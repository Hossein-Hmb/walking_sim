/**
 * src/world/TerrainGenerator.ts
 *
 * Contents: `generateTerrain` — the single pure function that turns a seed into the island. It
 * produces the heightmap, carves the river network into it, then derives biome weights and a river
 * influence mask from the *carved* heights. Also declares the worker message protocol
 * (`TerrainWorkerRequest` / `TerrainWorkerResponse`) so the worker and `WorldSystem` agree on it
 * without importing each other.
 *
 * Purpose: this is the authoritative definition of the world's shape. Everything downstream —
 * the visual chunk meshes, the Rapier heightfield (WS2), the biome shader (WS4), scatter placement
 * (WS5) — reads the arrays this function returns. There is deliberately no second source of truth.
 *
 * How the island is composed, per (x, z):
 *   1. `shore`    — warped radial falloff. 1 across the interior, 0 past the rim, so heights sink to
 *                   a sea floor at the edges. This bounds the world without invisible walls.
 *   2. `hills`    — domain-warped fBm, the rolling grassland relief (0–70 m).
 *   3. `massif`   — a low-frequency mask that decides *where* mountains are allowed to exist, so the
 *                   range clusters instead of speckling the whole island.
 *   4. `bulk`     — broad fBm giving the range its *mass*: the high plateau the peaks stand on.
 *   5. `ridge`    — ridged multifractal crests on top of the bulk.
 *   6. rivers     — traced and carved (see RiverNetwork.ts). MUST run before biomes.
 *   7. biomes     — grass / rock / snow / sand weights from height, slope, moisture and river mask.
 *
 * ── Why mountains are bulk + ridge, not ridge alone ─────────────────────────
 * A ridged multifractal scaled straight to `maxHeight` gives knife edges: the fold at `1 - |noise|`
 * has a slope discontinuity, so with the full 320 m of amplitude on the base octave the crests come
 * out near-vertical. Measured on seed 1337 that produced high ground that was 88% steeper than 46°,
 * on which no snow can settle — 0.05% of the map ended up snow-capped. Splitting the amplitude
 * between a broad `bulk` field and a smaller `ridge` term keeps the peaks but gives them shoulders,
 * which is what real ranges look like and what snow, grass and the player all need.
 *
 * ── Two-resolution sampling (the 1.5 s budget) ──────────────────────────────
 * `shore`, `massif`, `bulk` and the domain-warp offsets all have wavelengths of 800 m and up, so
 * evaluating them at every one of the 263k heightmap cells is waste: they are computed on a
 * `MACRO_STRIDE`-spaced grid (1/16 the samples) and bilinearly interpolated. Only `hills`, `ridge`
 * and `detail` — the terms with detail at the 4 m cell scale — are evaluated per cell. That cuts the
 * noise budget from ~7.1M evaluations to ~3.2M with no visible difference.
 *
 * ⚠ Runs inside `terrain.worker.ts`. No three.js, no DOM — only `utils/math`, `./noise` and
 * `./RiverNetwork`, all of which are dependency-free.
 */

import { RAD2DEG, clamp01, lerp, smoothstep, smootherstep, mulberry32 } from '../utils/math';
import { fbm2, makeNoise2D, ridged2, warpX, warpZ } from './noise';
import { buildRiverNetwork, countRiversReachingSea, type GeneratedRiver } from './RiverNetwork';

// ---------------------------------------------------------------------------
// Composition tuning. These are shape-of-the-world constants rather than gameplay knobs, so they
// live here instead of in world.config.ts (which WS8 tunes).
// ---------------------------------------------------------------------------

