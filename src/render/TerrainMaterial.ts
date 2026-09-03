/**
 * src/render/TerrainMaterial.ts
 *
 * Contents: `createTerrainMaterial()` — a `MeshStandardMaterial` whose shader is extended through
 * `onBeforeCompile` to blend four procedural biome palettes, re-derive rock and snow from the real
 * surface slope, add triplanar detail grain, darken when wet, and draw the Odradek scan ring.
 *
 * Purpose: this is the material WS1's terrain chunks render with. It is the single place that turns
 * the `aBiome` vertex attribute into a landscape. Everything is procedural — no textures are
 * downloaded, which is what keeps first paint under the 5 s budget.
 *
 * ── CONTRACT FOR WS1 ────────────────────────────────────────────────────────
 *   Geometry MUST provide: `position`, `normal`.
 *   Geometry SHOULD provide: `aBiome`  (vec4, [grass, rock, snow, sand], sums to 1)
 *   Geometry MAY provide:    `aRiver`  (float 0..1, distance-to-channel mask, 1 = river bed)
 *   Geometry MAY provide:    `aWet`    (float 0..1, any other permanently damp ground)
 *   No UVs and no vertex colours are used; do not write them.
 *   Chunks may be positioned with `mesh.position` — all shading is done in world space.
 *
 *   If `aBiome` is absent the shader detects it (an unbound vec4 attribute reads as (0,0,0,1)) and
 *   falls back to an altitude+slope estimate, so the world still looks like a world. Because of
 *   that detection, WS1 should never emit a vertex of *exactly* (0,0,0,1); clamp pure sand to
 *   (0.001, 0, 0, 0.999).
 *
 * ── CONTRACT FOR WS6 ────────────────────────────────────────────────────────
 *   The material binds `ctx.uniforms.uWetness`, `uScanOrigin` and `uScanRadius` by reference.
 *   Write `.value` on those objects; never replace them and never touch this file.
 *
 * Cost: one extra fBm (12 hashes) plus one triplanar (36 hashes) per fragment, and no extra draw
 * calls or passes. Share ONE material instance across every chunk so the program is compiled once.
 */

import * as THREE from 'three';
import { TERRAIN_LOOK, WORLD } from '../config/world.config';
import type { GameContext } from '../core/types';
import { GLSL_NOISE } from './shaderLib';

/** Uniforms this material owns (as opposed to the ones it borrows from `ctx.uniforms`). */
interface TerrainOwnUniforms {
  [name: string]: THREE.IUniform;
}

const VERTEX_PARS = /* glsl */ `
attribute vec4 aBiome;
attribute float aWet;
attribute float aRiver;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec4 vBiomeW;
varying float vWetW;

uniform float uSeaLevel;
uniform float uSnowLine;
uniform vec2 uRockSlope;
uniform vec2 uSnowSlope;

/**
 * Used only when the geometry has no aBiome attribute. Reproduces the broad strokes of WS1's
 * biome map from information every mesh already has: how high it is and how steep it is.
 */
vec4 ws4_proceduralBiome( vec3 p, vec3 n ) {
  float slopeDeg = degrees( acos( clamp( n.y, 0.0, 1.0 ) ) );
  float rock = smoothstep( uRockSlope.x, uRockSlope.y, slopeDeg );
  float snow = smoothstep( uSnowLine - 70.0, uSnowLine + 30.0, p.y )
             * ( 1.0 - smoothstep( uSnowSlope.x, uSnowSlope.y, slopeDeg ) );
  float sand = 1.0 - smoothstep( uSeaLevel + 0.5, uSeaLevel + 5.0, p.y );
  float grass = max( 0.0, 1.0 - rock - snow - sand );
  vec4 b = vec4( grass, rock, snow, sand );
  return b / max( dot( b, vec4( 1.0 ) ), 1e-4 );
}
`;

