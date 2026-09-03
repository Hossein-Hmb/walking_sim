# WS0 — Foundation & Contracts: STATUS ✅ COMPLETE

> **What this file is:** the handoff note from WS0 to WS1–WS7. It records what shipped, every
> deviation from `PLAN.md`, and the things a parallel agent needs to know before touching the repo.
> Read it once before you start your workstream.

---

## 1. What shipped

**Toolchain / project root**

| File | Notes |
|---|---|
| `package.json` | `dev` / `build` / `preview` / `typecheck` scripts |
| `tsconfig.json` | strict, `noEmit`, `verbatimModuleSyntax`, ES2022/bundler resolution |
| `vite.config.ts` | ES2022 target, ESM workers enabled (for WS1), three/rapier vendor chunks |
| `index.html` | full-viewport canvas `#game`, placeholder boot overlay `#boot`, inline favicon |
| `.gitignore`, `README.md` | — |

**Engine core** — `src/core/`

| File | Contents |
|---|---|
| `types.ts` | ★ every shared interface. **Append-only from now on.** |
| `EventBus.ts` | `GameEvents` map + typed `on` / `once` / `off` / `emit`; handler throws are caught and logged |
| `Engine.ts` | renderer/scene/camera/fog/resize + the frame loop |
| `System.ts` | `System` re-export + `SystemRegistry` (ordered init/update/dispose, per-system timings, failure quarantine) |
| `GameContext.ts` | `createGameContext`, `createPlayerState`, `createSharedUniforms`, `createTimeState` |
| `stubs.ts` | ⚠ temporary — see §3 |

**Config & utils**

- `src/config/world.config.ts` — `WORLD`, `PLAYER`, `CAMERA`, `PERF` exactly as in PLAN.md, plus
  `RENDER` and `TIME` (see deviations).
- `src/utils/math.ts` — clamp/lerp/damp/smoothstep/angles + mulberry32 RNG and hashes.
  **Imports nothing at all**, so WS1 can use it inside the terrain Web Worker.
- `src/utils/Perf.ts` — `perf` singleton: stats.js panel + custom overlay (fps, frame ms, draw
  calls, triangles, programs, geometries, textures, named timers), F1 toggle, budget colouring.

**Bootstrap** — `src/main.ts` awaits `RAPIER.init()`, builds the context, registers systems, starts
the loop. It is the only file that names concrete implementations; each has a `TODO(WSn)` marker
showing exactly where to plug your system in.

---

## 2. Verified acceptance (WS0 exit criteria)

| Criterion | Result |
|---|---|
| `npm install` | clean, 35 packages, 0 vulnerabilities |
| `npm run typecheck` | clean (TypeScript 7.0.2) |
| `npm run build` | succeeds — **~981 kB gzipped total** (game 8 kB, three 131 kB, rapier 842 kB) |
| `npm run dev` renders a canvas | yes — ground plane, grid, 40 instanced landmark blocks, lit |
| 60 fps | yes, measured 60 fps / 0.20 ms frame time / **6 draw calls** / 1 k triangles |
| Sphere moves with arrow keys | yes — 3.01 m in 0.7 s ramping to `PLAYER.walkSpeed` |
| Space jumps and lands | yes — leaves ground, returns to y = 1.0, `grounded` flips correctly |
| Sprint drains stamina | yes |
| No NaN in player position | verified |
| stats.js panel + F1 debug overlay | yes; F1 also emits `debug:toggle` |
| Console errors | **0 errors.** One warning remains — see §4 |

Rapier API verified against the *installed* 0.19.3, as PLAN.md required:
`init(): Promise<void>` ✅, `World.createCharacterController(offset)` ✅,
`ColliderDesc.heightfield(nrows, ncols, heights: Float32Array, scale, flags?)` ✅,
`setMaxSlopeClimbAngle` / `setMinSlopeSlideAngle` / `enableAutostep` / `enableSnapToGround` ✅,
`world.debugRender()` ✅. **`await RAPIER.init()` already runs in `main.ts` — WS2 does not need to
add it.**

---

## 3. The stubs (all in `src/core/stubs.ts` — deleted wholesale in WS8)

| Stub | Behaviour | Replaced by |
|---|---|---|
| `StubWorld` | flat plane at y = 0, 100 % grass, no rivers. Allocates real full-size `heights` (513²) and `biomes` (513²×4) arrays so WS2 can build a heightfield against the correct shapes today. | WS1 |
| `StubPhysics` | creates a **genuine, empty `RAPIER.World`** (gravity `PLAYER.gravity`) so the WASM path is exercised, but resolves movement and raycasts analytically against `IWorld`. `addHeightfield` / `addStaticTrimesh` / `removeCollider` are no-ops with `TODO(WS2)`. | WS2 |
| `StubCharacterBody` | kinematic capsule clamped to `sampleHeight`, clamped to island bounds. | WS2 |
| `StubInput` | **not a stub** — real keyboard + pointer handling, edge-triggered jump/actions, blur-safe. | WS3 (move the file, keep the semantics) |
| `StubSceneSystem` | ground plane, grid, hemisphere + directional light, 40 instanced landmark blocks (so motion is visible). | WS1 / WS4 |
| `StubPlayerSystem` | icosphere avatar, camera-relative movement with `damp`, jump with a 0.15 s buffer, placeholder stamina, damped orbit follow camera. | WS3 |

Each stub is the dumbest thing that satisfies its interface. **Do not add features to `stubs.ts`** —
build them in your own workstream's files and swap the wiring in `main.ts`.

---

## 4. Deviations from PLAN.md

All additive; nothing in the plan's contract text was removed or renamed.

