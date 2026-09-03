/**
 * src/features/WeatherSystem.ts
 *
 * Contents: the `WeatherSystem` — WS6 feature ②, "timefall". Rain cells that drift across the
 * island on the prevailing wind, the wall of haze you see coming minutes before it arrives, the
 * GPU rain streaks and blizzard flakes in a box around the camera, the visibility collapse, and
 * the `uWetness` ramp that darkens the ground.
 *
 * Purpose: weather that *arrives*. A storm you can watch cross a valley toward you is worth far
 * more than a global rain toggle, and it costs the same.
 *
 * Cost: 5 draw calls at worst — one `LineSegments` for rain, one `Points` for snow, one open
 * cylinder per cell for the haze wall, and one camera-locked dome for the whiteout. No render
 * targets, no post-processing.
 *
 * Integration:
 *   - writes  `ctx.uniforms.uWetness.value` (WS4's terrain darkens and glosses) and
 *             `ctx.uniforms.uWind.value` (WS5's grass, WS4's sea drift) — always `.value`, never
 *             the uniform object, per WS4_STATUS §2
 *   - writes  `scene.fog` near/far/colour *after* WS4's `SkySystem` has written it, which is why
 *             this system must stay registered after the sky
 *   - emits   `weather:changed` — WS7's HUD shows `clear / timefall / blizzard` plus wind speed
 *   - listens `photo:toggle` → the storm holds still for the photograph
 *
 * Note on speed: cells drift at `WEATHER.cellDriftSpeed` (17 m/s, so one crosses the 2048 m island
 * in about two minutes, which is PLAN.md's acceptance criterion) while the *reported* surface wind
 * stays in the believable 1.7–8.5 m/s range. They are deliberately different numbers.
 */

import * as THREE from 'three';
import { CAMERA, WEATHER, WORLD } from '../config/world.config';
import type { Unsubscribe } from '../core/EventBus';
import type { GameContext, System } from '../core/types';
import { clamp01, damp, lerp, mulberry32, randomRange, smoothstep } from '../utils/math';
import { perf } from '../utils/Perf';

/** One drifting disc of bad weather. All cells share the prevailing wind direction. */
interface RainCell {
  center: THREE.Vector2;
  radius: number;
  strength: number;
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
}

const PRECIP_VERTEX_HEAD = /* glsl */ `
uniform vec3 uBox;
uniform vec3 uCenter;
uniform vec3 uPhase;
uniform vec3 uVel;
uniform float uFadeStart;
uniform float uFadeEnd;
varying float vFade;

/**
 * Wrap a seed point into a box that travels with the camera, then push it along the accumulated
 * drift. uPhase is integrated on the CPU rather than derived from time so that a change of wind
 * direction bends the fall instead of teleporting every drop.
 */
vec3 ws6_wrap( vec3 seed ) {
  vec3 origin = uCenter - uBox * 0.5;
  return mod( seed * uBox + uPhase - origin, uBox ) + origin;
}
`;

const RAIN_VERTEX = /* glsl */ `
${PRECIP_VERTEX_HEAD}

uniform float uStreak;
attribute float aTail;

void main() {
  vec3 p = ws6_wrap( position );
  // The tail vertex trails backwards along the velocity, so streaks shear with the wind.
  p -= normalize( uVel ) * ( uStreak * aTail );

  vFade = 1.0 - smoothstep( uFadeStart, uFadeEnd, distance( p, uCenter ) );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
}
`;

const RAIN_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vFade;