/** Normalised radius at which the interior plateau starts falling away toward the sea. */
const SHORE_INNER = 0.70;
/** Normalised radius at which the falloff has fully reached the sea floor. */
const SHORE_OUTER = 1.02;
/** How much low-frequency noise distorts the island radius. Higher = more ragged coastline. */
const COAST_IRREGULARITY = 0.26;
/** Height of the ocean floor at the map rim, in metres relative to sea level. */
const SEA_FLOOR = -38;
/** Height of the bare interior platform before hills and mountains are added. */
const INLAND_BASE = 7;
/** Peak-to-trough of the grassland hills, in metres. */
const HILL_AMPLITUDE = 70;
/** Metres of fine detail layered on everything, so close-up ground is never billiard-flat. */
const DETAIL_AMPLITUDE = 2.2;
/** Metres the hill/ridge noise field is sheared along itself. */
const WARP_AMPLITUDE = 95;
/** Mountains are only allowed where the low-frequency range field exceeds this. */
const MASSIF_THRESHOLD_LOW = 0.40;
const MASSIF_THRESHOLD_HIGH = 0.70;
/** Metres of broad "the range has mass" elevation at the centre of a full massif. */
const MOUNTAIN_BULK = 232;
/** Metres of ridged crest stacked on top of the bulk. */
const MOUNTAIN_RIDGE = 128;
/** Exponent on the ridge field. >1 sharpens crests; keep modest or the peaks go vertical again. */
const RIDGE_SHARPNESS = 1.25;
/** One macro-field sample per this many heightmap cells. Must be >= 1. */
const MACRO_STRIDE = 4;

/** Slope (degrees) over which snow slides off rather than settling. */
const SNOW_SLIP_LOW = 40;
const SNOW_SLIP_HIGH = 62;
/** Altitude band over which the snow line fades in. */
const SNOW_FADE_BELOW = 55;
const SNOW_FADE_ABOVE = 45;
/** Altitude band over which high ground goes bare-rock even where it is flat. */
const ALPINE_ROCK_LOW = 150;
const ALPINE_ROCK_HIGH = 265;
/**
 * Dry grassland shows through as bare earth. Without this, `moisture` only ever scales grass — and
 * since grass is then renormalised back to 1 wherever it is the only non-zero weight, the moisture
 * field has literally no effect across the ~60% of the island that is plain grassland. Letting
 * dryness raise a little rock is what turns that into patchy ground.
 */
const DRY_GROUND_ROCK = 0.3;
const DRY_MOISTURE_WET = 0.56;
const DRY_MOISTURE_ARID = 0.28;
/** Beaches: sand fades out above this height and on slopes steeper than the second pair. */
const BEACH_TOP = 7;
const BEACH_SLOPE_LOW = 16;
const BEACH_SLOPE_HIGH = 30;
/**
 * WS4's terrain shader detects a *missing* `aBiome` attribute by testing for exactly (0,0,0,1) —
 * the value WebGL gives an unbound vec4 — and falls back to estimating biomes from slope and
 * altitude. Pure sea bed would otherwise hit that value exactly and silently disable the real biome
 * map, so a sliver of grass is always left in the mix. See `TerrainMaterial.ts` §CONTRACT FOR WS1.
 */
const MIN_NON_SAND_WEIGHT = 0.002;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface TerrainParams {
  seed: number;
  /** Island side length in metres. */
  size: number;
  /** Heightmap vertices per side (odd, so it divides cleanly into chunks). */
  resolution: number;
  maxHeight: number;
  seaLevel: number;
  snowLine: number;
  /** Slope in degrees at which ground reads as exposed rock. */
  rockSlopeDeg: number;
  riverCount: number;
}

export interface TerrainStats {
  minHeight: number;
  maxHeight: number;
  /** Fraction of grid cells above sea level. */
  landFraction: number;
  /** Fraction of grid cells whose dominant biome is snow. */
  snowFraction: number;
  riverCount: number;
  riversReachingSea: number;
  /** Wall-clock milliseconds spent generating. */
  generateMs: number;
}

export interface TerrainResult {
  /** `resolution²`, row-major, `index = z * resolution + x`. */
  heights: Float32Array;
  /** `resolution² × 4`, stride 4 = [grass, rock, snow, sand], each group sums to 1. */
  biomes: Float32Array;
  /** `resolution²`, 0 = dry, 1 = river bed centre. */
  riverMask: Float32Array;
  rivers: GeneratedRiver[];
  stats: TerrainStats;
}

export type ProgressFn = (progress: number, label: string) => void;

// --- worker protocol -------------------------------------------------------

export interface TerrainWorkerRequest {
  type: 'generate';
  params: TerrainParams;
}

