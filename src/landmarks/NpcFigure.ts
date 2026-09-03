/**
 * src/landmarks/NpcFigure.ts
 *
 * Contents: a stylized low-poly standing figure (cloak, hood, limbs) used for the two lore NPCs
 * on Naqsh-e Jahan. Idle bob plus a look-at yaw when the player is in range.
 *
 * Purpose: visual-only — no physics. Sized to the player porter so the square feels inhabited
 * without a second animation system. `LoreSystem` owns placement and dispose.
 */

import * as THREE from "three";
import { AVATAR, LORE } from "../config/world.config";
import { dampAngle } from "../utils/math";

export type NpcPalette = "merchant" | "scholar";

const PALETTES: Record<
  NpcPalette,
  { cloak: number; suit: number; accent: number }
> = {
  merchant: { cloak: 0xb8955c, suit: 0x3a2a1c, accent: 0xc45a2a },
  scholar: { cloak: 0x2c4a62, suit: 0xe8dcc4, accent: 0x1a8a7a },
};

/**
 * @complexity Time: O(1) per frame | Space: O(1) shared-per-instance geometries.
 */
export class NpcFigure {
  readonly root = new THREE.Group();

  private readonly figure = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private heading: number;

  constructor(palette: NpcPalette, yaw: number) {
    this.heading = yaw;
    this.root.add(this.figure);
    this.figure.add(this.body);
    this.figure.rotation.y = yaw;
    this.build(palette);
  }

  /**
   * @complexity Time: O(1) | Space: O(1)
   */
  update(
    dt: number,
    elapsed: number,
    targetX: number,
    targetZ: number,
    inRange: boolean,
  ): void {
    if (inRange) {
      const yaw = Math.atan2(
        targetX - this.root.position.x,
        targetZ - this.root.position.z,
      );
      this.heading = dampAngle(this.heading, yaw, LORE.npcLookLambda, dt);
      this.figure.rotation.y = this.heading;
    }
    this.body.position.y = Math.sin(elapsed * 1.35 + this.heading) * LORE.npcBobMetres;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.clear();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
  }

  private build(palette: NpcPalette): void {
    const colors = PALETTES[palette];
    const cloak = this.mat(colors.cloak, 0.62);
    const suit = this.mat(colors.suit, 0.7);
    const accent = this.mat(colors.accent, 0.4);
    const boot = this.mat(AVATAR.bootColor, 0.85);
    const radial = 5;

    this.add(this.body, new THREE.CapsuleGeometry(0.22, 0.42, 2, radial), cloak, 0, 0.16, 0.04);
    this.add(this.body, new THREE.CylinderGeometry(0.3, 0.36, 0.38, radial, 1), cloak, 0, -0.08, 0.02);
    this.add(this.body, new THREE.SphereGeometry(0.2, radial, 4), cloak, 0, 0.58, 0);
    this.add(this.body, new THREE.SphereGeometry(0.14, radial, 4), suit, 0, 0.54, 0.08);
    this.add(this.body, new THREE.BoxGeometry(0.18, 0.055, 0.06), accent, 0, 0.56, 0.2);

    const hipY = -0.28;
    const shoulderY = 0.36;
    const leftHip = new THREE.Group();
    const rightHip = new THREE.Group();
    const leftShoulder = new THREE.Group();
    const rightShoulder = new THREE.Group();
    leftHip.position.set(-0.13, hipY, 0.02);
    rightHip.position.set(0.13, hipY, 0.02);
    leftShoulder.position.set(-0.28, shoulderY, 0.02);
    rightShoulder.position.set(0.28, shoulderY, 0.02);
    this.figure.add(leftHip, rightHip);
    this.body.add(leftShoulder, rightShoulder);

    const leg = new THREE.CapsuleGeometry(0.11, 0.48, 1, radial);
    const arm = new THREE.CapsuleGeometry(0.065, 0.38, 1, radial);
    const shoe = new THREE.BoxGeometry(0.16, 0.1, 0.24);
    this.add(leftHip, leg, suit, 0, -0.34, 0);
    this.add(rightHip, leg, suit, 0, -0.34, 0);
    this.add(leftHip, shoe, boot, 0, -0.66, 0.04);
    this.add(rightHip, shoe, boot, 0, -0.66, 0.04);
    this.add(leftShoulder, arm, cloak, 0, -0.24, 0);
    this.add(rightShoulder, arm, cloak, 0, -0.24, 0);

    if (palette === "merchant") {
      this.add(this.body, new THREE.BoxGeometry(0.36, 0.28, 0.16), accent, 0, 0.12, -0.26);
    } else {
      this.add(this.body, new THREE.BoxGeometry(0.12, 0.22, 0.04), accent, 0.16, 0.2, 0.24);
    }
  }

  private mat(color: number, roughness: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      color,
      roughness,
      metalness: 0.04,
      flatShading: true,
    });
    this.materials.push(m);
    return m;
  }

  private add(
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
  ): void {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    parent.add(mesh);
    if (!this.geometries.includes(geometry)) this.geometries.push(geometry);
  }
}
