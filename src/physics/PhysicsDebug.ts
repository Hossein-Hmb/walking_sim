/**
 * src/physics/PhysicsDebug.ts
 *
 * Contents: `PhysicsDebug`, the F1 collider visualisation. Draws two things:
 *   1. Rapier's own `world.debugRender()` line soup — the character capsule, WS5's rock trimeshes,
 *      any dynamic bodies — in Rapier's colours.
 *   2. A green wireframe of the terrain heightfield in a window around the player, reconstructed
 *      **from the collider's own data read back out of WASM** rather than from `WorldData`.
 *
 * Purpose: point 2 is the visual half of PLAN.md §Risks 1. Because the grid is rebuilt from what
 * Rapier actually stored (`heightfieldHeights()` / `heightfieldNRows()` / `heightfieldScale()`),
 * it is an independent witness: if the row/column transpose in `Heightfield.ts` were wrong, this
 * wireframe would visibly mirror across the diagonal relative to WS1's terrain mesh. When they sit
 * on top of each other, physics and visuals genuinely agree.
 *
 * Why not just `debugRender()` the terrain too: a 513² heightfield is ~524 000 triangles, which is
 * roughly 1.5 million debug line segments. It would hang the tab. The heightfield collider is
 * filtered out of the Rapier pass and replaced by the local window instead.
 *
 * This is a plain class, not a `System` — `PhysicsSystem` owns it and drives it, which keeps the
 * WS2 edit to `main.ts` down to a single line.
 */

import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { PHYSICS } from '../config/world.config';

/** Lifts the wireframe just clear of the terrain surface so it is visible instead of z-fighting. */
const SURFACE_LIFT = 0.03;

export class PhysicsDebug {
  private group: THREE.Group | null = null;
  private colliderLines: THREE.LineSegments | null = null;
  private terrainLines: THREE.LineSegments | null = null;
  private _visible = false;
  /** Latched if `debugRender` ever returns an unreasonable number of segments. */
  private colliderPassRetired = false;

  // Cached heightfield readback — pulling it out of WASM allocates, so only do it on a rebuild.
  private cachedVersion = -1;
  private heights: Float32Array | null = null;
  private nrows = 0;
  private ncols = 0;
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly origin = new THREE.Vector3();
  private readonly lastFocus = new THREE.Vector3(Infinity, Infinity, Infinity);

  get visible(): boolean {
    return this._visible;
  }