export type TerrainWorkerResponse =
  | { type: 'progress'; progress: number; label: string }
  | {
      type: 'done';
      heights: Float32Array;
      biomes: Float32Array;
      riverMask: Float32Array;
      rivers: GeneratedRiver[];
      stats: TerrainStats;
    }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Generates the whole island. Deterministic for a given `params.seed`.
 *
 * @param params - Island dimensions and biome thresholds (normally straight from `WORLD`).
 * @param onProgress - Optional 0..1 progress callback, so the loading screen can animate.
 * @returns Heights, biome weights, river mask, river splines/ribbons and a stats block.
 *
 * @complexity Time: O(resolution² × octaves) ≈ 6M noise evaluations at 513² — roughly 250–450 ms.
 * Space: O(resolution²) — 1 MB heights + 4 MB biomes + 1 MB mask + 3 MB scratch during carving.
 *
 * @example
 * const world = generateTerrain({ seed: 1337, size: 2048, resolution: 513, maxHeight: 400,
 *   seaLevel: 0, snowLine: 220, rockSlopeDeg: 38, riverCount: 4 });
 */
export function generateTerrain(params: TerrainParams, onProgress?: ProgressFn): TerrainResult {
  const t0 = now();
  const { resolution: res, size } = params;
  const cells = res * res;
  const cell = size / (res - 1);

  const heights = new Float32Array(cells);
  const biomes = new Float32Array(cells * 4);

  onProgress?.(0, 'raising the island');
  const macro = buildMacroField(params);
  fillHeights(heights, macro, params, onProgress);

  onProgress?.(0.6, 'carving rivers');
  const { rivers, mask } = buildRiverNetwork(
    heights,
    { size, resolution: res, seaLevel: params.seaLevel, riverCount: params.riverCount },
    mulberry32(params.seed ^ 0x5eed),
  );

  onProgress?.(0.78, 'weathering the ground');
  const snowFraction = computeBiomes(heights, mask, biomes, params, cell, macro);

  let minHeight = Infinity;
  let maxObserved = -Infinity;
  let land = 0;
  for (let i = 0; i < cells; i++) {
    const h = heights[i];
    if (h < minHeight) minHeight = h;
    if (h > maxObserved) maxObserved = h;
    if (h > params.seaLevel) land++;
  }

  onProgress?.(1, 'world ready');
  return {
    heights,
    biomes,
    riverMask: mask,
    rivers,
    stats: {
      minHeight,
      maxHeight: maxObserved,
      landFraction: land / cells,
      snowFraction,
      riverCount: rivers.length,
      riversReachingSea: countRiversReachingSea(rivers),
      generateMs: now() - t0,
    },
  };
}

// ---------------------------------------------------------------------------
// Height field
// ---------------------------------------------------------------------------

/**
 * The four long-wavelength fields, sampled on a `MACRO_STRIDE`-spaced grid. Everything here has a
 * wavelength of 800 m or more, so bilinear reconstruction at 16 m spacing is indistinguishable from
 * evaluating the noise per cell — and 16× cheaper.
 */
interface MacroField {
  /** Macro nodes per side. */
  res: number;
  /** Heightmap cells between macro nodes. */
  stride: number;
  /** Island mask, 1 inland → 0 past the rim. */
  shore: Float32Array;
  /** Where mountains are permitted, 0..1. */
  massif: Float32Array;
  /** Broad elevation of the range, 0..1. */
  bulk: Float32Array;
  /** Domain-warp offsets in metres. */
  warpU: Float32Array;
  warpV: Float32Array;
  /** Biome moisture, 0..1 — also long-wavelength, so it rides along here. */
  moisture: Float32Array;
}

/**
 * Evaluates the long-wavelength fields on the coarse grid.
 *
 * @complexity Time: O((resolution / stride)² × 13 noise evaluations) — ~216k evaluations at 513²
 * with stride 4. Space: O((resolution / stride)²) — six ~66 kB arrays.
 */
