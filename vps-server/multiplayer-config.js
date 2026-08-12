import { LEVELS } from './game-logic.js';

export const MAX_PLAYERS = 4;
export const SERVER_TICK_RATE = 60;
export const SNAPSHOT_RATE = 30;
export const SHOT_COOLDOWN_MS = 210;
export const SWAP_COOLDOWN_MS = 180;
export const PROJECTILE_SPEED = 760;
export const PROJECTILE_RADIUS = 15;
export const PROJECTILE_SPAWN_DISTANCE = 54;
export const RECONNECT_GRACE_MS = 15_000;

export const PLAYER_SLOTS = [
  { x: 610, y: 360, accent: 0xf6c85f },
  { x: 690, y: 360, accent: 0x35d8ff },
  { x: 610, y: 430, accent: 0xff6f7f },
  { x: 690, y: 430, accent: 0xb98aff }
];

export function getLevelSettings(levelIndex, playerCount) {
  const safeLevelIndex = Math.max(0, Math.min(LEVELS.length - 1, Math.floor(levelIndex)));
  const safePlayerCount = Math.max(1, Math.min(MAX_PLAYERS, Math.floor(playerCount) || 1));
  const level = LEVELS[safeLevelIndex];
  return {
    ...level,
    balls: level.balls + (safePlayerCount - 1) * 5,
    speed: level.speed * (1 + (safePlayerCount - 1) * 0.16),
    startDistance: level.startDistance + (safePlayerCount - 1) * 24
  };
}

export function normalizeAngle(angle) {
  if (!Number.isFinite(angle)) return 0;
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}
