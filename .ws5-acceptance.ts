/**
 * .ws5-acceptance.ts — WS5's placement acceptance test. Not part of the app bundle; excluded from
 * `tsconfig.json` (which only includes `src`), so it never affects `npm run typecheck` or the build.
 *
 * Contents: a synthetic terraced island with all four biomes, a sea and a snow line, plus thirteen
 * assertions over `src/world/scatter.ts` — determinism, biome/slope/altitude gating, areal density
 * against `PERF.grassPerChunk`, ground adhesion, and per-cell generation cost.
 *
 * Purpose: the placement half of WS5 is pure and terrain-independent, so it can be verified far more
 * precisely on a synthetic world than by looking at the game. The terraces are deliberately flat and
 * single-biome: on sloped ground the `(1 - slope)` term legitimately suppresses grass, so only a
 * flat world can prove the density budget is actually being hit.
 *
 * Run:
 *   npx rolldown ./.ws5-acceptance.ts --platform node --format esm -o /tmp/ws5.mjs && node /tmp/ws5.mjs
 * (rolldown ships with Vite; the leading `./` is required for a dot-prefixed entry to resolve.)
 */

import { PERF, VEGETATION, WORLD } from './src/config/world.config';
import type { BiomeWeights, IWorld, WorldData } from './src/core/types';
import {
  CHUNK_SIZE,
  DRIFTWOOD_RULES,
  GRASS_RULES,
  ROCK_RULES,
  SCATTER,
  generateScatterCell,
} from './src/world/scatter';

// --- a synthetic island: a cone rising to 320 m, sand ring at the shore -----
class TestWorld implements IWorld {
  readonly data: WorldData = {
    seed: 1337,
    size: WORLD.size,
    resolution: WORLD.resolution,
    heights: new Float32Array(0),
    biomes: new Float32Array(0),
    rivers: [],
    seaLevel: WORLD.seaLevel,
  };

  /**
   * Concentric terraces so each test zone is dead flat and single-biome, which is what makes the
   * density assertion meaningful: on sloped ground the (1 - slope) term legitimately suppresses
   * grass, so a sloped world can never reach the PERF budget.
   *   r <   300 : snow plateau at 280 m
   *   r <   600 : rock shelf at 160 m
   *   r <   850 : grass meadow at 40 m
   *   r <  1000 : sand beach at 1.5 m
   */
  sampleHeight(x: number, z: number): number {
    const r = Math.hypot(x, z);
    if (r < 300) return 280;
    if (r < 600) return 160;
    if (r < 850) return 40;
    if (r < 1000) return 1.5;
    return -6;
  }

  sampleNormal(): never {
    throw new Error('unused');
  }

  sampleSlope(x: number, z: number): number {
    const e = 0.5;
    const dx = (this.sampleHeight(x + e, z) - this.sampleHeight(x - e, z)) / (2 * e);
    const dz = (this.sampleHeight(x, z + e) - this.sampleHeight(x, z - e)) / (2 * e);
    return Math.atan(Math.hypot(dx, dz));
  }

  sampleBiome(x: number, z: number): BiomeWeights {
    const y = this.sampleHeight(x, z);
    if (y > WORLD.snowLine) return [0, 0.3, 0.7, 0];
    if (y > 120) return [0.1, 0.9, 0, 0];
    if (y < 4) return [0.15, 0, 0, 0.85];
    return [1, 0, 0, 0];
  }

  findSpawnPoint(): never {
    throw new Error('unused');
  }
}

const world = new TestWorld();
let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

// Cells chosen to sit wholly inside one terrace, so each assertion isolates one variable.
const MEADOW_GRASS_CELL = [10, 0] as const; // cellSize 64 → x 640..704, all grass, flat
const ROCK_SHELF_CELL = [3, 0] as const; // cellSize 128 → x 384..512, all rock, flat
const MEADOW_ROCK_CELL = [5, 0] as const; // cellSize 128 → x 640..768, all grass, flat

// --- 1. determinism ---------------------------------------------------------
const a = generateScatterCell(world, GRASS_RULES, ...MEADOW_GRASS_CELL, 1337);
const b = generateScatterCell(world, GRASS_RULES, ...MEADOW_GRASS_CELL, 1337);
check(
  'grass cell is deterministic',
  a.count === b.count && a.data.every((v, i) => v === b.data[i]),
  `${a.count} instances, identical buffers`,
);

const c = generateScatterCell(world, GRASS_RULES, ...MEADOW_GRASS_CELL, 9001);
check(
  'a different world seed relays the cell',
  a.count > 0 && (c.count !== a.count || !c.data.every((v, i) => v === a.data[i])),
);

