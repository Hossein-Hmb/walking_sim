/**
 * src/core/EventBus.ts
 *
 * Contents: the `GameEvents` map (the typed catalogue of every notification the game can emit) and
 * the `EventBus` class — a tiny synchronous, strongly-typed pub/sub.
 *
 * Purpose: systems must never import one another. When system A needs to tell the world that
 * something happened, it emits an event; anyone who cares subscribes. This is what lets the
 * workstreams in PLAN.md be developed independently.
 *
 * RULES: `GameEvents` is APPEND-ONLY after WS0. Add new keys freely; never change the payload shape
 * of an existing key without announcing it, because other workstreams are already coding against it.
 */

import type * as THREE from "three";
import type { BiomeName, BiomeWeights, QualityLevel, WorldData } from "./types";

/** The complete catalogue of game events. Key = event name, value = payload shape. */
export interface GameEvents {
  // --- world lifecycle -----------------------------------------------------
  "world:ready": { data: WorldData };

  // --- player --------------------------------------------------------------
  "player:spawned": { position: THREE.Vector3 };
  "player:landed": { impact: number; biome: BiomeWeights };
  "player:tumbled": { position: THREE.Vector3 };
  "player:enterBiome": { biome: BiomeName };

  // --- weather -------------------------------------------------------------
  "weather:changed": { rain: number; snow: number; wind: THREE.Vector2 };

  // --- features ------------------------------------------------------------
  "cairn:placed": { position: THREE.Vector3; isGhost: boolean };
  /** An authored landmark is in the world — HUD puts a compass diamond on it. */
  "landmark:placed": { position: THREE.Vector3; name: string };
  "scan:pulse": { origin: THREE.Vector3 };
  "photo:toggle": { active: boolean };

  // --- ui ------------------------------------------------------------------
  "hud:toast": { text: string; ms?: number };
  /** Contextual interact chip. `label` is the verb ("read", "listen"); `null` hides it. */
  "hud:prompt": { label: string | null };
  /** Manuscript card for a square fact. `null` closes it. */
  "hud:lore": { title: string; body: string } | null;

  // --- WS0 additions -------------------------------------------------------
  /** Emitted by long-running generation (WS1's terrain worker) so WS7's loading screen can animate. */
  "loading:progress": { progress: number; label: string };
  /** Everything is generated and the first real frame is about to render. */
  "loading:done": Record<string, never>;
  /** F1. Owned by the perf overlay; consumed by WS2's collider wireframe and WS7's perf panel. */
  "debug:toggle": { active: boolean };

  // --- WS7 additions -------------------------------------------------------
  /**
   * The pause/help overlay opened or closed. WS7 only draws the overlay; whoever owns the loop
   * decides what pausing means (in `main.ts` it stops and restarts the Engine's RAF). Systems with
   * their own timers (WS6's weather cells, WS3's tumble recovery) should honour it too.
   */
  "hud:pause": { paused: boolean };
  /**
   * A quality preset was selected in the pause overlay, or restored from `localStorage` at startup.
   * WS7 owns the control and the persistence; WS8 owns what each level actually changes
   * (pixel ratio, grass density, shadows, fog distance).
   */
  "quality:changed": { level: QualityLevel };
}

export type EventName = keyof GameEvents;
export type EventHandler<K extends EventName> = (
  payload: GameEvents[K],
) => void;
/** Call to unsubscribe. Returned by `on`/`once`. */
export type Unsubscribe = () => void;

export class EventBus {
  private readonly handlers = new Map<
    EventName,
    Set<EventHandler<EventName>>
  >();

  /** Subscribe. Returns an unsubscribe function — prefer it over calling `off` manually. */
  on<K extends EventName>(name: K, handler: EventHandler<K>): Unsubscribe {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as EventHandler<EventName>);
    return () => this.off(name, handler);
  }

  /** Subscribe for exactly one emission. */
  once<K extends EventName>(name: K, handler: EventHandler<K>): Unsubscribe {
    const wrapped: EventHandler<K> = (payload) => {
      off();
      handler(payload);
    };
    const off = this.on(name, wrapped);
    return off;
  }

  off<K extends EventName>(name: K, handler: EventHandler<K>): void {
    const set = this.handlers.get(name);
    if (!set) return;
    set.delete(handler as EventHandler<EventName>);
    if (set.size === 0) this.handlers.delete(name);
  }

  /**
   * Dispatch synchronously. Iterates a snapshot so handlers may subscribe/unsubscribe during
   * dispatch, and isolates throws so one broken listener cannot kill the frame loop.
   */
  emit<K extends EventName>(name: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(name);
    if (!set || set.size === 0) return;
    for (const handler of [...set]) {
      try {
        (handler as EventHandler<K>)(payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${String(name)}" threw:`, err);
      }
    }
  }

  /** Drop every subscription. Used on teardown / hot reload. */
  clear(): void {
    this.handlers.clear();
  }
}
