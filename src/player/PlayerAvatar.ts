/**
 * src/player/PlayerAvatar.ts
 *
 * Contents: `PlayerAvatar` — everything visual about the player: a flat-shaded low-poly porter
 * (hood, cargo pack, striding limbs), lean into slope and speed, tumble spin, and a short fading
 * motion trail.
 *
 * Purpose: PLAN.md WS3 asked the original sphere to "sell walking without animation". The porter
 * keeps that contract — stride phase is driven by distance travelled, not by time — so the figure
 * reads as gripping the ground at any frame rate. Keeping all of that out of `PlayerSystem` leaves
 * the controller as pure simulation with no THREE.Object3D bookkeeping in it.
 *
 * This is a plain view object, NOT a `System`: it is constructed and driven by `PlayerSystem`, which
 * already owns the state it needs. Registering it separately would mean duplicating that state.
 *
 * Rendering note: the mesh position is damped toward the 60 Hz physics position with a high lambda
 * (`AVATAR.followLambda`). At 144 fps this hides the fixed-step quantisation without introducing
 * lag a player can feel (~25 ms); at 60 fps it is a near-identity.
 */

import * as THREE from 'three';
import { AVATAR, PLAYER } from '../config/world.config';
import { clamp, clamp01, damp, dampAngle } from '../utils/math';

/** Everything the avatar needs to know about the simulation for one frame. */
export interface AvatarFrame {
  /** Physics-space centre of the character body. */
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  groundNormal: THREE.Vector3;
  grounded: boolean;
  tumbling: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
const IDENTITY = new THREE.Quaternion();
/** How strongly the figure tips to match the ground it stands on (0 = never, 1 = fully aligned). */
const SLOPE_ALIGN = 0.22;
/** Horizontal speed below which the figure is treated as standing still. */
const IDLE_SPEED = 0.4;

interface TrailSample {
  x: number;
  y: number;
  z: number;
  /** `elapsed` at capture, seconds. */
  t: number;
}

interface PorterMaterials {
  cloak: THREE.MeshStandardMaterial;
  suit: THREE.MeshStandardMaterial;
  pack: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  boot: THREE.MeshStandardMaterial;
}

export class PlayerAvatar {
  /** Carries the lean; children carry heading, stride and tumble so those never fight. */
  readonly root = new THREE.Group();
  /** Damped render position — the camera and any VFX should follow this, not the raw body. */
  readonly renderPosition = new THREE.Vector3();

  readonly radius: number;

  private readonly figure: THREE.Group;
  private readonly tumblePivot: THREE.Group;
  private readonly body: THREE.Group;
  private readonly leftHip: THREE.Group;
  private readonly rightHip: THREE.Group;
  private readonly leftShoulder: THREE.Group;
  private readonly rightShoulder: THREE.Group;

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.MeshStandardMaterial[] = [];

  private readonly trail: THREE.Line;
  private readonly trailGeometry: THREE.BufferGeometry;
  private readonly trailMaterial: THREE.LineBasicMaterial;
  private readonly trailPositions: Float32Array;
  private readonly trailColors: Float32Array;
  private readonly trailSamples: TrailSample[] = [];
  private nextTrailAt = 0;
  private readonly trailRgb = new THREE.Color(AVATAR.trailColor);

  private readonly scene: THREE.Scene;

  /** Yaw the figure is currently facing, radians. */
  private heading = 0;
  /** Metres travelled while grounded — drives the walk cycle. */
  private distance = 0;
  private swingWeight = 0;

  // Scratch — the update path must not allocate.
  private readonly velXZ = new THREE.Vector3();
  private readonly tumbleAxis = new THREE.Vector3();
  private readonly rollQuat = new THREE.Quaternion();
  private readonly targetUp = new THREE.Vector3();
  private readonly leanQuat = new THREE.Quaternion();

