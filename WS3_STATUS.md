# WS3 — Input, Player Controller & Third-Person Camera: STATUS ✅ COMPLETE

> **What this file is:** the handoff note from WS3 to the streams that consume the player — WS6
> (features) and WS7 (HUD) above all, plus WS8 at integration time. It records the controls, exactly
> what state and events WS3 publishes, what it appended to the shared files, and the two places its
> behaviour is worth knowing about before you build on top of it.

---

## 1. What shipped

| File | Contents |
|---|---|
| `src/player/InputSystem.ts` | Real keyboard / pointer / gamepad → `InputState`. Moved out of `core/stubs.ts` per PLAN.md, semantics preserved, plus pointer lock, gamepad, and visibility-change hardening. |
| `src/player/PlayerSystem.ts` | Locomotion: camera-relative walk/sprint, buffered + coyote-time jump, stamina economy, balance meter, tumble → recover state machine. Publishes `ctx.player`. Owns the avatar. |
| `src/player/PlayerAvatar.ts` | The icosphere: no-slip rolling, lean into slope and speed, tumble spin, fading motion trail. A plain view object, **not** a `System` — see §5. |
| `src/player/ThirdPersonCamera.ts` | Damped orbit boom, obstruction pull-in, terrain-height floor, auto-align behind travel, sprint FOV punch. Registered as the `camera` system. |

`StubInput` and `StubPlayerSystem` in `core/stubs.ts` are now **dead code**. They were left in place —
WS8 deletes that file wholesale — but nothing imports them any more.

---

## 2. Controls

| Input | Action |
|---|---|
| **Arrow keys** / **WASD** | Move (camera-relative) |
| **Space** | Jump — 0.15 s input buffer, 0.12 s coyote grace |
| **Shift** | Sprint (held) |
| **Left-drag** | Orbit the camera |
| **Double-click canvas** | Pointer-lock orbit (Esc releases it, as the browser mandates) |
| **Q / C / P** | `scan` / `cairn` / `photo` actions |
| **F1** | `debug` action (the perf overlay also listens directly) |
| **Esc** | `pause` action |
| Gamepad | Left stick move, right stick look, **A** jump, **RB/RT** sprint. Hot-pluggable; costs one array read per frame when nothing is connected. |

Arrow keys, WASD and the left stick are summed and then clamped, so any of them works alone and
holding two at once cannot exceed full speed.

---

## 3. What WS6 / WS7 can consume

### `ctx.player` (`IPlayerState`)

Written in place every fixed step — capture the object by reference in `init()`, never reassign it.

| Field | Notes |
|---|---|
| `position`, `velocity`, `grounded` | Straight from the character body. |
| `stamina` | 0..1. Drains sprinting and climbing, regenerates walking/standing/tumbling. |
| `balance` | 1 = steady, 0 = falling. |
| `isTumbling` | True only during the tumble itself, **not** during the get-up. |
| `biome` | `BiomeWeights` under the player. |
| `altitude` | **Metres of the player's FEET above sea level** — i.e. `position.y - 1.0`, not the body centre. This is the number a HUD should print. |

**WS3 additions to `IPlayerState`** (appended in `core/types.ts` by declaration merging; all optional,
so nothing that already produced an `IPlayerState` broke). All are written every fixed step, so you
may treat them as present at runtime:

| Field | Notes |
|---|---|
| `horizontalSpeed` | m/s on the XZ plane. |
| `locomotion` | `'idle' \| 'walk' \| 'sprint' \| 'air' \| 'tumble' \| 'recover'` — exported as the type `PlayerLocomotion`. |
| `slope` | Radians of the ground under the player, 0 = flat. |
| `sprinting` | True only while sprint is actually being *applied* (not merely while Shift is down). |
| `wading` | Feet below sea level; movement is slowed to `LOCOMOTION.wadeSpeedScale`. |
| `cameraYaw` | Follow-camera yaw in radians around world Y — the heading for a compass. Written by `ThirdPersonCamera`. |

### Events emitted

Only keys that already existed in `GameEvents` are used — **WS3 did not touch `EventBus.ts`.**