  /** Builds the meshes and adds them to the scene, hidden. Call once from `PhysicsSystem.init`. */
  attach(scene: THREE.Scene): void {
    if (this.group) return;

    const colliderGeom = new THREE.BufferGeometry();
    colliderGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    colliderGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 4));
    this.colliderLines = new THREE.LineSegments(
      colliderGeom,
      new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false }),
    );

    const terrainGeom = new THREE.BufferGeometry();
    terrainGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(PHYSICS.debugMaxSegments * 6), 3),
    );
    terrainGeom.setDrawRange(0, 0);
    this.terrainLines = new THREE.LineSegments(
      terrainGeom,
      new THREE.LineBasicMaterial({
        color: 0x38ff9e,
        transparent: true,
        opacity: 0.55,
        toneMapped: false,
      }),
    );

    // Both meshes are rebuilt from world-space coordinates every frame, so culling would be wrong.
    this.colliderLines.frustumCulled = false;
    this.terrainLines.frustumCulled = false;

    this.group = new THREE.Group();
    this.group.name = 'physics:debug';
    this.group.visible = false;
    this.group.add(this.colliderLines, this.terrainLines);
    scene.add(this.group);
  }

  setVisible(visible: boolean): void {
    this._visible = visible;
    if (this.group) this.group.visible = visible;
    // Force a rebuild on the next show so a stale window is never displayed.
    if (!visible) this.lastFocus.set(Infinity, Infinity, Infinity);
  }

  /**
   * Refreshes both line sets. Only call when visible — `debugRender` is not cheap.
   *
   * @param world - The Rapier world to draw.
   * @param heightfield - The terrain collider, or null if none has been built yet.
   * @param version - Rebuild counter from `PhysicsSystem`; a change invalidates the height cache.
   * @param focus - Point to centre the terrain window on (the player).
   *
   * @complexity Time: O(colliders + windowCells). The terrain window is only regenerated when the
   * focus moves more than `PHYSICS.debugRebuildDistance`, so the steady-state cost is the Rapier
   * pass alone.
   */
  render(
    world: RAPIER.World,
    heightfield: RAPIER.Collider | null,
    version: number,
    focus: THREE.Vector3,
  ): void {
    if (!this._visible || !this.colliderLines) return;

    // Everything except the terrain: capsule, rocks, dynamic bodies. The filter is the only way to
    // keep the heightfield out (disabling the collider does not exclude it from debugRender), and
    // ~1.5 M segments would hang the tab, so a breach of the cap retires the Rapier pass for good
    // rather than shipping that to the GPU.
    if (!this.colliderPassRetired) {
      const handle = heightfield?.handle;
      const buffers = world.debugRender(undefined, (c) => c.handle !== handle);
      if (buffers.vertices.length > PHYSICS.debugMaxSegments * 6) {
        this.colliderPassRetired = true;
        console.warn(
          `[PhysicsDebug] collider wireframe produced ${buffers.vertices.length / 6} segments ` +
            '(terrain filter failed?) — disabling it. The terrain wireframe is unaffected.',
        );
        this.colliderLines.geometry.setDrawRange(0, 0);
      } else {
        setAttribute(this.colliderLines.geometry, 'position', buffers.vertices, 3);
        setAttribute(this.colliderLines.geometry, 'color', buffers.colors, 4);
        this.colliderLines.geometry.setDrawRange(0, buffers.vertices.length / 3);
      }
    }

    if (!heightfield) return;
    if (version !== this.cachedVersion) this.readBackHeightfield(heightfield, version);
    if (focus.distanceToSquared(this.lastFocus) > PHYSICS.debugRebuildDistance ** 2) {
      this.lastFocus.copy(focus);
      this.rebuildTerrainWindow(focus);
    }
  }

  dispose(): void {
    for (const lines of [this.colliderLines, this.terrainLines]) {
      if (!lines) continue;
      lines.geometry.dispose();
      (lines.material as THREE.Material).dispose();
    }
    this.group?.removeFromParent();
    this.group = null;
    this.colliderLines = null;
    this.terrainLines = null;
    this.heights = null;
    this.cachedVersion = -1;
  }

  /** Pulls the collider's height matrix, dimensions and placement back out of WASM. */
  private readBackHeightfield(collider: RAPIER.Collider, version: number): void {
    this.heights = collider.heightfieldHeights();
    this.nrows = collider.heightfieldNRows();
    this.ncols = collider.heightfieldNCols();
    const s = collider.heightfieldScale();
    this.scale.set(s.x, s.y, s.z);
    const t = collider.translation();
    this.origin.set(t.x, t.y, t.z);
    this.cachedVersion = version;
    this.lastFocus.set(Infinity, Infinity, Infinity);
  }

  /**
   * Emits a grid of line segments over the heightfield vertices nearest `focus`.
   *
   * Index convention (measured; see `Heightfield.ts`): the vertex matrix is
   * `(nrows + 1) × (ncols + 1)` stored column-major, row `i` runs along +Z and column `j` along +X:
   *
   *     y = heights[i + j * (nrows + 1)] * scale.y
   *     x = (-0.5 + j / ncols) * scale.x + origin.x
   *     z = (-0.5 + i / nrows) * scale.z + origin.z
   */
  private rebuildTerrainWindow(focus: THREE.Vector3): void {
    const lines = this.terrainLines;
    const heights = this.heights;
    if (!lines || !heights || this.nrows < 1 || this.ncols < 1) return;

    const stride = this.nrows + 1;
    const cellX = this.scale.x / this.ncols;
    const cellZ = this.scale.z / this.nrows;

    // Vertex index of the focus point, then a symmetric window clipped to the field.
    const jc = Math.round(((focus.x - this.origin.x) / this.scale.x + 0.5) * this.ncols);
    const ic = Math.round(((focus.z - this.origin.z) / this.scale.z + 0.5) * this.nrows);
    const spanJ = Math.max(1, Math.round(PHYSICS.debugWireframeRadius / cellX));
    const spanI = Math.max(1, Math.round(PHYSICS.debugWireframeRadius / cellZ));
    const j0 = Math.max(0, Math.min(this.ncols, jc - spanJ));
    const j1 = Math.max(0, Math.min(this.ncols, jc + spanJ));
    const i0 = Math.max(0, Math.min(this.nrows, ic - spanI));
    const i1 = Math.max(0, Math.min(this.nrows, ic + spanI));

    const attr = lines.geometry.getAttribute('position') as THREE.BufferAttribute;
    const out = attr.array as Float32Array;
    const maxFloats = out.length;
    let n = 0;

    const vx = (j: number): number => (-0.5 + j / this.ncols) * this.scale.x + this.origin.x;
    const vz = (i: number): number => (-0.5 + i / this.nrows) * this.scale.z + this.origin.z;
    const vy = (i: number, j: number): number =>
      heights[i + j * stride] * this.scale.y + this.origin.y + SURFACE_LIFT;

    // Segments along +X (constant row) and along +Z (constant column).
    for (let i = i0; i <= i1 && n + 6 <= maxFloats; i++) {
      const z = vz(i);
      for (let j = j0; j < j1 && n + 6 <= maxFloats; j++) {
        out[n++] = vx(j);
        out[n++] = vy(i, j);
        out[n++] = z;
        out[n++] = vx(j + 1);
        out[n++] = vy(i, j + 1);
        out[n++] = z;
      }
    }
    for (let j = j0; j <= j1 && n + 6 <= maxFloats; j++) {
      const x = vx(j);
      for (let i = i0; i < i1 && n + 6 <= maxFloats; i++) {
        out[n++] = x;
        out[n++] = vy(i, j);
        out[n++] = vz(i);
        out[n++] = x;
        out[n++] = vy(i + 1, j);
        out[n++] = vz(i + 1);
      }
    }

    attr.needsUpdate = true;
    lines.geometry.setDrawRange(0, n / 3);
  }
}

/**
 * Replaces an attribute's buffer, reallocating only when the size actually changes — `debugRender`
 * returns a fresh array every call but its length is stable frame to frame.
 */
function setAttribute(
  geometry: THREE.BufferGeometry,
  name: string,
  data: Float32Array,
  itemSize: number,
): void {
  const existing = geometry.getAttribute(name) as THREE.BufferAttribute | undefined;
  if (existing && existing.array.length === data.length) {
    (existing.array as Float32Array).set(data);
    existing.needsUpdate = true;
    return;
  }
  geometry.setAttribute(name, new THREE.BufferAttribute(data, itemSize));
}
