/**
 * src/landmarks/isfahanStamp.ts
 *
 * Contents: site picking and heightmap stamping for Naqsh-e Jahan. Pure data — no three.js scene
 * graph — so `WorldSystem` can flatten the plaza into `WorldData.heights` before the sampler,
 * chunks, and Rapier heightfield are built. That is what keeps the square on the ground instead
 * of floating as a second mesh.
 *
 * Purpose: the square sits north of a river (mosque facing the water, as in Isfahan). The stamp
 * is the single source of truth for where the landmark is; meshes and colliders read `LandmarkSite`.
 */

import { ISFAHAN, WORLD } from "../config/world.config";
import type { LandmarkSite, WorldData } from "../core/types";
import { clamp, lerp, smoothstep } from "../utils/math";

const INNER_W = ISFAHAN.plazaWidth * 0.5 + ISFAHAN.arcadeDepth;
const INNER_L =
  ISFAHAN.plazaLength * 0.5 +
  Math.max(ISFAHAN.mosqueDepth, ISFAHAN.bazaarDepth);

/**
 * Pick a river-side pose, flatten a plateau, and publish it on `data.landmarks`.
 * No-ops (and returns null) when no land large enough exists — the island stays procedural.
 */
export function applyIsfahanStamp(data: WorldData): LandmarkSite | null {
  const site = pickIsfahanSite(data);
  if (!site) return null;
  stampPlateau(data, site);
  data.landmarks = [site];
  return site;
}

/** True when grass/rocks must stay off the paving and building footprints. */
export function pointInLandmarkFootprint(
  data: WorldData,
  x: number,
  z: number,
): boolean {
  const sites = data.landmarks;
  if (!sites || sites.length === 0) return false;
  for (const site of sites) {
    const { lx, lz } = toLocal(site, x, z);
    if (Math.abs(lx) < INNER_W + 4 && Math.abs(lz) < INNER_L + 4) return true;
  }
  return false;
}

function pickIsfahanSite(data: WorldData): LandmarkSite | null {
  let best: LandmarkSite | null = null;
  let bestScore = -Infinity;

  for (const river of data.rivers) {
    const pts = river.points;
    if (pts.length < 5) continue;
    const step = Math.max(1, (pts.length / 14) | 0);
    const start = Math.floor(pts.length * 0.22);
    const end = Math.floor(pts.length * 0.78);
    for (let i = start; i < end; i += step) {
      const a = pts[i]!;
      const b = pts[Math.min(i + 1, pts.length - 1)]!;
      const tx = b.x - a.x;
      const tz = b.z - a.z;
      const len = Math.hypot(tx, tz);
      if (len < 2) continue;
      const px = -tz / len;
      const pz = tx / len;
      const bank =
        (river.width ?? 24) * 0.5 +
        ISFAHAN.riverGap +
        ISFAHAN.mosqueDepth +
        ISFAHAN.plazaLength * 0.5;
      for (const sign of [-1, 1] as const) {
        const nx = px * sign;
        const nz = pz * sign;
        // Local +Z (mosque / south) points back at the river.
        const yaw = Math.atan2(-nx, -nz);
        const site = makeSite(data, a.x + nx * bank, a.z + nz * bank, yaw);
        const score = scoreSite(data, site);
        if (score > bestScore) {
          bestScore = score;
          best = site;
        }
      }
    }
  }

  if (bestScore < 0) {
    const half = data.size * 0.5 - ISFAHAN.edgeMargin - INNER_L;
    for (let z = -half; z <= half && bestScore < 0; z += 96) {
      for (let x = -half; x <= half && bestScore < 0; x += 96) {
        const site = makeSite(data, x, z, 0);
        const score = scoreSite(data, site);
        if (score > bestScore) {
          bestScore = score;
          best = site;
        }
      }
    }
  }

  return bestScore >= 0 ? best : null;
}

function makeSite(
  data: WorldData,
  x: number,
  z: number,
  yaw: number,
): LandmarkSite {
  const halfWidth = ISFAHAN.plazaWidth * 0.5;
  const halfLength = ISFAHAN.plazaLength * 0.5;
  const y = medianHeight(data, x, z, yaw, halfWidth * 0.6, halfLength * 0.6);
  const northX = -Math.sin(yaw);
  const northZ = -Math.cos(yaw);
  // TEMP: spawn on the plaza (central path, north of the pool) instead of outside the north gate.
  const spawnDist = 30;
  return {
    id: "isfahan",
    x,
    z,
    y: Math.max(y, WORLD.seaLevel + ISFAHAN.minAboveSea),
    yaw,
    spawnX: x + northX * spawnDist,
    spawnZ: z + northZ * spawnDist,
    spawnYaw: yaw + Math.PI,
    halfWidth,
    halfLength,
  };
}

