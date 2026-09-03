# WS5 — Vegetation & Scatter: STATUS ✅ COMPLETE

> **What this file is:** the handoff note for WS5. It records what shipped, the measured performance,
> every deviation from `PLAN.md`, and the handful of things WS6 and WS8 need to know before touching
> vegetation. Written in the same spirit as `WS0_STATUS.md` — read §5 if you own another workstream.

---

## 1. What shipped

| File | Owner | Contents |
|---|---|---|
| `src/world/scatter.ts` | **new, WS5** | Deterministic placement: packed instance record, biome/slope/altitude density rules, `generateScatterCell()` |
| `src/render/VegetationSystem.ts` | **new, WS5** | Procedural geometry + materials, wind/fade GLSL injection, cell streaming, instance repacking, rock colliders |
| `src/config/world.config.ts` | shared, **appended only** | New `VEGETATION` block (see §4) |
| `src/main.ts` | shared | One line in the `TODO(WS5)` slot |
| `.ws5-acceptance.ts` | **new, WS5** | 13-assertion headless placement test (not in `tsconfig`'s `include`, so it never affects typecheck or build) |

Nothing else was touched. `src/core/types.ts` needed no additions — the `IWorld` sampling contract
and `ctx.uniforms` were sufficient exactly as WS0 shipped them.

**Three layers, all instanced:**

- **Grass** — 3-plane cross-quad with a procedurally-drawn blade alpha mask, alpha-*tested*, bent by
  a travelling wind wave in the vertex shader, tinted per-instance from a position hash.
- **Rocks** — 3 low-poly boulder variants (hash-displaced icosahedra, baked tilt, flat bottom),
  biased to rock/snow biomes but present in grassland. The nearest ones get physics colliders.
- **Driftwood** — 2 log variants, sand biome only, only within `shoreBand` metres of the waterline.

---

## 2. Measured acceptance

Against WS1's real island (production build, discrete GPU, 1280×720):

| PLAN.md WS5 criterion | Target | Measured |
|---|---|---|
| Grass instances within `PERF.grassRadius` | ≥ 6 000 / chunk | **6 084 / 128 m chunk** at full density; 6 887 live on a grassland slope, 10 080 on flat ground |
| Extra draw calls | ≤ 12 | **7** (4 main pass + 3 rock shadow-pass) |
| CPU cost | < 2 ms | **0.18 ms** per generated cell, ≤ 1 cell most frames; repack ~0.5 ms roughly once a second |
| Visible popping | none | none — fade is pop-free *by construction*, see §3 |
| Repopulation hitch | none | none — generation is wall-clock budgeted at `VEGETATION.cellBudgetMs` |
| Triangles | (within the 500 k budget) | **49 482** for ~7 000 instances |

The 13 assertions in `.ws5-acceptance.ts` all pass: determinism, no grass above the snow line /
under water / on ground past the slope cap, density matching `PERF.grassPerChunk`, rocks 14× denser
on rock than on grass at equal slope, driftwood never inland, and nothing floating.

Shader verification: both compiled programs were queried for active uniforms. The grass program
keeps `uVegTime`, `uVegWind`, `uVegWindParams`, `uVegTintA/B`, `uVegCenter`, `uVegFade`; the
rock/driftwood program keeps only `uVegCenter` and `uVegFade`. Since GLSL strips unused uniforms,
this confirms the wind and tint code really is executing on grass and really is absent elsewhere.

Also verified: builds clean (`npx vite build`), and `tsc --noEmit` reports **zero** errors in any
WS5 file.

---

## 3. The three design decisions worth knowing about

**① One `InstancedMesh` per geometry variant, not per chunk.** Per-chunk meshes would let the GPU
frustum-cull, but they multiply draw calls by the live chunk count and walk straight into PLAN.md's
Risk #3. Every layer is a disc centred on the player, so whole-mesh culling could never fire anyway;
`frustumCulled` is therefore off and the vertex shader eats the instances behind the camera. That is
the right trade at ~7 000 instances and the wrong one at 256 separate meshes.

**② Two independent clocks.** Generating a cell costs thousands of `sampleHeight`/`sampleSlope`/
`sampleBiome` calls, so cells are generated nearest-first under a **wall-clock budget** and cached;
repacking the instance matrices is far cheaper and only runs once the player has moved
`VEGETATION.rebuildEpsilon` metres. Neither ever runs long enough to hitch, and the budget is shared
frame-wide across layers so grass always gets it before rocks.

**③ The fade is pop-free by construction, not by tuning.** The CPU keeps every instance within
`radius + rebuildEpsilon` of the last repack anchor. The shader scales instances to zero over the
last `fadeBand` metres, measured from `uVegCenter`, which tracks the player *every* frame. Because
the anchor and the player differ by at most `rebuildEpsilon`, anything the shader would draw at
non-zero size is guaranteed to already be in the buffer. There is no radius at which an instance can
appear or vanish abruptly — no tuning required, and it stays correct if WS8 changes the radii.

Two smaller ones: the per-instance record is **8 floats, not a 16-float matrix** (every prop is a
Y-rotation plus a scale, so the repack expands it with 16 plain stores and no trigonometry), and
candidates are drawn by **stratified jitter** rather than uniform random — same O(n) cost, far more
even coverage, and none of the expense of a Poisson-disc pass.

---

## 4. Deviations from PLAN.md

All additive. Nothing in anyone else's contract changed.

1. **`VEGETATION` config block (new, appended to `world.config.ts`).** PLAN.md puts grass under
   `PERF` (`grassRadius`, `grassPerChunk`) but says nothing about rocks, driftwood, wind or fade.
   `VEGETATION` holds those; it **reads** `PERF.grassRadius` and `PERF.grassPerChunk` rather than
   restating them, so WS8 can still tune grass from `PERF` alone.
2. **Generation cells are not terrain chunks.** PLAN.md says "repopulate when the player crosses a
   chunk boundary". Grass uses 64 m cells (rocks and driftwood use 128 m) because 128 m of grass is
   ~1 ms of generation in one lump, whereas 64 m cells amortise smoothly. Densities are declared per
   128 m chunk and converted, so `PERF.grassPerChunk` still means exactly what it says.
   Rock **colliders** are still rebuilt on terrain-chunk crossings, as specified.
3. **`MeshLambertMaterial`, not `MeshStandardMaterial`.** Grass is the most fragment-bound thing in
   the scene and PBR buys nothing on a blade of grass. Rocks and driftwood match for consistency.
4. **Wind is read from a private uniform, not `ctx.uniforms.uWind`.** WS0 assigns WS6 as the writer
   of the shared `uWind`, so WS5 never writes it. Instead the system subscribes to
   `weather:changed`, eases toward that vector, and falls back to `ctx.uniforms.uWind.value` until
   WS6 lands. `uTime` **is** the shared object, assigned by reference — the wind animates with zero
   per-frame CPU work.
5. **Rock tilt is baked per variant** rather than randomised per instance, which is what keeps the
   instance record at 8 floats. Variety comes from Y rotation, independent XZ/Y scale, three
   distinct hulls, and a per-instance sink depth that half-buries some boulders.
6. **`quadAspect` (1.7).** Grass tufts are wider than they are tall. Widening a tuft closes the gaps
   between tufts for free, whereas raising `perChunk` costs instances, matrices and bandwidth.

---

## 5. What other agents need to know

**Ownership.** `src/render/VegetationSystem.ts` and `src/world/scatter.ts` are WS5's. The
`VEGETATION` block in `world.config.ts` is WS5's to shape but WS8's to tune.

**WS6 (weather).** Emit `weather:changed` with `wind` as a horizontal m/s vector and the grass will
follow it automatically — no coupling beyond the event. Magnitude drives sway amplitude (saturating
around 2.5 m/s), direction drives the travelling wave. Nothing else in WS5 needs weather.

**WS8 (tuning), the knobs in rough order of impact:**

- `PERF.grassPerChunk` — instance count, linear in cost. Halve it for the Low preset.
- `PERF.grassRadius` — instance count grows with the *square* of this. Buffers resize automatically.
- `VEGETATION.grass.quadAspect` — coverage per tuft; the cheapest way to keep density *looking* high
  while lowering `perChunk`.
- `VEGETATION.grass.alphaTest` / `castShadow` — the fragment-cost levers on weak GPUs.
- `VEGETATION.cellBudgetMs` — smoothness of streaming. Note that at least one cell always generates
  per frame regardless, so this bounds the extra cells, not the first one.
- `VEGETATION.rocks.maxColliders` / `colliderRadius` — physics cost.

**Three things that would break if changed carelessly:**

- The grass geometry is **1 unit tall** and the wind shader uses `position.y` directly as its bend
  weight. Changing the geometry height without changing the shader will scale the wind with it.
- `ScatterRules.maxDensity` must remain a true supremum of `density()`. It sizes the instance
  buffers before a single cell exists; if `density()` can exceed it, instances get silently dropped
  once the buffer fills. All three current rules are bounded by construction (biome weights sum to 1
  and every affinity is ≤ 1).
- Instances are **not** re-placed when the player moves, only re-*packed*. A cell is generated once
  and cached, so placement is stable and reproducible. Anything that changes the terrain under a
  cached cell must invalidate the cache — `world:ready` already does this, which is what makes the
  stub → WS1 swap correct mid-session.

**Cost reporting.** The system publishes `perf.mark('veg', ms)`, so its per-frame cost is on the F1
overlay already.

---

## 6. Known limitations (deliberate, not oversights)

1. **`sampleBiome` allocates.** `IWorld.sampleBiome` returns a fresh 4-tuple, so cell generation
   allocates one array per surviving candidate (~1 500 per cell, ~1 cell per frame). It is well
   inside the nursery and did not register in profiling. If WS1 ever adds an out-parameter overload,
   scatter generation is the one caller that would benefit.
2. **Distant rocks cast unfaded shadows.** Rocks shrink to zero between 186 m and 220 m in the main
   pass, but the stock `MeshDepthMaterial` used for the shadow pass does not carry the fade. This is
   invisible with any sane shadow frustum — WS0/WS4 keep it tight around the player — but it would
   surface if WS4 ever pushed the directional shadow camera past ~186 m.
3. **Grass does not cast shadows.** Alpha-tested shadow casters are expensive and, at this blade
   size, close to invisible. `VEGETATION.grass.castShadow` flips it on if WS8 disagrees.
4. **Driftwood needs a sand biome.** It is correctly absent inland and on WS0's all-grass
   `StubWorld` (beyond a token grassland term); it appears on WS1's beaches.
5. **No LOD within a layer.** Every live instance renders at full geometry. At 6 tris for grass and
   20–80 for a boulder there is nothing worth switching, and the distance fade already removes the
   far ones.
