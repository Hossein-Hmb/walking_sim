/**
 * src/physics/Heightfield.ts
 *
 * Contents: everything to do with turning a `WorldData.heights` array into a Rapier heightfield
 * collider — the index-order translation (`packHeightsForRapier`), the collider descriptor factory
 * (`createHeightfieldDesc`), and two self-tests that prove the translation is right
 * (`probeHeightfieldConvention`, `verifySamplerAgreement`).
 *
 * Purpose: PLAN.md §Risks 1 names physics/visual terrain drift as the #1 bug source in this project,
 * because Rapier's heightfield indexing does not match the row-major `[z * res + x]` layout WS1
 * produces. Getting it wrong is nearly invisible (the terrain looks fine, the player floats or sinks
 * in a way that reads as "physics is janky"). All of that knowledge is isolated in this one file.
 *
 * ── RAPIER 0.19.3 HEIGHTFIELD CONVENTION (measured, not guessed) ─────────────────────────────────
 * Verified by raycasting against synthetic asymmetric fields in Node against the *installed*
 * package. `probeHeightfieldConvention()` below re-runs the same measurement at runtime.
 *
 *   1. `nrows` / `ncols` are the number of QUADS (subdivisions), NOT the number of vertices.
 *      `heights.length` must be exactly `(nrows + 1) * (ncols + 1)`.
 *      Passing vertex counts panics the WASM module with an opaque `RuntimeError: unreachable`.
 *      (The bundled JSDoc says "number of rows in the heights matrix", which is misleading.)
 *
 *   2. The height matrix is COLUMN-MAJOR over `(nrows + 1) × (ncols + 1)` vertices:
 *          heights[i + j * (nrows + 1)]        i = row index, j = column index
 *
 *   3. Row index `i` maps to +Z. Column index `j` maps to +X. Neither axis is flipped.
 *      => Rapier index = `zi + xi * (nrows + 1)`, WS1 index = `zi * resolution + xi`.
 *         With `nrows + 1 == resolution` these are TRANSPOSES of one another.
 *
 *   4. The field is centred on the collider's translation and spans
 *      `x ∈ [-scale.x/2, +scale.x/2]`, `z ∈ [-scale.z/2, +scale.z/2]`.
 *      Vertex (i, j) sits at `x = (-0.5 + j/ncols) * scale.x`, `z = (-0.5 + i/nrows) * scale.z`,
 *      `y = heights[i + j*(nrows+1)] * scale.y`. We use `scale.y = 1` so heights are metres.
 *
 *   5. There is NOTHING outside the field — a ray or a character that leaves the footprint simply
 *      finds no geometry. Callers must keep bodies inside (see `PHYSICS.boundsMargin`).
 *
 *   6. `heights` is COPIED into WASM memory. PLAN.md's "same array, no copy" anti-drift guarantee is
 *      not literally achievable; mutating `WorldData.heights` afterwards does nothing until the
 *      collider is rebuilt. `PhysicsSystem.addHeightfield` is that rebuild, and it is one call.
 *
 *   7. Ray/shape queries return nothing until `world.step()` has run at least once after a collider
 *      is added — the broad-phase acceleration structure is built during the step.
 *
 *   8. ⚠ BUG in 0.19.3: a raycast whose x or z falls in a sub-millimetre band on the NEGATIVE side
 *      of a cell boundary reports no hit at all, even though the surface is right there. Measured
 *      on a 4 m grid: `x = 0` hits, `x = +1e-9` hits, `x = -1e-9` … `x = -1e-6` all MISS,
 *      `x = -1e-3` hits again. Contact generation is unaffected — only ray queries.
 *      This is not the rare curiosity it looks like: the character controller's normal nudge parks
 *      the player at coordinates like `-8.98e-8`, so a character standing near a grid line (the
 *      world origin is one) reproduces it every single frame. `castRayRobust` below is the fix and
 *      every ray this workstream issues goes through it.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import { PHYSICS } from '../config/world.config';
import { mulberry32 } from '../utils/math';
import type { IPhysics, IWorld, WorldData } from '../core/types';

/**
 * Lateral offset used to dodge the cell-boundary raycast bug (convention note 8). 1 mm: far larger
 * than the dead band, far smaller than anything the game can perceive.
 */
const BOUNDARY_NUDGE = 1e-3;

