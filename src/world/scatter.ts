/**
 * src/world/scatter.ts
 *
 * Contents: the deterministic *placement* half of WS5. Defines the packed per-instance record
 * layout (`SCATTER`), the biome / slope / altitude density rules for each scatter kind
 * (`GRASS_RULES`, `ROCK_RULES`, `DRIFTWOOD_RULES`), and `generateScatterCell()` — which turns a
 * cell coordinate into a `Float32Array` of instance transforms by stratified-jitter sampling the
 * `IWorld` height / slope / biome samplers.
 *
 * Purpose: WS5 owns two separable concerns — *where* things go (this file) and *how* they are drawn
 * (`src/render/VegetationSystem.ts`). Keeping placement here makes it pure, free of three.js scene
 * state, and dependent only on the `IWorld` sampling contract, so it runs against WS0's flat
 * `StubWorld` today, against WS1's real island tomorrow, and could be moved into a Web Worker later
 * without touching a line of renderer code.
 *
 * Determinism (PLAN.md / WS0_STATUS §Determinism): every cell is seeded from
 * `hash2(cx, cz) ^ worldSeed ^ rules.salt`, never `Math.random()`. A cell therefore produces the
 * identical layout no matter when — or how many times — it is generated, which is what makes
 * "repopulate when the player crosses a boundary" invisible.
 *
 * Complexity: `generateScatterCell` is O(candidatesPerCell) time — one jittered sample per stratum,
 * each costing at most one `sampleHeight` + one `sampleSlope` + one `sampleBiome`. Space is
 * O(accepted) for the returned buffer plus one module-level scratch buffer that is reused across
 * calls, so steady-state generation allocates exactly one `Float32Array` per cell.
 */

import { VEGETATION, WORLD } from "../config/world.config";
import type { BiomeWeights, IWorld } from "../core/types";
import { pointInLandmarkFootprint } from "../landmarks/isfahanStamp";
import {
  TAU,
  clamp01,
  degToRad,
  hash2,
  mulberry32,
  smoothstep,
} from "../utils/math";

// ---------------------------------------------------------------------------
// Packed instance record
// ---------------------------------------------------------------------------

/**
 * Field offsets into a cell's packed instance buffer.
 *
 * One record is 8 floats rather than a 16-float matrix: every scattered prop is a Y-rotation plus a
 * (uniform-XZ, independent-Y) scale, which the renderer can expand into a `Matrix4` with 16 plain
 * stores and zero trigonometry. `cos`/`sin` are baked here so the per-frame repack never calls
 * `Math.cos`.
 */
export const SCATTER = {
  X: 0,
  Y: 1,
  Z: 2,
  /** Scale applied to local X and Z. */
  SCALE_XZ: 3,
  /** Scale applied to local Y. */
  SCALE_Y: 4,
  COS: 5,
  SIN: 6,
  /** Index of the geometry variant this instance uses, 0 .. rules.variants - 1. */
  VARIANT: 7,
  STRIDE: 8,
} as const;

/** One generated cell of scatter, ready to be repacked into an `InstancedMesh`. */
export interface ScatterCell {
  readonly cx: number;
  readonly cz: number;
  /** Exactly `count * SCATTER.STRIDE` floats — no slack. */
  readonly data: Float32Array;
  readonly count: number;
}

/**
 * Everything `generateScatterCell` needs to know about one kind of prop. Pure data plus a density
 * function, so adding a new scatter kind never touches the generator.
 */
export interface ScatterRules {
  readonly id: string;
  /** Mixed into the per-cell seed so two kinds never share a placement pattern. */
  readonly salt: number;
  /** Metres per side of a generation cell. Smaller = cheaper, more incremental generation. */
  readonly cellSize: number;
  /** Candidate points evaluated per cell, before density rejection. */
  readonly candidatesPerCell: number;
  readonly minScale: number;
  readonly maxScale: number;
  /** Vertical stretch multiplier applied on top of `scale`, for squat/tall variation. */
  readonly minStretch: number;
  readonly maxStretch: number;
  readonly variants: number;
  /** Fraction of the instance's height pushed below the ground so nothing floats on a slope. */
  readonly sink: number;
  /** Hard reject below `WORLD.seaLevel + minAboveSea` (metres, may be negative). */
  readonly minAboveSea: number;
  /** Hard reject above this absolute world Y. */
  readonly maxY: number;
  /** Hard reject on ground steeper than this (radians). */
  readonly maxSlope: number;
  /** Supremum of `density()`. Used to size instance buffers up front — must never be exceeded. */
  readonly maxDensity: number;
  /** Acceptance probability in 0..`maxDensity` for a candidate at this sample. */
  density(biome: BiomeWeights, slope: number, y: number): number;
}

// ---------------------------------------------------------------------------
// Cell addressing
// ---------------------------------------------------------------------------

/** Terrain chunk edge length in metres — the unit `PERF.grassPerChunk` is quoted in. */
export const CHUNK_SIZE = WORLD.size / WORLD.chunkGrid;

