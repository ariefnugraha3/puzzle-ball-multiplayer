export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;
export const BALL_RADIUS = 19;
export const BALL_SPACING = 38;

export const BALL_TYPES = [
  { key: 'coral', color: 0xff5a6f, light: 0xffa0ac, dark: 0x8f1e39 },
  { key: 'aqua', color: 0x35d8ff, light: 0xa6f2ff, dark: 0x08789f },
  { key: 'sun', color: 0xffcb45, light: 0xffeda1, dark: 0xa85f08 },
  { key: 'leaf', color: 0x72e06a, light: 0xc0ffae, dark: 0x237837 },
  { key: 'violet', color: 0xb578ff, light: 0xe1bdff, dark: 0x5c2a9e },
  { key: 'ember', color: 0xff8a3d, light: 0xffc58f, dark: 0x9b3f12 }
];

export const LEVELS = [
  {
    name: 'Jade Gate',
    balls: 34,
    colors: 4,
    speed: 47,
    startDistance: 720
  },
  {
    name: 'Sun Passage',
    balls: 44,
    colors: 5,
    speed: 56,
    startDistance: 790
  },
  {
    name: 'Temple Heart',
    balls: 54,
    colors: 6,
    speed: 64,
    startDistance: 850
  }
];

export const TRACK_CONTROL_POINTS = [
  { x: -100, y: 150 },
  { x: 95, y: 88 },
  { x: 360, y: 76 },
  { x: 720, y: 98 },
  { x: 1058, y: 86 },
  { x: 1195, y: 235 },
  { x: 1160, y: 500 },
  { x: 948, y: 628 },
  { x: 620, y: 646 },
  { x: 286, y: 590 },
  { x: 116, y: 430 },
  { x: 170, y: 262 },
  { x: 395, y: 188 },
  { x: 692, y: 190 },
  { x: 950, y: 230 },
  { x: 1040, y: 365 },
  { x: 952, y: 498 },
  { x: 764, y: 532 },
  { x: 574, y: 496 },
  { x: 452, y: 405 },
  { x: 474, y: 310 },
  { x: 606, y: 270 },
  { x: 755, y: 286 },
  { x: 842, y: 355 },
  { x: 820, y: 430 }
];

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * (
      2 * p1.x +
      (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
    ),
    y: 0.5 * (
      2 * p1.y +
      (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
    )
  };
}

export class SampledPath {
  constructor(controlPoints, samplesPerSegment = 28) {
    if (!Array.isArray(controlPoints) || controlPoints.length < 2) {
      throw new Error('SampledPath requires at least two points.');
    }

    this.points = [];
    for (let index = 0; index < controlPoints.length - 1; index += 1) {
      const p0 = controlPoints[Math.max(0, index - 1)];
      const p1 = controlPoints[index];
      const p2 = controlPoints[index + 1];
      const p3 = controlPoints[Math.min(controlPoints.length - 1, index + 2)];

      for (let sample = 0; sample < samplesPerSegment; sample += 1) {
        this.points.push(catmullRom(p0, p1, p2, p3, sample / samplesPerSegment));
      }
    }
    this.points.push({ ...controlPoints.at(-1) });

    this.distances = [0];
    for (let index = 1; index < this.points.length; index += 1) {
      const previous = this.points[index - 1];
      const current = this.points[index];
      this.distances.push(
        this.distances[index - 1] + Math.hypot(current.x - previous.x, current.y - previous.y)
      );
    }
    this.length = this.distances.at(-1);
  }

  getPointAtDistance(distance) {
    if (distance <= 0) {
      const start = this.points[0];
      const tangent = this.getTangentAtDistance(0, true);
      return { x: start.x + tangent.x * distance, y: start.y + tangent.y * distance };
    }

    if (distance >= this.length) {
      const end = this.points.at(-1);
      const tangent = this.getTangentAtDistance(this.length, true);
      const overflow = distance - this.length;
      return { x: end.x + tangent.x * overflow, y: end.y + tangent.y * overflow };
    }

    let low = 0;
    let high = this.distances.length - 1;
    while (low < high - 1) {
      const middle = Math.floor((low + high) / 2);
      if (this.distances[middle] <= distance) low = middle;
      else high = middle;
    }

    const span = this.distances[high] - this.distances[low] || 1;
    const ratio = (distance - this.distances[low]) / span;
    return {
      x: this.points[low].x + (this.points[high].x - this.points[low].x) * ratio,
      y: this.points[low].y + (this.points[high].y - this.points[low].y) * ratio
    };
  }

  getTangentAtDistance(distance, useSampleDirection = false) {
    const radius = useSampleDirection ? 4 : 8;
    const before = this.getPointWithoutTangent(clamp(distance - radius, 0, this.length));
    const after = this.getPointWithoutTangent(clamp(distance + radius, 0, this.length));
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const magnitude = Math.hypot(dx, dy) || 1;
    return { x: dx / magnitude, y: dy / magnitude };
  }

