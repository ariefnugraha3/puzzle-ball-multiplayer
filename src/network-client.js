const SESSION_KEY = 'zuma-rift-session';
const ROOM_KEY = 'zuma-rift-room';
const NAME_KEY = 'zuma-rift-name';

function safeStorage(storage, operation, fallback = null) {
  try {
    return operation(storage);
  } catch {
    return fallback;
  }
}

function resolveWebSocketUrl() {
  const configuredUrl = import.meta.env.VITE_WS_URL?.trim();
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
    if (event.code === 4001) {
      const wasInRoom = Boolean(this.roomCode || this.selfId);
      this.clearRoomState();
      this.setStatus('offline');
      if (wasInRoom) this.emit('roomLeft', { reason: 'SESSION_REPLACED' });
      this.emit('error', {
        code: 'SESSION_REPLACED',
        message: 'Sesi ini dibuka di tab lain. Muat ulang halaman untuk menyambung kembali.'
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
    this.playerName = String(name).trim().slice(0, 18) || 'Penjaga';
    safeStorage(localStorage, (storage) => storage.setItem(NAME_KEY, this.playerName));
  }

  leaveRoom() {
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
    return this.send({ type: 'fire', angle, clientShotId });
  }

  swap() {
    return this.send({ type: 'swap' });
  }

  action(action) {
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

  close() {
    this.intentionalClose = true;
    window.clearTimeout(this.reconnectTimer);
    window.clearTimeout(this.aimTimer);
    window.clearInterval(this.pingTimer);
    this.socket?.close(1000, 'Client closing');
  }
}