/**
 * Restate a per-terrain-chunk budget as a per-cell candidate count, preserving areal density.
 * Lets WS8 tune `PERF.grassPerChunk` without anyone having to re-derive cell numbers.
 */
function candidatesFor(perChunk: number, cellSize: number): number {
  const ratio = cellSize / CHUNK_SIZE;
  return Math.max(1, Math.round(perChunk * ratio * ratio));
}

/**
 * Collapse a signed cell coordinate pair into a single integer usable as a `Map` key.
 * Valid for |c| < 32768 cells, i.e. ±2 million metres at the smallest cell size — the island is
 * 2 km across, so this has four orders of magnitude of headroom.
 */
export function cellKey(cx: number, cz: number): number {
  return ((cx + 0x8000) << 16) | ((cz + 0x8000) & 0xffff);
}

// ---------------------------------------------------------------------------
// Density rules
// ---------------------------------------------------------------------------

const GRASS = VEGETATION.grass;
const ROCKS = VEGETATION.rocks;
const WOOD = VEGETATION.driftwood;

const GRASS_MAX_SLOPE = degToRad(GRASS.maxSlopeDeg);
const ROCK_MAX_SLOPE = degToRad(ROCKS.maxSlopeDeg);
const WOOD_MAX_SLOPE = degToRad(WOOD.maxSlopeDeg);

/** 1 at and above the waterline, ramping to 0 just below it. Keeps grass off the seabed. */
function shoreline(y: number): number {
  return smoothstep(WORLD.seaLevel - GRASS.shoreFade, WORLD.seaLevel, y);
}

/**
 * Grass: PLAN.md's rule verbatim — `sampleBiome().grass × (1 - slope)`, gated off above the snow
 * line and below the waterline.
 */
export const GRASS_RULES: ScatterRules = {
  id: "grass",
  salt: 0x51ed270b,
  cellSize: GRASS.cellSize,
  candidatesPerCell: candidatesFor(GRASS.perChunk, GRASS.cellSize),
  minScale: GRASS.minScale,
  maxScale: GRASS.maxScale,
  minStretch: GRASS.minStretch,
  maxStretch: GRASS.maxStretch,
  variants: 1,
  sink: GRASS.sink,
  minAboveSea: -GRASS.shoreFade,
  maxY: WORLD.snowLine,
  maxSlope: GRASS_MAX_SLOPE,
  maxDensity: GRASS.densityScale,
  density(biome, slope, y) {
    const grass = biome[0];
    if (grass <= 0.02) return 0;
    const slopeFactor = 1 - clamp01(slope / GRASS_MAX_SLOPE);
    const snowFactor =
      1 - smoothstep(WORLD.snowLine - GRASS.snowFade, WORLD.snowLine, y);
    return (
      clamp01(grass * slopeFactor * snowFactor * shoreline(y)) *
      GRASS.densityScale
    );
  },
};

/**
 * Rocks: biased to the rock and snow biomes, but with a deliberate non-zero grassland term so
 * boulders still break up the meadows (and so something visible scatters against WS0's all-grass
 * `StubWorld`). Slope reduces but never eliminates them — scree belongs on hillsides.
 */
export const ROCK_RULES: ScatterRules = {
  id: "rocks",
  salt: 0x2c1b3f97,
  cellSize: ROCKS.cellSize,
  candidatesPerCell: candidatesFor(ROCKS.perChunk, ROCKS.cellSize),
  minScale: ROCKS.minScale,
  maxScale: ROCKS.maxScale,
  minStretch: ROCKS.minStretch,
  maxStretch: ROCKS.maxStretch,
  variants: ROCKS.variants,
  sink: ROCKS.sink,
  minAboveSea: -3,
  maxY: WORLD.maxHeight,
  maxSlope: ROCK_MAX_SLOPE,
  maxDensity: ROCKS.densityScale,
  density(biome, slope) {
    // Biome weights sum to 1 and every affinity is <= 1, so `affinity` can never exceed 1 — which
    // is what lets `maxDensity` be a hard bound for buffer sizing.
    const affinity =
      biome[1] * ROCKS.weightRock +
      biome[2] * ROCKS.weightSnow +
      biome[3] * ROCKS.weightSand +
      biome[0] * ROCKS.weightGrass;
    const slopeFactor = 1 - 0.55 * clamp01(slope / ROCK_MAX_SLOPE);
    return clamp01(affinity * slopeFactor) * ROCKS.densityScale;
  },
};

