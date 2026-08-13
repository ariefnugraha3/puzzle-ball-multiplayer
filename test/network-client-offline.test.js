import test from 'node:test';
import assert from 'node:assert/strict';

import { NetworkClient } from '../src/network-client.js';

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

function installBrowserGlobals() {
  const previous = {
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    window: globalThis.window,
    WebSocket: globalThis.WebSocket
  };
  globalThis.localStorage = createStorage();
  globalThis.sessionStorage = createStorage();
  globalThis.window = {
    location: { protocol: 'http:', host: 'localhost:5173' },
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout
  };
  globalThis.WebSocket = class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
    }

    addEventListener() {}
    close() {
      this.readyState = 3;
    }
  };
  return () => {
    globalThis.localStorage = previous.localStorage;
    globalThis.sessionStorage = previous.sessionStorage;
    globalThis.window = previous.window;
    globalThis.WebSocket = previous.WebSocket;
  };
}

test('network client can run a playable local offline campaign', () => {
  const restore = installBrowserGlobals();
  try {
    const client = new NetworkClient();
    const statuses = [];
    const joined = [];
    const snapshots = [];

    client.on('status', (event) => statuses.push(event.status));
    client.on('roomJoined', (event) => joined.push(event));
    client.on('snapshot', (snapshot) => snapshots.push(snapshot));

    client.startOffline('Solo Keeper');
    const firstSnapshot = snapshots.at(-1);

    assert.equal(client.status, 'local');
    assert.equal(client.roomCode, 'LOCAL');
    assert.equal(statuses.at(-1), 'local');
    assert.equal(joined.length, 1);
    assert.equal(joined[0].offline, true);
    assert.equal(firstSnapshot.state, 'playing');
    assert.equal(firstSnapshot.players.length, 1);
    assert.equal(firstSnapshot.players[0].id, client.selfId);
    assert.equal(firstSnapshot.players[0].name, 'Solo Keeper');
    assert.ok(firstSnapshot.chain.length > 0);

    assert.equal(client.action('pause'), true);
    assert.equal(snapshots.at(-1).state, 'paused');

    client.leaveRoom();
    assert.equal(client.status, 'connecting');
    assert.equal(client.roomCode, null);
    client.close();
  } finally {
    restore();
  }
});