  getPointWithoutTangent(distance) {
    if (distance <= 0) return this.points[0];
    if (distance >= this.length) return this.points.at(-1);

    let low = 0;
    let high = this.distances.length - 1;
    while (low < high - 1) {
      const middle = Math.floor((low + high) / 2);
      if (this.distances[middle] <= distance) low = middle;
      else high = middle;
    }
    const span = this.distances[high] - this.distances[low] || 1;
    const ratio = (distance - this.distances[low]) / span;
    return {
      x: this.points[low].x + (this.points[high].x - this.points[low].x) * ratio,
      y: this.points[low].y + (this.points[high].y - this.points[low].y) * ratio
    };
  }

  getClosestDistance(x, y, minimum = 0, maximum = this.length) {
    let bestDistance = clamp(minimum, 0, this.length);
    let bestDistanceSquared = Number.POSITIVE_INFINITY;

    for (let index = 1; index < this.points.length; index += 1) {
      const segmentStartDistance = this.distances[index - 1];
      const segmentEndDistance = this.distances[index];
      if (segmentEndDistance < minimum || segmentStartDistance > maximum) continue;

      const start = this.points[index - 1];
      const end = this.points[index];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSquared = dx * dx + dy * dy || 1;
      const ratio = clamp(((x - start.x) * dx + (y - start.y) * dy) / lengthSquared, 0, 1);
      const projectedX = start.x + dx * ratio;
      const projectedY = start.y + dy * ratio;
      const distanceSquared = (x - projectedX) ** 2 + (y - projectedY) ** 2;

      if (distanceSquared < bestDistanceSquared) {
        bestDistanceSquared = distanceSquared;
        bestDistance = segmentStartDistance + (segmentEndDistance - segmentStartDistance) * ratio;
      }
    }

    return bestDistance;
  }
}

export function createSeededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildColorSequence(count, colorCount, random = Math.random) {
  const safeColorCount = clamp(Math.floor(colorCount), 1, BALL_TYPES.length);
  const sequence = [];

  while (sequence.length < count) {
    const candidates = Array.from({ length: safeColorCount }, (_, index) => index).filter((color) => {
      const length = sequence.length;
      return !(length >= 2 && sequence[length - 1] === color && sequence[length - 2] === color);
    });

    const previous = sequence.at(-1);
    const repeatPrevious = previous !== undefined && candidates.includes(previous) && random() < 0.36;
    const color = repeatPrevious
      ? previous
      : candidates[Math.floor(random() * candidates.length)];
    sequence.push(color);
  }

  return sequence;
}

export function getMatchRange(colors, index, minimumMatch = 3) {
  if (!Array.isArray(colors) || index < 0 || index >= colors.length) return null;

  const color = colors[index];
  let start = index;
  let end = index;
  while (start > 0 && colors[start - 1] === color) start -= 1;
  while (end < colors.length - 1 && colors[end + 1] === color) end += 1;

  const count = end - start + 1;
  return count >= minimumMatch ? { start, end, count, color } : null;
}

export function getBoundaryMatchIndex(colors, boundaryIndex) {
  if (boundaryIndex <= 0 || boundaryIndex >= colors.length) return -1;
  return colors[boundaryIndex - 1] === colors[boundaryIndex] ? boundaryIndex : -1;
}

export function chooseAmmoColor(colors, random = Math.random) {
  if (!colors.length) return 0;
  const uniqueColors = [...new Set(colors)];
  return uniqueColors[Math.floor(random() * uniqueColors.length)];
}

export function calculateMatchScore(matchCount, combo, levelNumber) {
  const base = matchCount * 100;
  const sizeBonus = Math.max(0, matchCount - 3) * 75;
  const comboMultiplier = 1 + Math.max(0, combo - 1) * 0.5;
  const levelMultiplier = 1 + Math.max(0, levelNumber - 1) * 0.15;
  return Math.round((base + sizeBonus) * comboMultiplier * levelMultiplier);
}

export function segmentCircleHit(start, end, center, radius) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.hypot(start.x - center.x, start.y - center.y) <= radius ? 0 : null;
  }

  const fromCenterX = start.x - center.x;
  const fromCenterY = start.y - center.y;
  const a = lengthSquared;
  const b = 2 * (fromCenterX * dx + fromCenterY * dy);
  const c = fromCenterX * fromCenterX + fromCenterY * fromCenterY - radius * radius;
  if (c <= 0) return 0;
  const discriminant = b * b - 4 * a * c;

  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const first = (-b - root) / (2 * a);
  const second = (-b + root) / (2 * a);
  if (first >= 0 && first <= 1) return first;
  if (second >= 0 && second <= 1) return second;
  return null;
}