/** Driftwood: sand biome, flat ground, only in the shoreline band above the waterline. */
export const DRIFTWOOD_RULES: ScatterRules = {
  id: "driftwood",
  salt: 0x7ae3d105,
  cellSize: WOOD.cellSize,
  candidatesPerCell: candidatesFor(WOOD.perChunk, WOOD.cellSize),
  minScale: WOOD.minScale,
  maxScale: WOOD.maxScale,
  minStretch: WOOD.minStretch,
  maxStretch: WOOD.maxStretch,
  variants: WOOD.variants,
  sink: WOOD.sink,
  minAboveSea: -0.4,
  maxY: WORLD.seaLevel + WOOD.shoreBand,
  maxSlope: WOOD_MAX_SLOPE,
  maxDensity: WOOD.weightSand * WOOD.densityScale,
  density(biome, slope, y) {
    const affinity = biome[3] * WOOD.weightSand + biome[0] * WOOD.weightGrass;
    if (affinity <= 0.001) return 0;
    const band =
      1 - smoothstep(WORLD.seaLevel + 1, WORLD.seaLevel + WOOD.shoreBand, y);
    const slopeFactor = 1 - clamp01(slope / WOOD_MAX_SLOPE);
    return clamp01(affinity * band * slopeFactor) * WOOD.densityScale;
  },
};

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Reused across calls so steady-state generation allocates only the exact-size output buffer.
 * `generateScatterCell` is not reentrant, which is fine — it is only ever called from the frame
 * loop, one cell at a time.
 */
let scratch = new Float32Array(0);

const EMPTY = new Float32Array(0);

/**
 * Place one cell's worth of props.
 *
 * Candidates are drawn on a jittered regular grid (stratified sampling) rather than uniformly at
 * random: for the same count it gives a far more even, blue-noise-like spread with no clumping and
 * no gaps, at the same O(n) cost — a Poisson-disc pass would cost several times more for a
 * difference nobody can see through 0.6 m of grass.
 *
 * @param world  height / slope / biome sampler. Only the `IWorld` contract is used, so a stub works.
 * @param rules  the scatter kind to place.
 * @param cx     cell X index (world X spans `[cx * cellSize, (cx + 1) * cellSize)`).
 * @param cz     cell Z index.
 * @param worldSeed `WorldData.seed`, so different islands scatter differently.
 * @returns a cell whose `data` holds exactly `count * SCATTER.STRIDE` floats.
 *
 * @complexity Time O(rules.candidatesPerCell); space O(accepted).
 */
export function generateScatterCell(
  world: IWorld,
  rules: ScatterRules,
  cx: number,
  cz: number,
  worldSeed: number,
): ScatterCell {
  const size = rules.cellSize;
  const originX = cx * size;
  const originZ = cz * size;
  const rng = mulberry32((hash2(cx, cz) ^ worldSeed ^ rules.salt) >>> 0);

  const side = Math.max(1, Math.ceil(Math.sqrt(rules.candidatesPerCell)));
  const step = size / side;

  const need = side * side * SCATTER.STRIDE;
  if (scratch.length < need) scratch = new Float32Array(need);
  const out = scratch;

  const minY = WORLD.seaLevel + rules.minAboveSea;
  const scaleSpan = rules.maxScale - rules.minScale;
  const stretchSpan = rules.maxStretch - rules.minStretch;

  let n = 0;
  for (let iz = 0; iz < side; iz++) {
    for (let ix = 0; ix < side; ix++) {
      const x = originX + (ix + rng()) * step;
      const z = originZ + (iz + rng()) * step;
      const roll = rng();

      // Cheapest tests first: a height lookup rejects everything underwater or above the snow line
      // before we pay for a slope gradient or a biome tuple allocation.
      const groundY = world.sampleHeight(x, z);
      if (groundY < minY || groundY > rules.maxY) continue;
      if (pointInLandmarkFootprint(world.data, x, z)) continue;

      const slope = world.sampleSlope(x, z);
      if (slope > rules.maxSlope) continue;

      if (roll >= rules.density(world.sampleBiome(x, z), slope, groundY))
        continue;

      const angle = rng() * TAU;
      const scale = rules.minScale + rng() * scaleSpan;
      const scaleY = scale * (rules.minStretch + rng() * stretchSpan);
      const variant =
        rules.variants > 1
          ? Math.min(rules.variants - 1, (rng() * rules.variants) | 0)
          : 0;

      const o = n * SCATTER.STRIDE;
      out[o + SCATTER.X] = x;
      out[o + SCATTER.Y] = groundY - rules.sink * scaleY;
      out[o + SCATTER.Z] = z;
      out[o + SCATTER.SCALE_XZ] = scale;
      out[o + SCATTER.SCALE_Y] = scaleY;
      out[o + SCATTER.COS] = Math.cos(angle);
      out[o + SCATTER.SIN] = Math.sin(angle);
      out[o + SCATTER.VARIANT] = variant;
      n++;
    }
  }

  return {
    cx,
    cz,
    data: n === 0 ? EMPTY : out.slice(0, n * SCATTER.STRIDE),
    count: n,
  };
}

/**
 * Instances per square metre this kind places at full density. Used to size instance buffers
 * before a single cell has been generated.
 */
export function arealDensity(rules: ScatterRules): number {
  return rules.candidatesPerCell / (rules.cellSize * rules.cellSize);
}