function buildMacroField(params: TerrainParams): MacroField {
  const half = params.size * 0.5;
  const cell = params.size / (params.resolution - 1);
  const stride = MACRO_STRIDE;
  // One extra node so the last heightmap row/column is inside the grid rather than extrapolated.
  const mres = Math.ceil((params.resolution - 1) / stride) + 1;
  const count = mres * mres;

  const coastNoise = makeNoise2D(params.seed ^ 0x51e3);
  const warpNoise = makeNoise2D(params.seed ^ 0x1a2b);
  const rangeNoise = makeNoise2D(params.seed ^ 0x2bd9);
  const bulkNoise = makeNoise2D(params.seed ^ 0x4a17);
  const moistureNoise = makeNoise2D(params.seed ^ 0x6d01);

  const shore = new Float32Array(count);
  const massif = new Float32Array(count);
  const bulk = new Float32Array(count);
  const warpU = new Float32Array(count);
  const warpV = new Float32Array(count);
  const moisture = new Float32Array(count);

  for (let mz = 0; mz < mres; mz++) {
    const z = -half + Math.min(mz * stride, params.resolution - 1) * cell;
    const row = mz * mres;
    for (let mx = 0; mx < mres; mx++) {
      const x = -half + Math.min(mx * stride, params.resolution - 1) * cell;
      const i = row + mx;

      // Island mask: a radial falloff whose radius is perturbed by low-frequency noise, which is
      // what turns a circle into a coastline with bays and headlands.
      const wobble = fbm2(coastNoise, x, z, 3, 0.00065);
      const radius = Math.hypot(x / half, z / half) * (1 + COAST_IRREGULARITY * wobble);
      const s = smootherstep(SHORE_OUTER, SHORE_INNER, radius);
      shore[i] = s;

      // Where mountains are allowed at all. `shore^1.35` keeps the range off the beaches.
      const range = fbm2(rangeNoise, x, z, 2, 0.00085) * 0.5 + 0.5;
      massif[i] = smootherstep(MASSIF_THRESHOLD_LOW, MASSIF_THRESHOLD_HIGH, range) * Math.pow(s, 1.35);

      bulk[i] = clamp01(fbm2(bulkNoise, x, z, 4, 0.0011) * 0.5 + 0.5);
      warpU[i] = warpX(warpNoise, x, z, 0.0012, WARP_AMPLITUDE);
      warpV[i] = warpZ(warpNoise, x, z, 0.0012, WARP_AMPLITUDE);
      moisture[i] = clamp01(fbm2(moistureNoise, x, z, 3, 0.0016) * 0.5 + 0.5);
    }
  }

  return { res: mres, stride, shore, massif, bulk, warpU, warpV, moisture };
}

/** Bilinear read of one macro field. `iA`/`iB` are the top/bottom row offsets, already resolved. */
function bilerpMacro(field: Float32Array, iA: number, iB: number, u: number, v: number): number {
  const top = field[iA] + (field[iA + 1] - field[iA]) * u;
  const bottom = field[iB] + (field[iB + 1] - field[iB]) * u;
  return top + (bottom - top) * v;
}

/**
 * Fills the heightmap: bilinear macro fields plus per-cell hills, ridges and fine detail.
 *
 * @complexity Time: O(resolution² × 11 noise evaluations) — ~2.9M evaluations at 513².
 * Space: O(1) beyond the caller's array.
 */
