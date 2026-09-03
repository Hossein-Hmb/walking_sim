# WS7 — HUD, Loading & Perf Tooling: STATUS ✅ COMPLETE

> **What this file is:** the handoff note from WS7. It records what shipped, every event the HUD
> listens for (so the other streams know what to emit to light it up), the append-only additions
> made to shared files, and the two things WS8 still has to wire.
>
> Read §4 if you own WS3, WS6 or WS8 — it is the whole contract.

---

## 1. What shipped

All new files live in `src/ui/`. Nothing else in the tree is owned by WS7.

| File | Contents |
|---|---|
| `src/ui/HudSystem.ts` | the `System`. Compass, stamina ring, readout, hints, toasts, tumble vignette, pause wiring, event subscriptions |
| `src/ui/Compass.ts` | heading strip widget: tick ring, cardinal labels, cairn markers, `bearingDeg` / `cardinalName` helpers |
| `src/ui/PauseOverlay.ts` | the Esc panel: control reference, journey summary, quality presets, focus management |
| `src/ui/LoadingScreen.ts` | full-viewport generation cover: smoothed progress bar, rotating traveler's-log line, self-removal |
| `src/ui/controls.ts` | `CONTROLS` — the one key-binding table the hints and the help panel both read |
| `src/ui/dom.ts` | `el` / `svgEl` / `setText` / `setProp` / `setAttr` / `setClass`, all compare-before-write |
| `src/ui/hud.css` | every rule for all of the above |

**In the game**

- **Loading screen** — covers `index.html`'s static `#boot` shell, driven by `loading:progress`,
  eased so a jump from 40 % to 100 % still reads as motion, and always allowed to visibly reach
  100 % before it fades. Rotating flavour line seeded from `WORLD.seed`.
- **Compass** — 150° strip with 15° ticks, 8 cardinal labels, a `312° NW` numeric readout, and
  diamond markers for cairns (dashed for phantom ones), nearest 6 of up to 32.
- **Stamina ring** — 270° SVG arc, bottom left. Nearly invisible at full and idle; fades in the
  moment it matters, warms to amber under 35 %, goes red under 10 %. A second inner arc appears
  when `balance` drops. One-word state under it: *steady / working / winded / spent / unsteady /
  falling*.
- **Readout** — bottom right: altitude, ground type, distance walked, in-world clock, plus two rows
  that appear only when something is emitting them: sky (`timefall · 5 m/s`) and nearest cairn.
- **Control hints** — bottom centre, fade out 20 s after the world becomes playable.
- **Toasts** — queue for `hud:toast`, capped at 3, oldest evicted.
- **Tumble vignette** — a wash of colour on `player:tumbled`.
- **Pause / help overlay** — Esc or H. Full control reference, journey summary, quality presets,
  resume button. `role="dialog"`, Tab trapped, focus returned to the canvas on close.
- **Perf overlay (F1)** — extended, not replaced. See §3.

---

## 2. Verified acceptance

Measured in Chromium against the live game (WS1–WS5 all landed while WS7 was being built, so this
was tested against real terrain, grass, sky and the real character controller).

| Criterion (PLAN.md WS7) | Result |
|---|---|
| HUD costs < 0.3 ms/frame | yes. Per frame the HUD does exactly one `transform` write; `perf.mark('hud', …)` reads **0.00 ms** in the F1 panel |
| Fully keyboard-dismissible | yes — Esc/H open, Esc/backdrop/resume close, Tab cycles inside the panel only |
| Scales 1280×720 → 4K | yes — one `--u: clamp(11px, 0.42vw + 8px, 18px)` unit, everything else in `em`; no media queries except a short-viewport tidy-up |
| Does not intercept game input | yes — `.hud` computes `pointer-events: none`, `.pause` too while closed |
| Loading screen hides world gen | yes — covers `#boot`, fades out on `loading:done`, never flashes (min 650 ms) |
| Perf panel shows fps/frame/draws/tris/named timers, red past budget | yes — verified showing `veg`, `hud`, `physics` marks and the `quality` note |
| Pause actually pauses | yes — `ctx.time.elapsed` advances **0.0000 s** over 600 ms while paused, `0.5997 s` over 600 ms after resume |
| Toasts / markers / weather / vignette | verified by emitting `cairn:placed` ×4, `weather:changed`, `hud:toast`, `player:tumbled` — toasts capped at 3, 4 markers drawn, sky and cairn rows appeared, vignette flashed |
| Console errors from WS7 | **none** |
| `tsc --noEmit` over WS7 + core + config + utils | clean |
| `vite build` | succeeds — CSS is **8.43 kB (2.70 kB gzipped)** |

---

## 3. Additions to shared files (all append-only, nothing renamed or changed)

1. **`src/core/EventBus.ts` — two new `GameEvents` keys.**
   - `'hud:pause': { paused: boolean }` — the overlay opened or closed.
   - `'quality:changed': { level: QualityLevel }` — a preset was picked, or restored at startup.
   Also adds `QualityLevel` to the existing type-only import.

2. **`src/config/world.config.ts` — two new blocks and two new `PERF` keys.**
   - `HUD` — hint fade delay, toast lifetime/cap, readout refresh rate, compass span, marker caps.
   - `LOADING` — min visible time, fade duration, log interval, easing rate, settle time.
   - `PERF.budgetFps = 55` and `PERF.budgetFrameMs = 18` (the PLAN.md manual-perf targets).

