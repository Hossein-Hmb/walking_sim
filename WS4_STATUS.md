# WS4 — Materials, Sky, Water, Lighting — STATUS

**State:** complete and merged into `main.ts`. `npx tsc --noEmit` passes across the whole
repository. Verified in-browser against WS1's real terrain and WS5's vegetation.

This document is the contract other workstreams read. **WS1** wants the *Terrain material contract*
section; **WS6** wants the *Shared uniform contract* section. Nobody needs to read the shader code.

---

## 1. What shipped

| File | Role |
| --- | --- |
| `src/render/TerrainMaterial.ts` | `createTerrainMaterial(ctx)` — the four-biome ground shader. |
| `src/render/WaterMaterial.ts` | `createWaterMaterial(ctx, kind)`, `createHeightTexture(data)`. |
| `src/render/WaterSystem.ts` | Sea plane + one ribbon mesh per river spline. |
| `src/render/SkySystem.ts` | Sky dome, star field, and the scene's fog/background. |
| `src/render/Lighting.ts` | Sun, moon, hemisphere, ambient, and the tracking shadow cascade. |
| `src/render/skyModel.ts` | The day/night maths. Single source of truth for sun position/colour. |
| `src/render/shaderLib.ts` | Shared GLSL noise (`ws4_fbm2`, `ws4_fbm3`, `ws4_triplanar`, …). |
| `src/render/TerrainPreviewSystem.ts` | Temporary. Self-deletes once WS1's terrain has relief. |

Appended (never rewrote) to shared files: `SKY`, `LIGHT`, `TERRAIN_LOOK`, `WATER` and
`TERRAIN_PREVIEW` blocks in `src/config/world.config.ts`; one key in `TERRAIN_ATTRIBUTES` in
`src/core/types.ts`. In `main.ts`, only the WS4 slot was touched.

`StubSceneSystem` is gone from `main.ts` — its plane, grid, landmark boxes and placeholder lights
are all superseded. The stub file itself was left on disk untouched since WS0 owns it.

---

## 2. Shared uniform contract (WS6: this is your section)

The three uniforms you asked for are live. WS4 binds the *exact objects* from `ctx.uniforms` into
every material it compiles, so writing `.value` reaches all of them with no per-frame bookkeeping
and no import of any WS4 file.

```ts
ctx.uniforms.uWetness.value = 0.8;              // 0 = bone dry, 1 = soaked
ctx.uniforms.uScanOrigin.value.copy(playerPos); // Vector3, world space — mutate, don't replace
ctx.uniforms.uScanRadius.value = 42;            // metres; <= 0 disables the scan entirely
```

**The one rule: mutate `.value`, never reassign the uniform object itself.** Replacing
`ctx.uniforms.uWetness` with a fresh `{ value }` silently disconnects every material, because they
each hold the original reference.

What each one does visually:

- **`uWetness`** — darkens terrain albedo toward `TERRAIN_LOOK.wetDarkening` and drops roughness to
  `wetRoughness`, so wet ground goes dark and glossy. Snow absorbs 35 % as much as soil, so
  snowfields stay bright in rain. Ramp it over a few seconds; an instant jump to 1 looks like a
  bug.
- **`uScanOrigin` / `uScanRadius`** — draws an expanding emissive ring plus a short tint trail
  behind it. The colour encodes traversability from the real per-fragment slope: green under
  `scanWalkableDeg`, amber by `scanCostlyDeg`, red past `scanFallDeg`. Animate the radius outward
  and set it to `-1` when the pulse finishes. The whole block is inside `if (uScanRadius > 0.0)`,
  so an inactive scan costs one uniform branch.

Also bound, already driven by the engine — you can read them, but don't fight them:

- **`uTime`** — seconds since start. `Engine` writes it every frame; water scroll and grass sway
  read it.
- **`uWind`** — `Vector2`, horizontal m/s. WS4 uses it for sea wave drift. **Yours to drive**: it
  is currently a constant `(1, 0)` and nothing else writes it, so your weather system can own it
  outright.

---

## 3. Terrain material contract (WS1: this is your section)

