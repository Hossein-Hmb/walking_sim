# PLAN.md — "Strandfall" Walking Simulator MVP

> **What this file is:** the authoritative implementation plan for a browser-based, third-person
> walking simulator inspired by Death Stranding. It contains the tech stack decisions, folder
> structure, shared code contracts, and a set of workstreams designed to be executed **in parallel by
> multiple agents** without merge conflicts. Every agent working on this repo should read this file
> first, claim exactly one workstream, and only edit files listed under that workstream's ownership.
>
> **Status:** planning complete, implementation not started.

---

## Objective

A player loads a URL, waits < 5s, and finds themselves as a lone traveler on a 2 km × 2 km procedural
island — grasslands rolling up into river valleys and snow-capped mountains. Arrow keys walk, Space
jumps, the terrain pushes back (slopes cost stamina, steep ground makes you tumble), and the world is
quietly haunted by cairns left by previous travelers. Runs at 60 fps on an integrated GPU.

---

## Tech Decisions

| Choice | Version | Rationale |
|---|---|---|
| **Vite** | `^8` | Zero-config TS + ESM dev server, instant HMR, tiny prod bundle. Fastest path to a shippable static site. |
| **TypeScript** | `^7` | Shared interfaces are the coordination mechanism between parallel agents; types make the contracts enforceable. Build transpiles via esbuild; `tsc --noEmit` is the type gate. |
| **Three.js** | `^0.185` | Mature WebGL renderer, huge ecosystem, `InstancedMesh`/LOD/fog built in. WebGPU rejected for MVP — compatibility risk with no payoff at this scale. |
| **Rapier3D (`@dimforge/rapier3d-compat`)** | `^0.19` | Rust/WASM, ~10× faster than cannon-es, and ships a **built-in `KinematicCharacterController`** with slope limits, auto-step and snap-to-ground — exactly the walking-on-terrain problem. The `-compat` build inlines WASM as base64, so **no Vite WASM plugin config is needed**. |
| **Rapier `Heightfield` collider** | — | One static collider for the entire terrain. O(1) draw/update cost, BVH-accelerated queries, and it consumes the same `Float32Array` the visual mesh is built from — eliminating visual/physics drift. |
| **simplex-noise** | `^4` | Fast, seedable, tree-shakeable 2D/3D noise for fBm terrain, moisture maps and wind. |
| **stats.js** + custom perf HUD | `^0.17` | Non-negotiable: perf budget must be observable from day one. |
| **No asset pipeline** | — | Everything procedural (geometry, colors, noise textures). No GLTF/texture downloads ⇒ tiny payload, fast first paint, no art dependency blocking code agents. |

**Rejected:** React Three Fiber (React reconciler overhead + no benefit for a single-canvas game),
cannon-es (slower, no character controller), Babylon.js (heavier, less familiar to most agents),
PlayCanvas/Unity WebGL (editor-centric, poor multi-agent parallelism).

---

## World Concept

A finite, bounded island — **2048 m × 2048 m** — with a sea around it, so there is no infinite-streaming
complexity but there *is* a horizon full of mountains.

- **Grasslands** (0–60 m): rolling fBm hills, dense instanced grass, wind waves.
- **River valleys**: 3–5 splines flow from peaks to sea, **carved into the heightmap** so valleys are
  real geometry; rendered as scrolling ribbon meshes with a fake-refraction water shader.
- **Mountains** (120–400 m): ridged multifractal noise, exposed rock on slopes > 38°.
- **Snow** (> 220 m, slope-modulated): brighter, high-specular, blizzard weather above the line.
- **Sea level = 0 m.** Falling below is survivable and swim-less — you just wade at a crawl.

---

## Architecture

### Runtime model

A single `Engine` owns the renderer/scene/clock and drives an ordered array of **`System`** objects.
Every feature is a `System`. Systems never import each other — they communicate through the
`GameContext` (shared services) and the `EventBus` (fire-and-forget notifications). This is what makes
the workstreams below independently developable.