const VERTEX_BODY = /* glsl */ `
  vWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );

  float ws4_sum = dot( aBiome, vec4( 1.0 ) );
  vec4 ws4_b = ws4_sum > 1e-4 ? aBiome / ws4_sum : vec4( 1.0, 0.0, 0.0, 0.0 );
  // WebGL hands an unbound vec4 attribute the value (0,0,0,1), which would paint the entire world
  // pure sand. Treat "w is the only component set" as "attribute missing" and estimate instead.
  float ws4_hasBiome = step( 1e-3, aBiome.x + aBiome.y + aBiome.z );
  vBiomeW = mix( ws4_proceduralBiome( vWorldPos, vWorldNormal ), ws4_b, ws4_hasBiome );

  // Two independent damp masks, strongest wins: WS1's river-channel distance field and a generic
  // one for anything else. Both default to 0, so "attribute absent" degrades to "never damp".
  vWetW = clamp( max( aWet, aRiver ), 0.0, 1.0 );
`;

const FRAGMENT_PARS = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec4 vBiomeW;
varying float vWetW;

uniform float uSeaLevel;
uniform vec2 uRockSlope;
uniform vec2 uSnowSlope;
uniform float uMacroScale;
uniform float uDetailScale;
/** x = distance where close-up detail starts fading, y = distance where it is gone. */
uniform vec2 uDetailFade;
/** x = strata amplitude, y = strata vertical frequency. */
uniform vec2 uStrata;

uniform vec3 uGrassLush;
uniform vec3 uGrassDry;
uniform vec3 uRockLight;
uniform vec3 uRockDark;
uniform vec3 uSnowBright;
uniform vec3 uSnowShade;
uniform vec3 uSandLight;
uniform vec3 uSandDark;

/** x = albedo multiplier when soaked, y = roughness when soaked, z = shoreline dry-out height. */
uniform vec3 uWetParams;
uniform float uWetness;

uniform vec3 uScanOrigin;
uniform float uScanRadius;
/** x = ring width (m), y = trail length (m). */
uniform vec2 uScanRing;
/** x = ring gain, y = trail gain. */
uniform vec2 uScanGains;
/** Slope in degrees at which terrain reads walkable / costly / lethal. */
uniform vec3 uScanSlopes;
uniform vec3 uScanGood;
uniform vec3 uScanWarn;
uniform vec3 uScanBad;

