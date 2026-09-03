/**
 * src/world/TerrainChunk.ts
 *
 * Contents: `buildChunkMeshData` (one chunk of the heightmap → raw interleaved-free typed arrays at
 * a chosen LOD stride, skirts included), `chunkMeshDataToGeometry` (wrap those arrays in a
 * `THREE.BufferGeometry`), and `verifyChunkAgainstSampler` (the anti-drift assertion PLAN.md asks
 * for). Also owns the vertex layout contract published to WS4.
 *
 * Purpose: keeps all geometry construction in one small, testable place so `WorldSystem` only has to
 * decide *which* chunks exist at *which* LOD.
 *
 * ── Vertex layout (the WS1 → WS4 handshake) ─────────────────────────────────
 *   position : vec3  — WORLD space (the meshes sit at the origin with an identity matrix)
 *   normal   : vec3  — central differences of the heightmap at stride 1, identical at every LOD
 *   aBiome   : vec4  — [grass, rock, snow, sand], sums to 1  (TERRAIN_ATTRIBUTES.biome)
 *   aRiver   : float — 0 = dry, 1 = river bed centre        (TERRAIN_ATTRIBUTES.river)
 * No `uv` and no vertex colours: WS4's `TerrainMaterial` shades entirely in world space and its
 * contract explicitly asks WS1 not to write them.
 *
 * ── LOD and skirts ─────────────────────────────────────────────────────────
 * A chunk is a `quadsPerChunk × quadsPerChunk` block of heightmap cells, sampled every `stride`
 * vertices (1/2/4/8). Neighbouring chunks at different strides leave visible cracks along their
 * shared edge, so every chunk is built as an `(n + 2)²` grid whose outer ring duplicates the edge
 * vertices' XZ but sits `skirtDepth` metres lower. That ring triangulates into a vertical curtain
 * that plugs the crack, and because the ring is just part of the same regular grid the winding and
 * corner cases fall out for free.
 *
 * ── Triangulation (must match HeightSampler and the Rapier heightfield) ─────
 * For the quad A=(x,z) B=(x+1,z) C=(x,z+1) D=(x+1,z+1) the triangles are (A, C, B) and (B, C, D) —
 * diagonal B–C, both wound so the face normal is +Y.
 */

import * as THREE from 'three';
import { clamp } from '../utils/math';
import { TERRAIN_ATTRIBUTES } from '../core/types';
import type { Rng } from '../core/types';

/** The subset of `WorldData` the geometry builder needs. */
export interface TerrainSource {
  heights: Float32Array;
  biomes: Float32Array;
  riverMask: Float32Array;
  /** Vertices per side. */
  resolution: number;
  /** Island side length in metres. */
  size: number;
}

/** Raw buffers for one chunk. Kept as plain arrays so far-away chunks can be concatenated cheaply. */
export interface ChunkMeshData {
  positions: Float32Array;
  normals: Float32Array;
  biome: Float32Array;
  river: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
  /** Vertical extent of the real (non-skirt) surface, for bounding volumes. */
  minY: number;
  maxY: number;
}

/**
 * Builds the geometry buffers for one terrain chunk at one LOD.
 *
 * @param src - The world arrays. Read-only here.
 * @param cx - Chunk column, `0 .. chunkGrid - 1`.
 * @param cz - Chunk row, `0 .. chunkGrid - 1`.
 * @param quadsPerChunk - Heightmap cells per chunk side at LOD0 (`(resolution - 1) / chunkGrid`).
 * @param stride - Vertex stride: 1 = full detail, 8 = every eighth vertex. Must divide `quadsPerChunk`.
 * @param skirtDepth - Metres the outer skirt ring hangs below the surface.
 *
 * @complexity Time: O(n²) where `n = quadsPerChunk / stride + 1` (1225 vertices at LOD0).
 * Space: O(n²) — about 64 kB per LOD0 chunk.
 */
