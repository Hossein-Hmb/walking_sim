/**
 * src/player/ThirdPersonCamera.ts
 *
 * Contents: `ThirdPersonCamera` — the follow rig. A damped orbit boom behind the player with mouse /
 * gamepad look, obstruction pull-in, a terrain-height floor, auto-alignment behind the direction of
 * travel, and a small FOV punch while sprinting.
 *
 * Purpose: PLAN.md WS3 requires that the camera "never ends up inside terrain". Two independent
 * mechanisms enforce that, because either one alone has a failure mode:
 *
 *   1. A five-ray probe along the boom (centre ray plus four offset by `CAMERA_RIG.probeOffset`,
 *      approximating a sphere cast — `IPhysics` exposes only `raycast`). The boom is shortened to
 *      the nearest hit minus `CAMERA.collisionPad`. This catches cliffs, rocks and anything else
 *      with a collider. See `PROBE_START` for why the rays do not begin at the focus point.
 *   2. A hard floor at `IWorld.sampleHeight(camera.xz) + collisionPad`. This catches the case ray
 *      probes miss entirely: standing at the foot of a smooth rise, where the boom passes over the
 *      hill crest and lands underground behind it.
 *
 * Both are used defensively (`typeof` guarded) so the rig degrades gracefully rather than throwing
 * if it is ever handed a world or physics service that does not implement them.
 *
 * The rig smooths the FOCUS point, not the camera position: the boom itself is then placed rigidly
 * from the smoothed focus. Damping the final position instead would let the camera lag *through* a
 * wall on a fast direction change, which is precisely the artefact this system exists to prevent.
 */

import * as THREE from "three";
import { CAMERA, CAMERA_RIG, INPUT, PLAYER } from "../config/world.config";
import { clamp, clamp01, damp, dampAngle } from "../utils/math";
import type { GameContext, System } from "../core/types";
import type { Unsubscribe } from "../core/EventBus";

const UP = new THREE.Vector3(0, 1, 0);
/** FOV changes below this many degrees are not worth a projection-matrix rebuild. */
const FOV_EPSILON = 0.01;
/**
 * Probes start this far along the boom instead of at the focus point.
 *
 * The focus sits inside the player's own capsule, and `IPhysics.raycast` has no collider-exclusion
 * parameter — a ray started there hits the player at distance 0 every single frame and slams the
 * camera to `minDistance`. Starting just beyond the capsule (half-height + radius, plus a margin)
 * sidesteps that without needing WS2 to widen the shared interface. Nothing is missed: the boom is
 * never allowed inside this radius anyway, since it is shorter than `CAMERA_RIG.minDistance`.
 */
const PROBE_START = PLAYER.height * 0.5 + PLAYER.radius + 0.15;

export class ThirdPersonCamera implements System {
  readonly name = "camera";

  /** Where the boom currently points, and where the player is steering it. */
  private yaw = 0;
  private targetYaw = 0;
  private pitch = 0.25;
  private targetPitch = 0.25;

  /** Current boom length after obstruction pull-in. */
  private distance: number = CAMERA.distance;
  private fov: number = CAMERA.fov;
  private lookIdleTime = 0;
  private enabled = true;
  private unsubscribe: Unsubscribe | null = null;

  // Scratch — the update path must not allocate.
  private readonly focus = new THREE.Vector3();
  private readonly desiredFocus = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly probeOrigin = new THREE.Vector3();
  private readonly probeRight = new THREE.Vector3();
  private readonly probeUp = new THREE.Vector3();

  init(ctx: GameContext): void {
    ctx.camera.fov = this.fov;

    // Start behind whatever direction the player spawned facing, and snap — no fly-in on frame 1.
    this.desiredFocus
      .copy(ctx.player.position)
      .addScaledVector(UP, this.focusHeight());
    this.focus.copy(this.desiredFocus);

    const site = ctx.world.data.landmarks?.[0];
    if (site) {
      this.yaw = site.spawnYaw;
      this.targetYaw = site.spawnYaw;
    }

    this.placeCamera(ctx, this.distance);

    // WS6's photo mode takes the camera over completely.
    this.unsubscribe = ctx.events.on("photo:toggle", ({ active }) => {
      this.enabled = !active;
    });
  }