/**
 * `castRayAndGetNormal` with a retry that works around Rapier 0.19.3's heightfield boundary bug.
 * Use this instead of calling Rapier's raycasts directly anywhere the terrain may be the target.
 *
 * @param world - The Rapier world.
 * @param ray - Origin and direction, already set. Restored before returning, so a shared, reused
 *   `Ray` instance is safe (and keeps this allocation-free on the hot path).
 * @param maxToi - Maximum distance, in units of `|dir|`.
 * @param excludeCollider - Collider to ignore, e.g. the caster's own capsule. Uses Rapier's native
 *   exclusion rather than a JS filter predicate — see the note in `CharacterBody.move`.
 * @returns The nearest hit, or null. A null here means there is genuinely nothing along the ray.
 *
 * @complexity Time: O(log n); O(2 log n) on a miss, since a genuine miss always pays for the retry.
 */
export function castRayRobust(
  world: RAPIER.World,
  ray: RAPIER.Ray,
  maxToi: number,
  excludeCollider?: RAPIER.Collider,
): RAPIER.RayColliderIntersection | null {
  const flags = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
  const first = world.castRayAndGetNormal(ray, maxToi, true, flags, undefined, excludeCollider);
  if (first) return first;

  // The dead band is only ever on the negative side of a boundary, so a positive nudge is always
  // a move into safe territory.
  const origin = ray.origin;
  ray.origin = { x: origin.x + BOUNDARY_NUDGE, y: origin.y, z: origin.z + BOUNDARY_NUDGE };
  const retry = world.castRayAndGetNormal(ray, maxToi, true, flags, undefined, excludeCollider);
  ray.origin = origin;
  return retry ?? null;
}

/** Machine-readable restatement of the conventions documented above. */
export const HEIGHTFIELD_CONVENTION = {
  /** `heights.length === (nrows + 1) * (ncols + 1)`; nrows/ncols count quads. */
  subdivisionsAreQuads: true,
  /** Linear index of vertex (row i, column j) in the array Rapier expects. */
  rapierIndex: (i: number, j: number, nrows: number): number => i + j * (nrows + 1),
  /** Linear index of vertex (grid x, grid z) in a `WorldData.heights` array. */
  worldIndex: (xi: number, zi: number, resolution: number): number => zi * resolution + xi,
  /** Row index tracks +Z, column index tracks +X. */
  rowAxis: 'z',
  columnAxis: 'x',
} as const;

/**
 * Transposes a WS1 row-major heightmap into the column-major matrix Rapier wants.
 *
 * @param heights - `resolution²` heights, `index = z * resolution + x` (WS1's contract).
 * @param resolution - Vertices per side (513 for this project).
 * @param out - Optional destination to avoid a 1 MB allocation on rebuild. Must be the right size.
 * @returns A `resolution²` array indexed `[zi + xi * resolution]`, ready for `ColliderDesc.heightfield`.
 *
 * @complexity Time: O(n) over `resolution²` | Space: O(n) for the output (O(1) auxiliary with `out`).
 *
 * @example
 * // 3x3 grid where height rises to the east only:
 * packHeightsForRapier(new Float32Array([0,1,2, 0,1,2, 0,1,2]), 3)
 * // → Float32Array [0,0,0, 1,1,1, 2,2,2]  (all of column j=1 is height 1, etc.)
 */
export function packHeightsForRapier(
  heights: Float32Array,
  resolution: number,
  out?: Float32Array,
): Float32Array {
  const cells = resolution * resolution;
  if (heights.length !== cells) {
    throw new Error(
      `[Heightfield] heights.length ${heights.length} != resolution² ${cells} (resolution ${resolution})`,
    );
  }
  const dst = out && out.length === cells ? out : new Float32Array(cells);
  // Column-major writes are sequential, which is the side worth keeping cache-friendly.
  for (let xi = 0; xi < resolution; xi++) {
    const dstBase = xi * resolution;
    for (let zi = 0; zi < resolution; zi++) {
      dst[dstBase + zi] = heights[zi * resolution + xi];
    }
  }
  return dst;
}

/**
 * Builds the collider descriptor for a whole terrain heightmap, centred on the world origin.
 *
 * @param data - The world the physics must agree with. Only `heights`, `resolution` and `size` are read.
 * @param packed - Optional pre-transposed array from `packHeightsForRapier` (reused across rebuilds).
 * @returns A descriptor for a static heightfield spanning `[-size/2, +size/2]` on X and Z.
 *
 * @complexity Time: O(resolution²) | Space: O(resolution²)
 */