```
main.ts
  └─ Engine
       ├─ fixed-step accumulator @ 60 Hz  → physics.step() + system.fixedUpdate(1/60)
       └─ variable render frame           → system.update(dt) → renderer.render()

System execution order (fixed):
  PhysicsSystem → WorldSystem → PlayerSystem → CameraSystem → WeatherSystem
  → VegetationSystem → CairnSystem → HudSystem → PhotoModeSystem
```

### Folder structure

```
walking_sim/
├─ index.html
├─ package.json
├─ tsconfig.json
├─ vite.config.ts
├─ README.md
├─ PLAN.md                         ← this file
└─ src/
   ├─ main.ts                      # bootstrap: init Rapier WASM, build ctx, register systems, start
   ├─ core/
   │  ├─ Engine.ts                 # renderer, scene, camera, resize, RAF, fixed-step loop
   │  ├─ System.ts                 # System interface + SystemRegistry
   │  ├─ GameContext.ts            # the shared service container
   │  ├─ EventBus.ts               # typed pub/sub
   │  └─ types.ts                  # ★ ALL SHARED CONTRACTS LIVE HERE
   ├─ config/
   │  └─ world.config.ts           # ★ ALL TUNABLE CONSTANTS LIVE HERE
   ├─ world/
   │  ├─ noise.ts                  # seeded fBm / ridged / domain-warp helpers
   │  ├─ TerrainGenerator.ts       # heights + biome weights + normals → WorldData
   │  ├─ RiverNetwork.ts           # spline generation + heightmap carving + ribbon geometry
   │  ├─ HeightSampler.ts          # bilinear sampling of WorldData (the single source of truth)
   │  ├─ TerrainChunk.ts           # one LOD-able BufferGeometry chunk
   │  └─ WorldSystem.ts            # chunk grid, LOD selection, distant-terrain mesh
   ├─ physics/
   │  ├─ PhysicsSystem.ts          # Rapier world, fixed step, heightfield collider
   │  ├─ CharacterBody.ts          # KinematicCharacterController wrapper
   │  └─ PhysicsDebug.ts           # F1 wireframe of Rapier colliders
   ├─ player/
   │  ├─ InputSystem.ts            # keyboard/mouse → InputState
   │  ├─ PlayerSystem.ts           # movement, jump, stamina, tumble state machine
   │  ├─ PlayerAvatar.ts           # the sphere mesh + trail + lean/wobble visuals
   │  └─ ThirdPersonCamera.ts      # spring-follow orbit cam with obstruction pull-in
   ├─ render/
   │  ├─ TerrainMaterial.ts        # biome-blending shader (onBeforeCompile on MeshStandardMaterial)
   │  ├─ WaterMaterial.ts          # river/sea surface shader
   │  ├─ SkySystem.ts              # sky dome, sun/moon, day-night, fog color driving
   │  └─ VegetationSystem.ts       # instanced grass + rocks around the player
   ├─ features/
   │  ├─ CairnSystem.ts            # place/persist/render cairns + phantom travelers
   │  ├─ WeatherSystem.ts          # timefall rain cells, blizzard, wetness
   │  ├─ ScannerSystem.ts          # Odradek pulse: traversability ring
   │  └─ PhotoModeSystem.ts        # freeze, free cam, grade, PNG export
   ├─ ui/
   │  ├─ HudSystem.ts              # stamina, compass, altitude, hints, toasts
   │  ├─ LoadingScreen.ts
   │  └─ hud.css
   └─ utils/
      ├─ math.ts                   # clamp, lerp, damp, smoothstep, seeded RNG
      └─ Perf.ts                   # stats.js + draw-call/tri counters + budget warnings
```

---

## Shared Contracts (★ frozen after WS0 lands)

These are the interfaces every other workstream codes against. **WS0 must ship these plus working
stub implementations of each, so all other streams can start immediately against the stubs.**
After WS0 merges, `src/core/types.ts` and `src/config/world.config.ts` are **append-only** — no agent
may change an existing signature without announcing it.

