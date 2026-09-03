/**
 * src/render/SkySystem.ts
 *
 * Contents: the `SkySystem` — a camera-locked gradient dome with a sun disc, a moon and a star
 * field, and the per-frame driver that advances `skyModel` and pushes its results into
 * `scene.fog` and `scene.background`.
 *
 * Purpose: two jobs, and the second one matters more than the first.
 *   1. Draw a sky that changes believably over the day/night cycle.
 *   2. Drive the fog colour from the *horizon* colour of that sky. Distant mountains then fade
 *      into exactly the band of sky sitting behind them, which is the whole trick behind aerial
 *      perspective — it does more for the sense of scale than any amount of geometry.
 *
 * Ordering: `SkySystem` must be registered before `Lighting` and before anything that reads
 * `skyState`, because it is the only writer and it updates in `update()`.
 *
 * Cost: one draw call, one triangle-strip-ish dome of ~2 k triangles, no shadow pass, no fog.
 * The dome is pinned to the camera and forced to the far plane, so it is depth-rejected wherever
 * terrain already covered the pixel.
 */

import * as THREE from 'three';
import { SKY } from '../config/world.config';
import type { GameContext, System } from '../core/types';
import { GLSL_NOISE } from './shaderLib';
import { skyState, skyUniforms, updateSkyState } from './skyModel';

const VERTEX = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = normalize( position );
  vec4 clip = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  // Force the dome onto the far plane. The mesh is then a unit sphere for culling purposes but
  // still draws behind absolutely everything, whatever the near/far settings are.
  gl_Position = clip.xyww;
}
`;

const FRAGMENT = /* glsl */ `
varying vec3 vDir;

uniform vec3 uSunDirection;
uniform vec3 uMoonDirection;
uniform vec3 uSunColor;
uniform vec3 uMoonColor;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform vec3 uGroundColor;
uniform float uDaylight;
uniform float uGoldenHour;
uniform float uSunDiscSize;
uniform float uMoonDiscSize;
uniform float uSunGlowExponent;
uniform float uSunGlowStrength;

${GLSL_NOISE}

/** Sparse point stars on a hashed lattice. Cheap enough to run every frame at full res. */
float ws4_stars( vec3 dir ) {
  vec3 p = dir * 320.0;
  vec3 id = floor( p );
  vec3 f = fract( p ) - 0.5;
  float r = ws4_hash13( id );
  float bright = smoothstep( 0.9965, 1.0, r );
  return bright * smoothstep( 0.3, 0.0, length( f ) );
}

void main() {
  vec3 dir = normalize( vDir );

  // pow() on the elevation compresses the gradient toward the horizon, where the interesting
  // colour lives; a linear ramp puts all the variation overhead where nobody looks.
  float up = clamp( dir.y, 0.0, 1.0 );
  vec3 color = mix( uHorizonColor, uZenithColor, pow( up, 0.45 ) );
  // Below the horizon the dome becomes the same haze the fog uses, so the seam is invisible.
  color = mix( uGroundColor, color, smoothstep( -0.14, 0.02, dir.y ) );

  float sunDot = max( dot( dir, uSunDirection ), 0.0 );

  // Broad glow, tightened and reddened at golden hour.
  float glowExp = mix( uSunGlowExponent, uSunGlowExponent * 0.45, uGoldenHour );
  color += uSunColor * pow( sunDot, glowExp ) * uSunGlowStrength * ( 0.4 + 0.6 * uDaylight );
  color += uSunColor * pow( sunDot, 220.0 ) * 0.9;

  float sunDisc = smoothstep( 1.0 - uSunDiscSize, 1.0 - uSunDiscSize * 0.35, sunDot );
  color += uSunColor * sunDisc * 6.0;

  float moonDot = max( dot( dir, uMoonDirection ), 0.0 );
  float moonDisc = smoothstep( 1.0 - uMoonDiscSize, 1.0 - uMoonDiscSize * 0.3, moonDot );
  float night = 1.0 - uDaylight;
  color += uMoonColor * moonDisc * 2.2 * night;
  color += uMoonColor * pow( moonDot, 90.0 ) * 0.25 * night;

  color += vec3( 0.85, 0.9, 1.0 ) * ws4_stars( dir ) * night * smoothstep( -0.02, 0.15, dir.y );

  gl_FragColor = vec4( color, 1.0 );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class SkySystem implements System {
  readonly name = 'ws4:sky';

  private dome!: THREE.Mesh;
  private geometry!: THREE.SphereGeometry;
  private material!: THREE.ShaderMaterial;

  init(ctx: GameContext): void {
    updateSkyState(ctx.time.timeOfDay);

    this.geometry = new THREE.SphereGeometry(1, SKY.domeSegments, SKY.domeSegments / 2);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...skyUniforms,
        uSunDiscSize: { value: SKY.sunDiscSize },
        uMoonDiscSize: { value: SKY.moonDiscSize },
        uSunGlowExponent: { value: SKY.sunGlowExponent },
        uSunGlowStrength: { value: SKY.sunGlowStrength },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });

    this.dome = new THREE.Mesh(this.geometry, this.material);
    this.dome.name = 'ws4:skyDome';
    // The dome is always exactly around the camera, so culling it is never right.
    this.dome.frustumCulled = false;
    this.dome.matrixAutoUpdate = false;
    ctx.scene.add(this.dome);

    this.applyFog(ctx);
  }

  update(_dt: number, ctx: GameContext): void {
    updateSkyState(ctx.time.timeOfDay);

    // `updateMatrix` also flags `matrixWorldNeedsUpdate`, which the renderer's own scene traversal
    // then honours — no need to walk the graph ourselves.
    this.dome.position.copy(ctx.camera.position);
    this.dome.updateMatrix();

    this.applyFog(ctx);
  }

  /**
   * Push the sky's horizon colour into the scene fog and clear colour. Mutates the existing
   * `THREE.Fog` and background `Color` in place — WS0's Engine owns those object identities.
   */
  private applyFog(ctx: GameContext): void {
    const fog = ctx.scene.fog;
    if (fog instanceof THREE.Fog) {
      fog.color.copy(skyState.fogColor);
      fog.near = skyState.fogNear;
      fog.far = skyState.fogFar;
    }
    if (ctx.scene.background instanceof THREE.Color) {
      ctx.scene.background.copy(skyState.fogColor);
    }
  }

  dispose(): void {
    this.dome.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
