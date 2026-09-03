/**
 * src/render/skyModel.ts
 *
 * Contents: the day/night model. `skyState` holds everything derived from `ctx.time.timeOfDay` —
 * sun/moon directions, light colours and intensities, the sky gradient keyframes, and the fog
 * colour and distances. `skyUniforms` mirrors the subset the shaders need, as three uniform
 * objects that are shared *by reference*.
 *
 * Purpose: `SkySystem` (dome + fog), `Lighting` (sun/moon/hemisphere) and `WaterMaterial` (sun
 * specular, sky reflection) all need the same numbers, and they must agree exactly or the sun disc
 * will be in one place and its shadows in another. Rather than have those systems import each
 * other — which PLAN.md forbids — they all read this one module-level object. `SkySystem` is the
 * only writer; it calls `updateSkyState` once per frame before anyone else runs.
 *
 * All three consumers are WS4-owned, so this module is an internal implementation detail of WS4,
 * not a cross-workstream contract. WS6 talks to WS4 through `ctx.uniforms` instead.
 *
 * Convention: `timeOfDay` is 0..1 with 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset.
 * `sunDirection` points *from the ground toward the sun*, which is the direction a
 * `THREE.DirectionalLight` must be offset in and the direction a shader dots against a normal.
 */

import * as THREE from 'three';
import { SKY, LIGHT } from '../config/world.config';
import { clamp01, lerp, smoothstep, TAU } from '../utils/math';

export interface SkyState {
  /** Unit vector from the ground toward the sun. */
  readonly sunDirection: THREE.Vector3;
  /** Unit vector toward the moon — exactly antipodal to the sun. */
  readonly moonDirection: THREE.Vector3;
  /** −1 (sun at nadir) .. +1 (sun at zenith). This drives literally everything else. */
  sunAltitude: number;
  /** 0 at night, 1 in full day. Smoothed across the horizon crossing. */
  daylight: number;
  /** Peaks at 1 when the sun sits on the horizon; 0 by mid-morning. */
  goldenHour: number;

  readonly sunColor: THREE.Color;
  sunIntensity: number;
  readonly moonColor: THREE.Color;
  moonIntensity: number;

  readonly zenithColor: THREE.Color;
  readonly horizonColor: THREE.Color;
  readonly groundColor: THREE.Color;

  readonly fogColor: THREE.Color;
  fogNear: number;
  fogFar: number;
}

/** The single shared instance. Mutated in place every frame — never reassign it. */
export const skyState: SkyState = {
  sunDirection: new THREE.Vector3(0, 1, 0),
  moonDirection: new THREE.Vector3(0, -1, 0),
  sunAltitude: 1,
  daylight: 1,
  goldenHour: 0,
  sunColor: new THREE.Color(SKY.sunColorNoon),
  sunIntensity: LIGHT.sunIntensityNoon,
  moonColor: new THREE.Color(SKY.moonColor),
  moonIntensity: 0,
  zenithColor: new THREE.Color(SKY.dayZenith),
  horizonColor: new THREE.Color(SKY.dayHorizon),
  groundColor: new THREE.Color(SKY.groundHaze),
  fogColor: new THREE.Color(SKY.dayHorizon),
  fogNear: SKY.fogNearDay,
  fogFar: SKY.fogFarDay,
};

/**
 * The shader-visible slice of `skyState`. These objects are handed to every WS4 material inside
 * `onBeforeCompile` / the `ShaderMaterial` constructor, so mutating `.value` in place propagates
 * to all of them with no per-frame uniform bookkeeping.
 */
export const skyUniforms: Record<string, THREE.IUniform> = {
  uSunDirection: { value: skyState.sunDirection },
  uMoonDirection: { value: skyState.moonDirection },
  uSunColor: { value: skyState.sunColor },
  uMoonColor: { value: skyState.moonColor },
  uZenithColor: { value: skyState.zenithColor },
  uHorizonColor: { value: skyState.horizonColor },
  uGroundColor: { value: skyState.groundColor },
  uDaylight: { value: 1 },
  uGoldenHour: { value: 0 },
};