```ts
// src/core/types.ts

export interface System {
  readonly name: string;
  init(ctx: GameContext): Promise<void> | void;
  fixedUpdate?(dt: number, ctx: GameContext): void;   // 1/60, physics-locked
  update?(dt: number, ctx: GameContext): void;        // variable, render-locked
  dispose?(): void;
}

export interface GameContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  events: EventBus;
  physics: IPhysics;          // WS2
  world: IWorld;              // WS1
  input: IInput;              // WS3
  player: IPlayerState;       // WS3
  time: TimeState;
}

export interface TimeState { elapsed: number; dt: number; timeOfDay: number; /* 0..1 */ }

/** Biome weights always sum to 1. Order is fixed: grass, rock, snow, sand. */
export type BiomeWeights = [grass: number, rock: number, snow: number, sand: number];

export interface WorldData {
  seed: number;
  size: number;               // metres, square
  resolution: number;         // vertices per side (513)
  heights: Float32Array;      // resolution² , row-major, index = z * res + x
  biomes: Float32Array;       // resolution² * 4, same indexing
  rivers: RiverSpline[];
  seaLevel: number;
}

export interface IWorld {
  readonly data: WorldData;
  /** Bilinear-interpolated height in world space. THE single source of truth. */
  sampleHeight(x: number, z: number): number;
  sampleNormal(x: number, z: number, out?: THREE.Vector3): THREE.Vector3;
  /** Slope in radians, 0 = flat. */
  sampleSlope(x: number, z: number): number;
  sampleBiome(x: number, z: number): BiomeWeights;
  /** Nearest point at/above sea level that is walkable — used for spawns and scatter. */
  findSpawnPoint(rng: () => number): THREE.Vector3;
}

export interface RiverSpline {
  points: THREE.Vector3[];    // ordered peak → sea, y = water surface height
  width: number;
}

export interface IPhysics {
  readonly world: RAPIER.World;
  addHeightfield(data: WorldData): void;
  createCharacter(pos: THREE.Vector3, radius: number, height: number): ICharacterBody;
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxToi: number): RaycastHit | null;
  addStaticTrimesh(geom: THREE.BufferGeometry, pos: THREE.Vector3): number; // returns handle
  removeCollider(handle: number): void;
}

export interface ICharacterBody {
  position: THREE.Vector3;          // read-only view, updated each fixedUpdate
  velocity: THREE.Vector3;
  grounded: boolean;
  groundNormal: THREE.Vector3;
  /** desiredTranslation is a per-step delta in world space. */
  move(desiredTranslation: THREE.Vector3): void;
  teleport(pos: THREE.Vector3): void;
}

export interface InputState {
  move: THREE.Vector2;        // camera-relative, already normalised, x=strafe z=forward
  look: THREE.Vector2;        // delta since last frame
  jump: boolean;              // edge-triggered
  sprint: boolean;            // held
  actions: Set<ActionId>;     // edge-triggered: 'scan' | 'cairn' | 'photo' | 'debug'
}
export interface IInput { readonly state: InputState; }

export interface IPlayerState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  grounded: boolean;
  stamina: number;            // 0..1
  balance: number;            // 1 = steady, 0 = about to fall
  isTumbling: boolean;
  biome: BiomeWeights;
  altitude: number;
}
```

```ts
// src/core/EventBus.ts — event map (append-only)
export interface GameEvents {
  'world:ready':      { data: WorldData };
  'player:spawned':   { position: THREE.Vector3 };
  'player:landed':    { impact: number; biome: BiomeWeights };
  'player:tumbled':   { position: THREE.Vector3 };
  'player:enterBiome':{ biome: 'grass' | 'rock' | 'snow' | 'sand' | 'water' };
  'weather:changed':  { rain: number; snow: number; wind: THREE.Vector2 };
  'cairn:placed':     { position: THREE.Vector3; isGhost: boolean };
  'scan:pulse':       { origin: THREE.Vector3 };
  'photo:toggle':     { active: boolean };
  'hud:toast':        { text: string; ms?: number };
}
```

