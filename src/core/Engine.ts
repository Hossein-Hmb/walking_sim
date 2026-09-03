/**
 * src/core/Engine.ts
 *
 * Contents: the `Engine` class — owns the WebGL renderer, scene, camera and clock, keeps the drawing
 * buffer in step with the canvas' laid-out size, and drives the frame loop over a `SystemRegistry`.
 *
 * Canvas sizing is split down one line: CSS owns the element's box (`#game { position: fixed;
 * inset: 0 }` in index.html), and this file only ever *measures* it. The engine never writes
 * width/height into the inline style, because an inline size beats the stylesheet and then has to be
 * kept correct by hand — which is how a canvas ends up larger than the window it lives in.
 *
 * Purpose: one place where the update order is defined, so no system has to know about any other.
 *
 * Frame structure:
 *   input.beginFrame()
 *   → fixed-step accumulator @ 60 Hz, capped at RENDER.maxFixedStepsPerFrame → systems.fixedUpdate
 *   → systems.update(dt)  (variable, render-locked)
 *   → renderer.render()
 *   → input.endFrame()
 *
 * The cap on catch-up steps is what prevents the "spiral of death" when a frame runs long (tab
 * switch, shader compile, terrain generation). Leftover time is discarded rather than simulated.
 *
 * WS8 additions (additive; `add`, `init`, `start`, `stop` and `dispose` are unchanged):
 *   - `setPaused()` — a pause that keeps rendering. Simulation, the clock and the day/night cycle
 *     all freeze, but the RAF loop keeps drawing, so the frame behind the pause overlay survives a
 *     window resize and the canvas never goes stale. Stopping the loop outright (the WS7 handoff
 *     suggestion) leaves a dead canvas that stretches on resize.
 *   - `setPixelRatioCap()` — the quality presets' pixel-ratio lever. It has to live here because
 *     `syncSize` re-applies the ratio and would otherwise clobber whatever the preset set.
 *   - WebGL context-loss handling — the browser reclaims a context on GPU pressure or a driver
 *     reset; without `preventDefault()` on the lost event it is never restored and the canvas is
 *     black for the rest of the session.
 */

import * as THREE from 'three';
import { RENDER, CAMERA, PERF, TIME } from '../config/world.config';
import { perf } from '../utils/Perf';
import { wrap } from '../utils/math';
import { SystemRegistry } from './System';
import type { GameContext, System } from './types';

/** Any frame longer than this is treated as a stall: simulate 0.25 s, drop the rest. */
const MAX_FRAME_DT = 0.25;

