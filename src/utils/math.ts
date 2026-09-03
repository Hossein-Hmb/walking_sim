/**
 * src/utils/math.ts
 *
 * Contents: small, dependency-free numeric helpers — clamping, interpolation, framerate-independent
 * damping, smoothstep, angle conversion, and deterministic seeded RNG / hashing.
 *
 * Purpose: shared by every workstream. Deliberately imports NOTHING (not even three.js) so it can be
 * used inside WS1's terrain Web Worker without dragging the renderer into the worker bundle.
 *
 * Note on `damp` vs `lerp`: never write `a = lerp(a, b, 0.1)` in an update loop — its speed depends
 * on framerate. Use `damp(a, b, lambda, dt)`, which is exact for any timestep.
 */

export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse of `lerp`: where does `v` sit between a and b? Unclamped. */
export function inverseLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

/** Remap `v` from one range to another, clamped to the output range. */
export function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return lerp(outMin, outMax, clamp01(inverseLerp(inMin, inMax, v)));
}

/**
 * Framerate-independent exponential approach. `lambda` is roughly "how many e-foldings per second";
 * 8–15 feels snappy, 1–3 feels heavy.
 */
export function damp(a: number, b: number, lambda: number, dt: number): number {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

/** Angular damp that takes the short way around the circle. Radians. */
export function dampAngle(a: number, b: number, lambda: number, dt: number): number {
  return a + shortestAngle(a, b) * (1 - Math.exp(-lambda * dt));
}

/** Signed shortest delta from angle `a` to angle `b`, in (-PI, PI]. */
export function shortestAngle(a: number, b: number): number {
  return ((((b - a) % TAU) + TAU + Math.PI) % TAU) - Math.PI;
}

/** Classic Hermite smoothstep, clamped. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(inverseLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

/** Ken Perlin's smootherstep — zero 1st AND 2nd derivative at the edges. */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(inverseLerp(edge0, edge1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  return Math.abs(d) <= maxDelta ? target : current + Math.sign(d) * maxDelta;
}

/** Wrap `v` into [0, range). Handles negatives correctly, unlike `%`. */
export function wrap(v: number, range: number): number {
  return ((v % range) + range) % range;
}

export function degToRad(deg: number): number {
  return deg * DEG2RAD;
}

export function radToDeg(rad: number): number {
  return rad * RAD2DEG;
}

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/**
 * Mulberry32 — a fast, well-distributed 32-bit PRNG. Use this everywhere instead of `Math.random`
 * so a given world seed always produces the same island, cairns, grass and rocks.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic 32-bit hash of two integers — handy for per-chunk seeds. */
export function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Deterministic 32-bit hash of a string — for turning names into seeds. */
export function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function randomRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

export function randomInt(rng: () => number, minInclusive: number, maxExclusive: number): number {
  return minInclusive + Math.floor(rng() * (maxExclusive - minInclusive));
}
