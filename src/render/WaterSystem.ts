/**
 * src/render/WaterSystem.ts
 *
 * Contents: the `WaterSystem` — the sea plane that surrounds the island and the ribbon meshes that
 * run down each river spline, both drawn with the shared shader from `WaterMaterial.ts`.
 *
 * Purpose: WS4's water half. It owns the meshes and the heightmap texture the sea shader reads its
 * depth from; the shading itself lives in `WaterMaterial.ts`.
 *
 * ── WS1 HANDSHAKE ───────────────────────────────────────────────────────────
 * Rivers come from `ctx.world.data.rivers` (`RiverSpline[]`: ordered peak → sea points whose `y`
 * is the water surface height, plus a `width`). Nothing else is required. The system rebuilds
 * itself on `world:ready`, so it is correct whether WS1 generates synchronously or in a worker.
 *
 * While WS1 has not landed the stub world reports zero rivers, so one synthetic river is drawn
 * across the flat plain purely so the water shader is visible and reviewable. It disappears the
 * instant a real world arrives.
 */

import * as THREE from 'three';
import { WATER, WORLD, TERRAIN_PREVIEW } from '../config/world.config';
import type { GameContext, RiverSpline, System } from '../core/types';
import type { Unsubscribe } from '../core/EventBus';
import { clamp, mulberry32 } from '../utils/math';
import { createHeightTexture, createWaterMaterial } from './WaterMaterial';

export class WaterSystem implements System {
  readonly name = 'ws4:water';

  private ctx!: GameContext;
  private seaMaterial!: THREE.ShaderMaterial;
  private riverMaterial!: THREE.ShaderMaterial;
  private sea!: THREE.Mesh;
  private heightTexture: THREE.DataTexture | null = null;
  private readonly riverMeshes: THREE.Mesh[] = [];
  private unsubscribe: Unsubscribe | null = null;

  init(ctx: GameContext): void {
    this.ctx = ctx;

    this.seaMaterial = createWaterMaterial(ctx, 'sea');
    this.riverMaterial = createWaterMaterial(ctx, 'river');

    const geo = new THREE.PlaneGeometry(
      WATER.seaExtent,
      WATER.seaExtent,
      WATER.seaSegments,
      WATER.seaSegments,
    );
    geo.rotateX(-Math.PI / 2);
    this.sea = new THREE.Mesh(geo, this.seaMaterial);
    this.sea.name = 'ws4:sea';
    this.sea.position.y = ctx.world.data.seaLevel;
    // A plane this large is never off screen, and its bounding sphere makes culling wrong anyway.
    this.sea.frustumCulled = false;
    // Transparent surfaces render after opaques; make sure the sea is behind the river ribbons
    // rather than fighting them for sort order.
    this.sea.renderOrder = 1;
    ctx.scene.add(this.sea);

    this.rebuild();
    this.unsubscribe = ctx.events.on('world:ready', () => this.rebuild());
  }

  /** Re-derive everything that depends on `WorldData`. Safe to call repeatedly. */
  private rebuild(): void {
    const data = this.ctx.world.data;

    this.heightTexture?.dispose();
    this.heightTexture = createHeightTexture(data);
    this.seaMaterial.uniforms.uHeightMap.value = this.heightTexture;
    this.seaMaterial.uniforms.uWorldSize.value = data.size;
    this.seaMaterial.uniforms.uSeaLevel.value = data.seaLevel;
    this.sea.position.y = data.seaLevel;

    this.clearRivers();
    const splines = data.rivers.length > 0 ? data.rivers : [makeStubRiver(data.seaLevel)];
    for (const spline of splines) {
      const geometry = buildRiverRibbon(spline);
      if (!geometry) continue;
      const mesh = new THREE.Mesh(geometry, this.riverMaterial);
      mesh.name = 'ws4:river';
      mesh.renderOrder = 2;
      this.riverMeshes.push(mesh);
      this.ctx.scene.add(mesh);
    }
  }

  private clearRivers(): void {
    for (const mesh of this.riverMeshes) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    this.riverMeshes.length = 0;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearRivers();
    this.sea.removeFromParent();
    this.sea.geometry.dispose();
    this.seaMaterial.dispose();
    this.riverMaterial.dispose();
    this.heightTexture?.dispose();
    this.heightTexture = null;
  }
}

/**
 * Turn a river spline into a flat ribbon of triangles that follows it.
 *
 * The spline is resampled along a Catmull-Rom curve so the ribbon is smooth regardless of how
 * coarsely WS1 sampled its steepest-descent walk. Each cross-section emits one vertex per entry in
 * `WATER.riverProfile`, which gives the shader a depth profile — a flat bed with shallow banks —
 * and therefore foam along both edges for free.
 *
 * @param spline - ordered peak → sea points; `y` is the water surface height.
 * @returns ribbon geometry with `position`, `aDepth` and `aFlow` attributes, or `null` if the
 *          spline is too short to define a curve.
 *
 * @complexity Time and space: O(WATER.riverSegments × WATER.riverProfile.length).
 */