// Keyframe palettes, parsed once. `THREE.Color` construction allocates, so never do it per frame.
const DAY_ZENITH = new THREE.Color(SKY.dayZenith);
const DAY_HORIZON = new THREE.Color(SKY.dayHorizon);
const DUSK_ZENITH = new THREE.Color(SKY.duskZenith);
const DUSK_HORIZON = new THREE.Color(SKY.duskHorizon);
const NIGHT_ZENITH = new THREE.Color(SKY.nightZenith);
const NIGHT_HORIZON = new THREE.Color(SKY.nightHorizon);
const GROUND_HAZE = new THREE.Color(SKY.groundHaze);
const SUN_NOON = new THREE.Color(SKY.sunColorNoon);
const SUN_HORIZON = new THREE.Color(SKY.sunColorHorizon);

const scratch = new THREE.Color();

/**
 * Recompute the whole sky from the clock. Cheap and allocation-free — safe to call every frame.
 *
 * @param timeOfDay 0..1, wrapping. 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset.
 *
 * @complexity Time: O(1) | Space: O(1), zero allocations.
 */
export function updateSkyState(timeOfDay: number): void {
  // theta = 0 at sunrise, PI/2 at noon. The great circle is then tilted off the zenith so the sun
  // tracks slightly north/south instead of passing through the exact overhead point, which reads
  // as flat and kills every shadow at midday.
  const theta = (timeOfDay - 0.25) * TAU;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const tilt = SKY.sunTilt;
  skyState.sunDirection.set(cosT, sinT * Math.cos(tilt), sinT * Math.sin(tilt)).normalize();
  skyState.moonDirection.copy(skyState.sunDirection).negate();

  const alt = skyState.sunDirection.y;
  skyState.sunAltitude = alt;

  // Civil twilight, roughly: the world is still lit a little below the geometric horizon.
  const daylight = smoothstep(-0.18, 0.15, alt);
  const golden = 1 - smoothstep(0, 0.35, Math.abs(alt));
  skyState.daylight = daylight;
  skyState.goldenHour = golden;
  skyUniforms.uDaylight.value = daylight;
  skyUniforms.uGoldenHour.value = golden;

  // Two-stage palette blend: night → dusk as the sun approaches the horizon, dusk → day as it
  // climbs. A single mix on `daylight` would skip the orange entirely.
  const duskness = smoothstep(-0.32, -0.02, alt);
  const dayness = smoothstep(0.02, 0.28, alt);
  skyState.zenithColor.copy(NIGHT_ZENITH).lerp(DUSK_ZENITH, duskness).lerp(DAY_ZENITH, dayness);
  skyState.horizonColor.copy(NIGHT_HORIZON).lerp(DUSK_HORIZON, duskness).lerp(DAY_HORIZON, dayness);

  // The downward-facing haze is the horizon colour pulled toward neutral grey — that is what sells
  // aerial perspective when you look down a valley.
  skyState.groundColor.copy(skyState.horizonColor).lerp(GROUND_HAZE, 0.45 * daylight + 0.1);

  skyState.sunColor.copy(SUN_HORIZON).lerp(SUN_NOON, smoothstep(0.02, 0.45, alt));
  skyState.sunIntensity =
    lerp(LIGHT.sunIntensityHorizon, LIGHT.sunIntensityNoon, smoothstep(0, 0.6, alt)) *
    smoothstep(LIGHT.sunFadeStart, LIGHT.sunFadeEnd, alt);

  // The moon fades in only once the sun is genuinely gone, and only while it is above the horizon.
  skyState.moonIntensity =
    LIGHT.moonIntensity * (1 - daylight) * clamp01(skyState.moonDirection.y * 3);

  // Fog takes the horizon colour so distant geometry dissolves into exactly the sky behind it.
  // Pulling it slightly toward the zenith keeps low mountains from looking washed out.
  scratch.copy(skyState.zenithColor);
  skyState.fogColor.copy(skyState.horizonColor).lerp(scratch, 1 - SKY.fogHorizonMix);
  skyState.fogNear = lerp(SKY.fogNearNight, SKY.fogNearDay, daylight);
  skyState.fogFar = lerp(SKY.fogFarNight, SKY.fogFarDay, daylight);
}
