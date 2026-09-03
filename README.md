# Strandfall

A browser-based third-person walking simulator on a 2 km × 2 km procedural island. Everything is
generated at runtime — no textures, no models, no downloads beyond the JS bundle.

> **This file** documents how to run the project, the controls, and the architecture that lets
> several agents build it in parallel. The authoritative implementation plan is [`PLAN.md`](./PLAN.md).
> **Current state: MVP complete.** All eight workstreams have landed — procedural terrain and
> rivers, Rapier physics, the player controller, materials/sky/water, vegetation, the four
> signature features, the HUD, and the integration pass. See [`WS8_STATUS.md`](./WS8_STATUS.md)
> for what works and what does not.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173 (Vite picks the next free port if it is taken)
```

Then walk with the arrow keys. The island generates in a Web Worker behind the loading screen and
takes roughly a quarter of a second; first paint is well inside a second on a warm cache.

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Type-check, then produce a static bundle in `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | `tsc --noEmit` — the type gate; must be clean before you push |

Requires Node 20+ and a WebGL2 browser.

## Controls

| Input | Action |
|---|---|
| Arrow keys / WASD | Walk (camera-relative) |
| Shift | Sprint — drains stamina, and so does climbing |
| Space | Jump |
| Mouse drag | Orbit the camera (double-click the canvas for pointer-lock look) |
| `Q` | Odradek scan — an expanding ring that tints the ground by how walkable it is |
| `C` | Stack a cairn. It persists in `localStorage` and is there when you reload |
| `P` | Photo mode: time freezes, the camera detaches, `Enter` downloads a PNG |
| `Esc` / `H` | Pause and help overlay, including the Low / Medium / High quality presets |
| `F1` | Perf / debug overlay — fps, draw calls, triangles, per-system timings, collider wireframe |

In photo mode the arrow keys fly the camera, `Q`/`E` descend and ascend, `Shift` boosts, `Enter`
saves the shot and `Esc` leaves.

## Architecture

A single `Engine` owns the renderer, scene, camera and clock, and drives an ordered list of
`System` objects. **Systems never import each other.** They talk through two things only:

- **`GameContext`** — the shared service container (`scene`, `camera`, `renderer`, `events`,
  `physics`, `world`, `input`, `player`, `time`, `uniforms`).
- **`EventBus`** — typed, synchronous fire-and-forget notifications (`world:ready`,
  `player:landed`, `weather:changed`, …).

```
main.ts
  └─ Engine
       ├─ input.beginFrame()
       ├─ fixed-step accumulator @ 60 Hz  → system.fixedUpdate(1/60)
       ├─ variable render frame           → system.update(dt) → renderer.render()
       └─ input.endFrame()
```

Two files are the contract between all workstreams and are **append-only**:

- `src/core/types.ts` — every shared interface.
- `src/config/world.config.ts` — every tunable constant. No magic numbers anywhere else.

### Layout

```
src/
├─ main.ts                # bootstrap: RAPIER.init(), build ctx, register systems, start
├─ core/
│  ├─ Engine.ts           # renderer, scene, camera, resize, fixed-step loop
│  ├─ System.ts           # System re-export + SystemRegistry
│  ├─ GameContext.ts      # service-container factories
│  ├─ EventBus.ts         # typed pub/sub + GameEvents map
│  └─ types.ts            # ★ all shared contracts
├─ config/world.config.ts # ★ all tunable constants, including the quality presets
├─ world/                 # WS1 — terrain generation, rivers, chunked LOD
├─ physics/               # WS2 — Rapier world, heightfield, character controller
├─ player/                # WS3 — input, movement, stamina, third-person camera
├─ render/                # WS4/WS5/WS8 — materials, sky, vegetation, quality presets
├─ features/              # WS6 — cairns, weather, scanner, photo mode
├─ ui/                    # WS7 — HUD, loading screen
└─ utils/                 # math.ts (dependency-free), Perf.ts (stats.js + budget overlay)
```

`src/core/stubs.ts` is gone: WS0's flat-plane world, analytic physics and placeholder scene existed
only to unblock the parallel streams, and every one of them has been replaced by the real thing.

### Stack

Vite 8 · TypeScript 7 · three.js r185 · Rapier 3D (`@dimforge/rapier3d-compat`) · simplex-noise ·
stats.js. Rapier's `-compat` build inlines its WASM as base64, so there is no WASM plugin to
configure — just `await RAPIER.init()` once in `main.ts`.

## Working on this repo

1. Read `PLAN.md` and claim exactly one workstream.
2. Only create/edit the files your workstream owns. If you need something from another stream, add
   a method to your own interface or emit an event — do not edit their files.
3. Never change an existing signature in `types.ts` / `world.config.ts`; append instead.
4. `npm run typecheck` must be clean before you hand off.

Performance budget (enforced by the F1 overlay, which turns red on breach):
≥ 55 fps at 1080p, < 150 draw calls, < 500 k triangles.
