import { writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';

const url = process.argv.find((value) => value.startsWith('--url='))?.slice(6) ?? 'ws://127.0.0.1:5173/ws';
const codeFile = process.argv.find((value) => value.startsWith('--code-file='))?.slice(12) ?? '';
const duration = Number(process.argv.find((value) => value.startsWith('--duration='))?.slice(11) ?? 45_000);
const clients = [];
let roomCode = '';
let started = false;

function connect(name, sessionId) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { perMessageDeflate: false });
    const client = { socket, name, sessionId };
    socket.once('open', () => {
      clients.push(client);
      resolve(client);
    });
    socket.once('error', reject);
    socket.on('message', (data) => handleMessage(client, JSON.parse(data.toString())));
  });
}

function send(client, message) {
  if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(message));
}

async function handleMessage(client, message) {
  if (message.type === 'roomJoined' && !roomCode) {
    roomCode = message.roomCode;
    if (codeFile) writeFileSync(codeFile, roomCode, 'utf8');
    const guests = await Promise.all([
      connect('Aqua Bot', 'smoke-session-aqua-002'),
      connect('Coral Bot', 'smoke-session-coral-003')
    ]);
    guests.forEach((guest) => send(guest, {
      type: 'joinRoom',
      roomCode,
      sessionId: guest.sessionId,
      name: guest.name
    }));
  }

  if (message.type === 'snapshot' && client === clients[0] && message.players.length === 4 && !started) {
    started = true;
    send(client, { type: 'action', action: 'start' });
  }

  if (message.type === 'snapshot' && message.state === 'playing') {
    const player = message.players.find((item) => item.name === client.name);
    if (player && Math.random() < 0.02) {
      const slotPositions = [{ x: 610, y: 360 }, { x: 690, y: 360 }, { x: 610, y: 430 }, { x: 690, y: 430 }];
      const slot = slotPositions[player.slot];
      const targetAngle = Math.atan2(100 - slot.y, 720 - slot.x);
      send(client, { type: 'aim', angle: targetAngle });
    }
  }
}

const host = await connect('Gold Bot', 'smoke-session-gold-001');
send(host, { type: 'createRoom', sessionId: host.sessionId, name: host.name });

const pingTimer = setInterval(() => {
  for (const client of clients) send(client, { type: 'ping', clientTime: performance.now() });
}, 2000);

setTimeout(() => {
  clearInterval(pingTimer);
  for (const client of clients) client.socket.close(1000, 'Smoke test finished');
  setTimeout(() => process.exit(0), 100).unref();
}, duration);
