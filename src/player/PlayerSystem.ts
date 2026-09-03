/**
 * src/player/PlayerSystem.ts
 *
 * Contents: `PlayerSystem` — the locomotion controller. Camera-relative walking and sprinting,
 * buffered/coyote-time jumping, the stamina economy, the balance meter, and the tumble → recover
 * state machine. It owns the `PlayerAvatar` view object and publishes `ctx.player` every fixed step.
 *
 * Purpose: this is "the feel of the game" (PLAN.md WS3). Everything here runs in `fixedUpdate` at a
 * locked 60 Hz and uses `damp` rather than `lerp`, so jump height, jump distance and acceleration
 * are identical at 30 fps and at 144 fps.
 *
 * Dependencies: only the `ICharacterBody` interface from WS2 (obtained via `ctx.physics`) and the
 * `IWorld` sampler from WS1. It runs unchanged against WS0's `StubPhysics`/`StubWorld` and will keep
 * running unchanged once the real Rapier controller and procedural island land — no import of any
 * concrete implementation appears in this file.
 *
 * State machine:
 *
 *        ┌──────── balance <= 0, or a hard landing ────────┐
 *        │                                                 ▼
 *   [controlled] ◄── recover timer elapses ── [recover] ◄── settled, or the tumble
 *        ▲                                                 hard-timeout fires
 *        └───────────────── (jump / fall / land keep you in `controlled`)
 *
 * `BALANCE.tumbleMaxSeconds` is the anti-soft-lock guarantee: a tumble ALWAYS ends, even if the
 * player is still sliding down a cliff face when the timer expires.
 */

import * as THREE from 'three';
import { BALANCE, LOCOMOTION, PLAYER, WORLD } from '../config/world.config';
import { clamp, clamp01, degToRad, mulberry32, remap } from '../utils/math';
import type {
  BiomeName,
  BiomeWeights,
  GameContext,
  ICharacterBody,
  InputState,
  IPlayerState,
  PlayerLocomotion,
  System,
} from '../core/types';
import type { Unsubscribe } from '../core/EventBus';
import { PlayerAvatar, type AvatarFrame } from './PlayerAvatar';

const SAFE_SLOPE = degToRad(BALANCE.safeSlopeDeg);
const CRITICAL_SLOPE = degToRad(BALANCE.criticalSlopeDeg);
/** A dominant biome must be at least this strong before we announce a biome change. Hysteresis. */
const BIOME_SWITCH_WEIGHT = 0.5;
/** Below this the player is considered standing still (avoids `idle`/`walk` flicker). */
const IDLE_SPEED = 0.25;
/** Anything under this Y is a bug (or a hole in a not-yet-finished heightfield): respawn. */
const VOID_Y = -200;

export class PlayerSystem implements System {
  readonly name = 'player';

  private body!: ICharacterBody;
  private avatar!: PlayerAvatar;
  private state!: IPlayerState;
  private readonly spawn = new THREE.Vector3();

  /** Distance from the body centre to the soles of its feet. */
  private readonly halfExtent = PLAYER.height * 0.5 + PLAYER.radius;

  // --- state machine ---
  private tumbling = false;
  private tumbleTime = 0;
  private recoverTimer = 0;
  private exhausted = false;
  private sprinting = false;
  private frozen = false;

  // --- timers / latches ---
  private jumpBuffer = 0;
  private jumpLatched = false;
  private coyote = 0;

  // --- sampled ground info, refreshed once per fixed step ---
  private slope = 0;
  private readonly downhill = new THREE.Vector2();
  private currentBiome: BiomeName = 'grass';

  private unsubscribe: Unsubscribe | null = null;

