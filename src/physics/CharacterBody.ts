/**
 * src/physics/CharacterBody.ts
 *
 * Contents: `CharacterBody`, the real `ICharacterBody` — a capsule on a position-based kinematic
 * rigid-body, moved through Rapier's built-in `KinematicCharacterController` so it walks up slopes,
 * steps over ledges, slides along walls and stays stuck to the ground going downhill.
 *
 * Purpose: WS3's `PlayerSystem` owns *intent* (how fast, which direction, when to jump); this class
 * owns *resolution* (where that intent actually lands once the terrain has had its say). The
 * contract is deliberately identical to WS0's `StubCharacterBody`, so player code written against
 * the stub keeps working unchanged:
 *
 *     body.velocity.y += PLAYER.gravity * dt;      // caller integrates
 *     body.move(body.velocity.clone().multiplyScalar(dt));
 *     if (body.grounded) { ... }                   // updated by move()
 *
 * `move()` takes a per-step world-space DELTA, not a velocity. `velocity` is a plain field the
 * caller owns; this class only ever *cancels* components of it that the world just refuted (landing
 * zeroes downward velocity, hitting a ceiling zeroes upward velocity).
 *
 * ── NOTES ───────────────────────────────────────────────────────────────────────────────────────
 *  - `position` is the capsule CENTRE, matching the stub. Feet are at `position.y - halfExtent`
 *    where `halfExtent = height/2 + radius`.
 *  - Snap-to-ground is switched off for any step with upward motion. Left on, it swallows jumps:
 *    the controller would drag the character straight back down to the surface it just left.
 *  - Ordering assumption: `PhysicsSystem` is registered first, so `world.step()` has already flushed
 *    last step's `setNextKinematicTranslation` into the collider before `move()` queries it. The
 *    collider therefore always sits exactly at `this.position` when a move starts.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PHYSICS, PLAYER } from '../config/world.config';
import { clamp, degToRad } from '../utils/math';
import { castRayRobust } from './Heightfield';
import type { ICharacterBody, IWorld } from '../core/types';

const UP = { x: 0, y: 1, z: 0 };
/** Below this the controller's reported movement counts as "we were stopped". */
const BLOCKED_EPSILON = 1e-4;

export class CharacterBody implements ICharacterBody {
  /** Capsule centre in world space. Read it; do not write it — use `move` / `teleport`. */
  readonly position = new THREE.Vector3();
  /** Owned by the caller (WS3). `move` only cancels components the world refuted. */
  readonly velocity = new THREE.Vector3();
  grounded = false;
  /** Up-facing surface normal under the feet. Stays (0,1,0) while airborne. */
  readonly groundNormal = new THREE.Vector3(0, 1, 0);

  // --- extras beyond ICharacterBody, free for WS3 to use ---------------------
  /** What the last `move` actually achieved, after collisions. */
  readonly lastMovement = new THREE.Vector3();
  /** True when the last `move` was obstructed (wall, ceiling, un-climbable slope). */
  blocked = false;
  /** Seconds since the character was last grounded. 0 while standing. Handy for coyote time. */
  timeSinceGrounded = 0;
  /** Incremented whenever the tunnelling backstop had to rescue the body. Should stay 0. */
  rescues = 0;

  /** Distance from the capsule centre to the lowest point of the capsule. */
  readonly halfExtent: number;

  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private snapEnabled = true;
  private disposed = false;

