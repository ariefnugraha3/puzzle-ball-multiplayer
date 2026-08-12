import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';

import { SERVER_TICK_RATE, SNAPSHOT_RATE } from '../src/multiplayer-config.js';
import { GameRoom, RoomError } from './game-room.js';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_MESSAGE_RATE = 120;
const MAX_SNAPSHOT_BUFFER = 32 * 1024;
const EMPTY_ROOM_TTL_MS = 30_000;

function sanitizeName(value) {
  const name = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 18);
  return name || 'Penjaga';
}

function sanitizeSessionId(value) {
  const sessionId = String(value ?? '').trim();
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId)) {
    throw new RoomError('INVALID_SESSION', 'Sesi client tidak valid. Muat ulang halaman.');
  }
  return sessionId;
}

function sanitizeRoomCode(value) {
  const roomCode = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z2-9]{5}$/.test(roomCode)) {
    throw new RoomError('INVALID_CODE', 'Kode room harus terdiri dari 5 karakter.');
  }
  return roomCode;
}

function makeRoomCode(rooms) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = '';
    for (let index = 0; index < 5; index += 1) {
      code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new RoomError('ROOM_CODE_EXHAUSTED', 'Server tidak dapat membuat kode room baru.');
}

export class RealtimeService {
  constructor(httpServer) {
    this.httpServer = httpServer;
    this.rooms = new Map();
    this.playerSockets = new Map();
    this.lastTickAt = performance.now();
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 16 * 1024,
      perMessageDeflate: false,
      clientTracking: true
    });

    this.onUpgrade = (request, socket, head) => {
      let pathname;
      try {
        pathname = new URL(request.url, 'http://localhost').pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (pathname !== '/ws') return;
      this.wss.handleUpgrade(request, socket, head, (webSocket) => {
        this.wss.emit('connection', webSocket, request);
      });
    };
    httpServer.on('upgrade', this.onUpgrade);
    this.wss.on('connection', (socket) => this.handleConnection(socket));

    this.tickTimer = setInterval(() => this.tick(), 1000 / SERVER_TICK_RATE);
    this.snapshotTimer = setInterval(() => this.broadcastSnapshots(), 1000 / SNAPSHOT_RATE);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), 5000);
  }

  handleConnection(socket) {
    socket.isAlive = true;
    socket.meta = {
      roomCode: null,
      playerId: null,
      sessionId: null,
      rateWindowStartedAt: performance.now(),
      rateCount: 0
    };
    socket._socket?.setNoDelay(true);
    socket._socket?.setKeepAlive(true, 5000);
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', (data, isBinary) => this.handleMessage(socket, data, isBinary));
    socket.on('close', () => this.handleClose(socket));
    socket.on('error', () => {});
    this.send(socket, {
      type: 'hello',
      protocol: 1,
      serverTime: performance.now(),
      tickRate: SERVER_TICK_RATE,
      snapshotRate: SNAPSHOT_RATE
    });
  }

  handleMessage(socket, data, isBinary) {
    if (isBinary) {
      this.sendError(socket, 'BINARY_NOT_SUPPORTED', 'Server hanya menerima pesan JSON.');
      return;
    }

    const now = performance.now();
    if (now - socket.meta.rateWindowStartedAt >= 1000) {
      socket.meta.rateWindowStartedAt = now;
      socket.meta.rateCount = 0;
    }
    socket.meta.rateCount += 1;
    if (socket.meta.rateCount > MAX_MESSAGE_RATE) {
      socket.close(1008, 'Rate limit');
      return;
    }

    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      this.sendError(socket, 'INVALID_JSON', 'Pesan client bukan JSON yang valid.');
      return;
    }

    try {
      this.routeMessage(socket, message, now);
    } catch (error) {
      if (error instanceof RoomError) this.sendError(socket, error.code, error.message);
      else {
        console.error('Realtime message error:', error);
        this.sendError(socket, 'SERVER_ERROR', 'Server gagal memproses perintah.');
      }
    }
  }

  routeMessage(socket, message, now) {
    switch (message?.type) {
      case 'ping':
        this.send(socket, { type: 'pong', clientTime: Number(message.clientTime) || 0, serverTime: now });
        return;
      case 'createRoom':
        this.createRoom(socket, message, now);
        return;
      case 'joinRoom':
        this.joinRoom(socket, message, now);
        return;
      case 'leaveRoom':
        this.leaveRoom(socket, now);
        return;
      case 'aim':
        this.withRoomPlayer(socket, (room, playerId) => room.updateAim(playerId, Number(message.angle)));
        return;
      case 'fire':
        this.withRoomPlayer(socket, (room, playerId) => {
          const result = room.fire(playerId, Number(message.angle), message.clientShotId, now);
          if (!result.ok) {
            this.send(socket, {
              type: 'shotRejected',
              clientShotId: String(message.clientShotId ?? '').slice(0, 48),
              reason: result.reason,
              serverTime: now
            });
          }
        });
        return;
      case 'swap':
        this.withRoomPlayer(socket, (room, playerId) => room.swapAmmo(playerId, now));
        return;
      case 'action':
        this.handleAction(socket, message.action, now);
        return;
      default:
        throw new RoomError('UNKNOWN_MESSAGE', 'Jenis pesan tidak dikenal.');
    }
  }

  createRoom(socket, message, now) {
    const sessionId = sanitizeSessionId(message.sessionId);
    const name = sanitizeName(message.name);
    this.detachSocketFromRoom(socket, now, true);
    const code = makeRoomCode(this.rooms);
    const room = new GameRoom({
      code,
      now,
      onEvent: (event) => this.broadcastRoom(code, event)
    });
    this.rooms.set(code, room);
    const player = room.addPlayer({ id: randomUUID(), sessionId, name, now });
    this.bindSocket(socket, room, player, sessionId);
    this.sendJoined(socket, room, player, false, now);
    this.broadcastSnapshot(room, now);
  }

  joinRoom(socket, message, now) {
    const code = sanitizeRoomCode(message.roomCode);
    const sessionId = sanitizeSessionId(message.sessionId);
    const name = sanitizeName(message.name);
    const room = this.rooms.get(code);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'Room tidak ditemukan atau sudah ditutup.');

    const currentRoomCode = socket.meta.roomCode;
    if (currentRoomCode === code && socket.meta.sessionId !== sessionId) {
      throw new RoomError('ALREADY_IN_ROOM', 'Keluar dari room saat ini sebelum mengganti sesi.');
    }
    if (currentRoomCode === code && socket.meta.sessionId === sessionId) {
      const currentPlayer = room.players.get(socket.meta.playerId);
      if (currentPlayer) {
        const player = room.reconnectPlayer(sessionId, name, now);
        this.bindSocket(socket, room, player, sessionId);
        this.sendJoined(socket, room, player, true, now);
        this.broadcastSnapshot(room, now);
        return;
      }
    }
    if (currentRoomCode && currentRoomCode !== code) this.detachSocketFromRoom(socket, now, true);
    let player = room.reconnectPlayer(sessionId, name, now);
    const reconnected = Boolean(player);
    if (!player) player = room.addPlayer({ id: randomUUID(), sessionId, name, now });
    this.bindSocket(socket, room, player, sessionId);
    this.sendJoined(socket, room, player, reconnected, now);
    this.broadcastSnapshot(room, now);
  }

  bindSocket(socket, room, player, sessionId) {
    const previousSocket = this.playerSockets.get(player.id);
    this.playerSockets.set(player.id, socket);
    socket.meta.roomCode = room.code;
    socket.meta.playerId = player.id;
    socket.meta.sessionId = sessionId;
    if (previousSocket && previousSocket !== socket && previousSocket.readyState === WebSocket.OPEN) {
      previousSocket.close(4001, 'Session replaced');
    }
  }

  sendJoined(socket, room, player, reconnected, now) {
    this.send(socket, {
      type: 'roomJoined',
      selfId: player.id,
      roomCode: room.code,
      reconnected,
      snapshot: room.getSnapshot(now)
    });
  }

  leaveRoom(socket, now) {
    this.detachSocketFromRoom(socket, now, true);
    this.send(socket, { type: 'roomLeft', serverTime: now });
  }

  detachSocketFromRoom(socket, now, permanent) {
    const { roomCode, playerId } = socket.meta;
    if (!roomCode || !playerId) return;
    const room = this.rooms.get(roomCode);
    if (this.playerSockets.get(playerId) === socket) this.playerSockets.delete(playerId);
    if (room) {
      if (permanent) room.removePlayer(playerId, now);
      else room.disconnectPlayer(playerId, now);
      this.broadcastSnapshot(room, now);
    }
    socket.meta.roomCode = null;
    socket.meta.playerId = null;
  }

  handleAction(socket, action, now) {
    this.withRoomPlayer(socket, (room, playerId) => {
      switch (action) {
        case 'start': room.startCampaign(playerId, now); break;
        case 'next': room.nextLevel(playerId, now); break;
        case 'retry': room.retryLevel(playerId, now); break;
        case 'restart': room.restartCampaign(playerId, now); break;
        case 'pause': room.togglePause(playerId, now); break;
        default: throw new RoomError('UNKNOWN_ACTION', 'Aksi room tidak dikenal.');
      }
      this.broadcastSnapshot(room, now);
    });
  }

  withRoomPlayer(socket, callback) {
    const room = this.rooms.get(socket.meta.roomCode);
    if (!room || !socket.meta.playerId) {
      throw new RoomError('NOT_IN_ROOM', 'Client belum bergabung ke room.');
    }
    return callback(room, socket.meta.playerId);
  }

  handleClose(socket) {
    const { roomCode, playerId } = socket.meta;
    if (!roomCode || !playerId || this.playerSockets.get(playerId) !== socket) return;
    this.playerSockets.delete(playerId);
    const room = this.rooms.get(roomCode);
    if (room) {
      const now = performance.now();
      room.disconnectPlayer(playerId, now);
      this.broadcastSnapshot(room, now);
    }
  }

  tick() {
    const now = performance.now();
    const elapsed = now - this.lastTickAt;
    this.lastTickAt = now;
    for (const [code, room] of this.rooms) {
      room.tick(now, elapsed);
      if (!room.players.size || (room.emptySince !== null && now - room.emptySince >= EMPTY_ROOM_TTL_MS)) {
        this.rooms.delete(code);
      }
    }
  }

  broadcastSnapshots() {
    const now = performance.now();
    for (const room of this.rooms.values()) {
      if (room.connectedPlayers.length) this.broadcastSnapshot(room, now);
    }
  }

  broadcastSnapshot(room, now) {
    this.broadcastRoom(room.code, room.getSnapshot(now), true);
  }

  broadcastRoom(roomCode, message, volatile = false) {
    const serialized = JSON.stringify(message);
    for (const socket of this.wss.clients) {
      if (socket.readyState === WebSocket.OPEN && socket.meta.roomCode === roomCode) {
        if (volatile && socket.bufferedAmount > MAX_SNAPSHOT_BUFFER) continue;
        socket.send(serialized);
      }
    }
  }

  send(socket, message) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  sendError(socket, code, message) {
    this.send(socket, { type: 'error', code, message, serverTime: performance.now() });
  }

  heartbeat() {
    for (const socket of this.wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }

  async close() {
    clearInterval(this.tickTimer);
    clearInterval(this.snapshotTimer);
    clearInterval(this.heartbeatTimer);
    this.httpServer.off('upgrade', this.onUpgrade);
    for (const socket of this.wss.clients) socket.close(1001, 'Server shutting down');
    await new Promise((resolve) => this.wss.close(resolve));
  }
}
