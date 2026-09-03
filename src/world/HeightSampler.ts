/**
 * src/world/HeightSampler.ts
 *
 * Contents: `HeightSampler`, the concrete `IWorld` implementation. Every query about the shape of
 * the world — height, normal, slope, biome, river influence, spawn points — resolves here against
 * the `WorldData` arrays and nothing else.
 *
 * Purpose: PLAN.md calls this "THE single source of truth", and Risk #1 in the plan is visual /
 * physics drift. The defence is that the rendered chunk meshes, the Rapier heightfield (WS2) and
 * this sampler all read the *same* `Float32Array` with the *same* indexing and — critically — the
 * *same triangulation*.
 *
 * ── Why triangle interpolation, not bilinear ────────────────────────────────
 * The contract in `types.ts` describes `sampleHeight` as "bilinear-interpolated". A bilinear patch
 * is a curved surface; the rendered mesh and the Rapier heightfield are flat triangles. Inside a
 * 4 m cell the two disagree by `|hA + hD − hB − hC| / 4`, which in the mountains is easily a metre
 * — the player would visibly hover or sink. So `sampleHeight` interpolates over the **same two
 * triangles the mesh is built from** (diagonal from `(x+1, z)` to `(x, z+1)`), making it exact
 * against rendered geometry rather than approximately right. `sampleHeightBilinear` is kept for the
 * cases that genuinely want a smooth field (normals, slope, gentle camera collision).
 */

import * as THREE from 'three';
import { clamp, clamp01, RAD2DEG } from '../utils/math';
import type { BiomeWeights, IWorld, Rng, WorldData } from '../core/types';

/** Spawn search: how many candidate points to test before settling for the best so far. */
const SPAWN_ATTEMPTS = 900;
/** Spawns stay inside this fraction of the island radius, so you never start in the surf. */
const SPAWN_MAX_RADIUS_FRAC = 0.6;
/** Spawn must be walkable: below this slope, in this height band, away from river beds. */
const SPAWN_MAX_SLOPE_DEG = 22;
const SPAWN_MIN_HEIGHT = 2.5;
const SPAWN_MAX_HEIGHT = 80;
const SPAWN_MAX_RIVER = 0.2;

export class HeightSampler implements IWorld {
  /** Metres between adjacent heightmap samples. */
  readonly cellSize: number;
  /** Half the island size — world coordinates run `[-half, +half]` on both axes. */
  private readonly half: number;
  private readonly res: number;
  private readonly maxIndex: number;

  private readonly scratchBiome: BiomeWeights = [1, 0, 0, 0];

  constructor(readonly data: WorldData) {
    this.res = data.resolution;
    this.cellSize = data.size / (data.resolution - 1);
    this.half = data.size * 0.5;
    this.maxIndex = data.resolution - 2;
  }

  /**
   * Height of the rendered/collidable surface at a world-space point.
   *
   * @param x - World X in metres, clamped to the island bounds.
   * @param z - World Z in metres, clamped to the island bounds.
   * @returns Height in metres. Outside the island the edge value is extended (the terrain is already
   *          well below sea level there, so this is invisible).
   *
   * @complexity Time: O(1) — 4 array reads | Space: O(1)
   *
   * @example
   * world.sampleHeight(0, 0);        // height at the island centre
   * world.sampleHeight(-1e9, 0);     // clamped, returns the western edge height
   */
  sampleHeight(x: number, z: number): number {
    const res = this.res;
    const gx = (x + this.half) / this.cellSize;
    const gz = (z + this.half) / this.cellSize;
    const x0 = clamp(Math.floor(gx), 0, this.maxIndex);
    const z0 = clamp(Math.floor(gz), 0, this.maxIndex);
    const u = clamp01(gx - x0);
    const v = clamp01(gz - z0);

    const h = this.data.heights;
    const i = z0 * res + x0;
    const hA = h[i]; // (x0,   z0  )
    const hB = h[i + 1]; // (x0+1, z0  )
    const hC = h[i + res]; // (x0,   z0+1)
    const hD = h[i + res + 1]; // (x0+1, z0+1)

    // Mesh triangulation is (A, C, B) + (B, C, D), i.e. the diagonal runs B–C. `u + v <= 1` is the
    // first triangle; both branches agree exactly on the shared diagonal, so the field is C0.
    return u + v <= 1
      ? hA + u * (hB - hA) + v * (hC - hA)
      : hD + (1 - u) * (hC - hD) + (1 - v) * (hB - hD);
  }

  /**
   * Smooth (bilinear) height. Differs from `sampleHeight` inside a cell by up to a metre in steep
   * terrain — use it for gradients and anything that wants continuity, never for ground contact.
   *
   * @complexity Time: O(1) | Space: O(1)
   */
  sampleHeightBilinear(x: number, z: number): number {
    const res = this.res;
    const gx = (x + this.half) / this.cellSize;
    const gz = (z + this.half) / this.cellSize;
    const x0 = clamp(Math.floor(gx), 0, this.maxIndex);
    const z0 = clamp(Math.floor(gz), 0, this.maxIndex);
    const u = clamp01(gx - x0);
    const v = clamp01(gz - z0);

    const h = this.data.heights;
    const i = z0 * res + x0;
    const top = h[i] + (h[i + 1] - h[i]) * u;
    const bottom = h[i + res] + (h[i + res + 1] - h[i + res]) * u;
    return top + (bottom - top) * v;
  }