  // Scratch vectors — `fixedUpdate` must not allocate.
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly step = new THREE.Vector3();
  private readonly avatarFrame: AvatarFrame = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    groundNormal: new THREE.Vector3(0, 1, 0),
    grounded: false,
    tumbling: false,
  };

  init(ctx: GameContext): void {
    this.state = ctx.player;

    // Deterministic spawn: same seed ⇒ same starting beach.
    const spawn = ctx.world.findSpawnPoint(mulberry32(WORLD.seed ^ 0x5f3a));
    spawn.y = ctx.world.sampleHeight(spawn.x, spawn.z) + this.halfExtent;
    this.spawn.copy(spawn);

    this.body = ctx.physics.createCharacter(spawn, PLAYER.radius, PLAYER.height);
    this.avatar = new PlayerAvatar(ctx.scene, spawn);

    this.state.position.copy(spawn);
    this.state.velocity.set(0, 0, 0);
    this.state.stamina = 1;
    this.state.balance = 1;
    this.state.isTumbling = false;
    this.state.biome = ctx.world.sampleBiome(spawn.x, spawn.z);
    this.currentBiome = dominantBiome(this.state.biome) ?? 'grass';

    // WS6's photo mode detaches the camera and freezes time; the player must not drift meanwhile.
    this.unsubscribe = ctx.events.on('photo:toggle', ({ active }) => {
      this.frozen = active;
    });

    ctx.events.emit('player:spawned', { position: spawn.clone() });
  }

  fixedUpdate(dt: number, ctx: GameContext): void {
    if (this.frozen) return;
    const body = this.body;
    const input = ctx.input.state;

    const p = body.position;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z) || p.y < VOID_Y) {
      this.respawn(ctx);
      return;
    }

    this.sampleGround(ctx);

    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    if (input.jump && !this.jumpLatched) {
      this.jumpBuffer = LOCOMOTION.jumpBufferSeconds;
      this.jumpLatched = true;
    }
    this.coyote = body.grounded ? LOCOMOTION.coyoteSeconds : Math.max(0, this.coyote - dt);

    const wasGrounded = body.grounded;

    if (this.tumbling) this.stepTumble(dt);
    else if (this.recoverTimer > 0) this.stepRecover(dt);
    else this.stepControlled(dt, ctx, input);

    body.velocity.y += PLAYER.gravity * dt;
    if (body.velocity.y < -LOCOMOTION.terminalVelocity) {
      body.velocity.y = -LOCOMOTION.terminalVelocity;
    }

    // Captured before the move: `body.move` is what zeroes vertical speed on contact.
    const impact = Math.max(0, -body.velocity.y);
    this.step.copy(body.velocity).multiplyScalar(dt);
    body.move(this.step);

    if (body.grounded && !wasGrounded) this.onLanded(ctx, impact);

    this.publish(ctx);
  }

  update(dt: number, ctx: GameContext): void {
    if (!this.frozen) {
      const f = this.avatarFrame;
      f.position.copy(this.body.position);
      f.velocity.copy(this.body.velocity);
      f.groundNormal.copy(this.body.groundNormal);
      f.grounded = this.body.grounded;
      f.tumbling = this.tumbling;
      this.avatar.update(dt, ctx.time.elapsed, f);
    }
    // Released here, at the end of the frame, so that a single Space press arms the jump buffer
    // exactly once no matter how many fixed steps ran inside this frame.
    this.jumpLatched = false;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.avatar?.dispose();
  }

  // -------------------------------------------------------------------------
  // Ground sampling
  // -------------------------------------------------------------------------

  /**
   * Refreshes `slope` and `downhill` for this step.
   *
   * The horizontal part of a surface normal points in the direction of steepest DESCENT, which is
   * exactly what both the climb penalty and the tumble slide need — so one normalisation serves both.
   */
  private sampleGround(ctx: GameContext): void {
    const n = this.body.groundNormal;
    const p = this.body.position;

    this.slope =
      this.body.grounded && n.lengthSq() > 1e-6
        ? Math.acos(clamp(n.y, -1, 1))
        : ctx.world.sampleSlope(p.x, p.z);

    this.downhill.set(n.x, n.z);
    if (this.downhill.lengthSq() > 1e-8) this.downhill.normalize();
    else this.downhill.set(0, 0);
  }

  /** 0 = flat or heading downhill, → 1 = climbing straight up a wall. */
  private climbFactor(moveDir: THREE.Vector3): number {
    if (this.downhill.lengthSq() < 1e-8) return 0;
    const intoSlope = -(moveDir.x * this.downhill.x + moveDir.z * this.downhill.y);
    return clamp01(intoSlope) * Math.sin(this.slope);
  }

  private isWading(): boolean {
    return this.body.position.y - this.halfExtent < WORLD.seaLevel;
  }

  // -------------------------------------------------------------------------
  // Controlled locomotion
  // -------------------------------------------------------------------------

  private stepControlled(dt: number, ctx: GameContext, input: InputState): void {
    const body = this.body;
    const st = this.state;

    this.updateBasis(ctx);
    this.desired
      .set(0, 0, 0)
      .addScaledVector(this.forward, input.move.y)
      .addScaledVector(this.right, input.move.x);

    const inputMag = clamp01(this.desired.length());
    const moving = inputMag > LOCOMOTION.moveDeadzone;
    if (moving) this.desired.normalize();
    else this.desired.set(0, 0, 0);

    // --- sprint gating: exhaustion latches until stamina has meaningfully recovered ---
    if (this.exhausted && st.stamina >= LOCOMOTION.sprintResumeStamina) this.exhausted = false;
    this.sprinting =
      input.sprint &&
      moving &&
      body.grounded &&
      !this.exhausted &&
      st.stamina > LOCOMOTION.sprintStaminaFloor;

    // --- speed: slope, water and unsteadiness all bite into it ---
    const climb = this.climbFactor(this.desired);
    let speed = (this.sprinting ? PLAYER.sprintSpeed : PLAYER.walkSpeed) *
      (1 - LOCOMOTION.slopeSlowdown * climb);
    if (this.isWading()) speed *= LOCOMOTION.wadeSpeedScale;
    speed *= remap(st.balance, 0, 0.5, 0.65, 1);

    const targetSpeed = speed * inputMag;
    const lambda = body.grounded ? LOCOMOTION.groundAccelLambda : LOCOMOTION.airAccelLambda;
    const k = 1 - Math.exp(-lambda * dt);
    body.velocity.x += (this.desired.x * targetSpeed - body.velocity.x) * k;
    body.velocity.z += (this.desired.z * targetSpeed - body.velocity.z) * k;

    // --- jump: buffered press + coyote grace, so both early and late presses feel fair ---
    if (this.jumpBuffer > 0 && this.coyote > 0) {
      body.velocity.y = PLAYER.jumpSpeed;
      this.jumpBuffer = 0;
      this.coyote = 0;
      // Stamina is parked — this is a walk, not a game. Restore these two lines to turn it back on.
      // st.stamina = clamp01(st.stamina - LOCOMOTION.jumpStaminaCost);
    }

    // this.updateStamina(dt, moving, climb);
    this.updateBalance(dt, ctx);
  }

  /**
   * Movement is relative to where the camera is looking, derived from the camera→player vector
   * rather than the camera's forward axis: it stays well-defined when the player looks straight
   * down, and it is what the player actually perceives as "away from me".
   */
  private updateBasis(ctx: GameContext): void {
    this.forward.copy(this.body.position).sub(ctx.camera.position);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) {
      ctx.camera.getWorldDirection(this.forward);
      this.forward.y = 0;
    }
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, -1);
    this.forward.normalize();
    // right = forward × up
    this.right.set(-this.forward.z, 0, this.forward.x);
  }

  private updateStamina(dt: number, moving: boolean, climb: number): void {
    const st = this.state;
    let drain = 0;
    if (moving && this.body.grounded) {
      if (this.sprinting) drain += PLAYER.staminaDrainSprint;
      drain += PLAYER.staminaDrainSlope * climb * (this.sprinting ? LOCOMOTION.sprintSlopeScale : 1);
    }

    if (drain > 0) {
      st.stamina = clamp01(st.stamina - drain * dt);
      if (st.stamina <= 0) this.exhausted = true;
    } else {
      // Walking still recovers, just at half rate; falling barely recovers at all.
      const regen = PLAYER.staminaRegen * (moving ? 0.5 : 1) * (this.body.grounded ? 1 : 0.35);
      st.stamina = clamp01(st.stamina + regen * dt);
    }
  }

  private updateBalance(dt: number, ctx: GameContext): void {
    const st = this.state;
    const speed = Math.hypot(this.body.velocity.x, this.body.velocity.z);
    const steep = remap(this.slope, SAFE_SLOPE, CRITICAL_SLOPE, 0, 1);

    let drain = 0;
    if (this.body.grounded && steep > 0) {
      // Standing still on a steep face is survivable; crossing it at speed is not.
      drain = BALANCE.slopeDrainPerSecond * steep * (0.35 + 0.65 * clamp01(speed / PLAYER.sprintSpeed));
      if (this.sprinting) drain *= BALANCE.sprintPenalty;
      if (st.stamina <= 1e-3) drain *= BALANCE.exhaustionPenalty;
    }

    if (drain > 0) {
      st.balance = clamp01(st.balance - drain * dt);
      if (st.balance <= 0) this.beginTumble(ctx);
    } else if (this.body.grounded) {
      st.balance = clamp01(st.balance + BALANCE.regenPerSecond * dt);
    }
  }

  // -------------------------------------------------------------------------
  // Tumble / recover
  // -------------------------------------------------------------------------

  private beginTumble(ctx: GameContext): void {
    if (this.tumbling) return;
    this.tumbling = true;
    this.tumbleTime = 0;
    this.recoverTimer = 0;
    this.jumpBuffer = 0;
    this.sprinting = false;
    this.state.balance = 0;
    this.state.isTumbling = true;
    ctx.events.emit('player:tumbled', { position: this.body.position.clone() });
    ctx.events.emit('hud:toast', { text: 'You lost your footing.', ms: 1800 });
  }

  /**
   * Control is gone: momentum carries, gravity pulls, and the slope keeps accelerating the roll.
   * Ends when the roll settles OR when the hard timeout fires — the latter is what makes "recovery
   * always works" true even if the player is still sliding when it expires.
   */
  private stepTumble(dt: number): void {
    const body = this.body;
    this.tumbleTime += dt;
    this.jumpBuffer = 0;
    // Being flat on your back is at least a chance to catch your breath.
    this.state.stamina = clamp01(this.state.stamina + PLAYER.staminaRegen * dt);

    if (body.grounded) {
      const slide = BALANCE.tumbleSlideAccel * Math.sin(this.slope) * dt;
      body.velocity.x += this.downhill.x * slide;
      body.velocity.z += this.downhill.y * slide;

      const drag = Math.exp(-BALANCE.tumbleDrag * dt);
      body.velocity.x *= drag;
      body.velocity.z *= drag;
    }

    const speed = Math.hypot(body.velocity.x, body.velocity.z);
    const settled =
      body.grounded && speed < BALANCE.tumbleStopSpeed && this.tumbleTime >= BALANCE.tumbleMinSeconds;
    if (settled || this.tumbleTime >= BALANCE.tumbleMaxSeconds) {
      this.tumbling = false;
      this.state.isTumbling = false;
      this.recoverTimer = BALANCE.recoverSeconds;
    }
  }

  /** Getting back up: input is ignored, the roll is braked, and balance ramps back in. */
  private stepRecover(dt: number): void {
    const body = this.body;
    this.recoverTimer = Math.max(0, this.recoverTimer - dt);
    this.jumpBuffer = 0;

    const brake = Math.exp(-6 * dt);
    body.velocity.x *= brake;
    body.velocity.z *= brake;
    this.state.stamina = clamp01(this.state.stamina + PLAYER.staminaRegen * dt);

    const progress = 1 - this.recoverTimer / BALANCE.recoverSeconds;
    this.state.balance = BALANCE.recoveredBalance * progress;
    if (this.recoverTimer === 0) this.state.balance = BALANCE.recoveredBalance;
  }

  private onLanded(ctx: GameContext, impact: number): void {
    const p = this.body.position;
    ctx.events.emit('player:landed', { impact, biome: ctx.world.sampleBiome(p.x, p.z) });

    const excess = impact - BALANCE.landingImpactThreshold;
    if (excess <= 0) return;
    this.state.balance = clamp01(this.state.balance - excess * BALANCE.landingImpactScale);
    if (this.state.balance <= 0) this.beginTumble(ctx);
  }

  private respawn(ctx: GameContext): void {
    console.warn('[player] position went out of bounds — respawning');
    this.body.teleport(this.spawn);
    this.avatar.snapTo(this.spawn);
    this.tumbling = false;
    this.tumbleTime = 0;
    this.recoverTimer = 0;
    this.exhausted = false;
    this.state.isTumbling = false;
    this.state.balance = 1;
    this.publish(ctx);
  }

  // -------------------------------------------------------------------------
  // Publication — everything downstream (WS6 features, WS7 HUD) reads this
  // -------------------------------------------------------------------------

  private publish(ctx: GameContext): void {
    const body = this.body;
    const st = this.state;

    st.position.copy(body.position);
    st.velocity.copy(body.velocity);
    st.grounded = body.grounded;
    // Metres of ground clearance above sea level, measured at the feet — what a HUD should show.
    st.altitude = body.position.y - this.halfExtent - WORLD.seaLevel;

    const speed = Math.hypot(body.velocity.x, body.velocity.z);
    st.horizontalSpeed = speed;
    st.slope = this.slope;
    st.sprinting = this.sprinting;
    st.wading = this.isWading();
    st.locomotion = this.classify(speed);

    const weights = ctx.world.sampleBiome(body.position.x, body.position.z);
    st.biome = weights;

    const name = st.wading ? 'water' : dominantBiome(weights, BIOME_SWITCH_WEIGHT);
    if (name !== null && name !== this.currentBiome) {
      this.currentBiome = name;
      ctx.events.emit('player:enterBiome', { biome: name });
    }
  }

  private classify(speed: number): PlayerLocomotion {
    if (this.tumbling) return 'tumble';
    if (this.recoverTimer > 0) return 'recover';
    if (!this.body.grounded) return 'air';
    if (speed < IDLE_SPEED) return 'idle';
    return this.sprinting ? 'sprint' : 'walk';
  }
}

const BIOME_NAMES: readonly BiomeName[] = ['grass', 'rock', 'snow', 'sand'];

/**
 * Strongest of the four biome weights.
 *
 * @param minWeight Hysteresis threshold — return `null` when no biome is clearly dominant, so that
 *                  walking along a blend boundary does not emit `player:enterBiome` every step.
 */
function dominantBiome(weights: BiomeWeights, minWeight = 0): BiomeName | null {
  let best = 0;
  for (let i = 1; i < 4; i++) if (weights[i] > weights[best]!) best = i;
  return weights[best]! >= minWeight ? BIOME_NAMES[best]! : null;
}