${GLSL_NOISE}
`;

const FRAGMENT_BODY = /* glsl */ `
  vec3 ws4_n = normalize( vWorldNormal );
  float ws4_slopeDeg = degrees( acos( clamp( ws4_n.y, 0.0, 1.0 ) ) );

  // Slope always wins over the biome map. Cliffs are bare rock however much grass the moisture map
  // wanted there, and snow does not cling to a vertical face — that single rule is most of what
  // makes a mountain read as a mountain.
  vec4 ws4_b = vBiomeW;
  ws4_b.z *= 1.0 - smoothstep( uSnowSlope.x, uSnowSlope.y, ws4_slopeDeg );
  ws4_b.y = max( ws4_b.y, smoothstep( uRockSlope.x, uRockSlope.y, ws4_slopeDeg ) );
  ws4_b /= max( dot( ws4_b, vec4( 1.0 ) ), 1e-4 );

  float ws4_macro = ws4_fbm2( vWorldPos.xz * uMacroScale );

  // Close-up grain is sub-pixel past a few hundred metres, where it turns into crawling noise on
  // every distant ridge. Fade it to its own mean instead, and skip the triplanar entirely out
  // there — distant terrain is most of the screen, and the branch is uniform across those quads.
  float ws4_near = 1.0 - smoothstep( uDetailFade.x, uDetailFade.y, length( vViewPosition ) );
  float ws4_detail = 0.5;
  if ( ws4_near > 0.002 ) {
    ws4_detail = mix( 0.5, ws4_triplanar( vWorldPos, ws4_n, uDetailScale ), ws4_near );
  }

  vec3 ws4_grass = mix( uGrassLush, uGrassDry, ws4_macro ) * ( 0.82 + 0.36 * ws4_detail );
  vec3 ws4_rock = mix( uRockDark, uRockLight, ws4_detail * 0.7 + ws4_macro * 0.3 );
  // Bedding planes. The phase is heavily warped by the macro field, otherwise a global sine in
  // world Y draws perfect contour lines across every mountain in the scene.
  ws4_rock *= 1.0 + uStrata.x * ( 0.35 + 0.65 * ws4_near )
            * sin( vWorldPos.y * uStrata.y + ws4_macro * 14.0 + ws4_detail * 2.0 );
  vec3 ws4_snow = mix( uSnowShade, uSnowBright, smoothstep( 0.35, 0.75, ws4_detail ) );
  vec3 ws4_sand = mix( uSandDark, uSandLight, ws4_macro ) * ( 0.9 + 0.2 * ws4_detail );

  vec3 ws4_albedo = ws4_grass * ws4_b.x + ws4_rock * ws4_b.y
                  + ws4_snow * ws4_b.z + ws4_sand * ws4_b.w;
  float ws4_rough = dot( ws4_b, vec4( 0.95, 0.88, 0.62, 0.94 ) );

  // Three wetness sources, strongest wins: WS1's per-vertex river/seep mask, a sea-level
  // proximity fallback for coastlines, and WS6's global rain. Snow soaks up less than soil.
  float ws4_shore = 1.0 - smoothstep( 0.0, uWetParams.z, vWorldPos.y - uSeaLevel );
  float ws4_wet = clamp( max( vWetW, ws4_shore ) + uWetness * ( 1.0 - 0.65 * ws4_b.z ), 0.0, 1.0 );
  ws4_albedo *= mix( 1.0, uWetParams.x, ws4_wet );
  float ws4_terrainRoughness = mix( ws4_rough, uWetParams.y, ws4_wet );

  diffuseColor.rgb = ws4_albedo;

  // Odradek pulse: a bright expanding ring plus a short tint trail behind it, coloured by how
  // walkable the ground under each fragment is. Inactive when WS6 leaves uScanRadius <= 0.
  vec3 ws4_scan = vec3( 0.0 );
  if ( uScanRadius > 0.0 ) {
    float ws4_d = distance( vWorldPos.xz, uScanOrigin.xz );
    float ws4_ring = 1.0 - smoothstep( 0.0, uScanRing.x, abs( ws4_d - uScanRadius ) );
    float ws4_inside = 1.0 - step( uScanRadius, ws4_d );
    float ws4_trail = ws4_inside * smoothstep( uScanRadius - uScanRing.y, uScanRadius, ws4_d );
    vec3 ws4_trav = mix( uScanGood, uScanWarn, smoothstep( uScanSlopes.x, uScanSlopes.y, ws4_slopeDeg ) );
    ws4_trav = mix( ws4_trav, uScanBad, smoothstep( uScanSlopes.y, uScanSlopes.z, ws4_slopeDeg ) );
    ws4_scan = ws4_trav * ( ws4_ring * uScanGains.x + ws4_trail * uScanGains.y );
  }