void main() {
  float alpha = uOpacity * vFade;
  if ( alpha <= 0.002 ) discard;
  gl_FragColor = vec4( uColor, alpha );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SNOW_VERTEX = /* glsl */ `
${PRECIP_VERTEX_HEAD}

uniform float uAge;
uniform float uSway;
uniform float uSwaySpeed;
uniform float uSize;

void main() {
  vec3 p = ws6_wrap( position );
  // Every flake gets its own phase from its seed, so the field never pulses in unison.
  float phase = uAge * uSwaySpeed + position.x * 37.0 + position.z * 19.0;
  p.x += sin( phase ) * uSway;
  p.z += cos( phase * 0.87 ) * uSway;

  vFade = 1.0 - smoothstep( uFadeStart, uFadeEnd, distance( p, uCenter ) );

  vec4 mvPosition = modelViewMatrix * vec4( p, 1.0 );
  gl_PointSize = clamp( uSize * ( 220.0 / max( 1.0, -mvPosition.z ) ), 1.0, 26.0 );
  gl_Position = projectionMatrix * mvPosition;
}
`;

const SNOW_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vFade;

void main() {
  float d = length( gl_PointCoord - 0.5 );
  float alpha = uOpacity * vFade * smoothstep( 0.5, 0.16, d );
  if ( alpha <= 0.004 ) discard;
  gl_FragColor = vec4( uColor, alpha );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const CURTAIN_VERTEX = /* glsl */ `
varying vec3 vWorldPos;
varying float vHeight;

#include <fog_pars_vertex>

void main() {
  vHeight = uv.y;
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vWorldPos = world.xyz;

  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;

  #include <fog_vertex>
}
`;

const CURTAIN_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform vec3 uCellCenter;

varying vec3 vWorldPos;
varying float vHeight;

#include <fog_pars_fragment>

void main() {
  // The shell's horizontal normal, derived from the cell axis rather than the interpolated one —
  // the cylinder is scaled non-uniformly, so its vertex normals are not the real surface normals.
  vec3 n = normalize( vec3( vWorldPos.x - uCellCenter.x, 0.0, vWorldPos.z - uCellCenter.z ) );
  vec3 v = normalize( cameraPosition - vWorldPos );

  // Grazing rays travel through more of the volume: that gradient is what makes a flat shell read
  // as a wall of rain rather than a cylinder.
  float rim = 1.0 - abs( dot( n, v ) );
  float vertical = pow( 1.0 - vHeight, 1.6 ) * smoothstep( 0.0, 0.05, vHeight );

  float alpha = clamp( uOpacity * vertical * ( 0.25 + 0.75 * rim ), 0.0, 1.0 );
  if ( alpha <= 0.003 ) discard;
  gl_FragColor = vec4( uColor, alpha );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export class WeatherSystem implements System {
  readonly name = 'weather';

  private readonly cells: RainCell[] = [];
  private readonly subscriptions: Unsubscribe[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];

  private group: THREE.Group | null = null;
  private rain: THREE.LineSegments | null = null;
  private rainMaterial: THREE.ShaderMaterial | null = null;
  private snow: THREE.Points | null = null;
  private snowMaterial: THREE.ShaderMaterial | null = null;
  private hazeDome: THREE.Mesh | null = null;
  private hazeMaterial: THREE.MeshBasicMaterial | null = null;

  private rng = mulberry32(WORLD.seed ^ 0x57031f);
  private windAngle = 0;
  private readonly windDir = new THREE.Vector2(1, 0);
  private readonly windVector = new THREE.Vector2(WEATHER.windBreeze, 0);

  private rainAmount = 0;
  private snowAmount = 0;
  private snowShare = 0;
  private wetness = 0;
  private frozen = false;
  private age = 0;

  private lastEmit = { rain: -1, snow: -1, wind: -1, time: -Infinity };

  private readonly rainPhase = new THREE.Vector3();
  private readonly snowPhase = new THREE.Vector3();
  private readonly rainVelocity = new THREE.Vector3();
  private readonly snowVelocity = new THREE.Vector3();
  private readonly stormColor = new THREE.Color();
  private readonly rainFogColor = new THREE.Color(WEATHER.rainFogColor);
  private readonly blizzardFogColor = new THREE.Color(WEATHER.blizzardFogColor);

  init(ctx: GameContext): void {
    this.rng = mulberry32((ctx.world.data.seed ^ 0x57031f) >>> 0);
    this.windAngle = this.rng() * Math.PI * 2;
    this.updateWindDirection(0);

    const group = new THREE.Group();
    group.name = 'weather';
    this.group = group;
    ctx.scene.add(group);

    this.buildPrecipitation(group);
    this.buildHazeDome(group);
    this.buildCells(ctx, group);

    this.subscriptions.push(
      ctx.events.on('photo:toggle', ({ active }) => {
        this.frozen = active;
      }),
    );
  }

  update(dt: number, ctx: GameContext): void {
    const t0 = performance.now();

    if (!this.frozen) {
      this.age += dt;
      this.updateWindDirection(dt);
      this.driftCells(dt);
      this.sampleAtPlayer(ctx);
      this.driveUniforms(dt, ctx);
      this.stepPrecipitation(dt, ctx);
      this.maybeEmit(ctx);
    }

    this.updateVisuals(ctx);
    this.applyFog(ctx);

    perf.mark('weather', performance.now() - t0);
  }

  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
    this.group?.removeFromParent();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.cells.length = 0;
    this.group = null;
    this.rain = null;
    this.snow = null;
    this.hazeDome = null;
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private buildPrecipitation(group: THREE.Group): void {
    const rainBox = new THREE.Vector3(...WEATHER.rainBox);
    const snowBox = new THREE.Vector3(...WEATHER.snowBox);

    // `position` carries the 0..1 seed, not a coordinate: the shader turns it into a world point
    // inside the camera-following box. That saves an attribute and keeps three's draw-count logic
    // (which reads `position.count`) happy.
    const rainSeeds = new Float32Array(WEATHER.rainCount * 2 * 3);
    const rainTails = new Float32Array(WEATHER.rainCount * 2);
    for (let i = 0; i < WEATHER.rainCount; i++) {
      const x = this.rng();
      const y = this.rng();
      const z = this.rng();
      for (let v = 0; v < 2; v++) {
        const o = (i * 2 + v) * 3;
        rainSeeds[o] = x;
        rainSeeds[o + 1] = y;
        rainSeeds[o + 2] = z;
        rainTails[i * 2 + v] = v;
      }
    }

    const rainGeom = new THREE.BufferGeometry();
    rainGeom.setAttribute('position', new THREE.BufferAttribute(rainSeeds, 3));
    rainGeom.setAttribute('aTail', new THREE.BufferAttribute(rainTails, 1));

    const rainMaterial = new THREE.ShaderMaterial({
      vertexShader: RAIN_VERTEX,
      fragmentShader: RAIN_FRAGMENT,
      uniforms: {
        uBox: { value: rainBox },
        uCenter: { value: new THREE.Vector3() },
        uPhase: { value: this.rainPhase },
        uVel: { value: this.rainVelocity },
        uStreak: { value: WEATHER.rainStreakLength },
        uFadeStart: { value: WEATHER.rainFadeStart },
        uFadeEnd: { value: Math.min(rainBox.x, rainBox.z) * 0.5 },
        uColor: { value: new THREE.Color(WEATHER.rainColor) },
        uOpacity: { value: 0 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const rain = new THREE.LineSegments(rainGeom, rainMaterial);
    rain.frustumCulled = false;
    rain.renderOrder = 3;
    rain.visible = false;
    group.add(rain);
    this.rain = rain;
    this.rainMaterial = rainMaterial;

    const snowSeeds = new Float32Array(WEATHER.snowCount * 3);
    for (let i = 0; i < snowSeeds.length; i++) snowSeeds[i] = this.rng();
    const snowGeom = new THREE.BufferGeometry();
    snowGeom.setAttribute('position', new THREE.BufferAttribute(snowSeeds, 3));

    const snowMaterial = new THREE.ShaderMaterial({
      vertexShader: SNOW_VERTEX,
      fragmentShader: SNOW_FRAGMENT,
      uniforms: {
        uBox: { value: snowBox },
        uCenter: { value: new THREE.Vector3() },
        uPhase: { value: this.snowPhase },
        uVel: { value: this.snowVelocity },
        uFadeStart: { value: WEATHER.snowFadeStart },
        uFadeEnd: { value: Math.min(snowBox.x, snowBox.z) * 0.5 },
        uColor: { value: new THREE.Color(WEATHER.snowColor) },
        uOpacity: { value: 0 },
        uAge: { value: 0 },
        uSway: { value: WEATHER.snowSwayAmplitude },
        uSwaySpeed: { value: WEATHER.snowSwaySpeed },
        uSize: { value: WEATHER.snowPointSize },
      },
      transparent: true,
      depthWrite: false,
    });

    const snow = new THREE.Points(snowGeom, snowMaterial);
    snow.frustumCulled = false;
    snow.renderOrder = 3;
    snow.visible = false;
    group.add(snow);
    this.snow = snow;
    this.snowMaterial = snowMaterial;

    this.disposables.push(rainGeom, rainMaterial, snowGeom, snowMaterial);
  }

  /**
   * WS4's sky dome is drawn with `fog: false`, so scene fog alone can never produce a whiteout —
   * the storm would close in on the terrain while a clear blue sky sat above it. This dome is the
   * missing half: camera-locked, depth-tested so terrain still occludes it, and only visible once
   * a cell is actually overhead.
   */
  private buildHazeDome(group: THREE.Group): void {
    const geometry = new THREE.SphereGeometry(CAMERA.far * 0.88, 16, 10);
    const material = new THREE.MeshBasicMaterial({
      color: WEATHER.rainFogColor,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    const dome = new THREE.Mesh(geometry, material);
    dome.frustumCulled = false;
    dome.renderOrder = 1;
    dome.visible = false;
    group.add(dome);

    this.hazeDome = dome;
    this.hazeMaterial = material;
    this.disposables.push(geometry, material);
  }

  private buildCells(ctx: GameContext, group: THREE.Group): void {
    const geometry = new THREE.CylinderGeometry(
      WEATHER.curtainTopFlare,
      1,
      1,
      WEATHER.curtainSegments,
      1,
      true,
    );
    geometry.translate(0, 0.5, 0);
    this.disposables.push(geometry);

    const half = WORLD.size / 2;
    for (let i = 0; i < WEATHER.cellCount; i++) {
      const material = new THREE.ShaderMaterial({
        vertexShader: CURTAIN_VERTEX,
        fragmentShader: CURTAIN_FRAGMENT,
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          {
            uColor: { value: new THREE.Color(WEATHER.curtainColor) },
            uOpacity: { value: 0 },
            uCellCenter: { value: new THREE.Vector3() },
          },
        ]),
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: true,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      mesh.visible = false;
      group.add(mesh);
      this.disposables.push(material);

      const cell: RainCell = {
        center: new THREE.Vector2(),
        radius: randomRange(this.rng, WEATHER.cellRadiusMin, WEATHER.cellRadiusMax),
        strength: randomRange(this.rng, WEATHER.cellStrengthMin, WEATHER.cellStrengthMax),
        mesh,
        material,
      };

      if (i === 0) {
        // One cell starts just upwind of the player: the first timefall should be a few minutes
        // away, not a coin flip on where the RNG dropped three discs in four square kilometres.
        cell.center.set(
          ctx.player.position.x - this.windDir.x * WEATHER.firstCellDistance,
          ctx.player.position.z - this.windDir.y * WEATHER.firstCellDistance,
        );
      } else {
        cell.center.set(randomRange(this.rng, -half, half), randomRange(this.rng, -half, half));
      }

      this.cells.push(cell);
    }
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  /** The prevailing wind wanders on two incommensurate sines — smooth, bounded, and seed-stable. */
  private updateWindDirection(dt: number): void {
    this.windAngle +=
      dt *
      WEATHER.windTurnRate *
      (Math.sin(this.age * 0.021) + 0.6 * Math.sin(this.age * 0.0071 + 1.7));
    this.windDir.set(Math.cos(this.windAngle), Math.sin(this.windAngle));
  }

  private driftCells(dt: number): void {
    const half = WORLD.size / 2;
    for (const cell of this.cells) {
      cell.center.x += this.windDir.x * WEATHER.cellDriftSpeed * dt;
      cell.center.y += this.windDir.y * WEATHER.cellDriftSpeed * dt;

      // Recycled once it has cleared the far edge, re-entering upwind with a fresh size so the
      // same storm never crosses twice.
      const along = cell.center.x * this.windDir.x + cell.center.y * this.windDir.y;
      const limit = half + cell.radius + WEATHER.cellRecycleMargin;
      if (along <= limit) continue;

      cell.radius = randomRange(this.rng, WEATHER.cellRadiusMin, WEATHER.cellRadiusMax);
      cell.strength = randomRange(this.rng, WEATHER.cellStrengthMin, WEATHER.cellStrengthMax);
      const lateral = randomRange(this.rng, -half, half);
      const entry = -(half + cell.radius);
      cell.center.set(
        this.windDir.x * entry - this.windDir.y * lateral,
        this.windDir.y * entry + this.windDir.x * lateral,
      );
    }
  }

  /** Strongest cell wins, rather than summing — overlapping cells must not exceed full intensity. */
  private intensityAt(x: number, z: number): number {
    let best = 0;
    for (const cell of this.cells) {
      const d = Math.hypot(cell.center.x - x, cell.center.y - z);
      const inner = cell.radius * (1 - WEATHER.cellEdgeSoftness);
      const v = cell.strength * (1 - smoothstep(inner, cell.radius, d));
      if (v > best) best = v;
    }
    return best;
  }

  private sampleAtPlayer(ctx: GameContext): void {
    const p = ctx.player.position;
    const local = this.intensityAt(p.x, p.z);
    this.snowShare = smoothstep(
      WORLD.snowLine - WEATHER.snowBandBelow,
      WORLD.snowLine + WEATHER.snowBandAbove,
      p.y,
    );
    this.rainAmount = local * (1 - this.snowShare);
    this.snowAmount = local * this.snowShare;
  }

  private driveUniforms(dt: number, ctx: GameContext): void {
    const storm = clamp01(this.rainAmount + this.snowAmount);
    const speed = lerp(WEATHER.windBreeze, WEATHER.windGale, storm);
    this.windVector.set(this.windDir.x * speed, this.windDir.y * speed);
    // Mutate `.value`, never replace the uniform — every material holds the original reference.
    ctx.uniforms.uWind.value.copy(this.windVector);

    const target = clamp01(this.rainAmount + this.snowAmount * WEATHER.wetFromSnow) * WEATHER.wetMax;
    const lambda = target > this.wetness ? WEATHER.wetRiseLambda : WEATHER.wetDryLambda;
    this.wetness = damp(this.wetness, target, lambda, dt);
    ctx.uniforms.uWetness.value = this.wetness;
  }

  private stepPrecipitation(dt: number, ctx: GameContext): void {
    const box = WEATHER.rainBox;
    this.rainVelocity.set(
      this.windVector.x * 0.7,
      -WEATHER.rainFallSpeed,
      this.windVector.y * 0.7,
    );
    this.rainPhase.addScaledVector(this.rainVelocity, dt);
    wrapPhase(this.rainPhase, box[0], box[1], box[2]);

    const snowBox = WEATHER.snowBox;
    this.snowVelocity.set(
      this.windVector.x * 0.45,
      -WEATHER.snowFallSpeed,
      this.windVector.y * 0.45,
    );
    this.snowPhase.addScaledVector(this.snowVelocity, dt);
    wrapPhase(this.snowPhase, snowBox[0], snowBox[1], snowBox[2]);

    if (this.rainMaterial) {
      this.rainMaterial.uniforms.uCenter!.value.copy(ctx.camera.position);
    }
    if (this.snowMaterial) {
      this.snowMaterial.uniforms.uCenter!.value.copy(ctx.camera.position);
      this.snowMaterial.uniforms.uAge!.value = this.age;
    }
  }

  // -------------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------------

  private updateVisuals(ctx: GameContext): void {
    if (this.rain && this.rainMaterial) {
      this.rain.visible = this.rainAmount > 0.02;
      this.rainMaterial.uniforms.uOpacity!.value = WEATHER.rainOpacity * this.rainAmount;
    }
    if (this.snow && this.snowMaterial) {
      this.snow.visible = this.snowAmount > 0.02;
      this.snowMaterial.uniforms.uOpacity!.value = WEATHER.snowOpacity * this.snowAmount;
    }

    const camera = ctx.camera.position;
    const [fullyOutside, fullyInside] = WEATHER.curtainInsideFade;
    for (const cell of this.cells) {
      const distance = Math.hypot(cell.center.x - camera.x, cell.center.y - camera.z);
      // Standing inside the cell, the curtain is behind you in every direction — the streaks and
      // the fog are what sell it from in here, so the shell gets out of the way.
      const exposure = smoothstep(cell.radius * fullyInside, cell.radius * fullyOutside, distance);
      const opacity = WEATHER.curtainOpacity * cell.strength * exposure;

      cell.mesh.visible = opacity > 0.004;
      if (!cell.mesh.visible) continue;

      cell.mesh.position.set(cell.center.x, ctx.world.data.seaLevel - 30, cell.center.y);
      cell.mesh.scale.set(cell.radius, WEATHER.curtainHeight, cell.radius);
      cell.material.uniforms.uOpacity!.value = opacity;
      cell.material.uniforms.uCellCenter!.value.set(cell.center.x, 0, cell.center.y);
    }

    if (this.hazeDome && this.hazeMaterial) {
      const storm = clamp01(this.rainAmount * 0.7 + this.snowAmount * 1.05);
      this.hazeDome.visible = storm > 0.01;
      this.hazeDome.position.copy(ctx.camera.position);
      this.hazeMaterial.opacity = storm * 0.95;
      this.hazeMaterial.color.copy(this.stormTint());
    }
  }

  private stormTint(): THREE.Color {
    return this.stormColor.copy(this.rainFogColor).lerp(this.blizzardFogColor, this.snowShare);
  }

  /**
   * Pull the fog in. This runs after `SkySystem.applyFog`, which rewrites near/far/colour from the
   * sky gradient every frame — so these edits never accumulate and never have to be undone.
   */
  private applyFog(ctx: GameContext): void {
    const fog = ctx.scene.fog;
    if (!(fog instanceof THREE.Fog)) return;

    const storm = clamp01(this.rainAmount + this.snowAmount);
    if (storm <= 0.005) return;

    const stormFar = lerp(WEATHER.rainFogFar, WEATHER.blizzardFogFar, this.snowShare);
    fog.far = Math.min(fog.far, lerp(fog.far, stormFar, storm));
    fog.near = Math.min(fog.near, fog.far * WEATHER.fogNearFactor);
    fog.color.lerp(this.stormTint(), storm * WEATHER.fogColorMix);
    if (ctx.scene.background instanceof THREE.Color) ctx.scene.background.copy(fog.color);
  }

  /** Throttled so the HUD is not asked to re-render text sixty times a second. */
  private maybeEmit(ctx: GameContext): void {
    const last = this.lastEmit;
    const speed = this.windVector.length();
    const first = last.rain < 0;
    const moved =
      Math.abs(this.rainAmount - last.rain) > WEATHER.emitDelta ||
      Math.abs(this.snowAmount - last.snow) > WEATHER.emitDelta ||
      Math.abs(speed - last.wind) > WEATHER.emitDelta * 10;
    const throttled = this.age - last.time < WEATHER.emitIntervalSeconds;
    if (!first && (!moved || throttled)) return;

    last.rain = this.rainAmount;
    last.snow = this.snowAmount;
    last.wind = speed;
    last.time = this.age;
    ctx.events.emit('weather:changed', {
      rain: this.rainAmount,
      snow: this.snowAmount,
      wind: this.windVector.clone(),
    });
  }
}

/** Keep an accumulated drift inside one box period so long sessions never lose float precision. */
function wrapPhase(phase: THREE.Vector3, sx: number, sy: number, sz: number): void {
  phase.x = ((phase.x % sx) + sx) % sx;
  phase.y = ((phase.y % sy) + sy) % sy;
  phase.z = ((phase.z % sz) + sz) % sz;
}