3. **`src/utils/Perf.ts` — extended, per the "WS7 may extend the panel contents" note in WS0_STATUS.**
   `attach`, `mark`, `beginFrame`, `endFrame`, `toggle` and the F1 binding are untouched.
   - New `perf.note(label, value)` for non-timing state (WS7 uses it for the quality preset).
     Unlike `mark`, a note persists until overwritten.
   - fps and frame time are now budgeted too, and each offending line is flagged with a leading
     `!` so it is obvious *which* budget broke rather than just that one did.

4. **`src/main.ts` — the `TODO(WS7)` slot only.** Three statements: construct the `LoadingScreen`,
   `engine.add(new HudSystem())`, and one subscription mapping `hud:pause` to
   `engine.stop()` / `engine.start()`. See §5 for why that last line lives in the bootstrap.

`src/core/types.ts` needed nothing — `QualityLevel` was already there.

---

## 4. Event dependencies — what to emit to light the HUD up

**Consumed (all optional; the HUD degrades to a placeholder when nobody emits).**

| Event | Owner | What it does in the HUD | Status today |
|---|---|---|---|
| `loading:progress` | WS1 / bootstrap | advances the loading bar and its phase label | live |
| `loading:done` | bootstrap | dismisses the loading screen, reveals the HUD, starts the hint timer, **enables the pause key** | live |
| `hud:toast` | anyone | queues a message | live (WS3 emits one on tumble) |
| `player:tumbled` | WS3 | vignette flash (no toast — WS3 already emits its own) | live |
| `player:enterBiome` | WS3 | toast, e.g. *"the snowfield"* | live |
| `cairn:placed` | WS6 | adds a compass marker (dashed if `isGhost`), toast for real cairns, reveals the *cairn* readout row | **not emitted yet** — verified by hand |
| `weather:changed` | WS6 | reveals the *sky* row: `clear` / `timefall` / `blizzard` + wind speed | **not emitted yet** — verified by hand |
| `scan:pulse` | WS6 | promotes the `Q` row in the help panel from "soon" to live | **not emitted yet** |
| `photo:toggle` | WS6 | hides the whole HUD while photo mode is active and blocks the pause key | **not emitted yet** |
| `debug:toggle` | Perf (F1) | updates the pause-panel footer hint | live |

**Emitted.**

| Event | Payload | Who should care |
|---|---|---|
| `hud:pause` | `{ paused }` | anyone with their own timers — WS6's weather cells and WS3's tumble-recovery timer should honour it |
| `quality:changed` | `{ level }` | **WS8** — see §5 |

**Player state read every tick (never written):** `position`, `altitude`, `stamina`, `balance`,
`isTumbling`, `biome`. **World read:** `data.seed`, `data.seaLevel`. **Camera read:**
`getWorldDirection` for the heading.

**A note for WS6 on the "soon" tags:** the help panel dims the `Q`, `C` and `P` rows and tags them
*soon* until it first observes `scan:pulse`, `cairn:placed` or `photo:toggle`. Nothing needs to be
edited when those systems land — emitting once promotes the row. The mechanism is
`ControlBinding.provenBy` in `src/ui/controls.ts`; WS8 may delete the flags outright.

---

## 5. What WS8 has to finish

1. **Make the quality presets do something.** WS7 owns the control, the `localStorage` persistence
   (key `strandfall.quality`, default `medium`) and the restore-on-load — the overlay re-emits
   `quality:changed` once during `init`, so a subscriber added in WS8 gets the stored value on the
   first frame without any extra plumbing. All that is missing is the subscriber that maps
   low/medium/high to pixel ratio, grass density, shadows and fog distance.

2. **Decide where pause lives.** WS7 deliberately does not stop the loop itself — a UI system
   should not own the Engine. The bootstrap currently does:

   ```ts
   events.on('hud:pause', ({ paused }) => (paused ? engine.stop() : engine.start()));
   ```

   That is a hard stop: `requestAnimationFrame` is cancelled, so nothing renders or simulates and
   the last frame stays on screen behind the overlay. `Engine.start()` resets its own clock, so
   resuming produces no dt spike. If WS8 would rather keep rendering while paused (for a blurred
   backdrop, or to keep the sky moving), replace that one line with a flag the systems check.

3. **Two details worth knowing.** The pause key is a direct `window` `keydown` listener rather than
   an `InputState.actions` read, because a stopped Engine never calls `update` — reading it through
   the input state would make the game pausable but not resumable. `InputSystem` still maps Escape
   to the `'pause'` action; nothing consumes it, and it is harmless. Separately, in Chrome the
   Escape that exits pointer lock is swallowed by the browser, so a pointer-locked player needs a
   second press (or `H`) to open the menu.

---

## 6. Blockers / notes

- **None for WS7 itself.** Its own typecheck is clean and `vite build` succeeds.
- **Repo-wide `npm run typecheck` was failing at hand-off, in other workstreams' files** — WS4's
  `TerrainMaterial.ts` (a backtick inside a comment inside a GLSL template literal terminating the
  string) and an unused import in WS2's `PhysicsSystem.ts` were both broken at various points while
  those agents were mid-edit, and WS3's camera threw `castRayRobust is not defined` at one point.
  All transient, all outside WS7's ownership, none touched.
- **`index.html` was not modified.** It still ships the static `#boot` panel, which is correct: it
  is what covers the screen before any JavaScript runs. `LoadingScreen` layers over it and both
  disappear together. If `main.ts` rewrites `#boot` into a fatal-error panel, a `MutationObserver`
  in `LoadingScreen` notices and removes the overlay immediately rather than hiding the error.
- **Not done, deliberately:** no minimap (there is no map in this game by design), no settings
  beyond quality, no photo-mode UI (WS6 owns that; the HUD only gets out of its way), and no
  gamepad hints (`InputSystem` supports pads, but the labels would be guesswork until someone
  decides on a button layout).
