/**
 * src/render/Lighting.ts
 *
 * Contents: the `Lighting` system — sun and moon directional lights, a hemisphere bounce, a small
 * ambient floor, and a single shadow cascade that follows the player.
 *
 * Purpose: forward-rendered, browser-budget lighting. Four lights total, one shadow map, no
 * post-processing. Everything it does is derived from `skyModel.skyState`, so the sun in the sky
 * and the sun casting shadows can never disagree.
 *
 * ── SHADOW STRATEGY ─────────────────────────────────────────────────────────
 * A 2 km island cannot be shadowed by one map at any useful resolution, and cascades are not worth
 * their cost here. Instead the single ortho frustum is a tight ±55 m box that tracks the player, so
 * texel density stays high where the player can actually see contact shadows, and distant terrain
 * relies on the shading in `TerrainMaterial` (slope + biome) to read its form.
 *
 * Two details that matter more than they look:
 *   - The shadow camera's centre is snapped to the shadow map's texel grid. Without it, walking
 *     makes every shadow edge crawl and shimmer, which is far more distracting than no shadows.
 *   - The shadow pass is switched off entirely once the sun drops below a usable intensity. At
 *     night the moon light casts nothing, which saves a full depth pass for half the cycle.
 *
 * Ordering: must be registered AFTER `SkySystem` (which is the only writer of `skyState`) and
 * after the player system, so it reads this frame's player position rather than last frame's.
 */

import * as THREE from 'three';
import { LIGHT, RENDER } from '../config/world.config';
import type { GameContext, System } from '../core/types';
import { clamp01, lerp } from '../utils/math';
import { skyState } from './skyModel';

export class Lighting implements System {
  readonly name = 'ws4:lighting';

  private sun!: THREE.DirectionalLight;
  private moon!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private ambient!: THREE.AmbientLight;

  /** Size of one shadow-map texel in world metres — the snapping quantum. */
  private texelWorldSize = 1;
  private readonly focus = new THREE.Vector3();

  init(ctx: GameContext): void {
    const r = LIGHT.shadowRadius;

    this.sun = new THREE.DirectionalLight(skyState.sunColor.getHex(), skyState.sunIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(RENDER.shadowMapSize, RENDER.shadowMapSize);
    this.sun.shadow.bias = LIGHT.shadowBias;
    this.sun.shadow.normalBias = LIGHT.shadowNormalBias;

    const cam = this.sun.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 1;
    // The light sits `shadowDistance` above the focus, so the far plane must clear both the climb
    // up to it and whatever depth of terrain sits below.
    cam.far = LIGHT.shadowDistance * 2;
    cam.updateProjectionMatrix();
    this.texelWorldSize = (2 * r) / RENDER.shadowMapSize;

    // A DirectionalLight aims at its target object, which must itself be in the scene graph.
    ctx.scene.add(this.sun);
    ctx.scene.add(this.sun.target);

    this.moon = new THREE.DirectionalLight(skyState.moonColor.getHex(), 0);
    this.moon.castShadow = false;
    ctx.scene.add(this.moon);

    this.hemi = new THREE.HemisphereLight(
      skyState.zenithColor.getHex(),
      skyState.groundColor.getHex(),
      LIGHT.hemiIntensityDay,
    );
    ctx.scene.add(this.hemi);

    // A floor so nothing in shadow is ever pure black, which tone mapping would crush anyway.
    this.ambient = new THREE.AmbientLight(0xffffff, LIGHT.ambientDay);
    ctx.scene.add(this.ambient);

    this.apply(ctx);
  }

  update(_dt: number, ctx: GameContext): void {
    this.apply(ctx);
  }

  /**
   * Copy this frame's sky into the lights and re-fit the shadow frustum around the player.
   *
   * @complexity Time: O(1), zero allocations.
   */
  private apply(ctx: GameContext): void {
    this.sun.color.copy(skyState.sunColor);
    this.sun.intensity = skyState.sunIntensity;
    this.sun.castShadow = skyState.sunIntensity >= LIGHT.shadowMinSunIntensity;

    this.moon.color.copy(skyState.moonColor);
    this.moon.intensity = skyState.moonIntensity;
    this.moon.position.copy(skyState.moonDirection).multiplyScalar(LIGHT.shadowDistance);

    // Ambient bounce tracks how bright the *sky* is, not how high the sun is. At dusk the sun
    // contributes almost nothing directly while the sky is a huge orange area light, so the golden
    // hour term keeps the ground lit through the exact window that would otherwise go black.
    const bounce = clamp01(skyState.daylight + skyState.goldenHour * LIGHT.goldenHourBounce);
    // Most of the sky's *energy* sits near the horizon, and overwhelmingly so at golden hour, so
    // the hemisphere's "sky" colour leans that way rather than using the zenith straight.
    this.hemi.color
      .copy(skyState.zenithColor)
      .lerp(skyState.horizonColor, 0.35 + 0.55 * skyState.goldenHour);
    this.hemi.groundColor.copy(skyState.groundColor);
    this.hemi.intensity = lerp(LIGHT.hemiIntensityNight, LIGHT.hemiIntensityDay, bounce);
    this.ambient.intensity = lerp(LIGHT.ambientNight, LIGHT.ambientDay, bounce);

    // Quantising the focus to whole shadow texels is what stops shadow edges from crawling as the
    // player walks: the projected scene now moves in exact texel steps instead of sub-texel ones.
    const q = this.texelWorldSize;
    this.focus.copy(ctx.player.position);
    this.focus.set(
      Math.round(this.focus.x / q) * q,
      Math.round(this.focus.y / q) * q,
      Math.round(this.focus.z / q) * q,
    );

    this.sun.target.position.copy(this.focus);
    this.sun.target.updateMatrixWorld();
    this.sun.position
      .copy(skyState.sunDirection)
      .multiplyScalar(LIGHT.shadowDistance)
      .add(this.focus);
  }

  dispose(): void {
    this.sun.target.removeFromParent();
    for (const light of [this.sun, this.moon, this.hemi, this.ambient]) {
      light.removeFromParent();
      light.dispose();
    }
  }
}
