import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';

import { RealtimeService } from '../server/realtime.js';

function createInbox(socket) {
  const messages = [];
  const waiters = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  });

  return {
    waitFor(predicate, timeoutMs = 2500) {
      const existingIndex = messages.findIndex(predicate);
      if (existingIndex >= 0) return Promise.resolve(messages.splice(existingIndex, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('Timed out waiting for WebSocket message'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    }
  };
}

async function openClient(url) {
  const socket = new WebSocket(url);
  const inbox = createInbox(socket);
  await once(socket, 'open');
  await inbox.waitFor((message) => message.type === 'hello');
  return { socket, inbox };
}

test('WebSocket server supports four players, rejects the fifth, and starts a game', async (context) => {
  const httpServer = createServer((request, response) => response.end('ok'));
  const realtime = new RealtimeService(httpServer);
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const clients = [];

  context.after(async () => {
    for (const client of clients) client.socket.close();
    await realtime.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  for (let index = 0; index < 5; index += 1) clients.push(await openClient(url));

  clients[0].socket.send(JSON.stringify({
    type: 'createRoom',
    sessionId: 'session-host-001',
    name: 'Host'
  }));
  const joinedHost = await clients[0].inbox.waitFor((message) => message.type === 'roomJoined');
  const roomCode = joinedHost.roomCode;

  for (let index = 1; index < 4; index += 1) {
    clients[index].socket.send(JSON.stringify({
      type: 'joinRoom',
      roomCode,
      sessionId: `session-player-00${index}`,
      name: `Player ${index + 1}`
    }));
    await clients[index].inbox.waitFor((message) => message.type === 'roomJoined');
  }

  clients[4].socket.send(JSON.stringify({
    type: 'joinRoom',
    roomCode,
    sessionId: 'session-player-005',
    name: 'Player 5'
  }));
  const roomFull = await clients[4].inbox.waitFor((message) => message.type === 'error');
  assert.equal(roomFull.code, 'ROOM_FULL');

  clients[0].socket.send(JSON.stringify({ type: 'action', action: 'start' }));
  const playing = await clients[0].inbox.waitFor(
    (message) => message.type === 'snapshot' && message.state === 'playing' && message.players.length === 4
  );
  assert.equal(playing.chain.length, 49);

  const pingSentAt = performance.now();
  clients[0].socket.send(JSON.stringify({ type: 'ping', clientTime: pingSentAt }));
  const pong = await clients[0].inbox.waitFor((message) => message.type === 'pong');
  assert.equal(pong.clientTime, pingSentAt);
  assert.ok(Number.isFinite(pong.serverTime));

  clients[0].socket.send(JSON.stringify({
    type: 'fire',
    angle: -Math.PI / 2,
    clientShotId: 'network-shot-1'
  }));
  const projectileSpawn = await clients[0].inbox.waitFor((message) => message.type === 'projectileSpawn');
  assert.equal(projectileSpawn.projectile.clientShotId, 'network-shot-1');
});

test('duplicate joins and session replacement keep exactly one authoritative player', async (context) => {
  const httpServer = createServer((request, response) => response.end('ok'));
  const realtime = new RealtimeService(httpServer);
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const clients = [];

  context.after(async () => {
    for (const client of clients) client.socket.close();
    await realtime.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  const first = await openClient(url);
  clients.push(first);
  first.socket.send(JSON.stringify({
    type: 'createRoom',
    sessionId: 'stable-session-001',
    name: 'Original'
  }));
  const initialJoin = await first.inbox.waitFor((message) => message.type === 'roomJoined');
  const roomCode = initialJoin.roomCode;

  first.socket.send(JSON.stringify({ type: 'action', action: 'start' }));
  await first.inbox.waitFor((message) => message.type === 'snapshot' && message.state === 'playing');
  first.socket.send(JSON.stringify({
    type: 'joinRoom',
    roomCode,
    sessionId: 'stable-session-001',
    name: 'Renamed'
  }));
  const duplicateJoin = await first.inbox.waitFor((message) => message.type === 'roomJoined');
  assert.equal(duplicateJoin.reconnected, true);
  assert.equal(duplicateJoin.snapshot.state, 'playing');
  assert.equal(duplicateJoin.snapshot.players.length, 1);
  assert.equal(duplicateJoin.snapshot.players[0].name, 'Renamed');

  first.socket.send(JSON.stringify({
    type: 'joinRoom',
    roomCode,
    sessionId: 'different-session-002',
    name: 'Intruder'
  }));
  const rejected = await first.inbox.waitFor((message) => message.type === 'error');
  assert.equal(rejected.code, 'ALREADY_IN_ROOM');
  assert.equal(realtime.rooms.get(roomCode).players.size, 1);

  const replacement = await openClient(url);
  clients.push(replacement);
  const replacedSocketClosed = once(first.socket, 'close');
  replacement.socket.send(JSON.stringify({
    type: 'joinRoom',
    roomCode,
    sessionId: 'stable-session-001',
    name: 'Replacement'
  }));
  const replacementJoin = await replacement.inbox.waitFor((message) => message.type === 'roomJoined');
  const [closeCode] = await replacedSocketClosed;

  assert.equal(closeCode, 4001);
  assert.equal(replacementJoin.selfId, initialJoin.selfId);
  assert.equal(replacementJoin.snapshot.players.length, 1);
  assert.equal(replacementJoin.snapshot.players[0].connected, true);
  assert.equal(realtime.rooms.get(roomCode).players.size, 1);
});