  constructor(scene: THREE.Scene, spawn: THREE.Vector3) {
    this.scene = scene;
    this.radius = PLAYER.radius + PLAYER.height * 0.5;

    this.tumblePivot = new THREE.Group();
    this.figure = new THREE.Group();
    this.body = new THREE.Group();
    this.leftHip = new THREE.Group();
    this.rightHip = new THREE.Group();
    this.leftShoulder = new THREE.Group();
    this.rightShoulder = new THREE.Group();

    this.buildPorter();

    this.root.name = 'player:avatar';
    this.root.add(this.tumblePivot);
    this.tumblePivot.add(this.figure);
    this.root.position.copy(spawn);
    this.renderPosition.copy(spawn);
    scene.add(this.root);

    // --- trail ---------------------------------------------------------------
    // World-space, so it is a sibling of the avatar rather than a child (a child would inherit the
    // lean and swing around). itemSize 4 on `color` enables per-vertex alpha in three.
    const n = AVATAR.trailPoints;
    this.trailPositions = new Float32Array(n * 3);
    this.trailColors = new Float32Array(n * 4);
    this.trailGeometry = new THREE.BufferGeometry();
    this.trailGeometry.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    this.trailGeometry.setAttribute('color', new THREE.BufferAttribute(this.trailColors, 4));
    this.trailGeometry.setDrawRange(0, 0);
    this.trailMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.trail = new THREE.Line(this.trailGeometry, this.trailMaterial);
    // The bounding sphere would have to be recomputed every frame otherwise.
    this.trail.frustumCulled = false;
    scene.add(this.trail);
  }

  /** Hard-set the avatar (spawn, teleport, respawn) with no interpolation and no trail smear. */
  snapTo(position: THREE.Vector3): void {
    this.root.position.copy(position);
    this.renderPosition.copy(position);
    this.distance = 0;
    this.swingWeight = 0;
    this.tumblePivot.quaternion.identity();
    this.trailSamples.length = 0;
    this.trailGeometry.setDrawRange(0, 0);
  }

  /**
   * @param dt       Variable render delta, seconds.
   * @param elapsed  `ctx.time.elapsed`, used to age trail samples.
   *
   * @complexity Time: O(AVATAR.trailPoints) per frame | Space: O(AVATAR.trailPoints), preallocated.
   */
  update(dt: number, elapsed: number, frame: AvatarFrame): void {
    this.renderPosition.set(
      damp(this.renderPosition.x, frame.position.x, AVATAR.followLambda, dt),
      damp(this.renderPosition.y, frame.position.y, AVATAR.followLambda, dt),
      damp(this.renderPosition.z, frame.position.z, AVATAR.followLambda, dt),
    );
    this.root.position.copy(this.renderPosition);

    this.velXZ.set(frame.velocity.x, 0, frame.velocity.z);
    const speed = this.velXZ.length();

    this.applyHeading(dt, speed);
    this.applyStride(dt, speed, frame);
    this.applyTumble(dt, frame);
    this.applyLean(dt, speed, frame);
    this.updateTrail(elapsed, speed, frame);
  }

  /**
   * Yaw toward travel. Holding the last heading when idle keeps the porter from spinning in place
   * on tiny velocity noise, and from snapping 180° the moment you tap a key.
   */
  private applyHeading(dt: number, speed: number): void {
    if (speed > IDLE_SPEED) {
      this.heading = dampAngle(
        this.heading,
        Math.atan2(this.velXZ.x, this.velXZ.z),
        AVATAR.headingLambda,
        dt,
      );
    }
    this.figure.rotation.y = this.heading;
  }

  /**
   * Stride phase is `distance / strideLength`, the no-slip equivalent of the old sphere roll: the
   * legs complete a cycle every `AVATAR.strideLength` metres, at any speed. Swing amplitude eases
   * in and out so starting and stopping does not pop.
   */
  private applyStride(dt: number, speed: number, frame: AvatarFrame): void {
    const moving = frame.grounded && speed > IDLE_SPEED && !frame.tumbling;
    if (moving) this.distance += speed * dt;

    const targetWeight = moving ? clamp01(speed / PLAYER.walkSpeed) : 0;
    this.swingWeight = damp(this.swingWeight, targetWeight, 12, dt);

    const phase = (this.distance / AVATAR.strideLength) * Math.PI * 2;
    const w = this.swingWeight;
    const leg = Math.sin(phase) * AVATAR.legSwing * w;
    const arm = Math.sin(phase) * AVATAR.armSwing * w;

    this.leftHip.rotation.x = -leg;
    this.rightHip.rotation.x = leg;
    this.leftShoulder.rotation.x = arm;
    this.rightShoulder.rotation.x = -arm;

    // Two bobs per cycle (one per footfall). Airborne / idle the body settles.
    const bob = moving ? Math.abs(Math.sin(phase)) * AVATAR.bobHeight * w : 0;
    this.body.position.y = damp(this.body.position.y, bob, 18, dt);
  }

