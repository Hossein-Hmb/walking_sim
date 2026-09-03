# WS2 — Physics & character body — STATUS

**State:** complete. Real Rapier world, heightfield terrain collider, and kinematic character
controller are live in `main.ts`; `StubPhysics` / `StubCharacterBody` are no longer used.

---

## 1. What shipped

| File | Role |
| --- | --- |
| `src/physics/PhysicsSystem.ts` | Owns the `RAPIER.World`. Implements `IPhysics` + `System`. Registered first, so every later system reads an already-stepped world. |
| `src/physics/CharacterBody.ts` | Implements `ICharacterBody`. Capsule on a position-based kinematic body, driven by Rapier's `KinematicCharacterController`. |
| `src/physics/Heightfield.ts` | Everything that knows Rapier's heightfield layout: the row-major → column-major transpose, the collider factory, `castRayRobust`, and two self-tests. |
| `src/physics/PhysicsDebug.ts` | F1 wireframe — Rapier's `debugRender()` for capsules/rocks plus a hand-built terrain grid windowed around the player. |

`world.config.ts` gained one appended `PHYSICS` block (tunables listed at the bottom of this doc).
`types.ts` needed no changes — the existing `IPhysics` / `ICharacterBody` shapes were sufficient.
`main.ts` changed only in the WS2 slot: `new PhysicsSystem(world)` replaces `new StubPhysics()`.

### Verified behaviour

All from a headless harness against real Rapier (513² island, 2048 m):

- Heightfield index order proven against a synthetic asymmetric linear field — max error 6.1e-6 m.
- `IWorld.sampleHeight` vs physics raycast over 1000 random points: mean 0.0001 m, max 0.0003 m.
- 5-minute (18 000-step) random walk with jumps: no NaN, **0 rescues**, worst penetration −0.016 m
  (i.e. the capsule never entered the terrain at all), 0.067 ms per step.
- Slopes: climbs 20/40/46°, blocked at 50/55/65°, slides on >52°. Matches the `PLAYER` config.
- Auto-steps a 0.28 m ledge; jump apex 0.91 m against a 0.96 m ideal (snap-to-ground is not eating it).
- Heightfield hot-swap (ground raised 50 m under a standing character) recovers in one backstop hit.
- Stale sampler + real collider (the first frames of the real game) produces **zero** false rescues.

`npm run build` is clean: `tsc --noEmit` passes with no errors and Vite builds.

---

## 2. API for WS3 (player controller)

`ICharacterBody` is unchanged from the stub, so player code written against `StubCharacterBody`
keeps working. The contract:

```ts
const body = ctx.physics.createCharacter(spawnPos, PLAYER.radius, PLAYER.height);

// per fixed step:
body.velocity.x = wishX;                 // you own horizontal velocity outright
body.velocity.z = wishZ;
body.velocity.y += PLAYER.gravity * dt;  // you integrate gravity
body.move(tmp.set(body.velocity.x * dt, body.velocity.y * dt, body.velocity.z * dt));
body.tick(dt);                           // optional: maintains timeSinceGrounded

if (body.grounded) { /* ... */ }
```

**`move()` takes a per-step world-space delta, not a velocity.** It resolves that delta against the
world and writes the result into `position`.

`velocity` is a field you own. `move()` only ever *cancels* components the world just refuted:
landing zeroes a downward `velocity.y`, hitting a ceiling zeroes an upward one. It never adds to it.

### Members

| Member | Notes |
| --- | --- |
| `position: Vector3` | Capsule **centre**, matching the stub. Feet are at `position.y - halfExtent`. Read it; do not write it. |
| `velocity: Vector3` | Yours. See above. |
| `grounded: boolean` | Refreshed by every `move()`. |
| `groundNormal: Vector3` | Surface normal under the feet; `(0,1,0)` while airborne. Use it for slope-aware speed or avatar lean. |
| `move(delta)` | The one call that matters. |
| `teleport(pos)` | Bypasses collision, zeroes velocity, and moves the collider *immediately* — safe to `move()` on the same frame. For spawning and tumble recovery. |

### Extras beyond the interface

Cast to `CharacterBody` (or just use them — `createCharacter` returns the real object) if useful:

| Member | Notes |
| --- | --- |
| `jump(speed): boolean` | Sets `velocity.y`, clears `grounded`, and suppresses snap-to-ground for the first frame. Returns `false` if not grounded. Equivalent to doing it by hand, minus the footgun. |
| `halfExtent: number` | `height/2 + radius`. Centre-to-feet distance. |
| `lastMovement: Vector3` | What the last `move()` actually achieved after collisions. Compare with your intended delta to detect walls. |
| `blocked: boolean` | True when the last `move()` was obstructed. |
| `timeSinceGrounded: number` | Seconds airborne, 0 while standing. Drop-in for coyote time; requires calling `tick(dt)`. |
| `rescues: number` | Times the tunnelling backstop fired. **Should stay 0.** If it climbs during normal play, something is wrong — please report rather than working around it. |

### Ordering requirement

`PhysicsSystem` must stay registered before `PlayerSystem`. `move()` assumes `world.step()` has
already flushed last step's `setNextKinematicTranslation` into the collider, so the collider sits
exactly at `position` when the sweep starts. `main.ts` has this right; don't reorder.

### Jump tuning note

Snap-to-ground is disabled for any step with upward motion and re-enabled on the way down. Left on,
it drags the character straight back to the surface it just left and the jump silently does nothing.
If you bypass `jump()` and set `velocity.y` yourself, `move()` still detects the ascent from the
sign of the delta, so it works — `jump()` just makes it explicit.

---

## 3. Heightfield conventions and caveats

Verified empirically against Rapier 0.19.3, not read off the docs. `HEIGHTFIELD_CONVENTION` in
`Heightfield.ts` restates all of this in machine-readable form, and
`probeHeightfieldConvention()` re-proves it at startup against a synthetic asymmetric field.

### The transpose (the important one)

**WS1's `WorldData.heights` is row-major `[z * resolution + x]`. Rapier's heightfield is
column-major.** `packHeightsForRapier()` performs the transpose; `PhysicsSystem.addHeightfield()`
calls it. Nothing else should touch the packed buffer.

Concretely, Rapier reads `heights[i + j * (nrows + 1)]` where:

- `i` (the row index) runs along **+Z**
- `j` (the column index) runs along **+X**

Skip the transpose on a symmetric island and nothing looks wrong — which is exactly why the
convention probe uses a deliberately asymmetric linear field, and why the sampler-agreement test
samples an island whose x and z terms differ.

### `nrows` / `ncols` are quad counts, not vertex counts

`ColliderDesc.heightfield(nrows, ncols, heights, scale)` wants **subdivisions**. For a 513×513
height array you pass `512, 512`, and `heights.length` must be exactly `(nrows+1) * (ncols+1)`.
Getting this wrong does not throw a useful error — it produces `RuntimeError: unreachable` from
inside the WASM module. Rapier copies the height data, so the source `Float32Array` can be reused
or transferred afterwards.

### Queries need a step first

Ray and shape queries return nothing until `world.step()` has run at least once after a collider is
added; the broad-phase structure is built during the step. `addHeightfield()` and
`addStaticTrimesh()` both step internally so callers can query immediately.

### ⚠ Raycast dead band at cell boundaries (Rapier 0.19.3 bug)

A raycast whose x or z lands in a sub-millimetre band on the **negative** side of a cell boundary
reports no hit at all, even though the surface is right there. Measured on a 4 m grid: `x = 0` hits,
`x = +1e-9` hits, `x = -1e-9` through `x = -1e-6` all **miss**, `x = -1e-3` hits again. Contact
generation is unaffected — this is ray queries only.

This is not a curiosity. The character controller's offset parks the player at coordinates like
`-8.98e-8`, so anyone standing near a grid line (the world origin is one) reproduces it every frame.

**Mitigation:** `castRayRobust()` in `Heightfield.ts` retries a missed cast with a +1 mm lateral
nudge. Every ray this workstream issues goes through it, including `IPhysics.raycast`. Measured on
the reproducer: bare Rapier hits 6 of 9 probe offsets, `castRayRobust` hits 9 of 9, and a genuine
off-field miss still correctly returns null.

**If you raycast the terrain from another workstream, use `castRayRobust` or `ctx.physics.raycast`
— do not call `world.castRay` directly.** One consequence: on the retry path, `RaycastHit.point` is
reconstructed from your origin and can sit up to 1.4 mm laterally from the true intersection.

### Bilinear vs triangulated

`IWorld.sampleHeight` bilinearly interpolates a quad; Rapier's heightfield is two triangles per
quad. They differ by up to half the quad's diagonal sag. On the real island this measured
0.0003 m max, far below the 0.01 m tolerance, but it is a real difference, not noise — do not expect
exact equality between `sampleHeight` and a raycast.