`;

/**
 * Build the shared terrain material.
 *
 * @param ctx - the game context; only `ctx.uniforms` and `ctx.world.data.seaLevel` are read, and
 *              the uniform objects are captured by reference so WS6 can drive them.
 * @returns a `MeshStandardMaterial` ready to be shared by every terrain chunk.
 *
 * @complexity Time: O(1). One shader program is compiled the first time a mesh using it renders.
 *
 * @example
 * const mat = createTerrainMaterial(ctx);          // once, in WorldSystem.init
 * chunkMesh = new THREE.Mesh(chunkGeometry, mat);  // reuse for all 256 chunks
 */
export function createTerrainMaterial(ctx: GameContext): THREE.MeshStandardMaterial {
  const seaLevel = ctx.world.data.seaLevel;

  const own: TerrainOwnUniforms = {
    uSeaLevel: { value: seaLevel },
    uSnowLine: { value: WORLD.snowLine },
    uRockSlope: {
      value: new THREE.Vector2(TERRAIN_LOOK.rockSlopeStartDeg, TERRAIN_LOOK.rockSlopeFullDeg),
    },
    uSnowSlope: {
      value: new THREE.Vector2(TERRAIN_LOOK.snowSlopeKeepDeg, TERRAIN_LOOK.snowSlopeGoneDeg),
    },
    uMacroScale: { value: TERRAIN_LOOK.macroNoiseScale },
    uDetailScale: { value: TERRAIN_LOOK.detailNoiseScale },
    uDetailFade: {
      value: new THREE.Vector2(TERRAIN_LOOK.detailFadeStart, TERRAIN_LOOK.detailFadeEnd),
    },
    uStrata: {
      value: new THREE.Vector2(TERRAIN_LOOK.strataStrength, TERRAIN_LOOK.strataFrequency),
    },

    uGrassLush: { value: new THREE.Color(TERRAIN_LOOK.grassLush) },
    uGrassDry: { value: new THREE.Color(TERRAIN_LOOK.grassDry) },
    uRockLight: { value: new THREE.Color(TERRAIN_LOOK.rockLight) },
    uRockDark: { value: new THREE.Color(TERRAIN_LOOK.rockDark) },
    uSnowBright: { value: new THREE.Color(TERRAIN_LOOK.snowBright) },
    uSnowShade: { value: new THREE.Color(TERRAIN_LOOK.snowShade) },
    uSandLight: { value: new THREE.Color(TERRAIN_LOOK.sandLight) },
    uSandDark: { value: new THREE.Color(TERRAIN_LOOK.sandDark) },

    uWetParams: {
      value: new THREE.Vector3(
        TERRAIN_LOOK.wetDarkening,
        TERRAIN_LOOK.wetRoughness,
        TERRAIN_LOOK.shoreWetHeight,
      ),
    },

    uScanRing: { value: new THREE.Vector2(TERRAIN_LOOK.scanRingWidth, TERRAIN_LOOK.scanTrail) },
    uScanGains: { value: new THREE.Vector2(TERRAIN_LOOK.scanRingGain, TERRAIN_LOOK.scanTrailGain) },
    uScanSlopes: {
      value: new THREE.Vector3(
        TERRAIN_LOOK.scanWalkableDeg,
        TERRAIN_LOOK.scanCostlyDeg,
        TERRAIN_LOOK.scanFallDeg,
      ),
    },
    uScanGood: { value: new THREE.Color(TERRAIN_LOOK.scanColorGood) },
    uScanWarn: { value: new THREE.Color(TERRAIN_LOOK.scanColorWarn) },
    uScanBad: { value: new THREE.Color(TERRAIN_LOOK.scanColorBad) },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    dithering: true,
  });

  material.onBeforeCompile = (shader) => {
    // Shared-by-reference: WS6 writes `.value` on these and every material sees it immediately.
    shader.uniforms.uWetness = ctx.uniforms.uWetness;
    shader.uniforms.uScanOrigin = ctx.uniforms.uScanOrigin;
    shader.uniforms.uScanRadius = ctx.uniforms.uScanRadius;
    Object.assign(shader.uniforms, own);

    shader.vertexShader = VERTEX_PARS + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n' + VERTEX_BODY,
    );

    shader.fragmentShader = FRAGMENT_PARS + shader.fragmentShader
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAGMENT_BODY)
      // `ws4_terrainRoughness` and `ws4_scan` are locals of main(), declared above by FRAGMENT_BODY
      // and still in scope at these later chunks.
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n  roughnessFactor = ws4_terrainRoughness;',
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n  totalEmissiveRadiance += ws4_scan;',
      );
  };

  // Every chunk shares one material and one program variant, so a constant key is correct and
  // stops three from hashing the (large) shader source on every material change.
  material.customProgramCacheKey = () => 'ws4-terrain-v1';
  material.userData.ws4Uniforms = own;

  // Without this, a geometry missing `aBiome` inherits whatever generic vertex-attribute value the
  // previous draw call left in WebGL state — the world's colour would depend on draw order. Not
  // declared on `Material` in three's typings (only on `ShaderMaterial`), hence the cast.
  (material as unknown as { defaultAttributeValues: Record<string, number[]> })
    .defaultAttributeValues = { aBiome: [0, 0, 0, 1], aWet: [0], aRiver: [0] };

  return material;
}
