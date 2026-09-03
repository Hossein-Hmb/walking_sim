/**
 * src/physics/PhysicsSystem.ts
 *
 * Contents: `PhysicsSystem` — the real `IPhysics`. Owns the Rapier world, the terrain heightfield
 * collider, every `CharacterBody`, static trimesh colliders (WS5's rocks), raycasts, the fixed-step
 * simulation call, and the F1 collider wireframe.
 *
 * Purpose: replaces WS0's `StubPhysics`. It is both a service (`IPhysics`, reached through
 * `ctx.physics`) and a `System` (registered FIRST, so everything else sees a world that has already
 * been stepped this tick).
 *
 * ── HOW THE TERRAIN GETS IN ─────────────────────────────────────────────────────────────────────
 * Registration order is Physics → World, so at `init()` time WS1's terrain may still be a flat
 * placeholder. Two paths cover that:
 *   1. `init()` builds a heightfield from whatever `ctx.world.data` holds right now, so there is
 *      solid ground from the very first frame.
 *   2. It subscribes to `world:ready` and rebuilds from the payload. Swapping WS1's real heightmap
 *      in is literally one call — `addHeightfield(data)` — and it is already wired.
 * Rapier copies heights into WASM memory, so mutating `WorldData.heights` in place is NOT enough;
 * WS1 must emit `world:ready` (or call `addHeightfield`) after any edit. See `Heightfield.ts`.
 *
 * ── FIXED STEP ──────────────────────────────────────────────────────────────────────────────────
 * The Engine already owns the 60 Hz accumulator and caps catch-up at `RENDER.maxFixedStepsPerFrame`
 * (PLAN.md's spiral-of-death guard), so this system just steps once per `fixedUpdate` and reports
 * its cost to the F1 overlay as `physics`.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PLAYER } from '../config/world.config';
import { perf } from '../utils/Perf';
import type {
  GameContext,
  ICharacterBody,
  IPhysics,
  IWorld,
  RaycastHit,
  System,
  WorldData,
} from '../core/types';
import { CharacterBody } from './CharacterBody';
import {
  castRayRobust,
  createHeightfieldDesc,
  packHeightsForRapier,
  probeHeightfieldConvention,
  verifySamplerAgreement,
} from './Heightfield';
import { PhysicsDebug } from './PhysicsDebug';

export class PhysicsSystem implements IPhysics, System {
  readonly name = 'physics';
  readonly world: RAPIER.World;

  /** The terrain collider, or null before the first `addHeightfield`. */
  private heightfield: RAPIER.Collider | null = null;
  /** Bumped on every heightfield rebuild so the debug wireframe knows to re-read it. */
  private heightfieldVersion = 0;
  /** Reused transpose buffer — a rebuild should not allocate a megabyte every time. */
  private packedHeights: Float32Array | null = null;

  private readonly characters: CharacterBody[] = [];
  private readonly debug = new PhysicsDebug();
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private readonly focus = new THREE.Vector3();
  private unsubscribe: Array<() => void> = [];

  /**
   * @param sampler - The world service. Held so characters can use the tunnelling backstop and so
   *   the sampler-vs-raycast agreement test has a reference to compare against.
   *
   * `RAPIER.init()` must already have been awaited (main.ts does it).
   */
  constructor(private readonly sampler: IWorld) {
    this.world = new RAPIER.World({ x: 0, y: PLAYER.gravity, z: 0 });
  }

  // -------------------------------------------------------------------------
  // System lifecycle
  // -------------------------------------------------------------------------

  init(ctx: GameContext): void {
    // Prove the index order before trusting it with the real island. Cheap, and it is the only
    // check that can fail while WS1's world is still a symmetric flat plane.
    const probe = probeHeightfieldConvention();
    for (const line of probe.details) (probe.ok ? console.info : console.error)(`[physics] ${line}`);

    this.addHeightfield(ctx.world.data);

    // WS1 generates in a worker; rebuild the collider the moment the real heights land.
    this.unsubscribe.push(
      ctx.events.on('world:ready', ({ data }) => {
        this.addHeightfield(data);
        this.reportSamplerAgreement(ctx.world);
      }),
    );
    this.unsubscribe.push(
      ctx.events.on('debug:toggle', ({ active }) => this.debug.setVisible(active)),
    );

    this.debug.attach(ctx.scene);
    this.reportSamplerAgreement(ctx.world);
  }

  fixedUpdate(dt: number, _ctx: GameContext): void {
    const t0 = performance.now();
    if (this.world.timestep !== dt) this.world.timestep = dt;
    this.world.step();
    for (const c of this.characters) c.tick(dt);
    perf.mark('physics', performance.now() - t0);
  }

  update(_dt: number, ctx: GameContext): void {
    if (!this.debug.visible) return;
    this.focus.copy(ctx.player.position);
    this.debug.render(this.world, this.heightfield, this.heightfieldVersion, this.focus);
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.debug.dispose();
    for (const c of this.characters) c.dispose();
    this.characters.length = 0;
    this.heightfield = null;
    this.world.free();
  }

  // -------------------------------------------------------------------------
  // IPhysics
  // -------------------------------------------------------------------------

  /**
   * (Re)builds the single static terrain collider from a heightmap. Idempotent — call it again
   * whenever the heights change (WS1's worker finishing, river carving, an editor tweak).
   *
   * @param data - Source of truth. `heights` is row-major `[z * resolution + x]`; this method
   *   performs the transpose into Rapier's column-major layout. See `Heightfield.ts` for why.
   *
   * @complexity Time: O(resolution²) for the transpose plus Rapier's BVH build (~40 ms for 513²).
   * Space: O(resolution²), reusing the same staging buffer across rebuilds.
   */
  addHeightfield(data: WorldData): void {
    if (this.heightfield) {
      this.world.removeCollider(this.heightfield, false);
      this.heightfield = null;
    }
    const cells = data.resolution * data.resolution;
    if (!this.packedHeights || this.packedHeights.length !== cells) {
      this.packedHeights = new Float32Array(cells);
    }
    packHeightsForRapier(data.heights, data.resolution, this.packedHeights);
    this.heightfield = this.world.createCollider(createHeightfieldDesc(data, this.packedHeights));
    this.heightfieldVersion++;
    // Ray/shape queries return nothing until the broad-phase has seen the new collider, and both
    // spawn placement and the agreement test query immediately after this returns.
    this.world.step();
  }

  /**
   * @param pos - Initial capsule centre.
   * @param radius - Capsule radius.
   * @param height - Cylindrical section height; total capsule height is `height + 2 * radius`.
   */
  createCharacter(pos: THREE.Vector3, radius: number, height: number): ICharacterBody {
    const body = new CharacterBody(this.world, this.sampler, pos, radius, height);
    this.characters.push(body);
    return body;
  }

  /**
   * Closest hit along a ray.
   *
   * @param origin - World-space start point.
   * @param dir - Direction; treat as normalised, since `distance` is reported in units of `dir`.
   * @param maxToi - Maximum distance (times `|dir|`) to search.
   * @returns The nearest hit, or null. `colliderHandle` is Rapier's own handle value. `point` is
   *   reconstructed from the caller's origin, so on the retry path of `castRayRobust` it can sit up
   *   to 1.4 mm laterally from the exact surface intersection.
   *
   * @complexity Time: O(log n) against the BVH. Space: O(1) except the returned vectors.
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxToi: number): RaycastHit | null {
    this.ray.origin = origin;
    this.ray.dir = dir;
    const hit = castRayRobust(this.world, this.ray, maxToi);
    if (!hit) return null;
    return {
      point: origin.clone().addScaledVector(dir, hit.timeOfImpact),
      normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      distance: hit.timeOfImpact,
      colliderHandle: hit.collider.handle,
    };
  }

  /**
   * Static triangle-mesh collider, for WS5's near-field rocks and anything else with real geometry.
   *
   * @param geom - Source geometry. Read through the attribute accessors, so interleaved or
   *   non-Float32 buffers are handled; the geometry itself is not retained.
   * @param pos - World-space translation applied to the mesh.
   * @returns A handle for `removeCollider`. Rapier handles are opaque numbers — do not do
   *   arithmetic on them.
   *
   * @complexity Time: O(triangles) to copy plus Rapier's BVH build. Space: O(triangles).
   */
  addStaticTrimesh(geom: THREE.BufferGeometry, pos: THREE.Vector3): number {
    const posAttr = geom.getAttribute('position');
    if (!posAttr) throw new Error('[physics] addStaticTrimesh: geometry has no position attribute');

    const vertexCount = posAttr.count;
    const vertices = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
      vertices[i * 3] = posAttr.getX(i);
      vertices[i * 3 + 1] = posAttr.getY(i);
      vertices[i * 3 + 2] = posAttr.getZ(i);
    }

    let indices: Uint32Array;
    if (geom.index) {
      const src = geom.index;
      indices = new Uint32Array(src.count);
      for (let i = 0; i < src.count; i++) indices[i] = src.getX(i);
    } else {
      indices = new Uint32Array(vertexCount);
      for (let i = 0; i < vertexCount; i++) indices[i] = i;
    }

    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.trimesh(vertices, indices).setTranslation(pos.x, pos.y, pos.z),
    );
    return collider.handle;
  }

  /**
   * @param handle - A handle previously returned by `addStaticTrimesh`. Unknown or already-removed
   *   handles are ignored rather than throwing, because WS5 rebuilds scatter colliders on every
   *   chunk change and double-frees are easy to write.
   */
  removeCollider(handle: number): void {
    try {
      const collider = this.world.getCollider(handle);
      if (collider) this.world.removeCollider(collider, true);
    } catch {
      /* stale handle — nothing to remove */
    }
  }

  // -------------------------------------------------------------------------
  // Diagnostics (also reachable from the console via `window.strandfall.ctx.physics`)
  // -------------------------------------------------------------------------

  /**
   * Runs the `sampleHeight`-vs-raycast agreement test and logs the outcome.
   * PLAN.md §Risks 1 asks for exactly this; see `verifySamplerAgreement` for the two thresholds.
   *
   * @param world - The world to compare against. Defaults to the one this system was built with.
   */
  reportSamplerAgreement(world: IWorld = this.sampler): boolean {
    const result = verifySamplerAgreement(this, world);
    for (const line of result.details) {
      (result.ok ? console.info : console.error)(`[physics] ${line}`);
    }
    return result.ok;
  }
}
