import { GameRoom, RoomError } from './game-room.js';
import { SERVER_TICK_RATE, SNAPSHOT_RATE } from './multiplayer-config.js';

const SESSION_KEY = 'zuma-rift-session';
const ROOM_KEY = 'zuma-rift-room';
const NAME_KEY = 'zuma-rift-name';
const OFFLINE_ROOM_CODE = 'LOCAL';

function safeStorage(storage, operation, fallback = null) {
  try {
    return operation(storage);
  } catch {
    return fallback;
  }
}

function resolveWebSocketUrl() {
  const configuredUrl = import.meta.env?.VITE_WS_URL?.trim();
  if (configuredUrl) return configuredUrl;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

function createSessionId() {
  const existing = safeStorage(sessionStorage, (storage) => storage.getItem(SESSION_KEY));
  if (existing) return existing;
  const id = globalThis.crypto?.randomUUID?.().replaceAll('-', '')
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  safeStorage(sessionStorage, (storage) => storage.setItem(SESSION_KEY, id));
  return id;
}

export class NetworkClient {
  constructor() {
    this.sessionId = createSessionId();
    this.roomCode = safeStorage(sessionStorage, (storage) => storage.getItem(ROOM_KEY));
    this.playerName = safeStorage(localStorage, (storage) => storage.getItem(NAME_KEY), '') || '';
    this.selfId = null;
    this.socket = null;
    this.status = 'offline';
    this.listeners = new Map();
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.pendingJoin = null;
    this.intentionalClose = false;
    this.latency = null;
    this.clockOffset = 0;
    this.lastAimSentAt = 0;
    this.pendingAim = null;
    this.aimTimer = null;
    this.mode = 'online';
    this.localRoom = null;
    this.localTickTimer = null;
    this.localSnapshotTimer = null;
    this.localLastTickAt = 0;
  }

  on(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    return () => this.listeners.get(type)?.delete(listener);
  }

  emit(type, payload) {
    for (const listener of this.listeners.get(type) ?? []) listener(payload);
  }

  setStatus(status) {
    this.status = status;
    this.emit('status', { status, latency: this.latency });
  }

  connect() {
    if (this.mode === 'offline') return;
    if (this.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.socket.readyState)) return;
    this.intentionalClose = false;
    this.setStatus(this.reconnectAttempt ? 'reconnecting' : 'connecting');
    this.socket = new WebSocket(resolveWebSocketUrl());
    this.socket.addEventListener('open', () => this.handleOpen());
    this.socket.addEventListener('message', (event) => this.handleMessage(event));
    this.socket.addEventListener('close', (event) => this.handleClose(event));
    this.socket.addEventListener('error', () => {});
  }

  handleOpen() {
    if (this.mode === 'offline') {
      this.socket?.close(1000, 'Offline mode active');
      return;
    }
    this.reconnectAttempt = 0;
    this.setStatus('online');
    this.startPing();
    if (this.pendingJoin) {
      const pending = this.pendingJoin;
      this.pendingJoin = null;
      pending();
    } else if (this.roomCode && this.playerName) {
      this.send({
        type: 'joinRoom',
        roomCode: this.roomCode,
        sessionId: this.sessionId,
        name: this.playerName
      });
    }
  }

  handleClose(event) {
    if (event.currentTarget && this.socket !== event.currentTarget) return;
    window.clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.socket = null;
    if (this.mode === 'offline') return;
    if (event.code === 4001) {
      const wasInRoom = Boolean(this.roomCode || this.selfId);
      this.clearRoomState();
      this.setStatus('offline');
      if (wasInRoom) this.emit('roomLeft', { reason: 'SESSION_REPLACED' });
      this.emit('error', {
        code: 'SESSION_REPLACED',
        message: 'This session was opened in another tab. Reload the page to reconnect.'
      });
      return;
    }
    if (this.intentionalClose || event.code === 1000) {
      this.setStatus('offline');
      return;
    }
    this.setStatus('reconnecting');
    const delay = Math.min(3000, 250 * 2 ** Math.min(this.reconnectAttempt, 4));
    this.reconnectAttempt += 1;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  handleMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === 'roomJoined') {
      this.selfId = message.selfId;
      this.roomCode = message.roomCode;
      safeStorage(sessionStorage, (storage) => storage.setItem(ROOM_KEY, this.roomCode));
      this.emit('roomJoined', message);
      if (message.snapshot) this.emit('snapshot', message.snapshot);
      return;
    }

    if (message.type === 'roomLeft') {
      const wasInRoom = Boolean(this.roomCode || this.selfId);
      this.clearRoomState();
      if (wasInRoom) this.emit('roomLeft', message);
      return;
    }

    if (message.type === 'pong') {
      const receivedAt = performance.now();
      const roundTrip = Math.max(0, receivedAt - message.clientTime);
      const offset = message.serverTime - (message.clientTime + roundTrip / 2);
      this.latency = this.latency === null ? roundTrip : this.latency * 0.72 + roundTrip * 0.28;
      this.clockOffset = this.clockOffset * 0.8 + offset * 0.2;
      this.emit('latency', { latency: this.latency, offset: this.clockOffset });
      return;
    }

    if (message.type === 'error' && message.code === 'ROOM_NOT_FOUND' && this.roomCode) {
      this.clearRoomState();
      this.emit('roomLeft', { reason: 'ROOM_NOT_FOUND' });
    }
    this.emit(message.type, message);
  }

  startPing() {
    window.clearInterval(this.pingTimer);
    const ping = () => this.send({ type: 'ping', clientTime: performance.now() });
    ping();
    this.pingTimer = window.setInterval(ping, 2000);
  }

  createRoom(name) {
    if (this.mode === 'offline') this.stopOfflineMode();
    this.setPlayerName(name);
    const command = () => this.send({
      type: 'createRoom',
      sessionId: this.sessionId,
      name: this.playerName
    });
    if (this.status === 'online') command();
    else {
      this.pendingJoin = command;
      this.connect();
    }
  }

  joinRoom(name, roomCode) {
    if (this.mode === 'offline') this.stopOfflineMode();
    this.setPlayerName(name);
    const normalizedCode = String(roomCode).trim().toUpperCase();
    const command = () => this.send({
      type: 'joinRoom',
      roomCode: normalizedCode,
      sessionId: this.sessionId,
      name: this.playerName
    });
    if (this.status === 'online') command();
    else {
      this.pendingJoin = command;
      this.connect();
    }
  }

  setPlayerName(name) {
    this.playerName = String(name).trim().slice(0, 18) || 'Guardian';
    safeStorage(localStorage, (storage) => storage.setItem(NAME_KEY, this.playerName));
  }

  leaveRoom() {
    if (this.mode === 'offline') {
      const roomCode = this.roomCode;
      this.stopOfflineMode();
      this.emit('roomLeft', { reason: 'LEFT', roomCode });
      this.connect();
      return;
    }
    const roomCode = this.roomCode;
    if (!roomCode && !this.selfId) return;
    this.send({ type: 'leaveRoom' });
    this.clearRoomState();
    this.emit('roomLeft', { reason: 'LEFT', roomCode });
  }

  clearRoomState() {
    this.roomCode = null;
    this.selfId = null;
    safeStorage(sessionStorage, (storage) => storage.removeItem(ROOM_KEY));
  }

  sendAim(angle) {
    if (this.mode === 'offline') {
      this.localRoom?.updateAim(this.selfId, angle);
      return;
    }
    this.pendingAim = angle;
    const now = performance.now();
    const remaining = 33 - (now - this.lastAimSentAt);
    if (remaining <= 0) {
      this.flushAim();
      return;
    }
    if (!this.aimTimer) this.aimTimer = window.setTimeout(() => this.flushAim(), remaining);
  }

  flushAim() {
    window.clearTimeout(this.aimTimer);
    this.aimTimer = null;
    if (this.pendingAim === null) return;
    this.send({ type: 'aim', angle: this.pendingAim });
    this.pendingAim = null;
    this.lastAimSentAt = performance.now();
  }

  fire(angle, clientShotId) {
    if (this.mode === 'offline') {
      return this.handleOfflineCommand((room, now) => {
        const result = room.fire(this.selfId, angle, clientShotId, now);
        if (!result.ok) {
          this.emit('shotRejected', {
            clientShotId: String(clientShotId ?? '').slice(0, 48),
            reason: result.reason,
            serverTime: now
          });
          return false;
        }
        this.emitLocalSnapshot(now);
        return true;
      });
    }
    return this.send({ type: 'fire', angle, clientShotId });
  }

  swap() {
    if (this.mode === 'offline') {
      return this.handleOfflineCommand((room, now) => {
        const ok = room.swapAmmo(this.selfId, now);
        if (ok) this.emitLocalSnapshot(now);
        return ok;
      });
    }
    return this.send({ type: 'swap' });
  }

  action(action) {
    if (this.mode === 'offline') {
      return this.handleOfflineCommand((room, now) => {
        switch (action) {
          case 'start': room.startCampaign(this.selfId, now); break;
          case 'next': room.nextLevel(this.selfId, now); break;
          case 'retry': room.retryLevel(this.selfId, now); break;
          case 'restart': room.restartCampaign(this.selfId, now); break;
          case 'pause': room.togglePause(this.selfId, now); break;
          default: throw new RoomError('UNKNOWN_ACTION', 'Unknown room action.');
        }
        this.emitLocalSnapshot(now);
        return true;
      });
    }
    return this.send({ type: 'action', action });
  }

  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  serverNow() {
    return performance.now() + this.clockOffset;
  }

  startOffline(name) {
    this.stopOnlineConnection();
    this.stopOfflineMode(false);
    this.mode = 'offline';
    this.setPlayerName(name);
    this.selfId = `local-${this.sessionId.slice(0, 16)}`;
    this.roomCode = OFFLINE_ROOM_CODE;
    this.latency = 0;
    safeStorage(sessionStorage, (storage) => storage.removeItem(ROOM_KEY));

    const now = performance.now();
    this.localLastTickAt = now;
    this.localRoom = new GameRoom({
      code: OFFLINE_ROOM_CODE,
      now,
      onEvent: (event) => this.emit(event.type, event)
    });
    this.localRoom.addPlayer({
      id: this.selfId,
      sessionId: this.sessionId,
      name: this.playerName,
      now
    });
    this.localRoom.startCampaign(this.selfId, now);
    this.setStatus('local');
    this.emit('roomJoined', { roomCode: this.roomCode, selfId: this.selfId, reconnected: false, offline: true });
    this.emitLocalSnapshot(now);
    this.startOfflineLoop();
  }

  startOfflineLoop() {
    window.clearInterval(this.localTickTimer);
    window.clearInterval(this.localSnapshotTimer);
    this.localTickTimer = window.setInterval(() => {
      if (!this.localRoom) return;
      const now = performance.now();
      const elapsed = now - this.localLastTickAt;
      this.localLastTickAt = now;
      this.localRoom.tick(now, elapsed);
    }, 1000 / SERVER_TICK_RATE);
    this.localSnapshotTimer = window.setInterval(() => {
      this.emitLocalSnapshot(performance.now());
    }, 1000 / SNAPSHOT_RATE);
  }

  emitLocalSnapshot(now) {
    if (!this.localRoom) return;
    this.emit('snapshot', this.localRoom.getSnapshot(now));
  }

  handleOfflineCommand(callback) {
    if (!this.localRoom || !this.selfId) return false;
    const now = performance.now();
    try {
      return callback(this.localRoom, now);
    } catch (error) {
      this.emit('error', {
        code: error instanceof RoomError ? error.code : 'LOCAL_ERROR',
        message: error.message || 'Offline mode failed to process the action.',
        serverTime: now
      });
      return false;
    }
  }

  stopOnlineConnection() {
    this.intentionalClose = true;
    window.clearTimeout(this.reconnectTimer);
    window.clearTimeout(this.aimTimer);
    window.clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.aimTimer = null;
    this.pingTimer = null;
    this.pendingJoin = null;
    this.socket?.close(1000, 'Switching mode');
    this.socket = null;
  }

  stopOfflineMode(updateStatus = true) {
    window.clearInterval(this.localTickTimer);
    window.clearInterval(this.localSnapshotTimer);
    this.localTickTimer = null;
    this.localSnapshotTimer = null;
    this.localRoom = null;
    if (this.mode === 'offline') {
      this.mode = 'online';
      this.clearRoomState();
      this.latency = null;
      if (updateStatus) this.setStatus('offline');
    }
  }

  close() {
    this.intentionalClose = true;
    window.clearTimeout(this.reconnectTimer);
    window.clearTimeout(this.aimTimer);
    window.clearInterval(this.pingTimer);
    window.clearInterval(this.localTickTimer);
    window.clearInterval(this.localSnapshotTimer);
    this.socket?.close(1000, 'Client closing');
  }
}