export function buildChunkMeshData(
  src: TerrainSource,
  cx: number,
  cz: number,
  quadsPerChunk: number,
  stride: number,
  skirtDepth: number,
): ChunkMeshData {
  const res = src.resolution;
  const cell = src.size / (res - 1);
  const half = src.size * 0.5;

  // `n` real vertices per side; `m` includes the skirt ring on both sides.
  const n = Math.floor(quadsPerChunk / stride) + 1;
  const m = n + 2;
  const vertexCount = m * m;
  const indexCount = (m - 1) * (m - 1) * 6;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const biome = new Float32Array(vertexCount * 4);
  const river = new Float32Array(vertexCount);
  const indices = new Uint32Array(indexCount);

  const baseX = cx * quadsPerChunk;
  const baseZ = cz * quadsPerChunk;
  const lastGrid = res - 1;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let b = 0; b < m; b++) {
    // Ring rows clamp onto the first/last real row, so they share XZ with the edge they hide.
    const j = clamp(b - 1, 0, n - 1);
    const gz = Math.min(baseZ + j * stride, lastGrid);
    const rowOffset = gz * res;
    const zm = gz > 0 ? rowOffset - res : rowOffset;
    const zp = gz < lastGrid ? rowOffset + res : rowOffset;
    const dzSpan = (gz > 0 ? 1 : 0) + (gz < lastGrid ? 1 : 0);
    const wz = -half + gz * cell;
    const edgeZ = b === 0 || b === m - 1;

    for (let a = 0; a < m; a++) {
      const i = clamp(a - 1, 0, n - 1);
      const gx = Math.min(baseX + i * stride, lastGrid);
      const gi = rowOffset + gx;
      const wx = -half + gx * cell;
      const isSkirt = edgeZ || a === 0 || a === m - 1;

      const surfaceY = src.heights[gi];
      if (surfaceY < minY) minY = surfaceY;
      if (surfaceY > maxY) maxY = surfaceY;

      const xm = gx > 0 ? gx - 1 : gx;
      const xp = gx < lastGrid ? gx + 1 : gx;
      const dxSpan = (gx > 0 ? 1 : 0) + (gx < lastGrid ? 1 : 0);
      const dhdx = dxSpan > 0 ? (src.heights[rowOffset + xp] - src.heights[rowOffset + xm]) / (dxSpan * cell) : 0;
      const dhdz = dzSpan > 0 ? (src.heights[zp + gx] - src.heights[zm + gx]) / (dzSpan * cell) : 0;
      const nl = Math.hypot(dhdx, 1, dhdz) || 1;

      const v = b * m + a;
      positions[v * 3] = wx;
      positions[v * 3 + 1] = isSkirt ? surfaceY - skirtDepth : surfaceY;
      positions[v * 3 + 2] = wz;
      normals[v * 3] = -dhdx / nl;
      normals[v * 3 + 1] = 1 / nl;
      normals[v * 3 + 2] = -dhdz / nl;
      const bo = gi * 4;
      biome[v * 4] = src.biomes[bo];
      biome[v * 4 + 1] = src.biomes[bo + 1];
      biome[v * 4 + 2] = src.biomes[bo + 2];
      biome[v * 4 + 3] = src.biomes[bo + 3];
      river[v] = src.riverMask[gi];
    }
  }

  let o = 0;
  for (let b = 0; b < m - 1; b++) {
    for (let a = 0; a < m - 1; a++) {
      const A = b * m + a;
      const B = A + 1;
      const C = A + m;
      const D = C + 1;
      indices[o] = A;
      indices[o + 1] = C;
      indices[o + 2] = B;
      indices[o + 3] = B;
      indices[o + 4] = C;
      indices[o + 5] = D;
      o += 6;
    }
  }

  return { positions, normals, biome, river, indices, vertexCount, indexCount, minY, maxY };
}

/**
 * Wraps chunk buffers in a `BufferGeometry`, publishing `aBiome` / `aRiver` under the names agreed
 * in `TERRAIN_ATTRIBUTES`.
 *
 * @complexity Time: O(1) (no copies — the arrays are adopted) | Space: O(1)
 */
export function chunkMeshDataToGeometry(data: ChunkMeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute(TERRAIN_ATTRIBUTES.biome, new THREE.BufferAttribute(data.biome, 4));
  geometry.setAttribute(TERRAIN_ATTRIBUTES.river, new THREE.BufferAttribute(data.river, 1));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

/**
 * PLAN.md WS1 acceptance: "`sampleHeight` matches rendered geometry within 0.01 m at 1000 random
 * points (write the assertion)."
 *
 * This walks the *actual* index buffer of a built LOD0 geometry, finds the triangle each random
 * point lands in, interpolates its plane barycentrically, and compares against the sampler. It
 * therefore catches the whole class of bugs PLAN.md flags as Risk #1 — swapped row/column order,
 * an off-by-one in the world↔grid mapping, wrong cell size, wrong diagonal — none of which a
 * formula-vs-formula check would notice.
 *
 * @param geometry - A LOD0 chunk geometry (stride 1). Coarser LODs legitimately deviate.
 * @param sampleHeight - The sampler under test.
 * @param rng - Seeded RNG so any failure reproduces.
 * @param samples - Random points to test.
 * @returns Max/mean absolute error in metres, how many points were testable, and the verdict.
 *
 * @complexity Time: O(samples × trianglesPerChunk) worst case; the triangle search short-circuits on
 * the first containing triangle. Space: O(1)
 */
export function verifyChunkAgainstSampler(
  geometry: THREE.BufferGeometry,
  sampleHeight: (x: number, z: number) => number,
  rng: Rng,
  samples = 1000,
): { maxError: number; meanError: number; tested: number; ok: boolean } {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const index = geometry.getIndex();
  if (!index) return { maxError: Infinity, meanError: Infinity, tested: 0, ok: false };
  const p = pos.array as Float32Array;
  const idx = index.array as ArrayLike<number>;

  const box = geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(pos);
  let maxError = 0;
  let total = 0;
  let tested = 0;

  for (let s = 0; s < samples; s++) {
    // Inset a little so points never land on the skirt curtain, which is deliberately below ground.
    const x = box.min.x + (box.max.x - box.min.x) * (0.02 + rng() * 0.96);
    const z = box.min.z + (box.max.z - box.min.z) * (0.02 + rng() * 0.96);

    let meshY = NaN;
    for (let t = 0; t < idx.length; t += 3) {
      const i0 = idx[t] * 3;
      const i1 = idx[t + 1] * 3;
      const i2 = idx[t + 2] * 3;
      const ax = p[i0];
      const az = p[i0 + 2];
      const bx = p[i1];
      const bz = p[i1 + 2];
      const cx = p[i2];
      const cz = p[i2 + 2];

      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue; // degenerate skirt-corner triangle
      const w0 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const w1 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;

      meshY = w0 * p[i0 + 1] + w1 * p[i1 + 1] + w2 * p[i2 + 1];
      break;
    }
    if (Number.isNaN(meshY)) continue;

    const error = Math.abs(meshY - sampleHeight(x, z));
    total += error;
    tested++;
    if (error > maxError) maxError = error;
  }

  return {
    maxError,
    meanError: tested > 0 ? total / tested : Infinity,
    tested,
    ok: tested > samples * 0.5 && maxError <= 0.01,
  };
}