| Event | When |
|---|---|
| `player:spawned` | Once, at the end of `PlayerSystem.init`. |
| `player:landed` | Every ground contact after airtime. `impact` is downward speed in m/s at the moment of contact. |
| `player:tumbled` | Balance hit zero (steep ground, or a landing above `BALANCE.landingImpactThreshold` = 12 m/s). |
| `player:enterBiome` | Dominant biome changed, with hysteresis: it must exceed 0.5 weight, so walking a blend boundary does not spam. Reports `'water'` while wading. |
| `hud:toast` | One line on tumble ("You lost your footing."). |

### Events consumed

`photo:toggle` — while photo mode is active, `PlayerSystem` skips simulation entirely and
`ThirdPersonCamera` stops writing to `ctx.camera`, so WS6 can take the camera over without a fight.
Nothing else needs to be coordinated.

---

## 4. Appends to shared files (announcing, per the append-only rule)

**`src/core/types.ts`** — one block at the end, nothing above it changed:
`PlayerLocomotion`, plus the optional `IPlayerState` fields listed in §3.

**`src/config/world.config.ts`** — four new blocks appended at the end. Nothing was added *inside*
`PLAYER` or `CAMERA`, deliberately, so two workstreams editing this file never touch the same lines.

| Block | Covers |
|---|---|
| `INPUT` | Look sensitivity, gamepad enable/deadzone/look speed. |
| `LOCOMOTION` | Acceleration lambdas, jump buffer + coyote time, sprint gating thresholds, terminal velocity, slope slowdown, wade speed. |
| `BALANCE` | Balance regen/drain, safe and critical slope angles, landing impact thresholds, all tumble/recover timings. |
| `AVATAR` | Mesh detail, render-follow lambda, lean, tumble spin, trail length/interval/fade. |
| `CAMERA_RIG` | Focus height, min distance, pull-in/out lambdas, probe ray count/offset, sprint FOV punch, auto-align tuning. |

**`src/main.ts`** — only the WS3 slot: `new InputSystem()` in place of `new StubInput()`, and
`engine.add(new PlayerSystem())` + `engine.add(new ThirdPersonCamera())` in place of
`StubPlayerSystem`. Registration order is Player → Camera, as PLAN.md requires.

---

## 5. Things worth knowing before you build on this

1. **`PlayerAvatar` is not a `System`.** It is constructed and driven by `PlayerSystem`, which already
   owns every piece of state it needs. Registering it separately would mean duplicating that state or
   inventing a channel between two systems that are the same feature. `PLAN.md` lists it as a WS3
   file, not as a WS3 system, and this is consistent with that.

2. **The camera probe does not start at the player's head.** `IPhysics.raycast` has no
   collider-exclusion parameter, and the camera's focus point sits *inside* the player capsule — so a
   ray from there hits the player at distance 0 every frame and slams the camera to its minimum boom
   length. (This was live for about ten minutes once WS2's real physics replaced `StubPhysics`; the
   analytic stub could not produce it.) The probe therefore starts `PLAYER.height/2 + PLAYER.radius +
   0.15 m` along the boom and adds that offset back to the reported distance. Nothing is missed,
   because the boom is never allowed inside that radius anyway.

   **If WS2 or WS8 later adds an exclusion argument to `IPhysics.raycast`, the constant `PROBE_START`
   in `ThirdPersonCamera.ts` becomes unnecessary and should be removed.**

3. **Two independent anti-clipping mechanisms**, because either alone has a hole: the ray probe
   (catches colliders) and a hard floor at `sampleHeight(camera.xz) + CAMERA.collisionPad` (catches
   the case the probe misses — a boom that passes over a crest and lands underground behind it). Both
   are `typeof`-guarded, so the rig degrades gracefully rather than throwing.

4. **The rig damps the FOCUS, not the camera position.** The boom is then placed rigidly from the
   smoothed focus. Damping the final position instead lets the camera lag *through* a wall on a fast
   direction change, which is exactly the artefact the system exists to prevent.

5. **Movement basis comes from the camera→player vector**, not the camera's forward axis. It stays
   well-defined when the player looks straight down, and it matches what a player perceives as "away
   from me".

6. **Camera auto-align only engages on mostly-forward input** (`|move.x| < 0.35`) and only after half
   a second without pointer input. Movement is camera-relative, so rotating the camera toward a
   sideways velocity rotates the velocity too — a feedback loop that spirals. With forward input the
   velocity already lies along the boom, making it a no-op except when terrain deflects the player,
   which is when the correction is wanted.