```ts
const material = createTerrainMaterial(ctx);          // ONCE, in WorldSystem.init
const mesh = new THREE.Mesh(chunkGeometry, material); // reuse the same instance for every chunk
```

Share one instance across all chunks. The shader program compiles once, and a per-chunk material
would mean a per-chunk program compile and a stutter every time LOD swaps.

**Attributes**

| Attribute | Type | Required? | Meaning |
| --- | --- | --- | --- |
| `position`, `normal` | — | **required** | Normals must be correct; slope drives rock and snow. |
| `aBiome` | `vec4` | strongly wanted | `[grass, rock, snow, sand]`, should sum to 1. |
| `aRiver` | `float` | optional | 0..1 distance-to-channel mask, 1 = river bed. |
| `aWet` | `float` | optional | 0..1 any other permanently damp ground. |

No UVs, no vertex colours — don't bother generating them. Chunks may be offset with
`mesh.position`; all shading is world-space, so chunk seams are invisible by construction.

**Two gotchas worth ten seconds of your time:**

1. **Never emit `aBiome` exactly `(0, 0, 0, 1)`.** WebGL hands an *unbound* `vec4` attribute that
   precise value, which is how the shader detects "this geometry has no biome data" and falls back
   to an altitude+slope estimate. A genuine pure-sand vertex is indistinguishable from a missing
   attribute. Clamp pure sand to `(0.001, 0, 0, 0.999)`.
2. **`aRiver` is worth supplying even though it's optional.** Without it, damp ground is estimated
   from proximity to sea level — which cannot see a carved river channel sitting 200 m up a
   valley. Those riverbanks will render as ordinary dry grass. Everything else degrades gracefully;
   this one case doesn't.

Slope overrides the biome map in both directions, deliberately: a cliff is bare rock however much
grass your moisture map wanted there, and snow won't cling to a vertical face. So you don't need to
special-case steep ground in your biome generation — send the climate answer and let the shader
handle the geology.

**Rivers.** `WaterSystem` reads `ctx.world.data.rivers` and rebuilds on the `world:ready` event, so
it works whether you generate synchronously or in a worker. A `RiverSpline` needs ordered peak→sea
points whose `y` is the *water surface* height, plus a `width`. Densely clustered points are
deduplicated and the ribbon is resampled by arc length, so a steepest-descent walk that stalls on
flat ground won't tangle the mesh.

---

## 4. Sky, lighting, and performance notes

`skyModel.ts` derives everything from `ctx.time.timeOfDay` (0 = midnight, 0.25 = sunrise,
0.5 = noon, 0.75 = sunset) and is the only reason the sun disc, its shadows, and the sun glitter on
the water can't drift apart. `SkySystem` is its sole writer and must stay registered before
`Lighting` and `WaterSystem`.

Fog colour is taken from the horizon colour, pulled slightly toward the zenith, so distant terrain
dissolves into exactly the sky behind it. Measured across the cycle: `#acc9e5` at noon with a
2300 m far plane, `#d19e98` at dawn, `#9e5b41` at dusk, `#0c152d` at night with the far plane
pulled in to 1200 m.

Budget: four lights, one 55 m shadow cascade that tracks the player, no post-processing, no render
targets, and no downloaded textures — everything is procedural, which is what keeps first paint
inside the 5 s target. Two details that carry more weight than they look: the shadow camera centre
is snapped to the shadow map's texel grid (otherwise every shadow edge crawls as you walk), and the
shadow pass switches off entirely once the sun drops below a usable intensity, saving a full depth
pass for half the cycle.

---

## 5. Blockers

**None.** Nothing is waiting on another workstream.

Two things to be aware of rather than act on:

- **`aRiver` / `aWet` are not yet emitted by WS1's chunk geometry.** The scene looks correct
  without them — the fallback handles coastlines fine — but carved river channels above sea level
  currently render dry. See gotcha 2 above. Purely additive on WS1's side; no WS4 change needed.
- **`TerrainPreviewSystem` is dead weight now** that WS1 ships real terrain with relief. It detects
  that and disposes itself during `init`, so it costs one heightfield scan at startup and nothing
  after. Safe to delete its `engine.add` line whenever someone is tidying `main.ts`.