```ts
// src/config/world.config.ts — every magic number lives here
export const WORLD = {
  seed: 1337,
  size: 2048,
  resolution: 513,        // (2^9)+1 → divides cleanly into 16 chunks of 32 quads
  chunkGrid: 16,          // 16×16 = 256 chunks, 128 m each
  maxHeight: 400,
  seaLevel: 0,
  snowLine: 220,
  rockSlopeDeg: 38,
  riverCount: 4,
} as const;

export const PLAYER = {
  radius: 0.5, height: 1.0,
  walkSpeed: 4.5, sprintSpeed: 8.0, airControl: 0.25,
  jumpSpeed: 6.5, gravity: -22,
  maxSlopeClimbDeg: 47, minSlopeSlideDeg: 52, autoStep: 0.4, snapToGround: 0.35,
  staminaDrainSprint: 0.14, staminaDrainSlope: 0.30, staminaRegen: 0.22,
} as const;

export const CAMERA = {
  distance: 7, height: 2.2, fov: 60, near: 0.1, far: 2600,
  followDamp: 8, rotateDamp: 14, minPitch: -0.55, maxPitch: 1.15, collisionPad: 0.4,
} as const;

export const PERF = {
  maxPixelRatio: 2,
  lodDistances: [140, 320, 700],    // LOD0/1/2/3 switch radii
  distantMeshBeyond: 900,           // single merged low-res mesh past this
  grassRadius: 90, grassPerChunk: 6000,
  budgetDrawCalls: 150, budgetTriangles: 500_000,
} as const;
```

---

## Plan — Workstreams

**Ownership rule:** a file has exactly one owning workstream. If you need a change in someone else's
file, emit an event or add a method to your own interface instead. Do not edit `PLAN.md` except to
tick the DoD checklist.

### WS0 — Foundation & Contracts ⛔ BLOCKING

> Everything else waits on this. Keep it to ~2 hours. Ship stubs, not features.

- **Goal:** a running Vite app that renders a grey plane, a sphere you can already move with arrow
  keys against a *stub* world/physics, and exports every interface above.
