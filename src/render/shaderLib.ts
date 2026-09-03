/**
 * src/render/shaderLib.ts
 *
 * Contents: GLSL source fragments shared by every WS4 material — cheap hashes, 2D/3D value noise,
 * 3-octave fBm, and a triplanar sampling helper built on top of them.
 *
 * Purpose: the terrain, water and sky shaders all want the same procedural primitives. One copy
 * keeps them visually consistent (the same grain appears on ground and under water) and gives a
 * single place to optimise if the fragment cost ever shows up in a profile.
 *
 * Naming: every symbol is prefixed `ws4_`. These strings are concatenated into the *same*
 * translation unit as three.js's own shader chunks, so an unprefixed `noise()` would eventually
 * collide with something.
 *
 * Cost: `ws4_noise3` is 8 hashes and `ws4_fbm3` is 24; `ws4_noise2` is 4 and `ws4_fbm2` is 12.
 * `ws4_triplanar` runs `ws4_fbm2` three times ⇒ 36. Budget one triplanar call per fragment.
 */

/** Hashes and value noise. Include before anything that calls them. */
export const GLSL_NOISE = /* glsl */ `
float ws4_hash13( vec3 p3 ) {
  p3 = fract( p3 * 0.1031 );
  p3 += dot( p3, p3.zyx + 31.32 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

float ws4_hash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

float ws4_noise2( vec2 x ) {
  vec2 i = floor( x );
  vec2 f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = ws4_hash12( i );
  float b = ws4_hash12( i + vec2( 1.0, 0.0 ) );
  float c = ws4_hash12( i + vec2( 0.0, 1.0 ) );
  float d = ws4_hash12( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}

float ws4_noise3( vec3 x ) {
  vec3 i = floor( x );
  vec3 f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  float n000 = ws4_hash13( i );
  float n100 = ws4_hash13( i + vec3( 1.0, 0.0, 0.0 ) );
  float n010 = ws4_hash13( i + vec3( 0.0, 1.0, 0.0 ) );
  float n110 = ws4_hash13( i + vec3( 1.0, 1.0, 0.0 ) );
  float n001 = ws4_hash13( i + vec3( 0.0, 0.0, 1.0 ) );
  float n101 = ws4_hash13( i + vec3( 1.0, 0.0, 1.0 ) );
  float n011 = ws4_hash13( i + vec3( 0.0, 1.0, 1.0 ) );
  float n111 = ws4_hash13( i + vec3( 1.0, 1.0, 1.0 ) );
  return mix(
    mix( mix( n000, n100, f.x ), mix( n010, n110, f.x ), f.y ),
    mix( mix( n001, n101, f.x ), mix( n011, n111, f.x ), f.y ),
    f.z
  );
}

// 3 octaves, amplitudes 1/2 + 1/4 + 1/8 = 7/8, rescaled back to roughly 0..1.
float ws4_fbm2( vec2 p ) {
  float v = 0.0;
  float a = 0.5;
  for ( int i = 0; i < 3; i ++ ) {
    v += a * ws4_noise2( p );
    p *= 2.03;
    a *= 0.5;
  }
  return v * 1.1428571;
}

float ws4_fbm3( vec3 p ) {
  float v = 0.0;
  float a = 0.5;
  for ( int i = 0; i < 3; i ++ ) {
    v += a * ws4_noise3( p );
    p *= 2.03;
    a *= 0.5;
  }
  return v * 1.1428571;
}

/**
 * Projection-blended fBm. Ground detail sampled from world position alone smears into vertical
 * streaks on cliff faces; blending the three axis projections by the surface normal fixes that
 * without a UV set — which matters here because the terrain has no UVs at all.
 */
float ws4_triplanar( vec3 p, vec3 n, float scale ) {
  vec3 w = pow( abs( n ), vec3( 4.0 ) );
  w /= max( w.x + w.y + w.z, 1e-4 );
  return w.x * ws4_fbm2( p.zy * scale )
       + w.y * ws4_fbm2( p.xz * scale )
       + w.z * ws4_fbm2( p.xy * scale );
}
`;