export function createHeightfieldDesc(data: WorldData, packed?: Float32Array): RAPIER.ColliderDesc {
  const res = data.resolution;
  if (res < 2) throw new Error(`[Heightfield] resolution must be >= 2, got ${res}`);
  const heights = packed ?? packHeightsForRapier(data.heights, res);
  // nrows/ncols are QUAD counts. heights.length must be (nrows+1)*(ncols+1) = resolution².
  const subdivisions = res - 1;
  return RAPIER.ColliderDesc.heightfield(
    subdivisions,
    subdivisions,
    heights,
    // scale.y = 1 keeps `heights` in metres; x/z stretch the unit footprint to the island size.
    { x: data.size, y: 1, z: data.size },
    // Smooths contact normals across triangle seams — without it the character catches on flat ground.
    RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES,
  ).setFriction(PHYSICS.terrainFriction);
}

// ---------------------------------------------------------------------------
// Self-test 1 — synthetic probe. Catches a wrong transpose even on a FLAT world.
// ---------------------------------------------------------------------------

export interface VerificationResult {
  ok: boolean;
  /** Largest absolute disagreement, in metres. */
  maxError: number;
  /** Human-readable lines suitable for `console` output. */
  details: string[];
}

/**
 * Builds a throwaway Rapier world containing a heightfield whose height is a *linear* function of
 * both x and z with very different coefficients, then raycasts it and compares against the analytic
 * answer. A linear field is reproduced exactly by any triangulation, so any error above float noise
 * means the index order (or the scale, or the centring) is wrong.
 *
 * This is the test that matters while WS1 is still a flat stub: a flat heightmap is symmetric, so a
 * transposed collider looks perfect and the bug only surfaces once real terrain lands.
 *
 * @returns Pass/fail plus the largest disagreement in metres.
 * @complexity Time: O(1) — a 5×5 field and 6 raycasts. Runs in well under a millisecond.
 */
export function probeHeightfieldConvention(): VerificationResult {
  const resolution = 5;
  const size = 8; // 2 m cells, footprint x,z ∈ [-4, +4]
  const details: string[] = [];

  // height(xi, zi) = xi + 10 * zi  → linear in world space, and wildly asymmetric between the axes.
  const heights = new Float32Array(resolution * resolution);
  for (let zi = 0; zi < resolution; zi++) {
    for (let xi = 0; xi < resolution; xi++) heights[zi * resolution + xi] = xi + 10 * zi;
  }
  const cell = size / (resolution - 1);
  const expectedAt = (x: number, z: number): number =>
    (x + size / 2) / cell + 10 * ((z + size / 2) / cell);

  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  let maxError = 0;
  let ok = true;
  try {
    world.createCollider(
      createHeightfieldDesc({
        seed: 0,
        size,
        resolution,
        heights,
        biomes: new Float32Array(0),
        rivers: [],
        seaLevel: 0,
      }),
    );
    // Queries return nothing until the broad-phase has been built (convention note 7).
    world.step();

    const probes: Array<[number, number]> = [
      [-3.1, 2.3],
      [2.7, -1.2],
      [0, 0],
      [3.6, 3.6],
      [-3.6, -3.6],
      [1.5, -3.2],
    ];
    const ray = new RAPIER.Ray({ x: 0, y: 200, z: 0 }, { x: 0, y: -1, z: 0 });
    for (const [x, z] of probes) {
      ray.origin = { x, y: 200, z };
      const hit = castRayRobust(world, ray, 400);
      if (!hit) {
        ok = false;
        details.push(`  MISS at (${x}, ${z}) — the footprint is not where we think it is`);
        continue;
      }
      const actual = 200 - hit.timeOfImpact;
      const expected = expectedAt(x, z);
      const error = Math.abs(actual - expected);
      maxError = Math.max(maxError, error);
      if (error > 1e-3) {
        ok = false;
        const transposed = expectedAt(z, x);
        const hint =
          Math.abs(actual - transposed) < 1e-3 ? '  ← matches the TRANSPOSE: row/column order is flipped' : '';
        details.push(
          `  (${x}, ${z}) expected ${expected.toFixed(4)} got ${actual.toFixed(4)}${hint}`,
        );
      }
    }

    // The field must stop dead at its declared extent — nothing should be hit outside it.
    ray.origin = { x: size / 2 + 1, y: 200, z: 0 };
    if (castRayRobust(world, ray, 400)) {
      ok = false;
      details.push(`  hit geometry outside the declared ${size} m footprint`);
    }
  } finally {
    world.free();
  }

  details.unshift(
    ok
      ? `heightfield convention OK (column-major, row←z, col←x; max error ${maxError.toExponential(1)} m)`
      : 'HEIGHTFIELD CONVENTION MISMATCH — physics terrain does not match WorldData.heights:',
  );
  return { ok, maxError, details };
}