- **Creates:** `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `.gitignore`,
  `README.md`, `src/main.ts`, `src/core/*`, `src/config/world.config.ts`, `src/utils/math.ts`,
  `src/utils/Perf.ts`
- **Must ship stub implementations** (so other streams are unblocked): `StubWorld` (flat plane at y=0,
  returns grass biome), `StubPhysics` (kinematic AABB against y=0), `StubInput` (real, it's cheap).
  Put stubs in `src/core/stubs.ts`.
- **Also:** `npm run dev`, `npm run build`, `npm run typecheck` scripts; verify the installed Rapier
  version's init API (`await RAPIER.init()`) actually matches before others depend on it.
- **Acceptance:** `npm run dev` opens a canvas at 60 fps; `npm run typecheck` is clean; a sphere moves
  with arrow keys on a flat plane; `stats.js` panel visible; F1 toggles a debug overlay.
- **Depends on:** nothing. **Blocks:** all.

---

### The following six streams run FULLY IN PARALLEL after WS0.

### WS1 — Terrain Generation & Chunked World

- **Goal:** replace `StubWorld` with a real procedural island: heights, biome weights, carved river
  valleys, chunked LOD meshes, and an exact `sampleHeight` that physics can trust.
- **Creates:** `src/world/noise.ts`, `TerrainGenerator.ts`, `RiverNetwork.ts`, `HeightSampler.ts`,
  `TerrainChunk.ts`, `WorldSystem.ts`
- **Notes:**
  - Generate in a **Web Worker** (`src/world/terrain.worker.ts`) so the loading screen animates; post
    back transferable `Float32Array`s.
  - Island mask: radial falloff so edges fall to sea level — bounds the world without invisible walls.
  - Ridged multifractal for mountains + domain-warped fBm for hills + moisture map for biome blend.
  - Rivers: pick `WORLD.riverCount` high-elevation starts, descend by steepest-gradient walk to sea,
    smooth into a Catmull-Rom spline, then carve a U-valley by distance-to-spline. **Carve before
    computing normals/biomes.**
  - Chunk geometry writes a `aBiome` (vec4) vertex attribute — WS4 consumes it. Do not write colors.
  - LOD by vertex stride (1/2/4/8) with skirts to hide cracks; merged low-res mesh past
    `PERF.distantMeshBeyond`.
- **Acceptance:** island generates in < 1.5 s in-worker; visibly distinct grass/rock/snow zones and
  ≥ 3 rivers reaching the sea; no LOD seams; ≤ 60 terrain draw calls with camera at ground level;
  `sampleHeight` matches rendered geometry within 0.01 m at 1000 random points (write the assertion).
- **Depends on:** WS0. **Consumed by:** WS2 (heightfield), WS4 (attribute), WS5 (scatter).

### WS2 — Physics & Character Body

- **Goal:** real Rapier world, terrain heightfield collider, and a `KinematicCharacterController`
  wrapper that walks slopes, auto-steps, and snaps to ground.
- **Creates:** `src/physics/PhysicsSystem.ts`, `CharacterBody.ts`, `PhysicsDebug.ts`
- **Notes:**
  - `await RAPIER.init()` in `main.ts` before any system init — coordinate the one-line change with WS0.
  - Build the heightfield from `WorldData.heights` **directly** (same array, same resolution) — that is
    the anti-drift guarantee. Rapier heightfields are indexed `[i * (res) + j]`; **verify row/column
    order and scale against `sampleHeight` with a raycast test, this is the #1 bug source.**
  - Configure controller: `setMaxSlopeClimbAngle`, `setMinSlopeSlideAngle`, `enableAutostep`,
    `enableSnapToGround` from `PLAYER` config.
  - Fixed 60 Hz step with an accumulator and a max of 5 catch-up steps (prevents spiral of death).
  - `PhysicsDebug` renders `world.debugRender()` as a `LineSegments`, toggled by F1.
- **Acceptance:** sphere never falls through terrain over a 5-minute automated random-walk; climbs
  ≤ 47° and slides on > 52°; physics step < 1.5 ms; F1 wireframe visually coincides with terrain.
- **Depends on:** WS0 (works against a flat stub heightmap until WS1 lands). **Blocks:** nothing hard.

### WS3 — Input, Player Controller & Third-Person Camera

- **Goal:** the actual feel of the game. Arrow keys move camera-relative, Space jumps, movement is
  responsive but weighted. Camera follows smoothly and never clips into a mountain.
- **Creates:** `src/player/InputSystem.ts`, `PlayerSystem.ts`, `PlayerAvatar.ts`, `ThirdPersonCamera.ts`
- **Notes:**
  - **Bindings:** Arrow keys *and* WASD move; Space jump; Shift sprint; mouse-drag or pointer-lock
    orbit; `Q` scan; `C` cairn; `P` photo; `F1` debug. Gamepad optional.
  - Movement is camera-relative and framerate-independent (`damp`, not `lerp`).
  - Stamina + balance live here and are published on `IPlayerState`; steep slopes drain faster.
    Balance ≤ 0 → `isTumbling`, hand control to a short dynamic-body ragdoll roll, then recover.
    Emit `player:tumbled`.
  - Avatar = icosphere with a subtle rolling rotation proportional to horizontal velocity, a lean into
    slope, and a short motion trail. Sells "walking" without animation.
  - Camera: spring-damped follow + orbit; sphere-cast from player to desired camera position and pull
    in on hit (`CAMERA.collisionPad`); slight FOV punch when sprinting.
- **Acceptance:** controls feel responsive with no visible stutter; camera never ends up inside
  terrain; jump apex/distance stable at 30 fps and 144 fps; stamina bar drains climbing and regens on
  flat ground; tumble triggers on cliffs and always recovers (never soft-locks).
- **Depends on:** WS0 stubs, then WS2's `ICharacterBody`. **Consumed by:** WS6, WS7.

### WS4 — Biome Materials, Sky, Water & Lighting

- **Goal:** the look. This is what makes it feel like a place rather than a tech demo.
- **Creates:** `src/render/TerrainMaterial.ts`, `WaterMaterial.ts`, `SkySystem.ts`, `Lighting.ts`
- **Notes:**
  - Terrain: `MeshStandardMaterial` + `onBeforeCompile` injection blending 4 procedural palettes by the
    `aBiome` attribute, plus triplanar value-noise detail so close-up ground isn't flat, plus a
    `uWetness` uniform (darkens + adds specular) driven by WS6's weather.
  - Sky: gradient dome shader (horizon/zenith/sun-glow) + directional sun + hemisphere light. Sun
    colour/elevation driven by `ctx.time.timeOfDay`; **drive `scene.fog.color` from the horizon colour**
    so distant mountains melt into aerial perspective — this single trick does most of the vista work.
  - Water: one shader for both sea plane and river ribbons — scrolling dual normal-noise, depth-based
    colour ramp (`gl_FragCoord`-based fake depth is fine), fresnel rim, foam band near the shoreline.
  - Keep it all **forward-rendered, no post-processing pass** except the optional grade in WS8. Shadows:
    single directional `PCFSoftShadowMap` at 2048², cascade-free, tight frustum around the player only.
- **Acceptance:** grass/rock/snow transitions read clearly and are slope-aware (snow doesn't stick to
  cliffs); water animates and reads as water; sunrise→night cycle is smooth with no popping; shader
  compile does not stall the first frame > 200 ms.
- **Depends on:** WS0; consumes WS1's `aBiome` attribute (develop against a stub plane with a
  hand-written attribute until WS1 lands).

### WS5 — Vegetation & Scatter

- **Goal:** grass that moves in the wind, rocks, and driftwood — placed by biome, cheap to render.
- **Creates:** `src/render/VegetationSystem.ts`, `src/world/scatter.ts`
- **Notes:**
  - `InstancedMesh` of a 3-plane cross-quad; repopulate only when the player crosses a chunk boundary,
    using a seeded RNG so the same chunk always looks the same.
  - Density from `sampleBiome().grass` × `1 - slope`; none above the snow line or under water.
  - Wind in the vertex shader: `sin(time + worldPos)` bend weighted by vertex height, wind vector from
    `weather:changed`.
  - Rocks: 3 low-poly variants, instanced, random scale/rotation, biased to rock/mountain biomes. Give
    physics colliders (`addStaticTrimesh`) only to rocks within 60 m, rebuilt on chunk change.
  - Alpha-tested (`alphaTest`), **not** alpha-blended — avoids sorting cost and transparency artifacts.
- **Acceptance:** grass within `PERF.grassRadius` at ≥ 6k instances/chunk with ≤ 12 extra draw calls
  and < 2 ms CPU; no visible popping (fade by scale over the last 15 m); repopulation does not hitch.
- **Depends on:** WS1's `IWorld` sampling (stubbable).

### WS6 — Signature Features (the surprises)

- **Goal:** four cheap, high-impact systems that give the world memory, weather, and a reason to look.
- **Creates:** `src/features/CairnSystem.ts`, `WeatherSystem.ts`, `ScannerSystem.ts`, `PhotoModeSystem.ts`

**① The Cairn Network — persistent traces of other travelers.**
Press `C` to stack a glowing cairn where you stand. Cairns persist in `localStorage` keyed by world
seed; on load they rise out of the ground with a thin vertical light beam. To ensure a *first-time*
player still feels the world is inhabited, seed ~15 **phantom cairns** procedurally at scenic points
(local maxima, river confluences, the highest reachable ridge), each with a short generated message
("a traveler rested here"). Walking near one shows the message. This is the emotional core and it
costs almost nothing: an `InstancedMesh` + a JSON blob.

**② Timefall — weather that arrives.**
Rain cells drift across the map on the wind vector. You *see* one coming as a moving wall of haze
before it reaches you. Rain = GPU-instanced streak particles in a box around the camera + fog density
ramp + `uWetness` on terrain. Above `WORLD.snowLine` the same cell becomes a blizzard (slower, larger
flakes, near-whiteout, visibility collapse). Emits `weather:changed`; drives grass wind and stamina.

**③ Odradek Scan — read the land.**
Press `Q` for an expanding ring pulse from the player. Where it passes, terrain is tinted by
traversability (green = walkable, amber = costly, red = will make you fall) using the slope already in
the terrain shader, driven by a `uScanOrigin`/`uScanRadius` uniform. Also pings nearby cairns. One
uniform, one shader branch, enormous perceived depth.

**④ Photo Mode.**
Press `P`: time freezes, HUD hides, camera detaches to free-fly (arrows + Q/E), a filmic grade +
vignette + letterbox applies, and `Enter` downloads a PNG via `renderer.domElement.toBlob`. Costs an
hour, and it is the thing players share.

- **Acceptance:** cairns survive a page reload; a weather cell visibly crosses the map within ~2 min
  and changes ground wetness and visibility; scan pulse renders correctly across chunk boundaries;
  photo mode exports a full-resolution PNG with no HUD in it.
- **Depends on:** WS0 events; WS4's terrain shader uniforms for ① and ③ (coordinate the uniform names
  `uWetness`, `uScanOrigin`, `uScanRadius` in `types.ts` up front); WS3's player state.

### WS7 — HUD, Loading & Perf Tooling

- **Goal:** DOM-based UI (no canvas cost), a loading screen that hides terrain generation, and a perf
  budget that fails loudly.
- **Creates:** `src/ui/HudSystem.ts`, `LoadingScreen.ts`, `hud.css`
- **Notes:** stamina arc, compass strip with cardinal + cairn markers, altitude/biome readout, toast
  queue for `hud:toast`, first-run control hints that fade after 20 s, pause/help overlay on `Esc`.
  Loading screen shows worker progress and a rotating traveler's-log line. Perf panel (F1) shows fps,
  frame ms, draw calls, triangles, physics ms, and turns red past `PERF.budget*`.
- **Acceptance:** HUD costs < 0.3 ms/frame, is fully keyboard-dismissible, scales from 1280×720 to 4K,
  and does not intercept game input.
- **Depends on:** WS0 only. **Fully parallel from minute one.**

---

### WS8 — Integration, Tuning & Performance Pass 🔒 LAST

- **Goal:** delete the stubs, wire the real systems, and make it *feel* good.
- **Touches:** `src/main.ts` (system registration), `world.config.ts` (tuning values only), any file
  with a measured perf problem — coordinate with the owning stream.
- **Tasks:** remove `src/core/stubs.ts`; profile with Chrome DevTools + `Perf.ts`; enforce
  `setPixelRatio(min(dpr, 2))`; verify frustum culling and LOD hysteresis; add a quality dropdown
  (Low/Med/High → pixel ratio, grass density, shadows, fog distance); test Chrome/Firefox/Safari;
  handle WebGL context loss; `vite build` and confirm bundle < 1.5 MB gzipped; write README with
  controls.
- **Acceptance:** the full DoD below passes.
- **Depends on:** WS1–WS7.

---

## Suggested Order

```
       ┌──────────────────────────── WS0 Foundation + stubs (BLOCKING) ────────────────────────────┐
       │                                                                                            │
       ▼                                                                                            ▼
  ┌────────┬────────┬────────┬────────┬────────┬────────┐
  │  WS1   │  WS2   │  WS3   │  WS4   │  WS5   │  WS7   │   ← all six start simultaneously
  │terrain │physics │player  │materials│vegetation│ HUD  │
  └───┬────┴───┬────┴───┬────┴───┬────┴───┬────┴────────┘
      │        │        │        │        │
      └────────┴────────┴───┬────┴────────┘
                            ▼
                          WS6 features   ← needs WS4 uniforms + WS3 player state
                            ▼
                          WS8 integration + perf
```

Soft handshakes worth scheduling early: **WS1 → WS2** (heightfield array layout), **WS1 → WS4**
(`aBiome` attribute name/format), **WS4 → WS6** (shader uniform names). Agree on these in the first
30 minutes; everything else is genuinely independent.

---

## Risks

1. **Physics/visual terrain drift** — Rapier heightfield row/column order and scaling differ from the
   Three.js `PlaneGeometry` convention (which is XY-then-rotated). Getting this wrong means the player
   floats or falls through, and it is very hard to spot visually.
   *Mitigation:* one shared `Float32Array`, an automated assertion comparing `sampleHeight` against a
   physics raycast at 1000 random points (must pass in CI/`npm run typecheck` era test), and the F1
   collider wireframe from day one.
2. **River carving becomes a time sink** — steepest-descent flow + valley carving + ribbon meshing +
   water shader is the most complex single piece here and can eat a whole stream.
   *Mitigation:* timebox to a fixed budget; the fallback ships carved valleys with a flat translucent
   water plane per river segment — visually 80 % of the value for 20 % of the work.
3. **Death by a thousand draw calls** — 256 chunks + grass patches + rocks + rain will blow the 150
   draw-call budget on integrated GPUs long before triangle count matters.
   *Mitigation:* hard budget in `PERF`, perf HUD goes red on breach, merged distant-terrain mesh,
   instancing everywhere, and a Low quality preset that halves grass and disables shadows.

---

## Verification

- `npm run typecheck` clean, `npm run build` succeeds, bundle < 1.5 MB gzipped.
- Automated: 1000-point sampler-vs-raycast agreement test; 5-minute headless random-walk with no
  fall-through and no NaN in player position.
- Manual perf: Chrome DevTools on integrated graphics — ≥ 55 fps at 1080p, frame time < 18 ms,
  draw calls < 150, triangles < 500 k, heap stable over 10 minutes (no leak on chunk repopulation).
- Manual play: reach a snow peak, cross a river, tumble off a cliff and recover, place a cairn,
  reload and see it, survive a timefall cell, export a photo.
- Cross-browser smoke test: Chrome, Firefox, Safari (macOS).

---

## Definition of Done — MVP

- [ ] Loads from a static build in a browser in < 5 s, no console errors.
- [ ] Third-person sphere avatar controllable with **arrow keys**; **Space jumps**; camera follows and
      never clips into terrain.
- [ ] Solid collision with terrain — no fall-through, no floating, slopes climb/slide correctly.
- [ ] Four readable biomes present and visually distinct: **grasslands, mountains, snow, rivers/water**.
- [ ] At least 3 rivers flow from mountains to the sea through geometry-carved valleys.
- [ ] Instanced grass with wind; rocks scattered by biome.
- [ ] Day/night cycle with sun-driven fog and lighting.
- [ ] Stamina + balance system: climbing costs, steep ground can make you tumble, recovery always works.
- [ ] Cairn network: place, persist across reload, phantom cairns seeded for first-time players.
- [ ] Timefall weather: a visible cell crosses the world, wets the ground, becomes a blizzard up high.
- [ ] Odradek scan pulse reads terrain traversability.
- [ ] Photo mode exports a PNG.
- [ ] HUD: stamina, compass, altitude, control hints, pause/help.
- [ ] ≥ 55 fps at 1080p on integrated graphics; draw calls < 150; triangles < 500 k.
- [ ] Quality presets (Low/Medium/High) selectable.
- [ ] README documents controls, architecture, and how to run.
