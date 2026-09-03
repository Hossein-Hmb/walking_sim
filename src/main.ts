/**
 * src/main.ts
 *
 * Contents: the bootstrap. Initialises the Rapier WASM module, constructs the Engine, builds the
 * `GameContext` out of the service implementations, registers the systems in their canonical order,
 * and starts the frame loop.
 *
 * Purpose: this is the ONE file that knows which concrete implementation backs each contract.
 *
 * Registration order IS execution order. PLAN.md fixes the spine of it —
 *   Physics → World → Player → Camera → Sky → Weather → Vegetation → Cairn → Hud → PhotoMode
 * — and each departure from that list is justified at the line it happens on. The rules that are
 * load-bearing rather than cosmetic:
 *
 *   1. Physics runs first, so every later system reads an already-stepped world (WS2_STATUS §2).
 *   2. Player runs before Camera; the camera must follow this frame's position, not last frame's.
 *   3. Sky is the sole writer of the shared sky state, so Lighting and Water read it after.
 *   4. Weather pulls the fog in on top of the sky's own per-frame write, so it follows the sky.
 *   5. Quality scales the fog after *both* of them, so a preset composes with the day/night cycle
 *      and with a storm instead of being overwritten by either.
 *   6. PhotoMode is last: it pins `ctx.time` and `uTime` for the frame and draws the grade over
 *      everything else.
 *
 * WS8 removed the last of WS0's scaffolding from this file: `src/core/stubs.ts` is deleted, and
 * WS4's `TerrainPreviewSystem` (a stand-in island for the weeks before WS1 landed) is gone with it.
 */

import RAPIER from "@dimforge/rapier3d-compat";
import { WORLD } from "./config/world.config";
import { Engine } from "./core/Engine";
import { EventBus } from "./core/EventBus";
import { createGameContext } from "./core/GameContext";
import { CairnSystem } from "./features/CairnSystem";
import { PhotoModeSystem } from "./features/PhotoModeSystem";
import { ScannerSystem } from "./features/ScannerSystem";
import { WeatherSystem } from "./features/WeatherSystem";
import { PhysicsSystem } from "./physics/PhysicsSystem";
import { InputSystem } from "./player/InputSystem";
import { PlayerSystem } from "./player/PlayerSystem";
import { ThirdPersonCamera } from "./player/ThirdPersonCamera";
import { Lighting } from "./render/Lighting";
import { QualitySystem } from "./render/QualitySystem";
import { SkySystem } from "./render/SkySystem";
import { VegetationSystem } from "./render/VegetationSystem";
import { WaterSystem } from "./render/WaterSystem";
import { LandmarkSystem } from "./features/LandmarkSystem";
import { LoreSystem } from "./features/LoreSystem";
import { HudSystem } from "./ui/HudSystem";
import { LoadingScreen } from "./ui/LoadingScreen";
import { perf } from "./utils/Perf";
import { WorldSystem } from "./world/WorldSystem";

async function bootstrap(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>("#game");
  if (!canvas) throw new Error("#game canvas not found in index.html");

  const events = new EventBus();
  events.emit("loading:progress", { progress: 0.1, label: "starting physics" });

  // Rapier ships as WASM. The `-compat` build inlines it as base64, so this is the only setup step
  // required — no Vite WASM plugin, no fetch, no asset copying. Must complete before any
  // RAPIER.* constructor runs.
  await RAPIER.init();

  const engine = new Engine(canvas);
  perf.attach(engine.renderer, events);

  events.emit("loading:progress", { progress: 0.4, label: "building world" });

  // ── Service implementations ───────────────────────────────────────────────
  const world = new WorldSystem(WORLD.seed); // WS1 — procedural island, generated in a Web Worker
  const physics = new PhysicsSystem(world); // WS2 — real Rapier world, heightfield + character controller
  const input = new InputSystem(); // WS3
  input.attach(canvas);

  const ctx = createGameContext(engine, { world, physics, input, events });
  engine.setContext(ctx);

  // ── System registration (order matters) ───────────────────────────────────
  engine.add(physics); // WS2 — must come first: everything else reads an already-stepped world.
  engine.add(world); // WS1 — generates the island in `init`, then drives chunk LOD each frame.
  engine.add(new PlayerSystem()); // WS3 — owns the avatar; must run before the camera.
  engine.add(new ThirdPersonCamera()); // WS3

  // WS4 — the look. Sky first (rule 3).
  engine.add(new SkySystem());
  engine.add(new Lighting());
  engine.add(new WaterSystem());
  engine.add(new LandmarkSystem()); // Naqsh-e Jahan fragment — after water so the river is already posed
  engine.add(new LoreSystem()); // plaques + NPCs on the square; after landmarks so the plaza exists
  engine.add(new VegetationSystem()); // WS5 — instanced grass, rocks and driftwood

  // WS6 — the signature features.
  engine.add(new WeatherSystem()); // timefall: drifting rain cells, wetness, blizzard (rule 4)
  engine.add(new CairnSystem()); // the cairn network: place, persist, phantom travelers
  engine.add(new ScannerSystem()); // Odradek scan pulse

  // WS8 — Low/Medium/High. Registered before the HUD so that WS7's restore-on-load re-emit of the
  // stored preset (which happens inside `HudSystem.init`) lands on a subscriber that already
  // exists, and the saved quality is live on the very first frame.
  engine.add(new QualitySystem((cap) => engine.setPixelRatioCap(cap))); // rule 5

  // WS7 — DOM user interface.
  // The loading screen is not a System: it has to be on screen *before* `engine.init()`, which is
  // where WS1's terrain generation runs. It listens for `loading:progress` / `loading:done` and
  // removes itself.
  new LoadingScreen(events);
  engine.add(new HudSystem());

  engine.add(new PhotoModeSystem()); // rule 6 — freeze, free camera, filmic grade, PNG export

  // The HUD only reports the intent to pause; what that means is the bootstrap's call. WS7 left a
  // hard `engine.stop()` here. That works, but a stopped RAF loop also stops presenting, so the
  // frozen frame behind the overlay stretches if the window is resized while paused. `setPaused`
  // keeps drawing and freezes the clock instead, which is also what photo mode already expects —
  // it needs a live frame to grade and capture.
  events.on("hud:pause", ({ paused }) => engine.setPaused(paused));

  events.emit("loading:progress", {
    progress: 0.7,
    label: "initialising systems",
  });
  await engine.init();

  events.emit("loading:progress", { progress: 1, label: "ready" });
  events.emit("loading:done", {});
  dismissBootScreen();

  engine.start();

  if (import.meta.env.DEV) {
    // Handy console handle while seven workstreams are landing in parallel.
    Object.assign(window, { strandfall: { engine, ctx, perf } });
    import.meta.hot?.dispose(() => {
      input.detach();
      engine.dispose();
      perf.dispose();
    });
  }
}

function dismissBootScreen(): void {
  const boot = document.querySelector<HTMLElement>("#boot");
  if (!boot) return;
  boot.classList.add("is-hidden");
  window.setTimeout(() => boot.remove(), 400);
}

function showFatalError(err: unknown): void {
  console.error("[strandfall] fatal:", err);
  const boot = document.querySelector<HTMLElement>("#boot");
  const message = err instanceof Error ? err.message : String(err);
  if (boot) {
    boot.classList.remove("is-hidden");
    boot.innerHTML = `<div class="boot__panel"><h1>Failed to start</h1><pre>${escapeHtml(message)}</pre></div>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

void bootstrap().catch(showFatalError);