// ---------------------------------------------------------------------------
// Self-test 2 — the live collider vs IWorld.sampleHeight (PLAN.md §Verification).
// ---------------------------------------------------------------------------

/**
 * Raycasts straight down at `n` deterministic random points and compares the hit height with
 * `IWorld.sampleHeight` — the "single source of truth" every other workstream samples.
 *
 * Two thresholds, because two very different failures hide here:
 *   - `PHYSICS.samplerConventionThreshold` (1 m): a real bug — wrong index order, scale or centring.
 *   - `PHYSICS.samplerTolerance` (0.01 m): WS1's bilinear sampler vs Rapier's triangulated quads.
 *     On rough terrain a per-quad disagreement of `(h00 + h11 - h01 - h10)/4` is expected and is
 *     *not* a physics bug; the same difference exists between `sampleHeight` and the rendered mesh.
 *
 * @param physics - The live physics service (must already own a heightfield).
 * @param world - The world whose `sampleHeight` is the reference.
 * @param samples - Number of probe points. Defaults to `PHYSICS.samplerTestPoints`.
 * @param seed - RNG seed, so a failure is reproducible.
 * @returns Pass/fail against the convention threshold, plus the error statistics.
 *
 * @complexity Time: O(samples · log(resolution)) — one BVH raycast per sample. ~2 ms for 1000 points.
 */
export function verifySamplerAgreement(
  physics: IPhysics,
  world: IWorld,
  samples: number = PHYSICS.samplerTestPoints,
  seed = 0x5eed,
): VerificationResult {
  const data = world.data;
  const half = data.size * 0.5 - PHYSICS.boundsMargin;
  const rng = mulberry32(seed);
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  // Start above the tallest possible terrain and cast far enough to clear the deepest valley.
  const rayStart = data.size;
  const maxToi = data.size * 2;

  let maxError = 0;
  let sumError = 0;
  let misses = 0;
  let worstX = 0;
  let worstZ = 0;

  for (let i = 0; i < samples; i++) {
    const x = (rng() * 2 - 1) * half;
    const z = (rng() * 2 - 1) * half;
    ray.origin = { x, y: rayStart, z };
    const hit = castRayRobust(physics.world, ray, maxToi);
    if (!hit) {
      misses++;
      continue;
    }
    const error = Math.abs(rayStart - hit.timeOfImpact - world.sampleHeight(x, z));
    sumError += error;
    if (error > maxError) {
      maxError = error;
      worstX = x;
      worstZ = z;
    }
  }

  const hits = samples - misses;
  const meanError = hits > 0 ? sumError / hits : Number.NaN;
  const ok = misses === 0 && maxError <= PHYSICS.samplerConventionThreshold;
  const details = [
    `sampleHeight vs raycast over ${samples} points: mean ${meanError.toFixed(4)} m, ` +
      `max ${maxError.toFixed(4)} m at (${worstX.toFixed(1)}, ${worstZ.toFixed(1)}), ${misses} misses`,
  ];
  if (!ok) {
    details.push(
      misses > 0
        ? `  ${misses} rays found no terrain — the collider footprint does not cover the world`
        : `  max error exceeds ${PHYSICS.samplerConventionThreshold} m — index order / scale is wrong`,
    );
  } else if (maxError > PHYSICS.samplerTolerance) {
    details.push(
      `  above the ${PHYSICS.samplerTolerance} m target, but below the ${PHYSICS.samplerConventionThreshold} m ` +
        'bug threshold: this is bilinear-vs-triangulated interpolation, not a convention error',
    );
  }
  return { ok, maxError, details };
}
