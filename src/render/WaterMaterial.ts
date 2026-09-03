/**
 * src/render/WaterMaterial.ts
 *
 * Contents: `createWaterMaterial()` — one `ShaderMaterial` serving both the sea plane and the river
 * ribbons, plus `createHeightTexture()`, which packs `WorldData.heights` into a GPU texture so the
 * sea can work out how deep it is under every pixel.
 *
 * Purpose: water sells "this is a place" more cheaply than anything else in the renderer. This is
 * deliberately a fake: scrolling dual value-noise for the normal, a fresnel rim reflecting the sky
 * gradient, a depth-driven colour ramp, and a foam band where the bed comes near the surface. No
 * render targets, no refraction pass, no depth prepass.
 *
 * ── HOW DEPTH WORKS ─────────────────────────────────────────────────────────
 *   Sea:    depth is sampled per-pixel from a heightmap texture built off `WorldData.heights`, so
 *           the coastline and its foam are crisp even though the sea mesh is a coarse grid.
 *           Outside the island bounds the shader ramps to `WATER.openOceanDepth`.
 *   Rivers: the heightmap is far too coarse for a 12 m channel, so ribbon geometry supplies depth
 *           per-vertex through `aDepth` and flow direction through `aFlow` (`WATER_RIVER` define).
 *
 * Where depth is <= 0 the ground is above the water line and the fragment is discarded — that is
 * what lets one 8 km sea plane sit under the whole island without being seen through the hills.
 */

import * as THREE from 'three';
import { WATER } from '../config/world.config';
import type { GameContext, WorldData } from '../core/types';
import { GLSL_NOISE } from './shaderLib';
import { skyUniforms } from './skyModel';

export type WaterKind = 'sea' | 'river';