  /**
   * Off-axis spin while tumbling so the roll reads as "lost their footing" rather than a walk.
   * Identity is eased back in on recovery so the porter stands up rather than popping upright.
   */
  private applyTumble(dt: number, frame: AvatarFrame): void {
    if (frame.tumbling) {
      this.tumbleAxis.copy(UP).cross(this.velXZ);
      if (this.tumbleAxis.lengthSq() < 1e-6) this.tumbleAxis.set(1, 0, 0);
      else this.tumbleAxis.normalize();
      this.rollQuat.setFromAxisAngle(this.tumbleAxis, AVATAR.tumbleSpin * dt);
      this.tumblePivot.quaternion.premultiply(this.rollQuat);
      this.rollQuat.setFromAxisAngle(UP, AVATAR.tumbleSpin * dt * 0.35);
      this.tumblePivot.quaternion.premultiply(this.rollQuat);
      return;
    }
    this.tumblePivot.quaternion.slerp(IDENTITY, 1 - Math.exp(-8 * dt));
  }

  /**
   * Two contributions, both expressed as a tilt of the local "up" axis:
   *   - terrain: tip partway toward the ground normal, so standing on a hillside looks committed;
   *   - speed: lean into the direction of travel, proportional to how fast the player is going.
   */
  private applyLean(dt: number, speed: number, frame: AvatarFrame): void {
    const maxTilt = Math.tan(AVATAR.leanMax);
    const speedLean = clamp01(speed / PLAYER.sprintSpeed) * maxTilt;

    let tiltX = 0;
    let tiltZ = 0;
    if (frame.grounded) {
      // `groundNormal.xz` points downhill; adding it tips the figure to match the surface.
      tiltX += frame.groundNormal.x * SLOPE_ALIGN;
      tiltZ += frame.groundNormal.z * SLOPE_ALIGN;
    }
    if (speed > 1e-4) {
      tiltX += (this.velXZ.x / speed) * speedLean;
      tiltZ += (this.velXZ.z / speed) * speedLean;
    }

    const tilt = Math.hypot(tiltX, tiltZ);
    if (tilt > maxTilt && tilt > 1e-6) {
      const k = maxTilt / tilt;
      tiltX *= k;
      tiltZ *= k;
    }

    this.targetUp.set(tiltX, 1, tiltZ).normalize();
    this.leanQuat.setFromUnitVectors(UP, this.targetUp);
    this.root.quaternion.slerp(this.leanQuat, 1 - Math.exp(-AVATAR.leanLambda * dt));
  }

  /**
   * A short breadcrumb line behind the player. Samples are captured on a fixed interval (so the
   * trail length is speed-independent) and expire by age (so it drains away when you stand still).
   */
  private updateTrail(elapsed: number, speed: number, frame: AvatarFrame): void {
    const samples = this.trailSamples;

    if (speed >= AVATAR.trailMinSpeed && frame.grounded && elapsed >= this.nextTrailAt) {
      this.nextTrailAt = elapsed + AVATAR.trailIntervalSeconds;
      // Just above the feet, so it does not z-fight with the ground it is drawn on.
      samples.push({
        x: this.renderPosition.x,
        y: this.renderPosition.y - this.radius + 0.06,
        z: this.renderPosition.z,
        t: elapsed,
      });
      if (samples.length > AVATAR.trailPoints) samples.shift();
    }

    // Expire from the front — samples are always in chronological order.
    while (samples.length > 0 && elapsed - samples[0]!.t > AVATAR.trailFadeSeconds) samples.shift();

    if (samples.length < 2) {
      this.trailGeometry.setDrawRange(0, 0);
      return;
    }

    const { r, g, b } = this.trailRgb;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      const p = i * 3;
      this.trailPositions[p] = s.x;
      this.trailPositions[p + 1] = s.y;
      this.trailPositions[p + 2] = s.z;

      const age = clamp01((elapsed - s.t) / AVATAR.trailFadeSeconds);
      const c = i * 4;
      this.trailColors[c] = r;
      this.trailColors[c + 1] = g;
      this.trailColors[c + 2] = b;
      // Fade with age, plus an extra taper on the last two points so the tail does not pop off.
      this.trailColors[c + 3] = (1 - age) * 0.45 * clamp(i / 2, 0, 1);
    }

