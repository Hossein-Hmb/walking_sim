/**
 * src/world/noise.ts
 *
 * Contents: seeded 2D value-noise primitives used to build the island — a deterministic
 * `simplex-noise` factory plus the three composites the terrain needs: fractal Brownian motion
 * (`fbm2`), ridged multifractal (`ridged2`, the thing that makes mountain *ridges* instead of
 * blobs), and domain warping (`warpX`/`warpZ`, which bends the noise field so hills stop looking
 * like a grid of bumps).
 *
 * Purpose: one place where "what does the terrain look like at (x, z)" bottoms out into raw noise.
 *
 * ⚠ This module runs inside `terrain.worker.ts`. It may only import `simplex-noise` and
 * `utils/math.ts` — both are dependency-free. Never import three.js (or anything that does) from
 * here, or the renderer ends up duplicated in the worker bundle.
 */

import { createNoise2D } from 'simplex-noise';
import { clamp01, mulberry32 } from '../utils/math';

/** A seeded 2D noise function returning roughly -1..1. */
export type Noise2D = (x: number, y: number) => number;

/**
 * Builds a deterministic 2D simplex noise function.
 *
 * @param seed - Any 32-bit integer. The same seed always yields the same field.
 * @complexity Time: O(1) construction (permutation table build) | Space: O(1)
 */
export function makeNoise2D(seed: number): Noise2D {
  return createNoise2D(mulberry32(seed >>> 0));
}

/**
 * Fractal Brownian motion — the standard "sum of octaves" fractal noise.
 *
 * @param noise - Base noise field.
 * @param x - World-space X in metres.
 * @param y - World-space Z in metres (named `y` because the noise field is 2D).
 * @param octaves - How many frequency doublings to sum. 1–7 is the useful range.
 * @param frequency - Base frequency in cycles per metre. `1 / wavelength`.
 * @param lacunarity - Frequency multiplier per octave.
 * @param gain - Amplitude multiplier per octave.
 * @returns Normalised to roughly -1..1 (divided by the total amplitude).
 *
 * @complexity Time: O(octaves) | Space: O(1)
 */
export function fbm2(
  noise: Noise2D,
  x: number,
  y: number,
  octaves: number,
  frequency: number,
  lacunarity = 2.0,
  gain = 0.5,
): number {
  let sum = 0;
  let norm = 0;
  let amp = 1;
  let freq = frequency;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq) * amp;
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Ridged multifractal (Musgrave). `1 - |noise|` folds the field so its zero crossings become sharp
 * creases, and squaring plus the `weight` feedback term makes high octaves only appear *on* the
 * ridges — which is what produces believable mountain spines and erosion-looking gullies rather
 * than the soft blobs plain fBm gives you.
 *
 * @returns 0..1, where 1 is a ridge crest.
 * @complexity Time: O(octaves) | Space: O(1)
 */
export function ridged2(
  noise: Noise2D,
  x: number,
  y: number,
  octaves: number,
  frequency: number,
  lacunarity = 2.0,
  gain = 0.5,
): number {
  let sum = 0;
  let norm = 0;
  let amp = 1;
  let freq = frequency;
  let weight = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(noise(x * freq, y * freq));
    n *= n;
    n *= weight;
    // Feedback: this octave's value gates the next one, so detail concentrates on the crests.
    weight = clamp01(n * 2.2);
    sum += n * amp;
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return norm > 0 ? clamp01(sum / norm) : 0;
}

/**
 * Domain warp offsets. Sampling the noise field at `(x + warpX(...), y + warpZ(...))` shears the
 * field along itself, turning symmetric bumps into folded, wind-blown looking terrain. The two
 * functions use different fixed offsets into the same field so a single noise instance suffices.
 *
 * @param amplitude - Warp distance in metres. ~0.1–0.3 × the feature wavelength reads best.
 * @complexity Time: O(octaves) | Space: O(1)
 */
export function warpX(noise: Noise2D, x: number, y: number, frequency: number, amplitude: number): number {
  return amplitude * fbm2(noise, x + 137.2, y - 41.7, 2, frequency);
}

export function warpZ(noise: Noise2D, x: number, y: number, frequency: number, amplitude: number): number {
  return amplitude * fbm2(noise, x - 219.4, y + 88.1, 2, frequency);
}