  /**
   * @param world - The live Rapier world.
   * @param sampler - Terrain source, used only by the tunnelling backstop and bounds clamp.
   * @param pos - Initial capsule centre.
   * @param radius - Capsule radius.
   * @param height - Cylindrical section height (total capsule height is `height + 2 * radius`).
   */
  constructor(
    private readonly world: RAPIER.World,
    private readonly sampler: IWorld,
    pos: THREE.Vector3,
    radius: number,
    height: number,
  ) {
    this.halfExtent = height * 0.5 + radius;
    this.position.copy(pos);

    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z),
    );
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(height * 0.5, radius).setFriction(0).setRestitution(0),
      this.body,
    );

    this.controller = world.createCharacterController(PHYSICS.characterOffset);
    this.controller.setUp(UP);
    this.controller.setSlideEnabled(true);
    this.controller.setMaxSlopeClimbAngle(degToRad(PLAYER.maxSlopeClimbDeg));
    this.controller.setMinSlopeSlideAngle(degToRad(PLAYER.minSlopeSlideDeg));
    this.controller.enableAutostep(PLAYER.autoStep, PHYSICS.autostepMinWidth, true);
    this.controller.enableSnapToGround(PLAYER.snapToGround);
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.controller.setCharacterMass(PHYSICS.characterMass);
  }

  /**
   * Resolves one step of intended motion against the world.
   *
   * @param desiredTranslation - World-space delta for this step (usually `velocity * dt`).
   *
   * @complexity Time: O(log n) BVH queries against the terrain BVH — one shape-cast sweep plus at
   * most one ground raycast. Space: O(1), no allocation on the hot path.
   */
  move(desiredTranslation: THREE.Vector3): void {
    if (this.disposed) return;
    const d = desiredTranslation;
    // A NaN here would silently poison the rigid-body and every system reading player position.
    if (!Number.isFinite(d.x) || !Number.isFinite(d.y) || !Number.isFinite(d.z)) {
      console.error('[CharacterBody] non-finite translation ignored:', d.x, d.y, d.z);
      return;
    }

    // Snap-to-ground would cancel a jump the instant it starts, so disable it while ascending.
    const wantSnap = d.y <= BLOCKED_EPSILON && this.velocity.y <= BLOCKED_EPSILON;
    if (wantSnap !== this.snapEnabled) {
      this.snapEnabled = wantSnap;
      if (wantSnap) this.controller.enableSnapToGround(PLAYER.snapToGround);
      else this.controller.disableSnapToGround();
    }

    // No JS filter predicate here (or in any query below): the controller already ignores the
    // collider it is moving, and Rapier 0.19.3's predicate path is unreliable — after a few hundred
    // filtered queries it silently starts reporting no hits. `filterExcludeCollider` is the
    // native mechanism, is cheaper, and does not have that problem.
    this.controller.computeColliderMovement(this.collider, d, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);

    const mv = this.controller.computedMovement();
    this.lastMovement.set(mv.x, mv.y, mv.z);
    this.position.x += mv.x;
    this.position.y += mv.y;
    this.position.z += mv.z;

    this.grounded = this.controller.computedGrounded();
    this.blocked =
      Math.abs(mv.x - d.x) > BLOCKED_EPSILON ||
      Math.abs(mv.y - d.y) > BLOCKED_EPSILON ||
      Math.abs(mv.z - d.z) > BLOCKED_EPSILON;

    // Landing kills downward speed; a ceiling kills upward speed. Without the second one, holding
    // jump under an overhang keeps accumulating velocity that fires the moment you step clear.
    if (this.grounded && this.velocity.y < 0) this.velocity.y = 0;
    else if (this.velocity.y > 0 && mv.y < d.y - BLOCKED_EPSILON) this.velocity.y = 0;

    this.updateGroundNormal();
    this.clampToWorld();
    this.rescueIfTunnelled();
    this.body.setNextKinematicTranslation(this.position);
  }

  /**
   * Advances the airborne timer. Optional — call once per fixed step if WS3 wants coyote time.
   * @param dt - Fixed timestep in seconds.
   */
  tick(dt: number): void {
    this.timeSinceGrounded = this.grounded ? 0 : this.timeSinceGrounded + dt;
  }

  /**
   * Convenience for WS3: launches the character if it is standing on something.
   * Equivalent to setting `velocity.y` yourself; this just packages the grounded check and makes
   * sure snap-to-ground cannot eat the first frame of the jump.
   *
   * @param speed - Initial upward speed in m/s (e.g. `PLAYER.jumpSpeed`).
   * @returns `true` if the jump was accepted.
   */
  jump(speed: number): boolean {
    if (!this.grounded) return false;
    this.velocity.y = speed;
    this.grounded = false;
    this.timeSinceGrounded = 0;
    this.snapEnabled = false;
    this.controller.disableSnapToGround();
    return true;
  }

  /**
   * Hard-sets the position, bypassing collision. Used for spawning and for WS3's tumble recovery.
   * @param pos - New capsule centre.
   */
  teleport(pos: THREE.Vector3): void {
    if (this.disposed) return;
    this.position.copy(pos);
    this.clampToWorld();
    this.velocity.set(0, 0, 0);
    this.lastMovement.set(0, 0, 0);
    this.grounded = false;
    this.blocked = false;
    this.groundNormal.set(0, 1, 0);
    // setTranslation + propagate makes the collider move NOW rather than at the next step, so an
    // immediately following `move()` sweeps from the new position instead of the old one.
    this.body.setTranslation(this.position, true);
    this.body.setNextKinematicTranslation(this.position);
    this.world.propagateModifiedBodyPositionsToColliders();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.world.removeCharacterController(this.controller);
    this.world.removeRigidBody(this.body); // also removes the attached collider
  }

  /**
   * Prefers a contact normal from the sweep (free); falls back to a short downward ray when the
   * controller snapped to ground without registering a collision.
   */
  private updateGroundNormal(): void {
    if (!this.grounded) {
      this.groundNormal.set(0, 1, 0);
      return;
    }

    let bestY = 0;
    let found = false;
    const count = this.controller.numComputedCollisions();
    for (let i = 0; i < count; i++) {
      const hit = this.controller.computedCollision(i);
      if (!hit) continue;
      // normal1 points out of the obstacle, so a floor's normal has a positive y.
      if (hit.normal1.y > bestY) {
        bestY = hit.normal1.y;
        this.groundNormal.set(hit.normal1.x, hit.normal1.y, hit.normal1.z);
        found = true;
      }
    }
    if (found && bestY > 0.1) return;

    this.ray.origin = this.position;
    this.ray.dir = { x: 0, y: -1, z: 0 };
    const hit = castRayRobust(
      this.world,
      this.ray,
      this.halfExtent + PLAYER.snapToGround + PHYSICS.characterOffset * 4,
      this.collider,
    );
    if (hit && hit.normal.y > 0) this.groundNormal.set(hit.normal.x, hit.normal.y, hit.normal.z);
    else this.groundNormal.set(0, 1, 0);
  }

  /**
   * The heightfield has no walls and nothing at all outside its footprint, so leaving it means
   * falling forever. Keep X/Z just inside the edge.
   */
  private clampToWorld(): void {
    const bound = this.sampler.data.size * 0.5 - PHYSICS.boundsMargin;
    this.position.x = clamp(this.position.x, -bound, bound);
    this.position.z = clamp(this.position.z, -bound, bound);
  }

  /**
   * Tunnelling backstop. If the capsule centre ends up far below the terrain surface, collision has
   * failed (or WS1 raised the ground out from under us) and we put the character back rather than
   * let it fall out of the world. This should never fire in normal play; `rescues` makes it visible.
   *
   * Two-stage on purpose. The cheap trigger is `IWorld.sampleHeight`, but the sampler can disagree
   * with the collider — most obviously while WS1's real heightmap is replacing the flat stub — and
   * a backstop that fights the geometry that actually exists is worse than no backstop at all. So a
   * trigger is confirmed with a raycast against the real collider before anything is moved.
   */
  private rescueIfTunnelled(): void {
    const groundY = this.sampler.sampleHeight(this.position.x, this.position.z);
    const finite = Number.isFinite(this.position.y);
    if (finite && this.position.y >= groundY - PHYSICS.rescueDepth) return;

    // Confirm against the collider: find the true surface by dropping a ray from well above it.
    const span = this.sampler.data.size;
    const sky = Math.max(groundY, finite ? this.position.y : groundY) + span;
    this.ray.origin = { x: this.position.x, y: sky, z: this.position.z };
    this.ray.dir = { x: 0, y: -1, z: 0 };
    const hit = castRayRobust(this.world, this.ray, span * 3, this.collider);
    const surfaceY = hit ? sky - hit.timeOfImpact : groundY;
    if (finite && this.position.y >= surfaceY - PHYSICS.rescueDepth) return;

    this.rescues++;
    // Loud the first few times, then occasional, so a systemic failure cannot flood the console.
    if (this.rescues <= 3 || this.rescues % 60 === 0) {
      console.warn(
        `[CharacterBody] tunnelling backstop fired (#${this.rescues}) at ` +
          `(${this.position.x.toFixed(1)}, ${this.position.z.toFixed(1)}) — snapping to ` +
          `y=${surfaceY.toFixed(2)}`,
      );
    }
    this.position.y = surfaceY + this.halfExtent + PHYSICS.characterOffset;
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    this.groundNormal.set(0, 1, 0);
  }
}