const VERTEX = /* glsl */ `
varying vec3 vWorldPos;

// Only the river variant has these. Declaring them in the sea program too would make them active
// attributes with nothing bound to them, and WebGL would then feed in whatever generic attribute
// value the previous draw call happened to leave behind.
#ifdef WATER_RIVER
  attribute float aDepth;
  attribute vec2 aFlow;
  varying float vDepthAttr;
  varying vec2 vFlow;
#endif

uniform float uTime;
uniform float uSwell;

#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>

void main() {
  vec3 pos = position;
  vWorldPos = ( modelMatrix * vec4( pos, 1.0 ) ).xyz;

  #ifdef WATER_RIVER
    vDepthAttr = aDepth;
    vFlow = aFlow;
  #endif

  // Two crossed low-frequency swells. Purely cosmetic and small enough that the player's feet
  // never visibly disagree with the physics plane at sea level.
  float swell = sin( vWorldPos.x * 0.035 + uTime * 0.6 ) * cos( vWorldPos.z * 0.028 - uTime * 0.45 );
  pos.y += swell * uSwell;

  vec4 mvPosition = modelViewMatrix * vec4( pos, 1.0 );
  gl_Position = projectionMatrix * mvPosition;

  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
varying vec3 vWorldPos;

#ifdef WATER_RIVER
  varying float vDepthAttr;
  varying vec2 vFlow;
#endif

uniform float uTime;
uniform vec2 uWind;

uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform vec3 uFoamColor;
uniform float uMaxOpacity;
uniform float uWaveScale;
uniform float uWaveSpeed;
uniform float uWaveStrength;
uniform float uFresnelPower;
uniform float uSpecularPower;
uniform float uFoamDepth;
uniform float uColorDepth;

uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform float uDaylight;

#ifndef WATER_RIVER
  uniform sampler2D uHeightMap;
  uniform float uWorldSize;
  uniform float uSeaLevel;
  uniform float uOpenOceanDepth;
  uniform float uOpenOceanRamp;
#endif

#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>

${GLSL_NOISE}

/**
 * Surface normal from two counter-scrolling noise fields, differentiated by finite difference.
 * Cheaper and more controllable than a real normal map, and it costs no texture fetch.
 */
vec3 ws4_waterNormal( vec2 p, vec2 drift ) {
  float e = 0.75;
  vec2 a = p * uWaveScale + drift;
  vec2 b = p * uWaveScale * 2.17 - drift * 1.63;
  float h  = ws4_fbm2( a )            + 0.5 * ws4_fbm2( b );
  float hx = ws4_fbm2( a + vec2( e * uWaveScale, 0.0 ) )
           + 0.5 * ws4_fbm2( b + vec2( e * uWaveScale * 2.17, 0.0 ) );
  float hz = ws4_fbm2( a + vec2( 0.0, e * uWaveScale ) )
           + 0.5 * ws4_fbm2( b + vec2( 0.0, e * uWaveScale * 2.17 ) );
  return normalize( vec3( ( h - hx ) * uWaveStrength, 0.12, ( h - hz ) * uWaveStrength ) );
}

void main() {
  #include <logdepthbuf_fragment>

  #ifdef WATER_RIVER
    float depth = vDepthAttr;
    vec2 drift = -vFlow * uTime * uWaveSpeed * 6.0;
  #else
    // Clamped sampling plus an explicit ramp: past the heightmap the bed is unknown, so declare it
    // deep rather than trusting the edge texel, which would smear the coastline out to sea.
    vec2 uv = vWorldPos.xz / uWorldSize + 0.5;
    float bed = texture2D( uHeightMap, clamp( uv, 0.0, 1.0 ) ).r;
    float depth = uSeaLevel - bed;
    vec2 outside = max( abs( vWorldPos.xz ) - uWorldSize * 0.5, vec2( 0.0 ) );
    depth = mix( depth, uOpenOceanDepth, smoothstep( 0.0, uOpenOceanRamp, length( outside ) ) );
    vec2 drift = uWind * uTime * uWaveSpeed;
  #endif

  // Above the waterline: this pixel is dry land, so there is no water here at all.
  if ( depth <= 0.0 ) discard;

  vec3 normal = ws4_waterNormal( vWorldPos.xz, drift );
  vec3 viewDir = normalize( cameraPosition - vWorldPos );

  float fresnel = pow( 1.0 - clamp( dot( normal, viewDir ), 0.0, 1.0 ), uFresnelPower );

  // "Reflection" = the sky gradient at the reflected elevation. Costs nothing and is the reason
  // the sea changes colour convincingly through the day/night cycle.
  vec3 reflectDir = reflect( -viewDir, normal );
  vec3 skyRefl = mix( uHorizonColor, uZenithColor, smoothstep( 0.0, 0.55, reflectDir.y ) );

  vec3 body = mix( uShallowColor, uDeepColor, smoothstep( 0.0, uColorDepth, depth ) );
  body *= 0.25 + 0.75 * uDaylight;

  vec3 color = mix( body, skyRefl, clamp( fresnel, 0.0, 0.85 ) );

  // Sun glitter.
  vec3 halfVec = normalize( uSunDirection + viewDir );
  float spec = pow( max( dot( normal, halfVec ), 0.0 ), uSpecularPower );
  color += uSunColor * spec * 1.6 * uDaylight;

  // Foam where the bed rises to meet the surface, broken up so the shoreline is not a clean band.
  float foamNoise = ws4_fbm2( vWorldPos.xz * 0.22 + drift * 2.0 );
  float foam = smoothstep( uFoamDepth, 0.0, depth ) * smoothstep( 0.25, 0.75, foamNoise );
  color = mix( color, uFoamColor * ( 0.35 + 0.65 * uDaylight ), clamp( foam, 0.0, 0.9 ) );

  float alpha = clamp( smoothstep( 0.0, 0.4, depth ) * uMaxOpacity + fresnel * 0.25 + foam * 0.5, 0.0, 1.0 );

  gl_FragColor = vec4( color, alpha );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/**
 * Build a water material.
 *
 * @param ctx  - game context; `uTime` and `uWind` are bound by reference from `ctx.uniforms`.
 * @param kind - `'sea'` samples depth from the heightmap texture, `'river'` from `aDepth`.
 * @returns a transparent `ShaderMaterial`. Fog and tone mapping are wired up like a built-in.
 *
 * @complexity Time: O(1). One program per kind.
 */
export function createWaterMaterial(ctx: GameContext, kind: WaterKind): THREE.ShaderMaterial {
  const isRiver = kind === 'river';

  const uniforms: Record<string, THREE.IUniform> = {
    ...THREE.UniformsLib.fog,
    ...skyUniforms,
    uTime: ctx.uniforms.uTime,
    uWind: ctx.uniforms.uWind,

    uShallowColor: { value: new THREE.Color(WATER.shallowColor) },
    uDeepColor: { value: new THREE.Color(WATER.deepColor) },
    uFoamColor: { value: new THREE.Color(WATER.foamColor) },
    uMaxOpacity: { value: WATER.maxOpacity },
    uWaveScale: { value: WATER.waveScale },
    uWaveSpeed: { value: WATER.waveSpeed },
    uWaveStrength: { value: WATER.waveStrength },
    uFresnelPower: { value: WATER.fresnelPower },
    uSpecularPower: { value: WATER.specularPower },
    uFoamDepth: { value: WATER.foamDepth },
    uColorDepth: { value: WATER.colorDepth },
    // Rivers follow the terrain they were carved into; only the open sea gets a swell.
    uSwell: { value: isRiver ? 0 : WATER.swellHeight },
  };

  if (!isRiver) {
    uniforms.uHeightMap = { value: null };
    uniforms.uWorldSize = { value: ctx.world.data.size };
    uniforms.uSeaLevel = { value: ctx.world.data.seaLevel };
    uniforms.uOpenOceanDepth = { value: WATER.openOceanDepth };
    uniforms.uOpenOceanRamp = { value: WATER.openOceanRamp };
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    defines: isRiver ? { WATER_RIVER: '' } : {},
    transparent: true,
    // Water is a thin surface over opaque ground; writing depth would make overlapping ribbons
    // punch holes in each other and in the sea.
    depthWrite: false,
    fog: true,
    // A ribbon's winding flips wherever a spline doubles back, so rivers are drawn both ways.
    side: isRiver ? THREE.DoubleSide : THREE.FrontSide,
  });

  if (isRiver) {
    // Guards against a ribbon geometry missing an attribute: without a declared default, WebGL
    // reuses whatever generic vertex-attribute value the previous draw call left behind.
    // three's typings pin this object to its built-in keys, hence the cast.
    Object.assign(material.defaultAttributeValues as Record<string, number[]>, {
      aDepth: [0],
      aFlow: [0, 0],
    });
  }

  return material;
}

/**
 * Pack `WorldData.heights` into a single-channel half-float texture for the sea shader.
 *
 * Half-float carries ~3 decimal digits, so precision is worst at the top of the mountains (±0.25 m
 * at 400 m) and essentially exact near y = 0 — which is precisely where the shoreline, and the only
 * consumer of this texture, lives.
 *
 * @param data - the world heightfield. `heights` is row-major, `index = z * resolution + x`.
 * @returns a `ClampToEdge`, linearly filtered `DataTexture`. Caller owns disposal.
 *
 * @complexity Time: O(resolution²) — 263 k conversions for the default 513² grid, ~2 ms.
 *             Space: O(resolution²) — 526 kB for 513².
 */
export function createHeightTexture(data: WorldData): THREE.DataTexture {
  const { heights, resolution } = data;
  const halves = new Uint16Array(resolution * resolution);
  for (let i = 0; i < halves.length; i++) {
    halves[i] = THREE.DataUtils.toHalfFloat(heights[i]);
  }
  const tex = new THREE.DataTexture(
    halves,
    resolution,
    resolution,
    THREE.RedFormat,
    THREE.HalfFloatType,
  );
  // Row 0 of `heights` is z = -size/2, and DataTexture does not flip, so v maps straight to z.
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
