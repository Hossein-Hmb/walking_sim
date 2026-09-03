# WS6 — Signature Features — STATUS

**State:** complete and registered in `main.ts`. `npm run typecheck` and `npm run build` both pass.
All four features verified in-browser against WS1 terrain, WS3 player, WS4 materials, WS5 vegetation
and WS7 HUD, at a steady 60 fps with a storm overhead (44 draw calls, ~95 k triangles).

This document is what **WS8** reads. Sections 2 (controls) and 5 (integration surface) are the ones
that matter for tuning and polish; nobody needs to read the shaders.

---

## 1. What shipped

| File | Role |
| --- | --- |
| `src/features/CairnSystem.ts` | Cairn network — place with `C`, persisted, phantom travelers, Odradek ping response. |
| `src/features/WeatherSystem.ts` | Timefall — drifting rain cells, approaching haze wall, wetness, high-altitude blizzard. |
| `src/features/ScannerSystem.ts` | Odradek scan — `Q` fires the expanding ring that WS4's terrain shader draws. |
| `src/features/PhotoModeSystem.ts` | Photo mode — `P` freezes time, frees the camera, grades the frame, `Enter` saves a PNG. |

Appended (never rewrote) to shared files: `CAIRN`, `WEATHER`, `SCANNER` and `PHOTO` blocks in
`src/config/world.config.ts`. Nothing in `src/core/types.ts` or `src/core/EventBus.ts` needed
changing — every event and uniform WS6 uses was already declared. In `main.ts`, only the WS6 slot
was touched.

