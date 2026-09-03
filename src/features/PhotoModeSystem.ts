/**
 * src/features/PhotoModeSystem.ts
 *
 * Contents: the `PhotoModeSystem` — WS6 feature ④. `P` freezes time, detaches the camera into a
 * damped free-fly rig, applies a filmic grade (vignette, cool shadow toe, letterbox) and downloads
 * a full-resolution PNG on `Enter`.
 *
 * Purpose: it is the thing players share, and it costs an hour.
 *
 * How the grade is done without a post-processing pass: a single full-screen quad drawn in clip
 * space with `MultiplyBlending`, so it darkens and tints whatever the scene already rendered. It
 * is part of the frame, not a CSS filter over the canvas — which is the only reason the exported
 * PNG looks like what is on screen. The HUD is DOM and never appears in the capture at all.
 *
 * How time freezes: `PlayerSystem` and `ThirdPersonCamera` both yield on `photo:toggle` (WS3
 * built that in), WS6's own weather / cairn / scanner systems freeze themselves, and this system
 * pins `ctx.time` and `ctx.uniforms.uTime` every frame. Because `uTime` is pinned *before* the
 * render, water, grass and the sky glitter all hold still exactly as photographed. `SkySystem`
 * updates before this system does, so the sun is one frame (≈ 0.02 s of a 600 s day) ahead of the
 * pinned value — a constant offset, not a drift.
 *
 * Integration:
 *   - reads   `ctx.input.state.move` / `.look` / `.sprint` for the free camera, plus its own
 *             `keydown` listener for `Q`/`E` (down/up), `Enter` (save) and `Escape` (exit) —
 *             those three are not in WS3's `ActionId` set and photo mode should not add to it
 *   - writes  `ctx.camera` directly, `ctx.time.*` and `ctx.uniforms.uTime.value` (all pinned)
 *   - emits   `photo:toggle` — WS7 hides the HUD and blocks the pause key, WS3 stops simulating,
 *             WS6's other three systems stop animating
 */

import * as THREE from 'three';
import { PHOTO, WORLD } from '../config/world.config';
import type { GameContext, System } from '../core/types';
import { clamp, damp } from '../utils/math';

const GRADE_VERTEX = /* glsl */ `
varying vec2 vNdc;

void main() {
  // A clip-space quad: no camera, no model matrix, no way for the rig to move it off screen.
  vNdc = position.xy;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

const GRADE_FRAGMENT = /* glsl */ `
uniform float uLetterbox;
uniform float uVignette;
uniform float uVignetteRadius;
uniform vec3 uShadowTint;
uniform float uTintStrength;

varying vec2 vNdc;