// --- 2. grass constraints ---------------------------------------------------
let grassTotal = 0;
let aboveSnow = 0;
let belowSea = 0;
let tooSteep = 0;
let sampled = 0;
for (let cx = -14; cx <= 14; cx += 1) {
  for (let cz = -14; cz <= 14; cz += 3) {
    const cell = generateScatterCell(world, GRASS_RULES, cx, cz, 1337);
    grassTotal += cell.count;
    sampled++;
    for (let i = 0, o = 0; i < cell.count; i++, o += SCATTER.STRIDE) {
      const x = cell.data[o + SCATTER.X];
      const z = cell.data[o + SCATTER.Z];
      const y = world.sampleHeight(x, z);
      if (y > WORLD.snowLine) aboveSnow++;
      if (y < WORLD.seaLevel - VEGETATION.grass.shoreFade) belowSea++;
      if (world.sampleSlope(x, z) > (VEGETATION.grass.maxSlopeDeg * Math.PI) / 180) tooSteep++;
    }
  }
}
check('no grass above the snow line', aboveSnow === 0, `${aboveSnow} violations of ${grassTotal}`);
check('no grass under water', belowSea === 0, `${belowSea} violations`);
check('no grass on ground steeper than the cap', tooSteep === 0, `${tooSteep} violations`);
check('grass is actually placed', grassTotal > 0, `${grassTotal} across ${sampled} cells`);

// --- 3. areal density matches the PERF budget -------------------------------
const perChunkGrass = (a.count / (GRASS_RULES.cellSize * GRASS_RULES.cellSize)) * CHUNK_SIZE * CHUNK_SIZE;
check(
  'peak grass density meets PERF.grassPerChunk',
  perChunkGrass >= PERF.grassPerChunk * 0.92,
  `${perChunkGrass.toFixed(0)} per 128 m chunk vs budget ${PERF.grassPerChunk}`,
);

// --- 4. rocks are biome-aware ----------------------------------------------
const rockOnShelf = generateScatterCell(world, ROCK_RULES, ...ROCK_SHELF_CELL, 1337).count;
const rockInMeadow = generateScatterCell(world, ROCK_RULES, ...MEADOW_ROCK_CELL, 1337).count;
check(
  'rocks favour the rock biome over grassland',
  rockOnShelf > rockInMeadow * 5,
  `${rockOnShelf} on the rock shelf vs ${rockInMeadow} in the meadow (same slope, same area)`,
);
check('rocks still appear in grassland', rockInMeadow > 0, `${rockInMeadow} boulders`);

// --- 5. driftwood is shoreline-only -----------------------------------------
let woodTotal = 0;
let woodInland = 0;
for (let cx = -8; cx <= 8; cx++) {
  for (let cz = -8; cz <= 8; cz++) {
    const cell = generateScatterCell(world, DRIFTWOOD_RULES, cx, cz, 1337);
    woodTotal += cell.count;
    for (let i = 0, o = 0; i < cell.count; i++, o += SCATTER.STRIDE) {
      const y = world.sampleHeight(cell.data[o + SCATTER.X], cell.data[o + SCATTER.Z]);
      if (y > WORLD.seaLevel + VEGETATION.driftwood.shoreBand) woodInland++;
    }
  }
}
check('driftwood placed', woodTotal > 0, `${woodTotal} logs`);
check('driftwood never strays inland', woodInland === 0, `${woodInland} violations`);

// --- 6. instances sit on the ground ----------------------------------------
let floating = 0;
for (let i = 0, o = 0; i < a.count; i++, o += SCATTER.STRIDE) {
  const ground = world.sampleHeight(a.data[o + SCATTER.X], a.data[o + SCATTER.Z]);
  const dy = a.data[o + SCATTER.Y] - ground;
  if (dy > 1e-4 || dy < -0.4) floating++;
}
check('grass sits on (or just under) the ground', floating === 0, `${floating} of ${a.count}`);

// --- 7. cost ----------------------------------------------------------------
const t0 = performance.now();
const reps = 60;
for (let i = 0; i < reps; i++) {
  generateScatterCell(world, GRASS_RULES, MEADOW_GRASS_CELL[0], -30 + i, 1337);
}
const perCell = (performance.now() - t0) / reps;
check(
  'grass cell generation fits the per-frame budget',
  perCell < VEGETATION.cellBudgetMs * 3,
  `${perCell.toFixed(2)} ms/cell (budget ${VEGETATION.cellBudgetMs} ms/frame)`,
);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