Registration order is load-bearing and is commented at the slot: `WeatherSystem` must run **after**
`SkySystem` (it pulls the fog in on top of the sky's own per-frame write), and `PhotoModeSystem`
must run **last** (it pins `ctx.time` and `uTime` for the frame).

---

## 2. Controls

| Key | Context | Action |
| --- | --- | --- |
| `C` | walking | Stack a cairn 3.2 m ahead of you. Refused while airborne, tumbling, below sea level, or within 9 m of another cairn — each refusal explains itself with a `hud:toast`. |
| `Q` | walking | Fire an Odradek pulse. 300 m sweep at 150 m/s ≈ 2 s, then a 0.4 s cooldown. |
| `P` | anywhere | Enter / leave photo mode. |
| `↑↓←→` / `WASD` | photo mode | Fly (camera-relative). |
| `Q` / `E` | photo mode | Descend / ascend. |
| `Shift` | photo mode | 3.5× boost. |
| drag | photo mode | Look. |
| `Enter` | photo mode | Download a full-resolution PNG. |
| `Escape` | photo mode | Leave photo mode (does **not** open the pause menu — WS7 blocks it while a photo is in progress). |

`Q`, `E`, `Enter` and `Escape` in photo mode are handled by `PhotoModeSystem`'s own `keydown`
listener, deliberately **not** added to WS3's `ActionId` set: they only exist while photo mode is
open, and `Q` already means "scan" outside it. The scanner freezes itself on `photo:toggle` for
exactly that reason, and cancels any pulse in flight so no scan ring appears in a photograph.

---

## 3. The four features, briefly

**Cairn network.** 15 phantom cairns are placed deterministically from the world seed at scenic
sites found by scanning the heightmap — summits, ridge shoulders and river confluences, each at
least `CAIRN.scenicSeparation` (165 m) apart. Yours are added on top, capped at `CAIRN.maxCairns`
(64, oldest of your own forgotten first), and are the
only ones written to `localStorage` (key `strandfall.cairns.<seed>`, versioned; a seed change or a
version bump is a clean slate, and corrupt or out-of-bounds entries are dropped rather than thrown).
Everything rises out of the ground on load in a staggered wave (~2.4 s each, 0.09 s apart), with the
whole set — stones, capstones and beams — drawn in 3 instanced draw calls. Walk within 13 m of one
and it tells you what it was for; an Odradek pulse makes each cairn flare as the ring reaches it,
delayed by its own distance, which is the thing that sells the sweep.

**Timefall.** Three soft-edged discs drift downwind at 17 m/s, crossing the island in about two
minutes, recycling upwind when they leave. One is seeded 1.4 km upwind of spawn so the first storm
is something you watch approach rather than something you wait for. Each cell's boundary is drawn as
a flared open shell — the visible wall of haze. Inside a cell, rain streaks and blizzard flakes are
GPU-animated inside a box that follows the camera (one draw call each), fog is pulled from the sky's
value in toward 620 m (rain) or 95 m (whiteout), and `uWetness` ramps up over a few seconds and dries
off slowly. Above `WORLD.snowLine` the rain becomes snow across a 70 m / 15 m band, snow only wets
the ground a quarter as much as rain, and `weather:changed` reports `clear` / `timefall` / `blizzard`
with a believable 1.7–8.5 m/s surface wind (deliberately a different number from the cell drift
speed).

**Odradek scan.** The system owns nothing visual: it mutates `uScanOrigin` / `uScanRadius` and WS4's
terrain shader draws the ring and the traversability tint. Radius `<= 0` is WS4's "no active scan"
sentinel, so an idle scanner costs one uniform branch per fragment.

**Photo mode.** Time stops (`ctx.time` and `uTime` are pinned every frame, so water, grass and sky
glitter hold exactly as photographed), the camera detaches into a damped free-fly rig clamped to the
island footprint, and a filmic grade — letterbox, vignette, cool shadow toe, slight exposure lift —
is drawn as one full-screen `MultiplyBlending` quad in clip space. That quad is part of the frame
rather than a CSS filter, which is the only reason the exported PNG matches the screen. The HUD is
DOM and never appears in the capture. Verified export: a 785 kB `image/png` named
`strandfall-<seed>-<timestamp>.png`.

---

## 4. Verification notes

- **Cairns:** placed, reloaded, and confirmed re-grounded at the same coordinates with the rise
  animation replaying (sampled 0 → 1 over ~2.4 s with the expected per-index stagger). Spacing,
  water and airborne refusals all toast correctly. `cairn:placed` fires for phantoms on load and for
  each placement.
- **Timefall:** standing in a cell gives `rainAmount` 1.0, `uWetness` 0.79 after 6 s, fog at 620 m,
  and visible streaks. Teleporting to the 271 m summit in the same cell flips it to `snowAmount` 1.0,
  `uWetness` 0.21, fog at 95 m, and the HUD reads `blizzard · 9 m/s`. The haze wall is legible from a
  ridge a kilometre off.
- **Scan:** `Q` emits one `scan:pulse` with the correct origin; radius samples 35 → 222 m over 1.5 s;
  cairns in range schedule pings.
- **Photo mode:** `ctx.time.elapsed` advances 1.2 s in 1.2 s of wall clock while walking and exactly
  0 while photo mode is open; no spurious `photo:toggle` events over a 3 s idle; PNG export confirmed.
- **Performance:** 60.4 fps measured in a full storm; 44 draw calls, 95 k triangles. WS6 adds at most
  8 draw calls total (3 cairn + 5 weather).
- **Console:** clean — no errors or warnings from WS6 across the session.

---

## 5. Integration surface (WS8: this is your section)

**Events emitted.** All four use payload shapes already declared in `EventBus.ts`; none were added.

| Event | Emitted by | When |
| --- | --- | --- |
| `cairn:placed` | `CairnSystem` | Once per cairn on load (`isGhost: true` for phantoms, `false` for yours) and once per placement. |
| `weather:changed` | `WeatherSystem` | Every 1.2 s, or sooner when rain/snow/wind moves by more than `emitDelta`. |
| `scan:pulse` | `ScannerSystem` | On each `Q`, with the world-space origin. |
| `photo:toggle` | `PhotoModeSystem` | On enter and exit. |
| `hud:toast` | `CairnSystem` | Cairn messages and placement refusals. |

**Events consumed.** `photo:toggle` (all four freeze), `scan:pulse` (cairns ping), `world:ready`
(cairns re-ground against the real island — harmless today, correct if the world is ever regenerated).

**Uniforms written**, always by mutating `.value` per WS4_STATUS §2, never by replacing the object:
`uWetness` and `uWind` (weather), `uScanOrigin` / `uScanRadius` (scanner), `uTime` (photo mode, pinned).

**Everything tunable lives in `src/config/world.config.ts`** under `CAIRN`, `WEATHER`, `SCANNER` and
`PHOTO`. Every field is commented with what it does and why it has the value it has. Tuning those
blocks needs no code change; the knobs most likely to want a pass are `WEATHER.curtainOpacity` /
`curtainColor` (how dark an approaching storm reads against the sky), `WEATHER.cellCount` (how often
weather happens at all), `CAIRN.beamNearFadeStart` / `beamNearFadeEnd` (how close you can stand to a
beam before it dissolves), and `PHOTO.letterbox` / `vignetteStrength`.

**Known limitations, all deliberate:**

- The haze wall is a shell of revolution, so its silhouette against the sky is a clean curve rather
  than a ragged one. It reads correctly at distance; at very close range you are inside it and it
  fades out on purpose.
- The scan ring's contrast is entirely WS4's terrain shader (`TERRAIN_LOOK.scan*`). WS6 only supplies
  origin and radius, so if the tint wants to be stronger, that dial is in WS4's block, not this one.
- Photo mode's grade is a multiply pass: it can darken and tint but cannot bloom or lift highlights.
  A real post-processing chain would be a WS8 decision, and would need to keep rendering into the
  same canvas for the PNG export to keep working.
- Cairn storage is per seed. Changing `WORLD.seed` hides your cairns rather than moving them, which
  is the correct behaviour — their coordinates mean nothing on a different island.
