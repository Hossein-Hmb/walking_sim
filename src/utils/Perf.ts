/**
 * src/utils/Perf.ts
 *
 * Contents: `PerfMonitor`, a module-level singleton (`perf`) wrapping stats.js plus a custom debug
 * overlay showing fps, frame time, draw calls, triangles, GPU resource counts and arbitrary named
 * timers (e.g. physics ms). Toggled with F1.
 *
 * Purpose: PLAN.md makes the performance budget non-negotiable and observable from day one. The
 * overlay turns red the moment `PERF.budgetDrawCalls` / `PERF.budgetTriangles` are breached.
 *
 * It is a singleton rather than a `System` so any workstream can report a timing without threading
 * a reference through `GameContext`:
 *
 *     import { perf } from '../utils/Perf';
 *     const t0 = performance.now();
 *     ...work...
 *     perf.mark('physics', performance.now() - t0);
 *
 * Ownership: created by WS0. WS7 may extend the panel contents; keep `mark()` and `attach()` stable.
 *
 * WS7 extension (additive only — `attach`, `mark`, `beginFrame`, `endFrame`, `toggle` and the F1
 * binding are untouched):
 *   - `note(label, value)` for non-timing state, e.g. the active quality preset:
 *         perf.note('quality', 'medium');
 *   - fps and frame time are now budgeted too (`PERF.budgetFps`, `PERF.budgetFrameMs`), so the
 *     panel goes red when the frame is slow, not only when it is fat. Each offending line is
 *     flagged with a leading `!` so it is obvious *which* budget broke.
 */

import Stats from 'stats.js';
import type * as THREE from 'three';
import { PERF } from '../config/world.config';
import type { EventBus } from '../core/EventBus';

const REFRESH_MS = 250;

export class PerfMonitor {
  private stats: Stats | null = null;
  private panel: HTMLDivElement | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private events: EventBus | null = null;
  private readonly marks = new Map<string, number>();
  private readonly notes = new Map<string, string>();
  private lastRefresh = 0;
  private frames = 0;
  private fps = 0;
  private frameMs = 0;
  private lastFrameStart = 0;
  private _visible = false;

  get visible(): boolean {
    return this._visible;
  }

  /** Build the DOM and bind F1. Call once, after the renderer exists. */
  attach(renderer: THREE.WebGLRenderer, events: EventBus, parent: HTMLElement = document.body): void {
    if (this.stats) return;
    this.renderer = renderer;
    this.events = events;

    this.stats = new Stats();
    this.stats.showPanel(0); // 0 = fps
    Object.assign(this.stats.dom.style, {
      position: 'fixed',
      top: '8px',
      left: '8px',
      zIndex: '1000',
    });
    parent.appendChild(this.stats.dom);

    this.panel = document.createElement('div');
    this.panel.id = 'perf-panel';
    Object.assign(this.panel.style, {
      position: 'fixed',
      top: '58px',
      left: '8px',
      zIndex: '1000',
      font: '11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace',
      color: '#d8e6ef',
      background: 'rgba(8, 14, 20, 0.72)',
      border: '1px solid rgba(216, 230, 239, 0.18)',
      borderRadius: '4px',
      padding: '6px 8px',
      minWidth: '190px',
      whiteSpace: 'pre',
      pointerEvents: 'none',
      backdropFilter: 'blur(4px)',
    } satisfies Partial<CSSStyleDeclaration>);
    parent.appendChild(this.panel);

    window.addEventListener('keydown', this.onKeyDown);
    this.setVisible(false);
  }

  /** Record a named timing in milliseconds for the current frame. */
  mark(label: string, ms: number): void {
    this.marks.set(label, ms);
  }

  /**
   * Record a named piece of non-timing state (quality preset, active weather cell, chunk count...).
   * Persists until overwritten — unlike `mark`, it is not a per-frame value.
   */
  note(label: string, value: string): void {
    this.notes.set(label, value);
  }

  /** Call at the very top of the frame. */
  beginFrame(): void {
    this.lastFrameStart = performance.now();
    this.stats?.begin();
  }

  /** Call after `renderer.render()` — `renderer.info` auto-resets on the next render. */
  endFrame(): void {
    this.stats?.end();
    this.frames++;
    this.frameMs = performance.now() - this.lastFrameStart;

    const now = performance.now();
    if (now - this.lastRefresh < REFRESH_MS) return;
    this.fps = (this.frames * 1000) / (now - this.lastRefresh);
    this.frames = 0;
    this.lastRefresh = now;
    if (this._visible) this.render();
  }

  setVisible(visible: boolean): void {
    this._visible = visible;
    if (this.stats) this.stats.dom.style.display = visible ? '' : 'none';
    if (this.panel) this.panel.style.display = visible ? '' : 'none';
  }

  toggle(): void {
    this.setVisible(!this._visible);
    this.events?.emit('debug:toggle', { active: this._visible });
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.stats?.dom.remove();
    this.panel?.remove();
    this.stats = null;
    this.panel = null;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code !== 'F1') return;
    e.preventDefault();
    this.toggle();
  };

  private render(): void {
    if (!this.panel || !this.renderer) return;
    const info = this.renderer.info;
    const calls = info.render.calls;
    const tris = info.render.triangles;

    const slowFps = this.fps > 0 && this.fps < PERF.budgetFps;
    const slowFrame = this.frameMs > PERF.budgetFrameMs;
    const fatCalls = calls > PERF.budgetDrawCalls;
    const fatTris = tris > PERF.budgetTriangles;

    const lines = [
      `${flag(slowFps)}fps        ${this.fps.toFixed(0).padStart(6)} / ${PERF.budgetFps}`,
      `${flag(slowFrame)}frame      ${this.frameMs.toFixed(2).padStart(6)} ms / ${PERF.budgetFrameMs}`,
      `${flag(fatCalls)}draw calls ${String(calls).padStart(6)} / ${PERF.budgetDrawCalls}`,
      `${flag(fatTris)}triangles  ${fmt(tris).padStart(6)} / ${fmt(PERF.budgetTriangles)}`,
      `  programs   ${String(info.programs?.length ?? 0).padStart(6)}`,
      `  geometries ${String(info.memory.geometries).padStart(6)}`,
      `  textures   ${String(info.memory.textures).padStart(6)}`,
    ];
    for (const [label, ms] of this.marks) {
      lines.push(`  ${label.padEnd(10)} ${ms.toFixed(2).padStart(6)} ms`);
    }
    for (const [label, value] of this.notes) {
      lines.push(`  ${label.padEnd(10)} ${value.padStart(6)}`);
    }
    lines.push('', '  F1 toggle debug');

    this.panel.textContent = lines.join('\n');
    this.panel.style.color =
      slowFps || slowFrame || fatCalls || fatTris ? '#ff8a7a' : '#d8e6ef';
  }
}

function flag(broken: boolean): string {
  return broken ? '! ' : '  ';
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
}

/** The one instance everybody uses. */
export const perf = new PerfMonitor();
