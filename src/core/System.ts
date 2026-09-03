/**
 * src/core/System.ts
 *
 * Contents: a re-export of the `System` contract (canonically declared in `types.ts`) and the
 * `SystemRegistry` that owns the ordered list of systems and drives their lifecycle.
 *
 * Purpose: the Engine should not care how many systems exist or what they are; it just asks the
 * registry to init / fixedUpdate / update / dispose. The registry also isolates exceptions so one
 * misbehaving system (likely, while seven workstreams are landing in parallel) cannot kill the
 * frame loop for everybody, and optionally records per-system timings for the perf overlay.
 */

import type { GameContext, System } from './types';

export type { System };

/** A system is quarantined after this many consecutive throws, so the rest of the game keeps running. */
const MAX_CONSECUTIVE_FAILURES = 5;

export class SystemRegistry {
  private readonly systems: System[] = [];
  private readonly failures = new Map<string, number>();
  private readonly disabled = new Set<string>();

  /** Set true to record per-system ms into `timings` (the F1 overlay does this). */
  profiling = false;
  /** System name → milliseconds spent in its last `update` + `fixedUpdate` calls. */
  readonly timings: Record<string, number> = {};

  /** Registration order IS execution order. See PLAN.md for the canonical ordering. */
  add(system: System): this {
    if (this.systems.some((s) => s.name === system.name)) {
      throw new Error(`[SystemRegistry] duplicate system name "${system.name}"`);
    }
    this.systems.push(system);
    return this;
  }

  get all(): readonly System[] {
    return this.systems;
  }

  get<T extends System = System>(name: string): T | undefined {
    return this.systems.find((s) => s.name === name) as T | undefined;
  }

  /** Sequential — later systems may depend on services published by earlier ones during init. */
  async initAll(ctx: GameContext): Promise<void> {
    for (const system of this.systems) {
      const t0 = performance.now();
      await system.init(ctx);
      const ms = performance.now() - t0;
      if (ms > 100) console.info(`[SystemRegistry] ${system.name}.init took ${ms.toFixed(0)} ms`);
    }
  }

  fixedUpdate(dt: number, ctx: GameContext): void {
    for (const system of this.systems) {
      if (!system.fixedUpdate || this.disabled.has(system.name)) continue;
      this.run(system, 'fixedUpdate', () => system.fixedUpdate!(dt, ctx));
    }
  }

  update(dt: number, ctx: GameContext): void {
    for (const system of this.systems) {
      if (!system.update || this.disabled.has(system.name)) continue;
      this.run(system, 'update', () => system.update!(dt, ctx));
    }
  }

  disposeAll(): void {
    // Reverse order: tear down dependents before the things they depend on.
    for (let i = this.systems.length - 1; i >= 0; i--) {
      try {
        this.systems[i]!.dispose?.();
      } catch (err) {
        console.error(`[SystemRegistry] ${this.systems[i]!.name}.dispose threw:`, err);
      }
    }
    this.systems.length = 0;
    this.failures.clear();
    this.disabled.clear();
  }

  /** Clears the timing accumulator. Call once per frame before the fixed-step loop. */
  resetTimings(): void {
    if (!this.profiling) return;
    for (const key of Object.keys(this.timings)) this.timings[key] = 0;
  }

  private run(system: System, phase: string, fn: () => void): void {
    const t0 = this.profiling ? performance.now() : 0;
    try {
      fn();
      this.failures.set(system.name, 0);
    } catch (err) {
      const count = (this.failures.get(system.name) ?? 0) + 1;
      this.failures.set(system.name, count);
      console.error(`[SystemRegistry] ${system.name}.${phase} threw (${count}):`, err);
      if (count >= MAX_CONSECUTIVE_FAILURES) {
        this.disabled.add(system.name);
        console.error(`[SystemRegistry] disabling "${system.name}" after ${count} failures.`);
      }
    }
    if (this.profiling) {
      this.timings[system.name] = (this.timings[system.name] ?? 0) + (performance.now() - t0);
    }
  }
}
