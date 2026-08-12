import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BALL_SPACING,
  TRACK_CONTROL_POINTS,
  SampledPath,
  buildColorSequence,
  calculateMatchScore,
  chooseAmmoColor,
  createSeededRandom,
  getBoundaryMatchIndex,
  getMatchRange,
  segmentCircleHit
} from '../src/game-logic.js';

test('sampled path maps its start, end, and overflow consistently', () => {
  const path = new SampledPath(TRACK_CONTROL_POINTS);
  const start = path.getPointAtDistance(0);
  const end = path.getPointAtDistance(path.length);
  const afterEnd = path.getPointAtDistance(path.length + BALL_SPACING);

  assert.deepEqual(start, TRACK_CONTROL_POINTS[0]);
  assert.deepEqual(end, TRACK_CONTROL_POINTS.at(-1));
  assert.ok(path.length > 3000);
  assert.ok(Math.hypot(afterEnd.x - end.x, afterEnd.y - end.y) > BALL_SPACING - 0.1);
});

test('closest path distance returns a nearby arc-length value', () => {
  const path = new SampledPath(TRACK_CONTROL_POINTS);
  const expectedDistance = path.length * 0.57;
  const point = path.getPointAtDistance(expectedDistance);
  const closestDistance = path.getClosestDistance(point.x + 2, point.y - 2);

  assert.ok(Math.abs(closestDistance - expectedDistance) < 8);
});

test('generated waves never contain an automatic match of three', () => {
  const sequence = buildColorSequence(200, 6, createSeededRandom(2026));

  assert.equal(sequence.length, 200);
  assert.ok(sequence.every((color) => color >= 0 && color < 6));
  for (let index = 2; index < sequence.length; index += 1) {
    assert.equal(
      sequence[index] === sequence[index - 1] && sequence[index] === sequence[index - 2],
      false
    );
  }
});

test('match range expands in both directions and rejects short groups', () => {
  const colors = [0, 1, 1, 1, 2, 2];

  assert.deepEqual(getMatchRange(colors, 2), { start: 1, end: 3, count: 3, color: 1 });
  assert.equal(getMatchRange(colors, 4), null);
  assert.equal(getMatchRange(colors, -1), null);
});

test('boundary detection only returns touching colors', () => {
  assert.equal(getBoundaryMatchIndex([0, 1, 1, 2], 2), 2);
  assert.equal(getBoundaryMatchIndex([0, 1, 2], 2), -1);
  assert.equal(getBoundaryMatchIndex([0, 1], 0), -1);
});

test('ammo is always selected from colors that remain in the chain', () => {
  const available = [2, 2, 4, 5];
  const random = createSeededRandom(4);

  for (let index = 0; index < 30; index += 1) {
    assert.ok(new Set(available).has(chooseAmmoColor(available, random)));
  }
});

test('swept collision catches fast projectiles and rejects misses', () => {
  assert.equal(segmentCircleHit({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 0 }, 10), 0.4);
  assert.equal(segmentCircleHit({ x: 50, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 0 }, 10), 0);
  assert.equal(segmentCircleHit({ x: 0, y: 30 }, { x: 100, y: 30 }, { x: 50, y: 0 }, 10), null);
});

test('score rewards larger matches, combos, and later levels', () => {
  const base = calculateMatchScore(3, 1, 1);
  assert.ok(calculateMatchScore(4, 1, 1) > base);
  assert.ok(calculateMatchScore(3, 2, 1) > base);
  assert.ok(calculateMatchScore(3, 1, 3) > base);
});