    this.trailGeometry.setDrawRange(0, samples.length);
    this.trailGeometry.attributes.position!.needsUpdate = true;
    this.trailGeometry.attributes.color!.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.root);
    this.scene.remove(this.trail);
    this.root.clear();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.trailGeometry.dispose();
    this.trailMaterial.dispose();
    this.trailSamples.length = 0;
  }

  // -------------------------------------------------------------------------
  // Porter construction
  // -------------------------------------------------------------------------

  /**
   * A faceted traveler sized to the physics capsule (feet at `-radius`, crown just under `+radius`).
   * Shared materials keep the draw cheap; moving parts hang off pivot groups so the walk cycle is
   * just a handful of `rotation.x` writes.
   */
  private buildPorter(): void {
    const mats = this.makeMaterials();
    const radial = 5 + AVATAR.detail;

    this.figure.add(this.body);
    // Slight porter hunch — the pack is the silhouette, the head leads it.
    this.body.rotation.x = 0.14;

    const hipY = -0.28;
    const shoulderY = 0.36;

    this.leftHip.position.set(-0.13, hipY, 0.02);
    this.rightHip.position.set(0.13, hipY, 0.02);
    this.leftShoulder.position.set(-0.28, shoulderY, 0.02);
    this.rightShoulder.position.set(0.28, shoulderY, 0.02);
    this.figure.add(this.leftHip, this.rightHip);
    this.body.add(this.leftShoulder, this.rightShoulder);

    // Coat / torso. Capsule is Y-aligned and centred.
    this.addPart(this.body, new THREE.CapsuleGeometry(0.22, 0.42, 2, radial), mats.cloak, 0, 0.16, 0.04);
    // Skirt of the coat, wider than the capsule so the silhouette reads at camera distance.
    this.addPart(this.body, new THREE.CylinderGeometry(0.3, 0.36, 0.38, radial, 1), mats.cloak, 0, -0.08, 0.02);
    // Hood.
    this.addPart(this.body, new THREE.SphereGeometry(0.2, radial, 4), mats.cloak, 0, 0.58, 0.0);
    // Face, set forward of the hood so it is not swallowed.
    this.addPart(this.body, new THREE.SphereGeometry(0.14, radial, 4), mats.suit, 0, 0.54, 0.08);
    // Visor — the orange read from the third-person camera.
    this.addPart(this.body, new THREE.BoxGeometry(0.18, 0.055, 0.06), mats.accent, 0, 0.56, 0.2);
    // Chest stripe.
    this.addPart(this.body, new THREE.BoxGeometry(0.16, 0.22, 0.06), mats.accent, 0, 0.18, 0.24);

    // Cargo pack — the thing that makes this a porter rather than a stick figure.
    this.addPart(this.body, new THREE.BoxGeometry(0.42, 0.52, 0.28), mats.pack, 0, 0.22, -0.3);
    this.addPart(this.body, new THREE.BoxGeometry(0.36, 0.12, 0.22), mats.pack, 0, 0.5, -0.28);
    this.addPart(this.body, new THREE.BoxGeometry(0.2, 0.08, 0.08), mats.accent, 0, 0.38, -0.46);

    // Legs hang from the hips so a single rotation.x is a stride. Left and right share
    // geometry — three.js is fine with one BufferGeometry on two meshes.
    const leg = new THREE.CapsuleGeometry(0.11, 0.48, 1, radial);
    const boot = new THREE.BoxGeometry(0.16, 0.1, 0.24);
    this.addPart(this.leftHip, leg, mats.suit, 0, -0.34, 0);
    this.addPart(this.rightHip, leg, mats.suit, 0, -0.34, 0);
    this.addPart(this.leftHip, boot, mats.boot, 0, -0.66, 0.04);
    this.addPart(this.rightHip, boot, mats.boot, 0, -0.66, 0.04);

    const arm = new THREE.CapsuleGeometry(0.065, 0.38, 1, radial);
    this.addPart(this.leftShoulder, arm, mats.cloak, 0, -0.24, 0);
    this.addPart(this.rightShoulder, arm, mats.cloak, 0, -0.24, 0);
  }

  private makeMaterials(): PorterMaterials {
    const make = (color: number, extras: ConstructorParameters<typeof THREE.MeshStandardMaterial>[0] = {}) => {
      const mat = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.72,
        metalness: 0.04,
        flatShading: true,
        ...extras,
      });
      this.materials.push(mat);
      return mat;
    };

    return {
      cloak: make(AVATAR.cloakColor, { roughness: 0.62 }),
      suit: make(AVATAR.suitColor, { roughness: 0.7 }),
      pack: make(AVATAR.packColor, { roughness: 0.55 }),
      accent: make(AVATAR.accentColor, {
        roughness: 0.38,
        metalness: 0.18,
        emissive: AVATAR.accentColor,
        emissiveIntensity: 0.28,
      }),
      boot: make(AVATAR.bootColor, { roughness: 0.85 }),
    };
  }

  private addPart(
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    parent.add(mesh);
    if (!this.geometries.includes(geometry)) this.geometries.push(geometry);
    return mesh;
  }
}
