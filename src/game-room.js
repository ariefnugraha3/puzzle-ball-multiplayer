import {
  BALL_RADIUS,
  BALL_SPACING,
  GAME_HEIGHT,
  GAME_WIDTH,
  LEVELS,
  TRACK_CONTROL_POINTS,
  SampledPath,
  buildColorSequence,
  calculateMatchScore,
  chooseAmmoColor,
  createSeededRandom,
  getBoundaryMatchIndex,
  getMatchRange,
  segmentCircleHit
} from './game-logic.js';
import {
  MAX_PLAYERS,
  PLAYER_SLOTS,
  PROJECTILE_RADIUS,
  PROJECTILE_SPAWN_DISTANCE,
  PROJECTILE_SPEED,
  RECONNECT_GRACE_MS,
  SHOT_COOLDOWN_MS,
  SWAP_COOLDOWN_MS,
  getLevelSettings,
  normalizeAngle
} from './multiplayer-config.js';

const MAX_FRAME_MS = 50;
const PROJECTILE_LIFETIME_MS = 2300;

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

function hashCode(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export class GameRoom {
  constructor({ code, now = 0, onEvent = () => {} } = {}) {
    if (!code) throw new Error('Room requires a code.');
    this.code = code;
    this.onEvent = onEvent;
    this.path = new SampledPath(TRACK_CONTROL_POINTS, 30);
    this.players = new Map();
    this.hostId = null;
    this.state = 'lobby';
    this.levelIndex = 0;
    this.score = 0;
    this.levelStartScore = 0;
    this.combo = 1;
    this.chain = [];
    this.projectiles = [];
    this.headDistance = 0;
    this.resolving = false;
    this.pendingResolution = null;
    this.comboResetAt = 0;
    this.snapshotSequence = 0;
    this.entityCounter = 0;
    this.generation = 0;
    this.lastUpdateAt = now;
    this.emptySince = null;
    this.random = createSeededRandom(hashCode(code));
  }

  nextId(prefix) {
    this.entityCounter += 1;
    return `${prefix}${this.entityCounter.toString(36)}`;
  }

  get connectedPlayers() {
    return [...this.players.values()].filter((player) => player.connected);
  }

  addPlayer({ id, sessionId, name, now = 0 }) {
    if (this.state !== 'lobby') {
      throw new RoomError('GAME_IN_PROGRESS', 'The game has already started. Wait for a new room or reconnect the previous session.');
    }
    if (this.players.size >= MAX_PLAYERS) {
      throw new RoomError('ROOM_FULL', 'The room is full (maximum 4 players).');
    }

    const usedSlots = new Set([...this.players.values()].map((player) => player.slot));
    const slot = PLAYER_SLOTS.findIndex((_, index) => !usedSlots.has(index));
    const player = {
      id,
      sessionId,
      name,
      slot,
      connected: true,
      disconnectedAt: null,
      aimAngle: -Math.PI / 2,
      currentColor: 0,
      nextColor: 1,
      shotCooldown: 0,
      swapCooldown: 0,
      joinedAt: now
    };
    this.players.set(id, player);
    if (!this.hostId) this.hostId = id;
    this.emptySince = null;
    this.emit('rosterChanged', { playerId: id, action: 'joined' }, now);
    return player;
  }

  findPlayerBySession(sessionId) {
    return [...this.players.values()].find((player) => player.sessionId === sessionId) ?? null;
  }

  reconnectPlayer(sessionId, name, now = 0) {
    const player = this.findPlayerBySession(sessionId);
    if (!player) return null;
    player.connected = true;
    player.disconnectedAt = null;
    player.name = name;
    this.emptySince = null;
    if (!this.hostId || !this.players.get(this.hostId)?.connected) this.migrateHost(now);
    this.emit('rosterChanged', { playerId: player.id, action: 'reconnected' }, now);
    return player;
  }

  disconnectPlayer(playerId, now = 0) {
    const player = this.players.get(playerId);
    if (!player || !player.connected) return;
    player.connected = false;
    player.disconnectedAt = now;
    this.projectiles = this.projectiles.filter((projectile) => projectile.ownerId !== playerId);
    if (this.hostId === playerId) this.migrateHost(now);
    if (!this.connectedPlayers.length) this.emptySince = now;
    this.emit('rosterChanged', { playerId, action: 'disconnected' }, now);
  }

  removePlayer(playerId, now = 0) {
    const player = this.players.get(playerId);
    if (!player) return false;
    this.players.delete(playerId);
    this.projectiles = this.projectiles.filter((projectile) => projectile.ownerId !== playerId);
    if (this.hostId === playerId) this.migrateHost(now);
    if (!this.connectedPlayers.length) this.emptySince = now;
    this.emit('rosterChanged', { playerId, action: 'left' }, now);
    return true;
  }

  migrateHost(now = 0) {
    const nextHost = this.connectedPlayers.sort((a, b) => a.slot - b.slot)[0] ?? null;
    this.hostId = nextHost?.id ?? null;
    this.emit('hostChanged', { hostId: this.hostId }, now);
  }

  pruneDisconnected(now, graceMs = RECONNECT_GRACE_MS) {
    for (const player of this.players.values()) {
      if (!player.connected && player.disconnectedAt !== null && now - player.disconnectedAt >= graceMs) {
        this.removePlayer(player.id, now);
      }
    }
  }

  assertHost(playerId) {
    if (playerId !== this.hostId) {
      throw new RoomError('HOST_ONLY', 'Only the host can perform this action.');
    }
  }

  startCampaign(playerId, now = 0) {
    this.assertHost(playerId);
    if (this.state !== 'lobby' && this.state !== 'won') {
      throw new RoomError('INVALID_STATE', 'The campaign cannot start from the current state.');
    }
    this.score = 0;
    this.prepareLevel(0, now);
  }

  prepareLevel(levelIndex, now = 0) {
    this.levelIndex = Math.max(0, Math.min(LEVELS.length - 1, levelIndex));
    this.levelStartScore = this.score;
    this.combo = 1;
    this.resolving = false;
    this.pendingResolution = null;
    this.comboResetAt = 0;
    this.projectiles = [];
    this.generation += 1;

    const playerCount = Math.max(1, this.connectedPlayers.length);
    const settings = getLevelSettings(this.levelIndex, playerCount);
    this.random = createSeededRandom(hashCode(`${this.code}:${this.generation}:${playerCount}`));
    const colors = buildColorSequence(settings.balls, settings.colors, this.random);
    this.headDistance = settings.startDistance;
    this.chain = colors.map((color) => ({ id: this.nextId('b'), color }));

    for (const player of this.players.values()) {
      player.currentColor = chooseAmmoColor(colors, this.random);
      player.nextColor = chooseAmmoColor(colors, this.random);
      player.shotCooldown = 0;
      player.swapCooldown = 0;
    }

    this.state = 'playing';
    this.lastUpdateAt = now;
    this.emit('stateChanged', { state: this.state, levelIndex: this.levelIndex }, now);
  }

  nextLevel(playerId, now = 0) {
    this.assertHost(playerId);
    if (this.state !== 'levelComplete') {
      throw new RoomError('INVALID_STATE', 'The next level is not available yet.');
    }
    this.score += 750 * (this.levelIndex + 1);
    this.prepareLevel(this.levelIndex + 1, now);
  }

  retryLevel(playerId, now = 0) {
    this.assertHost(playerId);
    if (this.state !== 'lost') {
      throw new RoomError('INVALID_STATE', 'The level can only be retried after losing.');
    }
    this.score = this.levelStartScore;
    this.prepareLevel(this.levelIndex, now);
  }

  restartCampaign(playerId, now = 0) {
    this.assertHost(playerId);
    if (!['lost', 'won', 'levelComplete'].includes(this.state)) {
      throw new RoomError('INVALID_STATE', 'The campaign cannot restart from the current state.');
    }
    this.score = 0;
    this.prepareLevel(0, now);
  }

  togglePause(playerId, now = 0) {
    this.assertHost(playerId);
    if (this.state === 'playing') this.state = 'paused';
    else if (this.state === 'paused') this.state = 'playing';
    else throw new RoomError('INVALID_STATE', 'The game cannot be paused right now.');
    this.lastUpdateAt = now;
    this.emit('stateChanged', { state: this.state, levelIndex: this.levelIndex }, now);
  }

  updateAim(playerId, angle) {
    const player = this.players.get(playerId);
    if (!player?.connected) return false;
    player.aimAngle = normalizeAngle(angle);
    return true;
  }

  fire(playerId, angle, clientShotId, now = 0) {
    const player = this.players.get(playerId);
    if (!player?.connected) return { ok: false, reason: 'PLAYER_NOT_FOUND' };
    if (this.state !== 'playing') return { ok: false, reason: 'NOT_PLAYING' };
    if (this.resolving || player.shotCooldown > 0 || !this.chain.length) {
      return { ok: false, reason: 'COOLDOWN' };
    }

    player.aimAngle = normalizeAngle(angle);
    const slot = PLAYER_SLOTS[player.slot];
    const direction = { x: Math.cos(player.aimAngle), y: Math.sin(player.aimAngle) };
    const projectile = {
      id: this.nextId('p'),
      ownerId: playerId,
      clientShotId: String(clientShotId ?? '').slice(0, 48),
      color: player.currentColor,
      x: slot.x + direction.x * PROJECTILE_SPAWN_DISTANCE,
      y: slot.y + direction.y * PROJECTILE_SPAWN_DISTANCE,
      vx: direction.x * PROJECTILE_SPEED,
      vy: direction.y * PROJECTILE_SPEED,
      age: 0
    };
    this.projectiles.push(projectile);
    player.currentColor = player.nextColor;
    player.nextColor = this.pickAmmoColor();
    player.shotCooldown = SHOT_COOLDOWN_MS;
    this.emit('projectileSpawn', { projectile: this.serializeProjectile(projectile) }, now);
    return { ok: true, projectile };
  }

  swapAmmo(playerId, now = 0) {
    const player = this.players.get(playerId);
    if (!player?.connected || this.state !== 'playing' || this.resolving || player.swapCooldown > 0) {
      return false;
    }
    [player.currentColor, player.nextColor] = [player.nextColor, player.currentColor];
    player.swapCooldown = SWAP_COOLDOWN_MS;
    this.emit('ammoChanged', {
      playerId,
      currentColor: player.currentColor,
      nextColor: player.nextColor
    }, now);
    return true;
  }

  pickAmmoColor() {
    return chooseAmmoColor(this.chain.map((ball) => ball.color), this.random);
  }

  sanitizeAmmo(now = 0) {
    if (!this.chain.length) return;
    const available = new Set(this.chain.map((ball) => ball.color));
    for (const player of this.players.values()) {
      let changed = false;
      if (!available.has(player.currentColor)) {
        player.currentColor = this.pickAmmoColor();
        changed = true;
      }
      if (!available.has(player.nextColor)) {
        player.nextColor = this.pickAmmoColor();
        changed = true;
      }
      if (changed) {
        this.emit('ammoChanged', {
          playerId: player.id,
          currentColor: player.currentColor,
          nextColor: player.nextColor
        }, now);
      }
    }
  }

  getCurrentSpeed() {
    return getLevelSettings(this.levelIndex, Math.max(1, this.connectedPlayers.length)).speed;
  }

  tick(now, elapsedMs = now - this.lastUpdateAt) {
    this.pruneDisconnected(now);
    if (!this.connectedPlayers.length) {
      this.lastUpdateAt = now;
      return;
    }
    if (this.state !== 'playing') {
      this.lastUpdateAt = now;
      return;
    }

    const safeElapsedMs = Math.max(0, Math.min(MAX_FRAME_MS, elapsedMs));
    const dt = safeElapsedMs / 1000;
    this.lastUpdateAt = now;
    for (const player of this.players.values()) {
      player.shotCooldown = Math.max(0, player.shotCooldown - safeElapsedMs);
      player.swapCooldown = Math.max(0, player.swapCooldown - safeElapsedMs);
    }

    this.headDistance += this.getCurrentSpeed() * dt;
    this.processPendingResolution(now);
    if (!this.resolving) this.updateProjectiles(dt, now);

    if (this.comboResetAt && now >= this.comboResetAt && !this.resolving) {
      this.combo = 1;
      this.comboResetAt = 0;
    }

    if (!this.resolving && this.chain.length && this.headDistance >= this.path.length - BALL_RADIUS * 0.45) {
      this.lose(now);
    }
  }

  updateProjectiles(dt, now) {
    for (let index = this.projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.projectiles[index];
      const start = { x: projectile.x, y: projectile.y };
      const end = { x: start.x + projectile.vx * dt, y: start.y + projectile.vy * dt };
      projectile.age += dt * 1000;

      let collision = null;
      for (let chainIndex = 0; chainIndex < this.chain.length; chainIndex += 1) {
        const distance = this.headDistance - chainIndex * BALL_SPACING;
        if (distance < -10) continue;
        const point = this.path.getPointAtDistance(distance);
        const hitTime = segmentCircleHit(start, end, point, BALL_RADIUS + PROJECTILE_RADIUS - 3);
        if (hitTime !== null && (!collision || hitTime < collision.time)) {
          collision = { time: hitTime, chainIndex };
        }
      }

      if (collision) {
        projectile.x = start.x + (end.x - start.x) * collision.time;
        projectile.y = start.y + (end.y - start.y) * collision.time;
        this.projectiles.splice(index, 1);
        this.handleImpact(projectile, collision.chainIndex, now);
        return;
      }

      projectile.x = end.x;
      projectile.y = end.y;
      const margin = 90;
      const outside = end.x < -margin || end.x > GAME_WIDTH + margin || end.y < -margin || end.y > GAME_HEIGHT + margin;
      if (outside || projectile.age >= PROJECTILE_LIFETIME_MS) this.projectiles.splice(index, 1);
    }
  }

  handleImpact(projectile, hitIndex, now = 0) {
    const hitBall = this.chain[hitIndex];
    if (!hitBall) return;
    const hitDistance = this.headDistance - hitIndex * BALL_SPACING;
    const closestDistance = this.path.getClosestDistance(
      projectile.x,
      projectile.y,
      hitDistance - BALL_SPACING * 1.4,
      hitDistance + BALL_SPACING * 1.4
    );
    const insertionIndex = closestDistance >= hitDistance ? hitIndex : hitIndex + 1;
    const insertedBall = { id: this.nextId('b'), color: projectile.color };
    this.headDistance += BALL_SPACING;
    this.chain.splice(insertionIndex, 0, insertedBall);
    this.resolving = true;
    this.pendingResolution = {
      kind: 'match',
      ballId: insertedBall.id,
      dueAt: now + 90
    };
    this.emit('impact', {
      projectileId: projectile.id,
      clientShotId: projectile.clientShotId,
      x: projectile.x,
      y: projectile.y,
      color: projectile.color
    }, now);
  }

  processPendingResolution(now) {
    if (!this.pendingResolution || now < this.pendingResolution.dueAt) return;
    const pending = this.pendingResolution;
    this.pendingResolution = null;

    if (pending.kind === 'match') {
      const index = this.chain.findIndex((ball) => ball.id === pending.ballId);
      if (index < 0) {
        this.resolving = false;
        return;
      }
      this.resolveMatchAt(index, now);
      return;
    }

    if (pending.kind === 'chain') {
      const colors = this.chain.map((ball) => ball.color);
      const matchIndex = getBoundaryMatchIndex(colors, pending.boundaryIndex);
      if (matchIndex >= 0 && getMatchRange(colors, matchIndex)) {
        this.combo += 1;
        this.resolveMatchAt(matchIndex, now);
      } else {
        this.resolving = false;
        this.comboResetAt = now + 650;
      }
      return;
    }

    if (pending.kind === 'complete') this.completeLevel(now);
  }

  resolveMatchAt(index, now = 0) {
    const range = getMatchRange(this.chain.map((ball) => ball.color), index);
    if (!range) {
      this.resolving = false;
      this.combo = 1;
      return null;
    }

    const removed = this.chain.slice(range.start, range.end + 1).map((ball, offset) => {
      const point = this.path.getPointAtDistance(this.headDistance - (range.start + offset) * BALL_SPACING);
      return { id: ball.id, color: ball.color, x: point.x, y: point.y };
    });
    this.chain.splice(range.start, range.count);
    if (range.start === 0) this.headDistance -= range.count * BALL_SPACING;
    const gained = calculateMatchScore(range.count, this.combo, this.levelIndex + 1);
    this.score += gained;
    this.sanitizeAmmo(now);
    this.emit('match', { removed, gained, combo: this.combo, score: this.score }, now);

    if (!this.chain.length) {
      this.pendingResolution = { kind: 'complete', dueAt: now + 360 };
    } else {
      this.pendingResolution = {
        kind: 'chain',
        boundaryIndex: range.start,
        dueAt: now + 270
      };
    }
    this.resolving = true;
    return { range, removed, gained };
  }

  completeLevel(now = 0) {
    this.resolving = false;
    this.pendingResolution = null;
    this.projectiles = [];
    this.state = this.levelIndex === LEVELS.length - 1 ? 'won' : 'levelComplete';
    this.emit('stateChanged', { state: this.state, levelIndex: this.levelIndex }, now);
  }

  lose(now = 0) {
    this.state = 'lost';
    this.resolving = false;
    this.pendingResolution = null;
    this.projectiles = [];
    this.emit('stateChanged', { state: this.state, levelIndex: this.levelIndex }, now);
  }

  serializeProjectile(projectile) {
    return {
      id: projectile.id,
      ownerId: projectile.ownerId,
      clientShotId: projectile.clientShotId,
      color: projectile.color,
      x: projectile.x,
      y: projectile.y,
      vx: projectile.vx,
      vy: projectile.vy
    };
  }

  getSnapshot(serverTime = 0) {
    this.snapshotSequence += 1;
    return {
      type: 'snapshot',
      protocol: 1,
      sequence: this.snapshotSequence,
      serverTime,
      roomCode: this.code,
      state: this.state,
      hostId: this.hostId,
      levelIndex: this.levelIndex,
      levelName: LEVELS[this.levelIndex].name,
      score: this.score,
      combo: this.combo,
      headDistance: this.headDistance,
      speed: this.getCurrentSpeed(),
      pathLength: this.path.length,
      resolving: this.resolving,
      chain: this.chain.map((ball) => [ball.id, ball.color]),
      projectiles: this.projectiles.map((projectile) => this.serializeProjectile(projectile)),
      players: [...this.players.values()]
        .sort((a, b) => a.slot - b.slot)
        .map((player) => ({
          id: player.id,
          name: player.name,
          slot: player.slot,
          connected: player.connected,
          aimAngle: player.aimAngle,
          currentColor: player.currentColor,
          nextColor: player.nextColor
        }))
    };
  }

  emit(type, payload, serverTime) {
    this.onEvent({ type, serverTime, roomCode: this.code, ...payload });
  }
}
