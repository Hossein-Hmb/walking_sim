/**
 * src/render/QualitySystem.ts
 *
 * Contents: `QualitySystem` — the subscriber that turns WS7's `quality:changed` event into actual
 * rendering settings: device pixel ratio, the shadow pass and its map resolution, fog distance,
 * and (for the Low preset) a camera far plane pulled in behind the fog.
 *
 * Purpose: WS7 shipped the Low/Medium/High control, its `localStorage` persistence and the
 * restore-on-load re-emit, but deliberately left the meaning of a preset to WS8. This is that
 * missing half. It is the only reader of the `QUALITY` block in `world.config.ts`.
 *
 * Ordering: must be registered AFTER `SkySystem` and `WeatherSystem`, because both rewrite
 * `scene.fog` every frame from their own models. Scaling the fog here — after them, every frame —
 * means the preset composes with the day/night cycle and with a storm instead of being overwritten
 * by either. Nothing in the sky or weather systems needs to know this system exists.
 *
 * Vegetation density is deliberately NOT handled here: `VegetationSystem` subscribes to the same
 * event and scales its own draw radii, which keeps its instance buffers and cell cache its own
 * business.
 */

import * as THREE from 'three';
import { CAMERA, QUALITY, QUALITY_FAR_PAD } from '../config/world.config';
import type { QualityPreset } from '../config/world.config';
import type { Unsubscribe } from '../core/EventBus';
import type { GameContext, QualityLevel, System } from '../core/types';
import { perf } from '../utils/Perf';

/** Fog near tracks far, so the whole gradient scales rather than the band getting squeezed. */
const FOG_NEAR_FLOOR = 8;

export class QualitySystem implements System {
  readonly name = 'quality';

  private preset: QualityPreset = QUALITY.medium;
  private level: QualityLevel = 'medium';
  private applied = false;
  private sun: THREE.DirectionalLight | null = null;
  private unsubscribe: Unsubscribe | null = null;

  /** Set by the bootstrap so the pixel-ratio cap can reach the renderer through the Engine. */
  constructor(private readonly setPixelRatioCap: (cap: number) => void) {}

  init(ctx: GameContext): void {
    // WS7's overlay re-emits the stored level once during its own `init`. Registration order puts
    // the HUD after this system, so that emit lands here and the stored preset applies on frame 1.
    this.unsubscribe = ctx.events.on('quality:changed', ({ level }) => {
      this.level = level;
      this.preset = QUALITY[level] ?? QUALITY.medium;
      this.applied = false;
    });
    this.apply(ctx);
  }

  update(_dt: number, ctx: GameContext): void {
    if (!this.applied) this.apply(ctx);
    this.syncShadowMap(ctx);
    this.applyFog(ctx);
  }

  /**
   * Push the preset into the renderer. Runs only on a change: toggling the shadow map invalidates
   * every compiled program, which is a visible hitch and must not happen per frame.
   *
   * @complexity O(objects in the scene) on a preset change, O(1) otherwise.
   */
  private apply(ctx: GameContext): void {
    this.applied = true;
    const renderer = ctx.renderer;
    const preset = this.preset;

    this.setPixelRatioCap(preset.pixelRatio);

    const shadowsChanged = renderer.shadowMap.enabled !== preset.shadows;
    renderer.shadowMap.enabled = preset.shadows;
    if (shadowsChanged) {
      // three bakes `shadowMap.enabled` into every program it compiles, so the existing ones are
      // now wrong. Marking materials dirty is the documented way to force the recompile.
      invalidateMaterials(ctx.scene);
      renderer.shadowMap.needsUpdate = true;
    }

    perf.note('quality', this.level);
  }

  /**
   * Resize the sun's shadow map to match the preset.
   *
   * Retried every frame rather than done once inside `apply`, because WS4 switches the sun's
   * `castShadow` off at night — which is exactly how the sun is told apart from the moon, and it
   * means the light may simply not be identifiable at the moment a preset is chosen.
   */
  private syncShadowMap(ctx: GameContext): void {
    const sun = this.sun ?? this.findSun(ctx.scene);
    if (!sun) return;
    const want = this.preset.shadowMapSize;
    if (sun.shadow.mapSize.x === want) return;
    sun.shadow.mapSize.setScalar(want);
    // The allocated depth target is still the old size; dropping it makes three build a new one.
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
  }

  /**
   * Scale this frame's fog, and optionally discard the geometry hiding behind it.
   *
   * Cheap enough to run unconditionally: `SkySystem` and `WeatherSystem` both rewrite the fog from
   * scratch every frame, so these edits never accumulate and never have to be undone.
   */
  private applyFog(ctx: GameContext): void {
    const fog = ctx.scene.fog;
    if (!(fog instanceof THREE.Fog)) return;

    const scale = this.preset.fogScale;
    if (scale !== 1) {
      fog.far *= scale;
      fog.near = Math.max(FOG_NEAR_FLOOR, fog.near * scale);
    }

    // Beyond `fog.far` linear fog is fully saturated and the scene background is that same fog
    // colour, so clipping there is invisible — but only while the fog is genuinely dense, which is
    // why it is gated on the preset rather than applied everywhere.
    const far = this.preset.cullToFog
      ? Math.min(CAMERA.far, fog.far * QUALITY_FAR_PAD)
      : CAMERA.far;
    if (ctx.camera.far !== far) {
      ctx.camera.far = far;
      ctx.camera.updateProjectionMatrix();
    }
  }

  /** The moon is a `DirectionalLight` too, so the shadow caster is the one that identifies itself. */
  private findSun(scene: THREE.Scene): THREE.DirectionalLight | null {
    const found: THREE.DirectionalLight[] = [];
    scene.traverse((object) => {
      if (found.length === 0 && object instanceof THREE.DirectionalLight && object.castShadow) {
        found.push(object);
      }
    });
    this.sun = found[0] ?? null;
    return this.sun;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.sun = null;
  }
}

/** Force a shader recompile of everything drawn in the scene. */
function invalidateMaterials(scene: THREE.Scene): void {
  scene.traverse((object) => {
    const material = (object as THREE.Mesh).material;
    if (!material) return;
    if (Array.isArray(material)) {
      for (const m of material) m.needsUpdate = true;
    } else {
      material.needsUpdate = true;
    }
  });
}