function scoreSite(data: WorldData, site: LandmarkSite): number {
  const pad = ISFAHAN.edgeMargin;
  const corners = footprintCorners(site);
  let minH = Infinity;
  let maxH = -Infinity;
  for (const [cx, cz] of corners) {
    if (!onIsland(cx, cz, pad)) return -1e6;
    const h = sampleHeightNN(data, cx, cz);
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  if (minH < WORLD.seaLevel + ISFAHAN.minAboveSea) return -1e6;
  if (maxH > ISFAHAN.maxHeight) return -1e6;
  if (sampleRiver(data, site.x, site.z) > 0.2) return -1e6;
  if (sampleRiver(data, site.spawnX, site.spawnZ) > 0.25) return -1e6;
  if (!onIsland(site.spawnX, site.spawnZ, pad)) return -1e6;

  const range = maxH - minH;
  const inland = 1 - Math.hypot(site.x, site.z) / (data.size * 0.5);
  return 40 - range * 0.35 + inland * 8;
}

function stampPlateau(data: WorldData, site: LandmarkSite): void {
  const res = data.resolution;
  const half = data.size * 0.5;
  const cell = data.size / (res - 1);
  const mask = data.riverMask;
  const heights = data.heights;
  const biomes = data.biomes;
  const apron = ISFAHAN.apron;
  const target = site.y;

  for (let iz = 0; iz < res; iz++) {
    const wz = iz * cell - half;
    for (let ix = 0; ix < res; ix++) {
      const wx = ix * cell - half;
      const { lx, lz } = toLocal(site, wx, wz);
      const ox = Math.max(0, Math.abs(lx) - INNER_W);
      const oz = Math.max(0, Math.abs(lz) - INNER_L);
      const w = 1 - smoothstep(0, apron, Math.max(ox, oz));
      if (w <= 1e-3) continue;

      const i = iz * res + ix;
      if (mask && mask[i]! > 0.4 && w < 0.95) continue;

      heights[i] = lerp(heights[i]!, target, w);
      const b = i * 4;
      const sand = lerp(biomes[b]!, 0, w);
      biomes[b] = sand; // grass → 0
      biomes[b + 1] = lerp(biomes[b + 1]!, 0.28, w);
      biomes[b + 2] = lerp(biomes[b + 2]!, 0, w);
      biomes[b + 3] = lerp(biomes[b + 3]!, 0.72, w);
    }
  }
}

/** Landmark-local XZ → world XZ (inverse of `toLocal`). */
export function landmarkToWorld(
  site: LandmarkSite,
  lx: number,
  lz: number,
): { x: number; z: number } {
  const c = Math.cos(site.yaw);
  const s = Math.sin(site.yaw);
  return {
    x: site.x + lx * c + lz * s,
    z: site.z - lx * s + lz * c,
  };
}

function toLocal(
  site: LandmarkSite,
  x: number,
  z: number,
): { lx: number; lz: number } {
  const dx = x - site.x;
  const dz = z - site.z;
  const c = Math.cos(site.yaw);
  const s = Math.sin(site.yaw);
  return { lx: dx * c - dz * s, lz: dx * s + dz * c };
}

function footprintCorners(site: LandmarkSite): Array<[number, number]> {
  const hw = INNER_W + 6;
  const hl = INNER_L + 6;
  const c = Math.cos(site.yaw);
  const s = Math.sin(site.yaw);
  const local: Array<[number, number]> = [
    [-hw, -hl],
    [hw, -hl],
    [-hw, hl],
    [hw, hl],
    [0, 0],
  ];
  return local.map(([lx, lz]) => [
    site.x + lx * c + lz * s,
    site.z - lx * s + lz * c,
  ]);
}

function medianHeight(
  data: WorldData,
  x: number,
  z: number,
  yaw: number,
  hw: number,
  hl: number,
): number {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const samples: number[] = [];
  for (const [lx, lz] of [
    [0, 0],
    [-hw, -hl],
    [hw, -hl],
    [-hw, hl],
    [hw, hl],
    [-hw, 0],
    [hw, 0],
    [0, -hl],
    [0, hl],
  ] as const) {
    samples.push(
      sampleHeightNN(data, x + lx * c + lz * s, z - lx * s + lz * c),
    );
  }
  samples.sort((a, b) => a - b);
  return samples[4]!;
}

function sampleHeightNN(data: WorldData, x: number, z: number): number {
  const res = data.resolution;
  const half = data.size * 0.5;
  const cell = data.size / (res - 1);
  const ix = clamp(Math.round((x + half) / cell), 0, res - 1);
  const iz = clamp(Math.round((z + half) / cell), 0, res - 1);
  return data.heights[iz * res + ix]!;
}

function sampleRiver(data: WorldData, x: number, z: number): number {
  const mask = data.riverMask;
  if (!mask) return 0;
  const res = data.resolution;
  const half = data.size * 0.5;
  const cell = data.size / (res - 1);
  const ix = clamp(Math.round((x + half) / cell), 0, res - 1);
  const iz = clamp(Math.round((z + half) / cell), 0, res - 1);
  return mask[iz * res + ix]!;
}

function onIsland(x: number, z: number, margin: number): boolean {
  const half = WORLD.size * 0.5 - margin;
  return x > -half && x < half && z > -half && z < half;
}