function fillHeights(
  heights: Float32Array,
  macro: MacroField,
  params: TerrainParams,
  onProgress?: ProgressFn,
): void {
  const res = params.resolution;
  const cell = params.size / (res - 1);
  const half = params.size * 0.5;
  const mres = macro.res;
  const invStride = 1 / macro.stride;
  const maxNode = mres - 2;

  const hillNoise = makeNoise2D(params.seed ^ 0x77c1);
  const ridgeNoise = makeNoise2D(params.seed ^ 0x9f4d);
  const detailNoise = makeNoise2D(params.seed ^ 0x3ce7);

  for (let gz = 0; gz < res; gz++) {
    const z = -half + gz * cell;
    const row = gz * res;

    const fz = gz * invStride;
    let mz = Math.floor(fz);
    let v = fz - mz;
    if (mz > maxNode) {
      mz = maxNode;
      v = 1;
    }
    const rowA = mz * mres;
    const rowB = rowA + mres;

    for (let gx = 0; gx < res; gx++) {
      const x = -half + gx * cell;

      const fx = gx * invStride;
      let mx = Math.floor(fx);
      let u = fx - mx;
      if (mx > maxNode) {
        mx = maxNode;
        u = 1;
      }
      const iA = rowA + mx;
      const iB = rowB + mx;

      const shore = bilerpMacro(macro.shore, iA, iB, u, v);
      const massif = bilerpMacro(macro.massif, iA, iB, u, v);
      const bulk = bilerpMacro(macro.bulk, iA, iB, u, v);
      const wx = x + bilerpMacro(macro.warpU, iA, iB, u, v);
      const wz = z + bilerpMacro(macro.warpV, iA, iB, u, v);

      const hills = fbm2(hillNoise, wx, wz, 4, 0.0022) * 0.5 + 0.5;
      const ridge = ridged2(ridgeNoise, wx, wz, 5, 0.0013);
      const detail = fbm2(detailNoise, x, z, 2, 0.011) * DETAIL_AMPLITUDE;

      const base = lerp(SEA_FLOOR, INLAND_BASE, shore);
      const hillHeight = Math.pow(hills, 1.35) * HILL_AMPLITUDE * shore;
      const mountain = massif * (bulk * MOUNTAIN_BULK + Math.pow(ridge, RIDGE_SHARPNESS) * MOUNTAIN_RIDGE);

      const h = base + hillHeight + mountain + detail * shore;
      heights[row + gx] = h > params.maxHeight ? params.maxHeight : h;
    }

    // Reporting every 64 rows keeps the postMessage traffic negligible.
    if ((gz & 63) === 0) onProgress?.((gz / res) * 0.6, 'raising the island');
  }
}

// ---------------------------------------------------------------------------
// Biome weights
// ---------------------------------------------------------------------------

/**
 * Derives the four biome weights for every grid cell from the CARVED heights.
 *
 * Rules, in priority order:
 *   - Anything at or below the waterline is sand (sea bed and beaches).
 *   - Slope past `rockSlopeDeg` is exposed rock; high altitude goes bare rock even when flat.
 *   - Snow accumulates above `snowLine`, but slides off slopes past `SNOW_SLIP_LOW` — so cliffs
 *     stay dark even at 400 m, which is the detail that makes mountains read as mountains.
 *   - River beds are gravel/sand; the banks immediately outside them are lush grass.
 *   - Grass takes whatever is left, biased by a moisture field so grassland is not uniform.
 * Weights are normalised so each group of four sums to exactly 1 (WS4's shader relies on this).
 *
 * @returns The fraction of cells whose dominant weight is snow (used for the stats block).
 * @complexity Time: O(resolution²), no noise evaluations — moisture is read from the macro grid.
 * Space: O(1)
 */