  update(dt: number, ctx: GameContext): void {
    if (!this.enabled) return;

    this.applyLook(dt, ctx);
    this.applyAutoAlign(dt, ctx);

    this.yaw = dampAngle(this.yaw, this.targetYaw, CAMERA.rotateDamp, dt);
    this.pitch = damp(this.pitch, this.targetPitch, CAMERA.rotateDamp, dt);

    this.desiredFocus
      .copy(ctx.player.position)
      .addScaledVector(UP, this.focusHeight());
    this.focus.set(
      damp(this.focus.x, this.desiredFocus.x, CAMERA.followDamp, dt),
      damp(this.focus.y, this.desiredFocus.y, CAMERA.followDamp, dt),
      damp(this.focus.z, this.desiredFocus.z, CAMERA.followDamp, dt),
    );

    const wanted =
      CAMERA.distance +
      (ctx.player.isTumbling ? CAMERA_RIG.tumbleDistanceBoost : 0);
    const free = this.probeDistance(ctx, wanted);
    // Pull in immediately (a frame inside a rock is a frame too many); ease back out slowly.
    const lambda =
      free < this.distance ? CAMERA_RIG.pullInLambda : CAMERA_RIG.pullOutLambda;
    this.distance = damp(this.distance, free, lambda, dt);

    this.placeCamera(ctx, this.distance);
    this.applyFov(dt, ctx);

    ctx.player.cameraYaw = this.yaw;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // -------------------------------------------------------------------------

  private focusHeight(): number {
    return CAMERA.height * CAMERA_RIG.focusHeightScale;
  }

  private applyLook(dt: number, ctx: GameContext): void {
    const look = ctx.input.state.look;
    if (look.x !== 0 || look.y !== 0) {
      this.targetYaw -= look.x * INPUT.lookSensitivity;
      this.targetPitch = clamp(
        this.targetPitch + look.y * INPUT.lookSensitivity,
        CAMERA.minPitch,
        CAMERA.maxPitch,
      );
      this.lookIdleTime = 0;
    } else {
      this.lookIdleTime += dt;
    }
  }

  /**
   * Drifts the boom back behind the direction of travel, so a player who never touches the mouse
   * still gets a usable camera.
   *
   * Only engages when the player is not strafing hard: movement is camera-relative, so rotating the
   * camera toward a sideways velocity would rotate the velocity too — a feedback loop that spirals.
   * With mostly-forward input the velocity already points along the boom, making this a no-op except
   * when terrain deflects the player, which is exactly when the correction is wanted.
   */
  private applyAutoAlign(dt: number, ctx: GameContext): void {
    if (this.lookIdleTime < CAMERA_RIG.autoAlignIdleSeconds) return;
    const player = ctx.player;
    if (!player.grounded || player.isTumbling) return;
    if (Math.abs(ctx.input.state.move.x) > CAMERA_RIG.autoAlignStrafeLimit)
      return;
    if (ctx.input.state.move.y <= 0) return;

    const v = player.velocity;
    if (v.x * v.x + v.z * v.z < 1) return;

    // The camera sits at yaw (sin, cos) from the focus, so the player faces -(sin, cos).
    const desiredYaw = Math.atan2(-v.x, -v.z);
    this.targetYaw = dampAngle(
      this.targetYaw,
      desiredYaw,
      CAMERA_RIG.autoAlignLambda,
      dt,
    );
  }

  /** Places the camera on the boom at `distance`, then applies the terrain-height floor. */
  private placeCamera(ctx: GameContext, distance: number): void {
    const cp = Math.cos(this.pitch);
    this.offset.set(
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cp,
    );
    ctx.camera.position.copy(this.focus).addScaledVector(this.offset, distance);

    const world = ctx.world;
    if (typeof world?.sampleHeight === "function") {
      const floor =
        world.sampleHeight(ctx.camera.position.x, ctx.camera.position.z) +
        CAMERA.collisionPad;
      if (ctx.camera.position.y < floor) ctx.camera.position.y = floor;
    }

    ctx.camera.lookAt(this.focus);
  }

  /**
   * Five-ray approximation of a sphere cast from the focus out along the boom.
   *
   * @returns the longest un-obstructed boom length, in [CAMERA_RIG.minDistance, wanted].
   * @complexity Time: O(1) — exactly `CAMERA_RIG.probeRays + 1` raycasts per frame.
   */
  private probeDistance(ctx: GameContext, wanted: number): number {
    const physics = ctx.physics;
    if (typeof physics?.raycast !== "function") return wanted;

    const cp = Math.cos(this.pitch);
    this.dir
      .set(
        Math.sin(this.yaw) * cp,
        Math.sin(this.pitch),
        Math.cos(this.yaw) * cp,
      )
      .normalize();
    // A stable basis perpendicular to the boom for the offset rays.
    this.probeRight.crossVectors(this.dir, UP);
    if (this.probeRight.lengthSq() < 1e-6) this.probeRight.set(1, 0, 0);
    this.probeRight.normalize();
    this.probeUp.crossVectors(this.probeRight, this.dir).normalize();

    const pad = CAMERA.collisionPad;
    const reach = wanted + pad - PROBE_START;
    if (reach <= 0) return clamp(wanted, CAMERA_RIG.minDistance, wanted);

    let nearest = wanted;
    const r = CAMERA_RIG.probeOffset;

    for (let i = 0; i <= CAMERA_RIG.probeRays; i++) {
      this.probeOrigin.copy(this.focus).addScaledVector(this.dir, PROBE_START);
      if (i > 0) {
        // 4 rays at 90° around the boom: +right, -right, +up, -up.
        const axis = i <= 2 ? this.probeRight : this.probeUp;
        this.probeOrigin.addScaledVector(axis, i % 2 === 1 ? r : -r);
      }
      const hit = physics.raycast(this.probeOrigin, this.dir, reach);
      if (!hit) continue;
      const free = PROBE_START + hit.distance - pad;
      if (free < nearest) nearest = free;
    }

    return clamp(nearest, CAMERA_RIG.minDistance, wanted);
  }

  /** A few degrees of extra FOV at full sprint — cheap, and it sells the speed. */
  private applyFov(dt: number, ctx: GameContext): void {
    const speed = ctx.player.horizontalSpeed ?? 0;
    const punch =
      clamp01(
        (speed - PLAYER.walkSpeed) /
          Math.max(PLAYER.sprintSpeed - PLAYER.walkSpeed, 1e-3),
      ) * CAMERA_RIG.sprintFovPunch;
    this.fov = damp(this.fov, CAMERA.fov + punch, CAMERA_RIG.fovLambda, dt);
    if (Math.abs(ctx.camera.fov - this.fov) > FOV_EPSILON) {
      ctx.camera.fov = this.fov;
      ctx.camera.updateProjectionMatrix();
    }
  }
}
