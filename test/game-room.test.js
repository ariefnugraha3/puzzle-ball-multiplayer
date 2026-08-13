import test from 'node:test';
import assert from 'node:assert/strict';

import { LEVELS } from '../src/game-logic.js';
import { MAX_PLAYERS, getLevelSettings } from '../src/multiplayer-config.js';
import { GameRoom, RoomError } from '../src/game-room.js';

function createRoom(playerCount, code = `ROOM${playerCount}`) {
  const events = [];
  const room = new GameRoom({ code, now: 0, onEvent: (event) => events.push(event) });
  for (let index = 0; index < playerCount; index += 1) {
    room.addPlayer({
      id: `player-${index + 1}`,
      sessionId: `session-${index + 1}`,
      name: `Player ${index + 1}`,
      now: index
    });
  }
  return { room, events };
}

for (let playerCount = 1; playerCount <= MAX_PLAYERS; playerCount += 1) {
  test(`campaign starts with valid scaling and ammo for ${playerCount} player(s)`, () => {
    const { room } = createRoom(playerCount);
    room.startCampaign('player-1', 100);
    const settings = getLevelSettings(0, playerCount);
    const available = new Set(room.chain.map((ball) => ball.color));

    assert.equal(room.state, 'playing');
    assert.equal(room.chain.length, settings.balls);
    assert.equal(room.getCurrentSpeed(), settings.speed);
    assert.equal(room.connectedPlayers.length, playerCount);
    for (const player of room.players.values()) {
      assert.ok(available.has(player.currentColor));
      assert.ok(available.has(player.nextColor));
    }
    for (let index = 2; index < room.chain.length; index += 1) {
      const colors = room.chain.slice(index - 2, index + 1).map((ball) => ball.color);
      assert.equal(colors[0] === colors[1] && colors[1] === colors[2], false);
    }
  });

  test(`level can finish cleanly with ${playerCount} player(s)`, () => {
    const { room } = createRoom(playerCount, `WIN${playerCount}`);
    room.startCampaign('player-1', 0);
    room.chain = [0, 0, 0].map((color) => ({ id: room.nextId('b'), color }));
    room.headDistance = 1000;
    room.resolving = true;

    room.resolveMatchAt(1, 100);
    assert.equal(room.chain.length, 0);
    room.tick(500, 16);
    assert.equal(room.state, 'levelComplete');

    room.nextLevel('player-1', 600);
    assert.equal(room.levelIndex, 1);
    assert.equal(room.state, 'playing');
  });
}

test('room rejects a fifth player', () => {
  const { room } = createRoom(4, 'FULL4');
  assert.throws(
    () => room.addPlayer({ id: 'player-5', sessionId: 'session-5', name: 'Player 5' }),
    (error) => error instanceof RoomError && error.code === 'ROOM_FULL'
  );
});

test('host migrates and disconnected player can reclaim the same slot', () => {
  const { room } = createRoom(3, 'HOST3');
  const originalSlot = room.players.get('player-1').slot;
  room.disconnectPlayer('player-1', 100);

  assert.equal(room.hostId, 'player-2');
  const reconnected = room.reconnectPlayer('session-1', 'Player One', 200);
  assert.equal(reconnected.id, 'player-1');
  assert.equal(reconnected.slot, originalSlot);
  assert.equal(reconnected.connected, true);
  assert.equal(room.hostId, 'player-2');
});

test('authoritative projectile reaches the chain and inserts exactly one ball', () => {
  const { room, events } = createRoom(1, 'SHOT1');
  room.startCampaign('player-1', 0);
  const player = room.players.get('player-1');
  const slot = { x: 610, y: 360 };
  const target = room.path.getPointAtDistance(room.headDistance);
  const angle = Math.atan2(target.y - slot.y, target.x - slot.x);
  const before = room.chain.length;

  assert.equal(room.fire(player.id, angle, 'local-shot-1', 1).ok, true);
  let now = 1;
  for (let index = 0; index < 120 && !events.some((event) => event.type === 'impact'); index += 1) {
    now += 1000 / 60;
    room.tick(now, 1000 / 60);
  }

  assert.ok(events.some((event) => event.type === 'impact'));
  assert.equal(room.chain.length, before + 1);
  assert.equal(room.projectiles.length, 0);
});

test('pause freezes simulation and only the host can toggle it', () => {
  const { room } = createRoom(2, 'PAUSE');
  room.startCampaign('player-1', 0);
  room.togglePause('player-1', 10);
  const distance = room.headDistance;
  room.tick(1010, 1000);

  assert.equal(room.state, 'paused');
  assert.equal(room.headDistance, distance);
  assert.throws(
    () => room.togglePause('player-2', 1100),
    (error) => error instanceof RoomError && error.code === 'HOST_ONLY'
  );
  room.togglePause('player-1', 1200);
  assert.equal(room.state, 'playing');
});

test('final level resolves to a campaign win', () => {
  const { room } = createRoom(1, 'FINAL');
  room.startCampaign('player-1', 0);
  room.levelIndex = LEVELS.length - 1;
  room.chain = [2, 2, 2].map((color) => ({ id: room.nextId('b'), color }));
  room.resolving = true;
  room.resolveMatchAt(1, 100);
  room.tick(500, 16);
  assert.equal(room.state, 'won');
});