### Self-tests

- `probeHeightfieldConvention()` — runs on `init()`. Builds a small asymmetric linear field and
  raycasts it. Catches transpose and axis-mapping errors even when the game world is a flat stub.
- `verifySamplerAgreement(physics, world, n)` — runs on `init()` and again on `world:ready`.
  Compares `sampleHeight` against raycasts at `n` random points. Warns above 0.01 m (interpolation),
  errors above 1.0 m (a genuine convention bug).

Both log to the console. If either one starts complaining after a WS1 change to the heightmap
layout, the transpose in `packHeightsForRapier` is the first place to look.

---

## 4. Other notes

**Terrain has no walls.** The heightfield is a finite patch with nothing outside it; leaving the
footprint means falling forever. `CharacterBody` clamps X/Z to `size/2 - PHYSICS.boundsMargin`
every move. If WS1 ever adds a real ocean floor or boundary geometry, that clamp can go.

**Tunnelling backstop.** If the capsule centre ends up more than `PHYSICS.rescueDepth` (5 m) below
the surface, it is snapped back. Deliberately two-stage: the cheap trigger is `sampleHeight`, but a
trigger is always *confirmed* with a raycast against the actual collider before anything moves. The
sampler and the collider genuinely disagree during the first frames of the game — `PhysicsSystem`
is registered before `WorldSystem`, so the flat stub sampler is live while real terrain may already
be collidable — and a backstop that fights real geometry is worse than no backstop.

**F1 debug.** `PhysicsDebug` subscribes to `debug:toggle`. Rapier's `debugRender()` emits ~1.5
million line segments for a 513² heightfield, which will hang the tab, so the heightfield is
filtered out of that pass and drawn as a hand-built wireframe windowed around the player
(`PHYSICS.debugWireframeRadius`, rebuilt only when the player moves `debugRebuildDistance`). If the
filter ever fails and the segment count exceeds `PHYSICS.debugMaxSegments`, the Rapier pass retires
itself permanently and logs a warning rather than freezing the browser.

**Rapier query filters.** Use `filterExcludeCollider`, not a JS filter predicate. In 0.19.3 the
predicate path silently starts reporting no hits after a few hundred filtered queries. Every
exclusion in this workstream uses the native parameter.

**Perf.** Physics is marked as `physics` in the perf overlay. 0.067 ms/step measured headless
(simulation + character move), against a 16.7 ms frame budget. Heightfield build for 513² is ~10 ms,
which is a visible hitch if WS1 ever rebuilds mid-frame — batch rebuilds if that becomes a pattern.

### `PHYSICS` config block (appended to `world.config.ts`)

| Key | Value | Meaning |
| --- | --- | --- |
| `characterOffset` | 0.02 | Gap kept between capsule and world. >0 for stability. |
| `characterMass` | 80 | kg, only used when pushing dynamic bodies. |
| `autostepMinWidth` | 0.25 | Free width required past a step before auto-stepping onto it. |
| `terrainFriction` | 1.0 | Heightfield collider friction. |
| `rescueDepth` | 5 | Backstop trigger depth below the surface. |
| `boundsMargin` | 2 | How far inside the heightfield edge the character is kept. |
| `debugWireframeRadius` | 56 | Half-width of the F1 terrain wireframe window. |
| `debugMaxSegments` | 40 000 | Hard cap on debug segments. |
| `debugRebuildDistance` | 8 | Player movement before the wireframe window rebuilds. |
| `samplerTestPoints` | 1000 | Agreement-test sample count. |
| `samplerTolerance` | 0.01 | Warn above this (interpolation difference). |
| `samplerConventionThreshold` | 1.0 | Error above this (convention bug). |

---

## 5. Blockers

None. Nothing in WS2 is waiting on another workstream, and nothing here should block WS3.

Two things worth other workstreams' attention rather than blockers:

1. **Raycasts against terrain must go through `ctx.physics.raycast` / `castRayRobust`.** WS3's
   camera collision probes and WS5's placement queries are the likely callers. Direct
   `world.castRay` will intermittently miss (see §3).
2. **`rescues` climbing above 0 during play means a real physics failure.** It is a safety net, not
   a mechanism. If WS3 sees it increment, that is a bug report for WS2, not something to design
   around.