/** Scratch for reading the renderer's current size without allocating every resize. */
const TMP_SIZE = new THREE.Vector2();

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly systems = new SystemRegistry();

  private ctx: GameContext | null = null;
  private rafId = 0;
  private running = false;
  private paused = false;
  private contextLost = false;
  private lastTime = 0;
  private accumulator = 0;
  private pixelRatioCap: number = PERF.maxPixelRatio;
  private resizeObserver: ResizeObserver | null = null;
  /** Latches once `syncSize` has had to override a canvas box CSS failed to keep inside the window. */
  private clampedToWindow = false;
  /** Last clamp written to the inline style, so we only touch the DOM when the window changes. */
  private clampWidth = 0;
  private clampHeight = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: RENDER.antialias,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, PERF.maxPixelRatio));
    this.renderer.shadowMap.enabled = true;
    // PLAN.md asks for PCFSoftShadowMap, but three r185 deprecates it (it silently falls back to
    // PCFShadowMap and logs a warning), so we select the fallback explicitly. WS4 owns shadow tuning.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Sane defaults; WS4 owns the final look and may override tone mapping / exposure.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(RENDER.clearColor);
    // WS4 replaces the colour each frame from the sky horizon; the object identity stays.
    this.scene.fog = new THREE.Fog(RENDER.fogColor, RENDER.fogNear, RENDER.fogFar);

    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, CAMERA.near, CAMERA.far);
    this.camera.position.set(0, CAMERA.height + 4, CAMERA.distance);
    this.camera.lookAt(0, 1, 0);

    this.syncSize();
    // One line, at boot, naming every number that decides how big the canvas is. Sizing bugs are
    // reported as "it overflows" and are otherwise unfalsifiable from a description — this makes the
    // browser state answer the question directly, and doubles as proof of which build is loaded.
    console.info(
      `[Engine] canvas ${canvas.clientWidth}×${canvas.clientHeight} CSS px | ` +
        `window ${window.innerWidth}×${window.innerHeight} | dpr ${window.devicePixelRatio} | ` +
        `buffer ${canvas.width}×${canvas.height} | fits: ${
          canvas.clientWidth <= window.innerWidth && canvas.clientHeight <= window.innerHeight
        } | outer ${window.outerWidth}×${window.outerHeight} | ` +
        `display ${window.screen.availWidth}×${window.screen.availHeight}`,
    );
    this.warnIfWindowExceedsDisplay();
    // Observe the canvas itself rather than the window. It is `position: fixed; inset: 0`, so it
    // resizes for *every* cause — window resize, zoom, fullscreen, OS chrome, the mobile URL bar
    // collapsing — and one observer replaces the pile of event listeners that each cover one case.
    // `frame` re-checks the size anyway, so a browser that never delivers these callbacks still
    // corrects itself on the next tick; this observer only makes it happen a frame sooner.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.syncSize);
      this.resizeObserver.observe(canvas);
    }
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  /** Must be called before `init`. The context is built in main.ts from these renderer objects. */
  setContext(ctx: GameContext): void {
    this.ctx = ctx;
  }

  add(system: System): this {
    this.systems.add(system);
    return this;
  }

  async init(): Promise<void> {
    if (!this.ctx) throw new Error('[Engine] setContext() must be called before init()');
    await this.systems.initAll(this.ctx);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Freeze simulation while continuing to present frames.
   *
   * Resuming resets the clock, so no time accumulates while paused and unpausing cannot produce a
   * dt spike — the same guarantee `start()` gives, without tearing down the RAF loop.
   */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (!paused) {
      this.lastTime = performance.now();
      this.accumulator = 0;
    }
  }

  /** Quality presets clamp the device pixel ratio through here; `syncSize` honours it afterwards. */
  setPixelRatioCap(cap: number): void {
    this.pixelRatioCap = Math.min(Math.max(cap, 0.5), PERF.maxPixelRatio);
    this.syncSize();
  }

  dispose(): void {
    this.stop();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.systems.disposeAll();
    this.renderer.dispose();
  }

  /**
   * Match the drawing buffer to the size the canvas is *actually laid out at*, and never fight CSS
   * for the layout box.
   *
   * The element's size is owned entirely by `#game { position: fixed; inset: 0 }` in index.html, so
   * it is the window's size by construction. We only measure it (`clientWidth/Height`, CSS pixels)
   * and resize the buffer to suit:
   *   - `setSize(w, h, false)` — `updateStyle: false` is essential. Left at the default, three.js
   *     writes `width/height` px into the inline style; that inline size then wins over the
   *     stylesheet and goes stale the moment the window changes without us hearing about it.
   *   - The canvas' *intrinsic* size (its width/height attributes) is `w × pixelRatio`, i.e. larger
   *     than the window on any retina display. `max-width/height: 100%` in the stylesheet is what
   *     stops that intrinsic size from overflowing the page.
   *
   * Measuring the element rather than `window.innerWidth/Height` also makes zoom, browser chrome and
   * the mobile URL bar free: whatever CSS resolved to is what we render at.
   */
  private readonly syncSize = (): void => {
    const vw = Math.max(1, Math.floor(window.innerWidth));
    const vh = Math.max(1, Math.floor(window.innerHeight));
    // Fall back to the window only if the element has no layout box yet (e.g. `display: none`),
    // where clientWidth reads 0 and would otherwise collapse the buffer to 1×1.
    let w = Math.max(1, Math.floor(this.canvas.clientWidth || vw));
    let h = Math.max(1, Math.floor(this.canvas.clientHeight || vh));

    // Safety net. Reaching here means CSS did not keep the canvas inside the window, which the
    // stylesheet alone should make impossible — so something outside this file is in play: a cached
    // copy of an older index.html, an extension or user stylesheet, or an ancestor that grew a
    // `transform`/`filter`/`contain` and thereby became the containing block for our `fixed`
    // element instead of the viewport. Whatever the cause, a canvas the player can only see part of
    // is the one outcome we never accept: clamp it to the window and report why, once.
    // Latching is deliberate. Once clamped, the measurement says the canvas fits — but only
    // *because* the clamp is holding it there, which is indistinguishable from the cause having
    // gone away. Releasing on that reading makes the two states alternate: release, the canvas
    // re-inflates, clamp, release… flickering the viewport every other frame. So the clamp stays,
    // and is simply recomputed from the live window size each tick, which keeps it correct across
    // window resizes. Staying clamped costs nothing: window-sized is what we wanted anyway.
    if (w > vw || h > vh || this.clampedToWindow) {
      this.reportOversizedCanvas(w, h, vw, vh); // no-ops after the first call
      if (this.clampWidth !== vw || this.clampHeight !== vh) {
        this.clampWidth = vw;
        this.clampHeight = vh;
        // `important` is the point, not belt-and-braces: whatever is oversizing the canvas may
        // itself be an `!important` rule, and a plain inline style loses to those. Inline +
        // important is the top of the author cascade, so it wins against any stylesheet.
        this.canvas.style.setProperty('width', `${vw}px`, 'important');
        this.canvas.style.setProperty('height', `${vh}px`, 'important');
        this.canvas.style.setProperty('max-width', '100%', 'important');
        this.canvas.style.setProperty('max-height', '100%', 'important');
      }
      w = vw;
      h = vh;
    }

    const ratio = Math.min(window.devicePixelRatio || 1, this.pixelRatioCap);
    const current = this.renderer.getSize(TMP_SIZE);
    if (current.x === w && current.y === h && this.renderer.getPixelRatio() === ratio) return;

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
  };

  /**
   * Logged once per session, not per frame — the condition persists for as long as its cause does,
   * so an unguarded warning here would be 60 lines a second. Names the likely culprit outright,
   * because the numbers alone do not say which of the possible causes it is.
   */
  private reportOversizedCanvas(w: number, h: number, vw: number, vh: number): void {
    if (this.clampedToWindow) return;
    this.clampedToWindow = true;
    const cs = getComputedStyle(this.canvas);
    console.warn(
      `[Engine] #game laid out at ${w}×${h} CSS px inside a ${vw}×${vh} window — clamping it.\n` +
        `Its stylesheet rule should have prevented this. Computed: position=${cs.position}, ` +
        `width=${cs.width}, height=${cs.height}, maxWidth=${cs.maxWidth}, inset=${cs.inset}.\n` +
        `Likeliest causes: a cached older index.html (hard-reload), a browser extension or user ` +
        `stylesheet, or an ancestor with transform/filter/contain capturing the fixed containing block.`,
    );
  }

  /**
   * The failure mode that looks identical to a broken canvas but is not one.
   *
   * If the *browser window* is bigger than the display it sits on — which macOS allows freely, since
   * moving a window from a large external monitor to the built-in screen keeps its size and simply
   * lets it hang off the edges — then the canvas correctly fills the window and part of that window
   * is still unreachable. Nothing in the page can fix it: `innerWidth` is honestly 1600 even when
   * only 1400 of it is on screen, and scripts cannot resize a window they did not open.
   *
   * So say it plainly, because the numbers otherwise read as "everything fits" while the player is
   * looking at a cropped game.
   */
  private warnIfWindowExceedsDisplay(): void {
    const { outerWidth: ow, outerHeight: oh, innerWidth: iw, innerHeight: ih } = window;
    const { availWidth: aw, availHeight: ah } = window.screen;
    // Generous slack: these legitimately differ by a few px (window shadows, chrome, rounding
    // between logical and device pixels). Only shout about overhang big enough to actually crop.
    const SLACK = 24;

    // Case 1 — the viewport is wider/taller than the window holding it. A real browser window cannot
    // do this: `outer` always exceeds `inner` by the height of the tab strip and toolbar. Seeing it
    // inverted means the viewport size is being dictated by something other than the window —
    // an embedded preview pane or webview, or DevTools device emulation, both of which pin the
    // viewport to a chosen size and then show it inside a smaller frame. The page renders the full
    // viewport it was told it has; the frame crops it. `outer` of 0 means "not a real window at
    // all", so it tells us nothing and is skipped.
    if (ow > 0 && oh > 0 && (iw - ow > SLACK || ih - oh > SLACK)) {
      console.warn(
        `[Engine] Viewport ${iw}×${ih} is larger than the window containing it (${ow}×${oh}). ` +
          `A normal browser window is always the other way round.\n` +
          `That means an embedded preview pane, webview, or DevTools device emulation is fixing the ` +
          `viewport size, and the surrounding frame is too small to show all of it — so the canvas ` +
          `renders correctly at ${iw}×${ih} and you only see part of it.\n` +
          `Open the game in a real browser tab to see the whole thing.`,
      );
      return;
    }

    // Case 2 — the window itself hangs off the display. macOS allows this freely: drag a window from
    // a large external monitor to the built-in screen and it keeps its size, edges off-screen.
    if (ow - aw > SLACK || oh - ah > SLACK) {
      console.warn(
        `[Engine] The browser window (${ow}×${oh}) is larger than this display's available area ` +
          `(${aw}×${ah}), so part of it is off-screen.\n` +
          `The canvas fills the window correctly — the window is what does not fit. Resize it, hit ` +
          `the green zoom button, or go fullscreen. A page cannot resize a window it did not open.`,
      );
    }
  }

  /**
   * Without `preventDefault()` the browser never fires `webglcontextrestored`, so a context lost
   * to GPU pressure or a driver reset would leave a permanently black canvas.
   */
  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
    console.warn('[Engine] WebGL context lost — pausing until it is restored');
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    this.lastTime = performance.now();
    this.accumulator = 0;
    console.info('[Engine] WebGL context restored');
  };

  private readonly frame = (nowMs: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.contextLost) return;

    perf.beginFrame();

    // Before anything else touches the DOM. The browser laid out during its own pre-paint pass, so
    // `clientWidth/Height` reads from a clean layout here and costs nothing; the same read taken
    // after the HUD rewrites its text would force a synchronous reflow every frame. Doing this per
    // frame — not only from the observer — is what guarantees the buffer can never sit at a stale
    // size, whatever the browser does or does not tell us about the viewport changing.
    this.syncSize();

    if (this.paused) {
      // Keep presenting so the frozen frame survives a resize, but let no time pass. Input is
      // begun and ended in the same breath: held keys still update, edge triggers are consumed
      // rather than queued, so unpausing cannot fire a jump the player pressed while paused.
      this.lastTime = nowMs;
      this.accumulator = 0;
      ctx.input.beginFrame?.();
      ctx.input.endFrame?.();
      this.renderer.render(this.scene, this.camera);
      perf.endFrame();
      return;
    }

    const dt = Math.min((nowMs - this.lastTime) / 1000, MAX_FRAME_DT);
    this.lastTime = nowMs;

    ctx.time.dt = dt;
    ctx.time.elapsed += dt;
    ctx.time.timeOfDay = wrap(ctx.time.timeOfDay + dt / TIME.dayLengthSeconds, 1);
    ctx.uniforms.uTime.value = ctx.time.elapsed;

    ctx.input.beginFrame?.();
    this.systems.resetTimings();

    const fixed = RENDER.fixedTimestep;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= fixed && steps < RENDER.maxFixedStepsPerFrame) {
      this.systems.fixedUpdate(fixed, ctx);
      this.accumulator -= fixed;
      steps++;
    }
    // Ran out of catch-up budget: throw away the backlog instead of falling further behind.
    if (this.accumulator >= fixed) this.accumulator = 0;

    this.systems.update(dt, ctx);
    this.renderer.render(this.scene, this.camera);

    ctx.input.endFrame?.();
    perf.endFrame();
  };
}