export function buildRiverRibbon(spline: RiverSpline): THREE.BufferGeometry | null {
  // A steepest-descent walk stalls where the ground flattens out, leaving a knot of near-identical
  // points — usually right at the river mouth. Feeding those to a spline makes the curve double
  // back on itself and the ribbon collapses into a tangle, so they are dropped first.
  const control = dedupeXZ(spline.points, Math.max(0.5, spline.width * 0.3));
  if (control.length < 2) return null;

  // Centripetal parameterisation (alpha 0.5) is the one that does not overshoot or loop on the
  // tight bends this kind of path produces.
  const curve = new THREE.CatmullRomCurve3(control, false, 'catmullrom', 0.5);
  // Sample count from arc length, not from the control-point count, so the ribbon is evenly
  // tessellated whether WS1 hands over 20 points or 200.
  const segments = clamp(
    Math.round(curve.getLength() / Math.max(2, spline.width * 0.6)),
    24,
    WATER.riverSegments,
  );
  const profile = WATER.riverProfile;
  const cols = profile.length;
  const rows = segments + 1;
  const halfWidth = spline.width * 0.5;
  const maxDepth = spline.width * WATER.riverDepthFactor;

  const positions = new Float32Array(rows * cols * 3);
  const depths = new Float32Array(rows * cols);
  const flows = new Float32Array(rows * cols * 2);

  // Equidistant along the curve, not equidistant in the spline parameter: uniform-t sampling
  // bunches samples wherever the control points were dense, which is the other half of the tangle.
  //
  // Tangents then come from a central difference of these samples rather than from
  // `curve.getTangent`, whose 3D derivative has a near-zero horizontal part on a steep descent —
  // normalising that amplifies noise and the cross-sections spin.
  const centers = curve.getSpacedPoints(segments);

  const tangent = new THREE.Vector3();
  const side = new THREE.Vector3();
  const lastSide = new THREE.Vector3(1, 0, 0);

  for (let i = 0; i < rows; i++) {
    const t = i / segments;
    const point = centers[i];
    const ahead = centers[Math.min(i + 1, rows - 1)];
    const behind = centers[Math.max(i - 1, 0)];
    tangent.set(ahead.x - behind.x, 0, ahead.z - behind.z);

    // A vertical drop has no horizontal direction to work from, so hold the previous orientation
    // rather than inventing one.
    if (tangent.lengthSq() < 1e-6) {
      side.copy(lastSide);
    } else {
      tangent.normalize();
      side.set(tangent.z, 0, -tangent.x);
      lastSide.copy(side);
    }

    const y = point.y + WATER.riverSurfaceOffset;
    // The channel widens toward the sea so a river mouth spreads into the shoreline rather than
    // ending in a hard rectangle.
    const w = halfWidth * (0.65 + 0.35 * t);

    for (let k = 0; k < cols; k++) {
      const v = i * cols + k;
      const off = profile[k].offset * w;
      positions[v * 3 + 0] = point.x + side.x * off;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = point.z + side.z * off;
      depths[v] = profile[k].depth * maxDepth;
      flows[v * 2 + 0] = tangent.x;
      flows[v * 2 + 1] = tangent.z;
    }
  }

  const indices = new Uint32Array(segments * (cols - 1) * 6);
  let w = 0;
  for (let i = 0; i < segments; i++) {
    const a = i * cols;
    const b = (i + 1) * cols;
    for (let k = 0; k < cols - 1; k++) {
      indices[w++] = a + k;
      indices[w++] = b + k;
      indices[w++] = a + k + 1;
      indices[w++] = a + k + 1;
      indices[w++] = b + k;
      indices[w++] = b + k + 1;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aDepth', new THREE.BufferAttribute(depths, 1));
  geometry.setAttribute('aFlow', new THREE.BufferAttribute(flows, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Copy a polyline, dropping every point that lands within `minSpacing` of the last kept one in the
 * horizontal plane. The final point is always kept so a river still reaches its mouth.
 *
 * @complexity Time: O(points.length) | Space: O(points.length).
 */
function dedupeXZ(points: readonly THREE.Vector3[], minSpacing: number): THREE.Vector3[] {
  if (points.length === 0) return [];
  const minSq = minSpacing * minSpacing;
  const out: THREE.Vector3[] = [points[0].clone()];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const last = out[out.length - 1];
    const dx = p.x - last.x;
    const dz = p.z - last.z;
    if (dx * dx + dz * dz >= minSq) out.push(p.clone());
  }
  const tail = points[points.length - 1];
  if (out.length > 1 && out[out.length - 1] !== tail) {
    // Replace rather than append: the dropped tail is by definition within `minSpacing`.
    out[out.length - 1] = tail.clone();
  }
  return out;
}

/**
 * A stand-in river for the flat stub world, so there is water to look at before WS1 lands.
 * Deterministic — same seed, same river, every reload.
 *
 * @complexity Time: O(1) | Space: O(1).
 */
function makeStubRiver(seaLevel: number): RiverSpline {
  const rng = mulberry32(WORLD.seed ^ 0x1d5e);
  const points: THREE.Vector3[] = [];
  const span = WORLD.size * 0.5;
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push(
      // Just above the stub world's flat ground: on real terrain WS1's splines carry their own
      // carved-valley heights, but here the plain is at sea level and a buried river is no river.
      new THREE.Vector3(
        -span + t * WORLD.size,
        seaLevel + 0.03,
        (rng() - 0.5) * 220 + Math.sin(t * 5.2) * 130,
      ),
    );
  }
  return { points, width: TERRAIN_PREVIEW.stubRiverWidth };
}