7. **A tumble always ends.** `BALANCE.tumbleMaxSeconds` (4 s) is a hard cap independent of whether the
   roll has settled, followed by `BALANCE.recoverSeconds` (0.7 s) of no-input get-up. Verified below.
   Standing back up on ground that is still un-standable re-tumbles you — that is intended (it is a
   cliff), and each tumble carries you further down it, so it terminates.

8. **Out-of-bounds guard.** A non-finite position, or a fall below y = −200, teleports the player back
   to spawn and logs a warning. It should never fire; WS2's own tunnelling backstop sits below it.

---

## 6. Verified acceptance

Measured in a browser against WS0's `StubWorld` (flat plane) with **WS2's real Rapier physics and
character controller**, which landed while WS3 was in flight.

| Criterion | Result |
|---|---|
| Arrow keys move | Walk 4.50 m/s, sprint 8.00 m/s, camera-relative; WASD identical |
| Space jumps | Apex 0.907 m, lands, `grounded` flips correctly |
| Framerate independence | Apex 0.907 m @ 52 fps vs 0.905 m @ 35 fps — **0.2 % difference** |
| Camera follows in third person | Boom holds 7.0 m at rest and while sprinting; no self-collision pull-in |
| Camera never clips | Ray probe + height floor both active; boom clamps to ≥ 1.2 m |
| Sprint FOV punch | 60° → 67.99° at full sprint, back to 60.02° on release |
| Stamina | 1.00 → 0.79 over 1.5 s sprinting; regenerates to 1.00 standing |
| Climbing cost | On an injected 55° slope: speed 4.5 → 1.7 m/s, stamina 1.00 → 0.21 in 3.2 s |
| Balance drains climbing | Same run: balance 1.00 → 0.00 in ~3.5 s, then tumble |
| Hard landing tumbles | 45 m drop → `player:landed` impact 44.4 m/s → `player:tumbled` → recover → idle |
| Tumble always recovers | On a permanently un-standable slope the tumble ended at **4.05 s** (the cap) and control returned 0.75 s later |
| Edge-triggered actions | Q/C/P/F1/Esc each fire exactly once per press; key auto-repeat yields **1** jump edge, not 6 |
| Blur safety | `blur` mid-movement releases every held key; speed → 0 |
| Pointer handling | Left-drag orbits (200 px → 0.70 rad); pointer movement with no button held is ignored |
| Console errors | 0 |
| Perf | 60 fps, 1.10 ms frame, 9 draw calls, physics 0.10 ms |
| Typecheck | Clean across `src/player`, `src/main.ts` and everything WS3 touched |

The slope figures were produced by injecting a fixed 55° ground normal, because `StubWorld` is a flat
plane and WS1's island had not landed. The code path exercised is the production one; only the input
to it was synthesised. **Re-check the balance and stamina tuning once WS1's real terrain exists** —
`BALANCE.safeSlopeDeg` (40°) and `criticalSlopeDeg` (62°) are guesses relative to `PLAYER`'s 47°
climb / 52° slide limits, and they are the two numbers most likely to want a pass in WS8.

---

## 7. Not done / out of scope

- **No footstep audio, no ragdoll skeleton.** PLAN.md's "hand control to a short dynamic-body ragdoll
  roll" is implemented as a momentum-carrying kinematic roll with a visual spin rather than a real
  Rapier dynamic body: it costs nothing, cannot get stuck in geometry, and reads the same at the size
  the avatar is drawn. If WS8 wants a true ragdoll, `stepTumble` is the only method to replace.
- **Third-person only.** No first-person or free-fly mode; WS6 owns the photo-mode camera and WS3
  already yields to it via `photo:toggle`.
- **Touch controls.** Not in the MVP scope.

## 8. Blockers

None for WS3. Two notes for whoever integrates:

- At the time of writing, `npm run build` fails on **other** workstreams' in-flight files
  (`src/render/VegetationSystem.ts`, `WaterMaterial.ts`, `src/world/HeightSampler.ts`,
  `src/world/TerrainChunk.ts`, and an unused import in `src/physics/PhysicsSystem.ts`). Nothing in
  `src/player`, and nothing WS3 appended, is implicated — WS3's scope typechecks clean on its own.
- WS3 has no hard dependency left: it runs against `StubWorld` today and needs no change when WS1's
  island replaces it, because it only ever calls `IWorld.sampleHeight` / `sampleSlope` / `sampleBiome`
  and `ICharacterBody`.
