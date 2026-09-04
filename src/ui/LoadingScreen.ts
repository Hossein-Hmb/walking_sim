/**
 * src/ui/LoadingScreen.ts
 *
 * Contents: `LoadingScreen`, the full-viewport overlay shown while the world is generated. It owns a
 * smoothed progress bar driven by `loading:progress`, a rotating traveler's-log line, and its own
 * fade-out on `loading:done`.
 *
 * Purpose: WS1 generates a 513² heightmap, carves rivers and builds chunk meshes before the first
 * real frame. That is a second or more of nothing, and "nothing" reads as "broken". This screen
 * covers it with something that is honest about progress and in keeping with the tone of the game.
 *
 * Relationship to `index.html`: the static `#boot` panel is the pre-JavaScript placeholder. This
 * overlay simply sits above it (z-index 200 vs 100) and both disappear at the same moment, so there
 * is no flash between them. If `main.ts` rewrites `#boot` into a fatal-error panel, the observer
 * below notices and gets out of the way immediately rather than hiding the error.
 *
 * It is deliberately NOT a `System`: it must exist before `engine.init()` runs, which is where the
 * work it is covering actually happens.
 *
 * Ownership: WS7.
 */

import './hud.css';
import { LOADING, WORLD } from '../config/world.config';
import type { EventBus, Unsubscribe } from '../core/EventBus';
import { clamp01, mulberry32 } from '../utils/math';
import { el, setProp, setText } from './dom';

/**
 * Traveler's-log lines. Flavour, not status: the real status is the phase label under the title.
 * Ordered deterministically from the world seed so a given island always reads the same way.
 */
const LOG_LINES: readonly string[] = [
  'surveying the coastline',
  'letting the snow settle on the peaks',
  'teaching four rivers where the sea is',
  'counting cairns left by earlier travelers',
  'asking the wind which way it blows',
  'measuring the distance to the far ridge',
  'waiting for the light to turn',
  'the island is remembering its shape',
];

export class LoadingScreen {
  private readonly root: HTMLDivElement;
  private readonly phase: HTMLParagraphElement;
  private readonly fill: HTMLDivElement;
  private readonly log: HTMLParagraphElement;
  private readonly percent: HTMLSpanElement;

  private readonly unsubscribes: Unsubscribe[] = [];
  private readonly bootObserver: MutationObserver | null = null;

  private target = 0.02;
  private shown = 0;
  private logIndex: number;
  private lastLogSwap = 0;
  private lastFrame = 0;
  private rafId = 0;
  private readonly mountedAt = performance.now();
  private finished = false;

  /**
   * Build and show the screen.
   *
   * @param events - the bus to listen on for `loading:progress` / `loading:done`
   * @param parent - host element, defaults to `document.body`
   *
   * @complexity Time: O(1) | Space: O(1)
   */
  constructor(events: EventBus, parent: HTMLElement = document.body) {
    this.root = el('div', 'loading', parent);
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');

    const inner = el('div', 'loading__inner', this.root);
    const title = el('h1', 'loading__title', inner);
    title.textContent = 'Iranzamin';
    this.phase = el('p', 'loading__phase', inner);
    this.phase.textContent = 'preparing the island';

    const bar = el('div', 'loading__bar', inner);
    this.fill = el('div', 'loading__fill', bar);

    const meta = el('div', 'loading__meta', inner);
    this.log = el('p', 'loading__log', meta);
    this.percent = el('span', 'mono', meta);
    this.percent.textContent = '0%';

    const foot = el('p', 'loading__foot', this.root);
    foot.textContent = 'arrow keys to walk · shift to press on · esc for help';

    // Deterministic starting line, then straight through the list.
    this.logIndex = Math.floor(mulberry32(WORLD.seed)() * LOG_LINES.length) % LOG_LINES.length;
    this.log.textContent = LOG_LINES[this.logIndex]!;

    this.unsubscribes.push(
      events.on('loading:progress', ({ progress, label }) => this.setProgress(progress, label)),
      events.on('loading:done', () => this.finish()),
    );

    this.bootObserver = this.watchBootPanel();

    this.lastFrame = performance.now();
    this.lastLogSwap = this.lastFrame;
    this.rafId = requestAnimationFrame(this.frame);
  }

  /**
   * Advance the bar. Progress is monotonic: a late-arriving smaller value is ignored, because a bar
   * that goes backwards reads as a bug even when it is technically accurate.
   *
   * @param progress - 0..1
   * @param label - short phase description, e.g. "carving rivers"
   */
  setProgress(progress: number, label?: string): void {
    this.target = Math.max(this.target, clamp01(progress));
    if (label) setText(this.phase, label);
  }

  /**
   * Run the bar to full, then fade out and remove. Safe to call more than once.
   *
   * The bar is always given `LOADING.settleMs` to visibly reach 100 % first — fading out while it
   * still reads 87 % looks like something was abandoned rather than finished.
   */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.target = 1;

    const elapsed = performance.now() - this.mountedAt;
    const wait = Math.max(LOADING.minVisibleMs - elapsed, LOADING.settleMs);
    window.setTimeout(() => this.dismiss(false), wait);
  }

  /** Replace the log line with an error and stop pretending to load. */
  fail(message: string): void {
    this.finished = true;
    setText(this.phase, 'the island did not form');
    setText(this.log, message);
    setProp(this.log, 'color', 'var(--alert)');
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /** Tear down listeners and DOM. Called automatically once the fade completes. */
  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
    this.bootObserver?.disconnect();
    this.root.remove();
  }

  private dismiss(immediate: boolean): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (immediate) {
      this.dispose();
      return;
    }
    this.root.classList.add('is-leaving');
    window.setTimeout(() => this.dispose(), LOADING.fadeMs);
  }

  private readonly frame = (now: number): void => {
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;

    // Ease toward the target so a jump from 0.4 to 1.0 still reads as motion rather than a snap.
    // Once the world is ready the bar hurries up: nobody wants to watch an easing curve.
    const lambda = this.finished ? LOADING.easeLambda * 3 : LOADING.easeLambda;
    this.shown += (this.target - this.shown) * (1 - Math.exp(-lambda * dt));
    if (this.target - this.shown < 0.002) this.shown = this.target;

    setProp(this.fill, 'transform', `scaleX(${this.shown.toFixed(4)})`);
    setText(this.percent, `${Math.round(this.shown * 100)}%`);

    if (now - this.lastLogSwap >= LOADING.logIntervalMs) {
      this.lastLogSwap = now;
      this.swapLogLine();
    }

    this.rafId = requestAnimationFrame(this.frame);
  };

  private swapLogLine(): void {
    this.log.classList.add('is-fading');
    window.setTimeout(() => {
      this.logIndex = (this.logIndex + 1) % LOG_LINES.length;
      setText(this.log, LOG_LINES[this.logIndex]!);
      this.log.classList.remove('is-fading');
    }, 500);
  }

  /**
   * `main.ts` reports a fatal boot error by rewriting the `#boot` panel, which lives *under* this
   * overlay. Watch for that and step aside instantly so the error is never hidden.
   */
  private watchBootPanel(): MutationObserver | null {
    const boot = document.querySelector('#boot');
    if (!boot) return null;
    const observer = new MutationObserver(() => {
      if (!boot.querySelector('pre')) return;
      observer.disconnect();
      this.dismiss(true);
    });
    observer.observe(boot, { childList: true, subtree: true });
    return observer;
  }
}
