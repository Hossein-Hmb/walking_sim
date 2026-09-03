/**
 * src/features/ScannerSystem.ts
 *
 * Contents: the `ScannerSystem` — WS6 feature ③, the Odradek scan. `Q` fires a ring that expands
 * from the player's feet; the ground it passes over is tinted by how walkable it is (green →
 * amber → red, read from the real per-fragment slope) and any cairn it reaches lights up.
 *
 * Purpose: enormous perceived depth for almost no cost. The ring is not geometry — it is two
 * uniforms on WS4's terrain shader, so it follows the terrain exactly, crosses chunk and LOD
 * boundaries without a seam, and adds zero draw calls.
 *
 * Integration:
 *   - writes  `ctx.uniforms.uScanOrigin.value` (mutated in place) and `uScanRadius.value`;
 *             `uScanRadius <= 0` is WS4's "no active scan" sentinel and switches the whole shader
 *             block off, so an idle scanner costs one uniform branch
 *   - reads   `ctx.input.state.actions` for `'scan'`
 *   - emits   `scan:pulse` — WS6's `CairnSystem` schedules its pings from it (delayed by distance
 *             over `SCANNER.speed`, so cairns answer as the ring arrives) and WS7 promotes its
 *             `Q` control-hint row
 *   - listens `photo:toggle` → `Q` is the free camera's "descend" key in photo mode, so the
 *             scanner must not also fire on it
 */

import * as THREE from 'three';
import { SCANNER } from '../config/world.config';
import type { Unsubscribe } from '../core/EventBus';
import type { GameContext, System } from '../core/types';

export class ScannerSystem implements System {
  readonly name = 'scanner';

  /** Metres. <= 0 means no pulse is in flight — the same sentinel WS4's shader reads. */
  private radius = -1;
  private cooldown = 0;
  private frozen = false;
  private unsubscribe: Unsubscribe | null = null;

  private readonly origin = new THREE.Vector3();

  init(ctx: GameContext): void {
    ctx.uniforms.uScanRadius.value = -1;
    this.unsubscribe = ctx.events.on('photo:toggle', ({ active }) => {
      this.frozen = active;
      if (active) this.cancel(ctx);
    });
  }

  update(dt: number, ctx: GameContext): void {
    if (this.frozen) return;

    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);

    if (this.radius <= 0) {
      if (this.cooldown <= 0 && ctx.input.state.actions.has('scan')) this.fire(ctx);
      return;
    }

    this.radius += SCANNER.speed * dt;
    if (this.radius >= SCANNER.maxRadius) {
      this.cancel(ctx);
      this.cooldown = SCANNER.cooldown;
      return;
    }
    ctx.uniforms.uScanRadius.value = this.radius;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private fire(ctx: GameContext): void {
    const p = ctx.player.position;
    this.origin.set(p.x, ctx.world.sampleHeight(p.x, p.z) + SCANNER.originLift, p.z);

    // Mutate the shared Vector3; replacing it would silently disconnect every terrain material.
    ctx.uniforms.uScanOrigin.value.copy(this.origin);
    this.radius = 0.01;
    ctx.uniforms.uScanRadius.value = this.radius;

    ctx.events.emit('scan:pulse', { origin: this.origin.clone() });
  }

  private cancel(ctx: GameContext): void {
    this.radius = -1;
    ctx.uniforms.uScanRadius.value = -1;
  }
}