function computeBiomes(
  heights: Float32Array,
  riverMask: Float32Array,
  biomes: Float32Array,
  params: TerrainParams,
  cell: number,
  macro: MacroField,
): number {
  const res = params.resolution;
  const mres = macro.res;
  const invStride = 1 / macro.stride;
  const maxNode = mres - 2;
  const rockLow = params.rockSlopeDeg - 9;
  const rockHigh = params.rockSlopeDeg + 11;
  const snowLow = params.snowLine - SNOW_FADE_BELOW;
  const snowHigh = params.snowLine + SNOW_FADE_ABOVE;
  const inv2Cell = 1 / (2 * cell);

  let snowDominant = 0;

  for (let gz = 0; gz < res; gz++) {
    const row = gz * res;
    const zm = gz > 0 ? row - res : row;
    const zp = gz < res - 1 ? row + res : row;
    const dzSpan = (gz > 0 ? 1 : 0) + (gz < res - 1 ? 1 : 0);

    const fz = gz * invStride;
    let mz = Math.floor(fz);
    let v = fz - mz;
    if (mz > maxNode) {
      mz = maxNode;
      v = 1;
    }
    const rowA = mz * mres;
    const rowB = rowA + mres;

    for (let gx = 0; gx < res; gx++) {
      const i = row + gx;
      const h = heights[i];

      const xm = gx > 0 ? gx - 1 : gx;
      const xp = gx < res - 1 ? gx + 1 : gx;
      const dxSpan = (gx > 0 ? 1 : 0) + (gx < res - 1 ? 1 : 0);
      const dhdx = dxSpan > 0 ? (heights[row + xp] - heights[row + xm]) * (2 / dxSpan) * inv2Cell : 0;
      const dhdz = dzSpan > 0 ? (heights[zp + gx] - heights[zm + gx]) * (2 / dzSpan) * inv2Cell : 0;
      const slopeDeg = Math.atan(Math.hypot(dhdx, dhdz)) * RAD2DEG;

      const river = riverMask[i];

      const fx = gx * invStride;
      let mx = Math.floor(fx);
      let u = fx - mx;
      if (mx > maxNode) {
        mx = maxNode;
        u = 1;
      }
      const moisture = bilerpMacro(macro.moisture, rowA + mx, rowB + mx, u, v);

      // --- sand: sea bed, beaches, river gravel ---------------------------
      let sand = smoothstep(2, -4, h);
      sand = Math.max(sand, smoothstep(BEACH_TOP, 0.6, h) * (1 - smoothstep(BEACH_SLOPE_LOW, BEACH_SLOPE_HIGH, slopeDeg)));
      sand = Math.max(sand, river * 0.9);

      // --- snow: altitude, but not on cliffs ------------------------------
      let snow = smoothstep(snowLow, snowHigh, h) * (1 - smoothstep(SNOW_SLIP_LOW, SNOW_SLIP_HIGH, slopeDeg));
      snow *= 1 - clamp01(sand);

      // --- rock: slope, plus a bare alpine band ---------------------------
      let rock = smoothstep(rockLow, rockHigh, slopeDeg);
      rock = Math.max(rock, smoothstep(ALPINE_ROCK_LOW, ALPINE_ROCK_HIGH, h) * lerp(0.35, 0.75, 1 - moisture));
      // Arid ground wears through to earth. Suppressed near rivers, where the bank is always lush,
      // and below the waterline, where "arid" is meaningless and the sea bed should read as sand.
      rock = Math.max(
        rock,
        smoothstep(DRY_MOISTURE_WET, DRY_MOISTURE_ARID, moisture) *
          DRY_GROUND_ROCK *
          (1 - clamp01(river * 3)) *
          smoothstep(-1, 3, h),
      );
      // Snow lies on top of rock where it settles.
      rock *= 1 - snow * 0.85;
      rock *= 1 - clamp01(sand) * 0.7;

      // --- grass: the remainder, lusher where it is wet and near rivers ---
      let grass = Math.max(0, 1 - rock - snow - sand);
      grass *= lerp(0.55, 1, moisture);
      grass += clamp01(river * 2 - river * river * 2) * 0.25;
      // Nothing grows underwater or above the permanent snow line.
      grass *= 1 - smoothstep(params.snowLine + 20, params.snowLine + 90, h);
      grass *= smoothstep(-0.5, 1.5, h);

      let sum = grass + rock + snow + sand;
      if (sum < 1e-5) {
        grass = 1;
        rock = 0;
        snow = 0;
        sand = 0;
        sum = 1;
      }
      const inv = 1 / sum;
      const o = i * 4;
      biomes[o] = grass * inv;
      biomes[o + 1] = rock * inv;
      biomes[o + 2] = snow * inv;
      biomes[o + 3] = sand * inv;

      // Never emit exactly (0,0,0,1) — see MIN_NON_SAND_WEIGHT.
      if (biomes[o] + biomes[o + 1] + biomes[o + 2] < MIN_NON_SAND_WEIGHT) {
        biomes[o] = MIN_NON_SAND_WEIGHT;
        biomes[o + 1] = 0;
        biomes[o + 2] = 0;
        biomes[o + 3] = 1 - MIN_NON_SAND_WEIGHT;
      }

      if (biomes[o + 2] > biomes[o] && biomes[o + 2] > biomes[o + 1] && biomes[o + 2] > biomes[o + 3]) {
        snowDominant++;
      }
    }
  }

  return snowDominant / (res * res);
}

/** `performance.now` is available in workers; fall back for safety in exotic hosts. */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
