/**
 * src/features/LandmarkSystem.ts
 *
 * Contents: `LandmarkSystem` — poses authored landmark fragments (Naqsh-e Jahan first) into the
 * scene, registers their colliders, lights the plaza lanterns after dusk, and toasts when the
 * player walks onto the plaza.
 *
 * Purpose: keep landmark meshes and colliders out of `WorldSystem`. The heightmap stamp lives in
 * `isfahanStamp.ts` and runs during world generation; this system only draws and collides what
 * that stamp already made walkable.
 *
 * `world:ready` has usually already fired by `init()` (same pattern as `CairnSystem`); we build
 * immediately and also subscribe in case the island is ever regenerated.
 */

import * as THREE from "three";
import { ISFAHAN } from "../config/world.config";
import type { Unsubscribe } from "../core/EventBus";
import type { GameContext, LandmarkSite, System } from "../core/types";
import { buildNaqshEJahan } from "../landmarks/NaqshEJahan";
import { pointInLandmarkFootprint } from "../landmarks/isfahanStamp";
import { skyState } from "../render/skyModel";
import { clamp01 } from "../utils/math";

export class LandmarkSystem implements System {
  readonly name = "landmarks";

  private group: THREE.Group | null = null;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials = new Set<THREE.Material>();
  private readonly colliderGeoms: THREE.BufferGeometry[] = [];
  private readonly colliderHandles: number[] = [];
  private readonly unsubs: Unsubscribe[] = [];
  private announced = false;
  private ctx: GameContext | null = null;
  private lampPositions: THREE.Vector3[] = [];
  private lampGlass: THREE.MeshStandardMaterial | null = null;
  private readonly lampLights: THREE.PointLight[] = [];
  private readonly localPlayer = new THREE.Vector3();

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.rebuild(ctx);
    this.unsubs.push(ctx.events.on("world:ready", () => this.rebuild(ctx)));
  }

  update(_dt: number, ctx: GameContext): void {
    this.updateLamps(ctx);
    const site = ctx.world.data.landmarks?.[0];
    if (!site || this.announced) return;
    const p = ctx.player.position;
    if (!pointInLandmarkFootprint(ctx.world.data, p.x, p.z)) return;
    this.announced = true;
    ctx.events.emit("hud:toast", {
      text: "Naqsh-e Jahan — the image of the world",
      ms: 5200,
    });
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.teardown();
    this.ctx = null;
  }

  private rebuild(ctx: GameContext): void {
    this.teardown();
    const site = ctx.world.data.landmarks?.[0];
    if (!site) return;
    this.mountIsfahan(ctx, site);
  }

  private mountIsfahan(ctx: GameContext, site: LandmarkSite): void {
    const { group, colliderMeshes, lampPositions, lampGlass } =
      buildNaqshEJahan(site);
    this.group = group;
    this.lampPositions = lampPositions;
    this.lampGlass = lampGlass;
    ctx.scene.add(group);
    group.updateMatrixWorld(true);

    this.captureResources(group);
    this.mountLampLights(group);

    const origin = new THREE.Vector3();
    for (const mesh of colliderMeshes) {
      const geom = mesh.geometry.clone();
      geom.applyMatrix4(mesh.matrixWorld);
      this.colliderGeoms.push(geom);
      this.colliderHandles.push(ctx.physics.addStaticTrimesh(geom, origin));
    }

    ctx.events.emit("landmark:placed", {
      position: new THREE.Vector3(site.x, site.y, site.z),
      name: "Naqsh-e Jahan",
    });
  }

  private captureResources(root: THREE.Object3D): void {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geom = mesh.geometry;
      if (geom && !this.geometries.includes(geom)) this.geometries.push(geom);
      const mats = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      for (const mat of mats) if (mat) this.materials.add(mat);
    });
  }

  private teardown(): void {
    const ctx = this.ctx;
    if (ctx) {
      for (const handle of this.colliderHandles)
        ctx.physics.removeCollider(handle);
    }
    this.colliderHandles.length = 0;
    for (const geom of this.colliderGeoms) geom.dispose();
    this.colliderGeoms.length = 0;

    this.group?.removeFromParent();
    this.group = null;
    for (const light of this.lampLights) {
      light.removeFromParent();
      light.dispose();
    }
    this.lampLights.length = 0;
    this.lampPositions = [];
    this.lampGlass = null;
    for (const geom of this.geometries) geom.dispose();
    this.geometries.length = 0;
    for (const mat of this.materials) mat.dispose();
    this.materials.clear();
    this.announced = false;
  }

  private mountLampLights(group: THREE.Group): void {
    const n = ISFAHAN.lampLightPool;
    for (let i = 0; i < n; i++) {
      const light = new THREE.PointLight(
        ISFAHAN.lampFlame,
        0,
        ISFAHAN.lampDistance,
        2,
      );
      light.castShadow = false;
      light.visible = false;
      light.name = `isfahan:lamp-light:${i}`;
      group.add(light);
      this.lampLights.push(light);
    }
  }

  /**
   * Glow tracks the sky, not a second clock. Only the nearest few lanterns are real lights —
   * the rest are emissive glass, which is enough to read the line of the arcade at a distance.
   *
   * @complexity Time: O(lamps × pool) per frame, pool is 8 | Space: O(1)
   */
  private updateLamps(ctx: GameContext): void {
    const glass = this.lampGlass;
    const group = this.group;
    if (!glass || !group || this.lampLights.length === 0) return;

    const glow = clamp01(1 - skyState.daylight);
    glass.emissiveIntensity = glow * 1.8;
    if (glow < 0.02) {
      for (const light of this.lampLights) {
        light.intensity = 0;
        light.visible = false;
      }
      return;
    }

    this.localPlayer.copy(ctx.player.position);
    group.worldToLocal(this.localPlayer);

    const pool = this.lampLights.length;
    const bestD = this.bestLampD;
    const bestI = this.bestLampI;
    bestD.fill(Infinity);
    bestI.fill(-1);

    const px = this.localPlayer.x;
    const pz = this.localPlayer.z;
    for (let i = 0; i < this.lampPositions.length; i++) {
      const p = this.lampPositions[i]!;
      const dx = p.x - px;
      const dz = p.z - pz;
      const d2 = dx * dx + dz * dz;
      let slot = -1;
      for (let k = pool - 1; k >= 0; k--) {
        if (d2 < bestD[k]!) slot = k;
      }
      if (slot < 0) continue;
      for (let k = pool - 1; k > slot; k--) {
        bestD[k] = bestD[k - 1]!;
        bestI[k] = bestI[k - 1]!;
      }
      bestD[slot] = d2;
      bestI[slot] = i;
    }

    const t = ctx.time.elapsed;
    for (let k = 0; k < pool; k++) {
      const light = this.lampLights[k]!;
      const idx = bestI[k]!;
      if (idx < 0) {
        light.visible = false;
        light.intensity = 0;
        continue;
      }
      const p = this.lampPositions[idx]!;
      light.position.copy(p);
      const flicker =
        1 + 0.045 * Math.sin(t * 7.3 + idx) + 0.03 * Math.sin(t * 13.1 + idx * 1.7);
      light.intensity = glow * ISFAHAN.lampIntensity * flicker;
      light.visible = true;
    }
  }

  private readonly bestLampD = new Float64Array(ISFAHAN.lampLightPool);
  private readonly bestLampI = new Int32Array(ISFAHAN.lampLightPool);
}