1. **`GameContext.uniforms: SharedUniforms` (new field).** PLAN.md tells WS6 to "coordinate the
   uniform names `uWetness`, `uScanOrigin`, `uScanRadius` in `types.ts` up front" but gives no
   mechanism. WS0 creates those uniform objects once and shares them by reference:
   WS4 assigns them into its shader inside `onBeforeCompile`; WS6 just writes `.value`. Neither side
   imports the other. Also includes `uTime` (advanced by the Engine every frame) and `uWind`.
2. **`IInput.beginFrame?()` / `endFrame?()` (new optional methods).** Edge-triggered flags (`jump`,
   `actions`) need to be true for exactly one whole frame *including every fixed step inside it*.
   The Engine calls these around the frame. Both optional, so a simpler input impl stays valid.
3. **`RENDER` and `TIME` config blocks (new).** Hold the values the bootstrap itself needs: clear/fog
   colour and distances, antialias, shadow map size, `fixedTimestep`, `maxFixedStepsPerFrame`,
   day length, start time of day. WS4 owns the final look and may drive fog/sky from its own sky
   gradient — these are defaults, not a claim on that territory.
4. **Extra `GameEvents` keys:** `loading:progress`, `loading:done` (WS1 worker → WS7 loading screen)
   and `debug:toggle` (F1; consumed by WS2's collider wireframe and WS7's perf panel).
5. **Extra types in `types.ts`:** `RaycastHit` (referenced by `IPhysics` in the plan but never
   defined), `BiomeName`, `ActionId` (adds `'pause'` for Esc), `TERRAIN_ATTRIBUTES` (`aBiome`),
   `Uniform<T>`, `SharedUniforms`, `QualityLevel`, `Rng`.
6. **`InputState.move` is a `THREE.Vector2` with `y` = forward.** The plan's comment said
   "x=strafe z=forward", which a `Vector2` has no room for. `x` = strafe, `y` = forward.
7. **`PCFSoftShadowMap` → `PCFShadowMap`.** three r185 deprecates the soft variant and silently
   falls back while logging a warning, so `Engine` selects the fallback explicitly. WS4 owns shadow
   quality and can revisit (e.g. VSM).
8. **Two strictness flags are off** in `tsconfig.json` (`strict` and `noUnusedLocals` stay on):
   `noUnusedParameters`, because implementations of the shared interfaces routinely ignore an
   argument; and `noUncheckedIndexedAccess`, because it types every `Float32Array` element read as
   `number | undefined` — verified against a probe file — which would litter WS1's terrain
   generator, WS2's heightfield builder and the bilinear sampler with non-null assertions.
9. **`ACESFilmicToneMapping`** is set as a default in `Engine`. WS4 may change it.
10. **Known warning, not fixable by us:** Rapier 0.19.3's own `init()` logs
    *"using deprecated parameters for the initialization function; pass a single object instead"*
    from its bundled wasm-bindgen glue. It is internal to the package. Console is otherwise clean.

---

## 5. What parallel agents must know

**File ownership.** Everything WS0 created is WS0's. Do not edit `Engine.ts`, `System.ts`,
`EventBus.ts`, `GameContext.ts`, `stubs.ts`, `index.html`, `vite.config.ts` or `tsconfig.json`.
Two shared exceptions:

- `src/core/types.ts` and `src/config/world.config.ts` — **append only**, never rename or change an
  existing signature/key. Announce anything you add.
- `src/main.ts` — you will need one or two lines here to register your system. Keep the edit to the
  marked `TODO(WSn)` slot so the merges stay trivial; WS8 owns the final wiring.

**Registration order is execution order** (see `main.ts`):
Physics → World → Player → Camera → Weather → Vegetation → Cairn → Hud → PhotoMode.

**Identity rules.** Systems capture `ctx.player`, `ctx.time` and `ctx.uniforms.*` by reference during
`init()`. Mutate those objects in place — never reassign them. Whole services (`ctx.world`,
`ctx.physics`) may only be swapped *before* `engine.init()` runs.

**Frame contract.**
`input.beginFrame()` → 0..5 × `fixedUpdate(1/60)` → `update(dt)` → `render()` → `input.endFrame()`.
Put anything physics-coupled in `fixedUpdate`; put anything visual/interpolated in `update`. Frames
longer than 0.25 s are clamped, and leftover accumulator time is discarded rather than simulated.

**Determinism.** Never call `Math.random()`. Use `mulberry32(seed)` from `utils/math.ts` and derive
per-chunk seeds with `hash2(cx, cz)`, so the island, grass and cairns are reproducible.

**Report your cost.** `import { perf } from '../utils/Perf'` then
`perf.mark('physics', ms)` — it shows up in the F1 overlay immediately.

**Handshakes agreed up front (from PLAN.md §Suggested Order):**

- WS1 → WS2: `WorldData.heights` is `Float32Array`, row-major, `index = z * resolution + x`,
  `resolution = 513`, world spans `[-size/2, +size/2]` on both axes. Pass the *same array* to Rapier.
- WS1 → WS4: the terrain vertex attribute is `aBiome`, a `vec4` `[grass, rock, snow, sand]` summing
  to 1. Use the `TERRAIN_ATTRIBUTES.biome` constant, not a string literal.
- WS4 → WS6: shader uniforms come from `ctx.uniforms` (`uTime`, `uWetness`, `uScanOrigin`,
  `uScanRadius`, `uWind`). Assign the shared objects into the shader; do not create new ones.

**Debug handle.** In dev, `window.strandfall` exposes `{ engine, ctx, perf }`.

---

## 6. Not done (deliberately out of WS0 scope)

Procedural terrain, rivers, LOD chunking, the real Rapier heightfield and character controller,
materials/sky/water, vegetation, cairns/weather/scanner/photo mode, the HUD and loading screen, the
`sampleHeight`-vs-raycast agreement test, and quality presets. Those are WS1–WS8.