void main() {
  // Multiply blending: black bars are simply a zero multiplier.
  if ( abs( vNdc.y ) > 1.0 - 2.0 * uLetterbox ) {
    gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
    return;
  }

  float r = length( vNdc );
  float falloff = smoothstep( uVignetteRadius, 1.45, r );
  vec3 grade = vec3( 1.0 - uVignette * falloff );
  // Cool the corners rather than just darkening them — that colour separation is most of what
  // reads as "filmic" at this budget.
  grade *= mix( vec3( 1.0 ), uShadowTint, uTintStrength * smoothstep( uVignetteRadius * 0.6, 1.45, r ) );

  gl_FragColor = vec4( grade, 1.0 );
}
`;

const HINT_STYLE = [
  'position:fixed',
  'left:50%',
  'transform:translateX(-50%)',
  'z-index:40',
  'padding:0.35em 0.9em',
  'border-radius:999px',
  'font:500 12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace',
  'letter-spacing:0.06em',
  'color:rgba(240,244,248,0.72)',
  'background:rgba(8,12,18,0.45)',
  'backdrop-filter:blur(6px)',
  'pointer-events:none',
  'user-select:none',
  'transition:opacity 220ms ease',
].join(';');

const HINT_TEXT = 'PHOTO · move ↑↓←→ · Q/E height · Shift fast · drag look · Enter saves · P exits';

export class PhotoModeSystem implements System {
  readonly name = 'photoMode';

  private active = false;
  private yaw = 0;
  private pitch = 0;
  private exportQueued = false;
  private exitQueued = false;

  private readonly velocity = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly held = new Set<string>();

  private grade: THREE.Mesh | null = null;
  private gradeGeometry: THREE.BufferGeometry | null = null;
  private gradeMaterial: THREE.ShaderMaterial | null = null;
  private hint: HTMLDivElement | null = null;
  private hintTimer = 0;

  private frozenTimeOfDay = 0;
  private frozenElapsed = 0;
  private frozenUniformTime = 0;
  private savedExposure = 1;
  private savedFov = 0;

  init(ctx: GameContext): void {
    this.buildGrade(ctx);
    this.buildHint();
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  update(dt: number, ctx: GameContext): void {
    if (ctx.input.state.actions.has('photo') || (this.exitQueued && this.active)) this.toggle(ctx);
    this.exitQueued = false;
    if (!this.active) return;

    // Pinned every frame, before the render, so nothing time-driven moves between shots.
    ctx.time.timeOfDay = this.frozenTimeOfDay;
    ctx.time.elapsed = this.frozenElapsed;
    ctx.uniforms.uTime.value = this.frozenUniformTime;

    this.steer(dt, ctx);
    this.fly(dt, ctx);

    if (this.hintTimer > 0) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0) this.setHint(HINT_TEXT);
    }

    if (this.exportQueued) {
      this.exportQueued = false;
      this.capture(ctx);
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.grade?.removeFromParent();
    this.gradeGeometry?.dispose();
    this.gradeMaterial?.dispose();
    this.hint?.remove();
    this.grade = null;
    this.hint = null;
  }

  // -------------------------------------------------------------------------
  // Mode switching
  // -------------------------------------------------------------------------

  private toggle(ctx: GameContext): void {
    this.active = !this.active;

    if (this.active) {
      this.frozenTimeOfDay = ctx.time.timeOfDay;
      this.frozenElapsed = ctx.time.elapsed;
      this.frozenUniformTime = ctx.uniforms.uTime.value;
      this.savedExposure = ctx.renderer.toneMappingExposure;
      this.savedFov = ctx.camera.fov;

      this.euler.setFromQuaternion(ctx.camera.quaternion);
      this.yaw = this.euler.y;
      this.pitch = this.euler.x;
      this.velocity.set(0, 0, 0);

      ctx.renderer.toneMappingExposure = this.savedExposure * PHOTO.exposure;
      if (this.grade) this.grade.visible = true;
      this.showHint(HINT_TEXT);
    } else {
      ctx.renderer.toneMappingExposure = this.savedExposure;
      // WS3's rig owns the FOV (it punches it on sprint) and restores itself, but leaving photo
      // mode's frozen value behind for a frame is a visible pop.
      ctx.camera.fov = this.savedFov;
      ctx.camera.updateProjectionMatrix();
      if (this.grade) this.grade.visible = false;
      this.hideHint();
      this.held.clear();
    }

    ctx.events.emit('photo:toggle', { active: this.active });
  }

  // -------------------------------------------------------------------------
  // Free camera
  // -------------------------------------------------------------------------

  private steer(dt: number, ctx: GameContext): void {
    const look = ctx.input.state.look;
    const targetYaw = this.yaw - look.x * PHOTO.lookSensitivity;
    const targetPitch = clamp(
      this.pitch - look.y * PHOTO.lookSensitivity,
      -PHOTO.maxPitch,
      PHOTO.maxPitch,
    );

    // Damped rather than direct, so a shaky drag still produces a smooth pan for the photograph.
    this.yaw = damp(this.yaw, targetYaw, PHOTO.lookDamp, dt);
    this.pitch = damp(this.pitch, targetPitch, PHOTO.lookDamp, dt);

    this.euler.set(this.pitch, this.yaw, 0);
    ctx.camera.quaternion.setFromEuler(this.euler);
  }

  private fly(dt: number, ctx: GameContext): void {
    const move = ctx.input.state.move;
    const lift = (this.held.has('KeyE') ? 1 : 0) - (this.held.has('KeyQ') ? 1 : 0);

    this.forward.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(ctx.camera.quaternion);

    const speed = PHOTO.moveSpeed * (ctx.input.state.sprint ? PHOTO.boostMultiplier : 1);
    this.desired
      .set(0, 0, 0)
      .addScaledVector(this.forward, move.y)
      .addScaledVector(this.right, move.x);
    this.desired.y += lift;
    if (this.desired.lengthSq() > 1) this.desired.normalize();
    this.desired.multiplyScalar(speed);

    this.velocity.x = damp(this.velocity.x, this.desired.x, PHOTO.moveDamp, dt);
    this.velocity.y = damp(this.velocity.y, this.desired.y, PHOTO.moveDamp, dt);
    this.velocity.z = damp(this.velocity.z, this.desired.z, PHOTO.moveDamp, dt);

    const p = ctx.camera.position.addScaledVector(this.velocity, dt);
    const limit = WORLD.size / 2 + PHOTO.boundsMargin;
    p.x = clamp(p.x, -limit, limit);
    p.z = clamp(p.z, -limit, limit);
    p.y = clamp(p.y, ctx.world.data.seaLevel + PHOTO.minAltitude, PHOTO.maxAltitude);
  }

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  /**
   * Render and read back in the same task. The drawing buffer is not preserved (WS0 leaves
   * `preserveDrawingBuffer` off, which is right — it costs bandwidth every frame), so waiting even
   * one animation frame between the render and the read hands back a blank image.
   */
  private capture(ctx: GameContext): void {
    const canvas = ctx.renderer.domElement;
    ctx.renderer.render(ctx.scene, ctx.camera);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `${PHOTO.fileNamePrefix}-${ctx.world.data.seed}-${stamp}.png`;

    try {
      canvas.toBlob((blob) => {
        if (!blob) {
          this.showHint('could not save the frame', 2.5);
          return;
        }
        const url = URL.createObjectURL(blob);
        download(url, name);
        window.setTimeout(() => URL.revokeObjectURL(url), 8000);
      }, 'image/png');
      this.showHint(`saved · ${canvas.width}×${canvas.height}`, 2.5);
    } catch (err) {
      console.warn('[photo] export failed:', err);
      this.showHint('could not save the frame', 2.5);
    }
  }

  // -------------------------------------------------------------------------
  // Resources
  // -------------------------------------------------------------------------

  private buildGrade(ctx: GameContext): void {
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.ShaderMaterial({
      vertexShader: GRADE_VERTEX,
      fragmentShader: GRADE_FRAGMENT,
      uniforms: {
        uLetterbox: { value: PHOTO.letterbox },
        uVignette: { value: PHOTO.vignetteStrength },
        uVignetteRadius: { value: PHOTO.vignetteRadius },
        uShadowTint: { value: new THREE.Color(PHOTO.shadowTint) },
        uTintStrength: { value: PHOTO.shadowTintStrength },
      },
      transparent: true,
      blending: THREE.MultiplyBlending,
      // three r185 only implements MultiplyBlending on the premultiplied path and logs an error
      // every frame otherwise. The shader writes alpha 1, so premultiplied and straight agree.
      premultipliedAlpha: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 10_000;
    mesh.visible = false;
    ctx.scene.add(mesh);

    this.grade = mesh;
    this.gradeGeometry = geometry;
    this.gradeMaterial = material;
  }

  private buildHint(): void {
    const el = document.createElement('div');
    el.style.cssText = HINT_STYLE;
    el.style.display = 'none';
    el.textContent = HINT_TEXT;
    document.body.appendChild(el);
    this.hint = el;
  }

  private showHint(text: string, revertAfter = 0): void {
    const el = this.hint;
    if (!el) return;
    el.style.display = 'block';
    // Sit just inside the lower letterbox bar rather than on top of the picture.
    el.style.bottom = `${(PHOTO.letterbox * 100) / 2}%`;
    el.style.transform = 'translate(-50%, 50%)';
    el.textContent = text;
    this.hintTimer = revertAfter;
  }

  private setHint(text: string): void {
    if (this.hint) this.hint.textContent = text;
  }

  private hideHint(): void {
    if (this.hint) this.hint.style.display = 'none';
    this.hintTimer = 0;
  }

  // -------------------------------------------------------------------------
  // Keys WS3 does not publish as actions
  // -------------------------------------------------------------------------

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.active) return;
    this.held.add(e.code);
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      this.exportQueued = true;
    }
    // Escape is a second way out. In Chrome a pointer-locked player spends the first press
    // releasing the lock, so it may take two — `P` always works in one.
    if (e.code === 'Escape') this.exitQueued = true;
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.held.clear();
  };
}

function download(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