  /**
   * Surface normal from central differences of the smooth field, spaced one cell apart — the same
   * formula `TerrainChunk` bakes into its vertex normals, so shading and gameplay agree.
   *
   * @param out - Optional target, to avoid allocating in a hot loop.
   * @complexity Time: O(1) — 16 array reads | Space: O(1)
   */
  sampleNormal(x: number, z: number, out?: THREE.Vector3): THREE.Vector3 {
    const c = this.cellSize;
    const dhdx = (this.sampleHeightBilinear(x + c, z) - this.sampleHeightBilinear(x - c, z)) / (2 * c);
    const dhdz = (this.sampleHeightBilinear(x, z + c) - this.sampleHeightBilinear(x, z - c)) / (2 * c);
    return (out ?? new THREE.Vector3()).set(-dhdx, 1, -dhdz).normalize();
  }

  /**
   * Slope in radians, 0 = flat.
   *
   * @complexity Time: O(1) | Space: O(1)
   */
  sampleSlope(x: number, z: number): number {
    const c = this.cellSize;
    const dhdx = (this.sampleHeightBilinear(x + c, z) - this.sampleHeightBilinear(x - c, z)) / (2 * c);
    const dhdz = (this.sampleHeightBilinear(x, z + c) - this.sampleHeightBilinear(x, z - c)) / (2 * c);
    return Math.atan(Math.hypot(dhdx, dhdz));
  }

  /**
   * Bilinearly interpolated biome weights, renormalised so the four components sum to exactly 1.
   *
   * ⚠ Returns a shared, reused array. Copy it if you need to keep it (`[...world.sampleBiome(x,z)]`).
   * @complexity Time: O(1) — 16 array reads | Space: O(1)
   */
  sampleBiome(x: number, z: number): BiomeWeights {
    const res = this.res;
    const gx = (x + this.half) / this.cellSize;
    const gz = (z + this.half) / this.cellSize;
    const x0 = clamp(Math.floor(gx), 0, this.maxIndex);
    const z0 = clamp(Math.floor(gz), 0, this.maxIndex);
    const u = clamp01(gx - x0);
    const v = clamp01(gz - z0);

    const b = this.data.biomes;
    const iA = (z0 * res + x0) * 4;
    const iB = iA + 4;
    const iC = ((z0 + 1) * res + x0) * 4;
    const iD = iC + 4;

    const out = this.scratchBiome;
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const top = b[iA + k] + (b[iB + k] - b[iA + k]) * u;
      const bottom = b[iC + k] + (b[iD + k] - b[iC + k]) * u;
      const value = top + (bottom - top) * v;
      out[k] = value;
      sum += value;
    }
    if (sum > 1e-6) {
      const inv = 1 / sum;
      out[0] *= inv;
      out[1] *= inv;
      out[2] *= inv;
      out[3] *= inv;
    } else {
      out[0] = 1;
      out[1] = 0;
      out[2] = 0;
      out[3] = 0;
    }
    return out;
  }

  /**
   * WS1 addition: 0 = dry land, 1 = the centre of a river bed. WS4 can drive wetness/foam from it
   * and WS5 can refuse to plant grass in the channel.
   *
   * @complexity Time: O(1) | Space: O(1)
   */
  sampleRiverInfluence(x: number, z: number): number {
    const mask = this.data.riverMask;
    if (!mask) return 0;
    const res = this.res;
    const gx = (x + this.half) / this.cellSize;
    const gz = (z + this.half) / this.cellSize;
    const x0 = clamp(Math.floor(gx), 0, this.maxIndex);
    const z0 = clamp(Math.floor(gz), 0, this.maxIndex);
    const u = clamp01(gx - x0);
    const v = clamp01(gz - z0);
    const i = z0 * res + x0;
    const top = mask[i] + (mask[i + 1] - mask[i]) * u;
    const bottom = mask[i + res] + (mask[i + res + 1] - mask[i + res]) * u;
    return top + (bottom - top) * v;
  }

  /**
   * Rejection-samples a walkable spawn: dry land in the low-altitude grass band, gentle slope, out
   * of the river beds, and biased toward grass-dominant ground. Deterministic for a given `rng`.
   *
   * @param rng - Seeded 0..1 source. Never pass `Math.random` (PLAN.md determinism rule).
   * @returns A world-space point whose `y` is the terrain height (callers add their own eye/foot offset).
   *
   * @complexity Time: O(SPAWN_ATTEMPTS) with O(1) work each; returns early on the first great
   * candidate. Space: O(1)
   */
  findSpawnPoint(rng: Rng): THREE.Vector3 {
    const maxRadius = this.half * SPAWN_MAX_RADIUS_FRAC;
    const maxSlope = SPAWN_MAX_SLOPE_DEG / RAD2DEG;

    let bestX = 0;
    let bestZ = 0;
    let bestHeight = this.sampleHeight(0, 0);
    let bestScore = -Infinity;

    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      // sqrt() keeps the sampling uniform over the disc rather than clustered at the centre.
      const r = Math.sqrt(rng()) * maxRadius;
      const a = rng() * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;

      const h = this.sampleHeight(x, z);
      if (h < this.data.seaLevel + SPAWN_MIN_HEIGHT || h > SPAWN_MAX_HEIGHT) continue;
      const slope = this.sampleSlope(x, z);
      if (slope > maxSlope) continue;
      if (this.sampleRiverInfluence(x, z) > SPAWN_MAX_RIVER) continue;

      const biome = this.sampleBiome(x, z);
      const score = biome[0] * 2 - slope * 3;
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestZ = z;
        bestHeight = h;
        // Flat, thoroughly grassy ground — no point looking further.
        if (biome[0] > 0.85 && slope < 0.12) break;
      }
    }

    return new THREE.Vector3(bestX, bestHeight, bestZ);
  }

  /** World-space bounds helper: true when the point is inside the island footprint. */
  contains(x: number, z: number): boolean {
    return x >= -this.half && x <= this.half && z >= -this.half && z <= this.half;
  }
}
