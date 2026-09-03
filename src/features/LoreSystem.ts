/**
 * src/features/LoreSystem.ts
 *
 * Contents: `LoreSystem` — proximity plaques and two idle NPCs around Naqsh-e Jahan. Prompts the
 * player to press E, then opens a HUD fact card. NPCs yaw toward the player and cycle spoken lines.
 *
 * Purpose: keep landmark storytelling out of `LandmarkSystem` (meshes/colliders) and out of the HUD
 * (which only draws). Reads `ctx.world.data.landmarks[0]` the same way the square is posed; systems
 * still do not import one another.
 *
 * `world:ready` may already have fired by `init()`; we build immediately and also subscribe.
 */

import * as THREE from "three";
import { LORE, PLAYER } from "../config/world.config";
import type { Unsubscribe } from "../core/EventBus";
import type { GameContext, LandmarkSite, System } from "../core/types";
import { isfahanLore, type LoreLine, type NpcDef, type PlaqueDef } from "../landmarks/isfahanFacts";
import { landmarkToWorld } from "../landmarks/isfahanStamp";
import { NpcFigure } from "../landmarks/NpcFigure";

type SpotKind = "read" | "listen";

interface Spot {
  id: string;
  kind: SpotKind;
  x: number;
  z: number;
  lines: readonly LoreLine[];
}

interface NpcRuntime {
  def: NpcDef;
  figure: NpcFigure;
  spot: Spot;
  cycle: number;
}

export class LoreSystem implements System {
  readonly name = "lore";

  private ctx: GameContext | null = null;
  private readonly unsubs: Unsubscribe[] = [];
  private readonly npcs: NpcRuntime[] = [];
  private readonly plaques: THREE.Mesh[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials = new Set<THREE.Material>();
  private spots: Spot[] = [];
  private lastLabel: string | null = null;
  private open = false;
  private photoActive = false;
  private plaqueGeom: THREE.BufferGeometry | null = null;
  private plaqueMat: THREE.MeshStandardMaterial | null = null;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.unsubs.push(ctx.events.on("world:ready", () => this.rebuild(ctx)));
    this.unsubs.push(
      ctx.events.on("photo:toggle", ({ active }) => {
        this.photoActive = active;
        if (active) {
          this.close(ctx);
          if (this.lastLabel !== null) {
            this.lastLabel = null;
            ctx.events.emit("hud:prompt", { label: null });
          }
        }
      }),
    );
    this.rebuild(ctx);
  }

  update(dt: number, ctx: GameContext): void {
    if (this.photoActive || this.spots.length === 0) return;

    const px = ctx.player.position.x;
    const pz = ctx.player.position.z;
    const nearest = this.nearest(px, pz);
    const promptR2 = LORE.promptRadius * LORE.promptRadius;
    const interactR2 = LORE.interactRadius * LORE.interactRadius;
    const inPrompt = nearest !== null && nearest.d2 <= promptR2;
    const inInteract = nearest !== null && nearest.d2 <= interactR2;
    const label = this.open || !inPrompt ? null : nearest!.spot.kind;

    if (label !== this.lastLabel) {
      this.lastLabel = label;
      ctx.events.emit("hud:prompt", { label });
    }

    if (this.open && (!nearest || nearest.d2 > promptR2)) this.close(ctx);

    if (!this.photoActive && inInteract && ctx.input.state.actions.has("interact")) {
      this.toggle(ctx, nearest!.spot);
    }

    const lookR2 = promptR2;
    for (const npc of this.npcs) {
      const dx = px - npc.spot.x;
      const dz = pz - npc.spot.z;
      npc.figure.update(dt, ctx.time.elapsed, px, pz, dx * dx + dz * dz <= lookR2);
    }
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
    this.mount(ctx, site);
  }

  private mount(ctx: GameContext, site: LandmarkSite): void {
    const lore = isfahanLore(site);
    const y = site.y + PLAYER.radius + PLAYER.height * 0.5;

    this.plaqueGeom = new THREE.BoxGeometry(0.55, 0.9, 0.16);
    this.plaqueMat = new THREE.MeshStandardMaterial({
      color: 0x8a6a3a,
      roughness: 0.55,
      metalness: 0.18,
    });
    this.geometries.push(this.plaqueGeom);
    this.materials.add(this.plaqueMat);

    for (const plaque of lore.plaques) {
      const { x, z } = landmarkToWorld(site, plaque.localX, plaque.localZ);
      this.spots.push({
        id: plaque.id,
        kind: "read",
        x,
        z,
        lines: [{ title: plaque.title, body: plaque.body }],
      });
      this.addPlaqueMarker(ctx, plaque, x, site.y + 0.45, z);
    }

    for (const def of lore.npcs) {
      const { x, z } = landmarkToWorld(site, def.localX, def.localZ);
      const figure = new NpcFigure(def.palette, def.yaw + site.yaw);
      figure.root.position.set(x, y, z);
      figure.root.name = `lore:npc:${def.id}`;
      ctx.scene.add(figure.root);
      const spot: Spot = { id: def.id, kind: "listen", x, z, lines: def.lines };
      this.spots.push(spot);
      this.npcs.push({ def, figure, spot, cycle: 0 });
    }
  }

  private addPlaqueMarker(
    ctx: GameContext,
    plaque: PlaqueDef,
    x: number,
    y: number,
    z: number,
  ): void {
    if (!this.plaqueGeom || !this.plaqueMat) return;
    const mesh = new THREE.Mesh(this.plaqueGeom, this.plaqueMat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `lore:plaque:${plaque.id}`;
    ctx.scene.add(mesh);
    this.plaques.push(mesh);
  }

  private nearest(
    px: number,
    pz: number,
  ): { spot: Spot; d2: number } | null {
    let best: { spot: Spot; d2: number } | null = null;
    for (const spot of this.spots) {
      const dx = px - spot.x;
      const dz = pz - spot.z;
      const d2 = dx * dx + dz * dz;
      if (!best || d2 < best.d2) best = { spot, d2 };
    }
    return best;
  }

  private toggle(ctx: GameContext, spot: Spot): void {
    if (this.open) {
      this.close(ctx);
      return;
    }
    let line = spot.lines[0]!;
    if (spot.kind === "listen") {
      const npc = this.npcs.find((n) => n.spot.id === spot.id);
      if (npc) {
        line = npc.spot.lines[npc.cycle]!;
        npc.cycle = (npc.cycle + 1) % npc.spot.lines.length;
      }
    }
    this.open = true;
    ctx.events.emit("hud:lore", { title: line.title, body: line.body });
  }

  private close(ctx: GameContext): void {
    if (!this.open && this.lastLabel === null) return;
    this.open = false;
    ctx.events.emit("hud:lore", null);
  }

  private teardown(): void {
    const ctx = this.ctx;
    if (ctx && (this.open || this.lastLabel !== null)) {
      ctx.events.emit("hud:prompt", { label: null });
      ctx.events.emit("hud:lore", null);
    }
    this.open = false;
    this.lastLabel = null;
    this.spots = [];

    for (const npc of this.npcs) npc.figure.dispose();
    this.npcs.length = 0;

    for (const mesh of this.plaques) mesh.removeFromParent();
    this.plaques.length = 0;

    for (const geom of this.geometries) geom.dispose();
    this.geometries.length = 0;
    for (const mat of this.materials) mat.dispose();
    this.materials.clear();
    this.plaqueGeom = null;
    this.plaqueMat = null;
  }
}
