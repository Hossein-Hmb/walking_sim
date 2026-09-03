# WS1 — Terrain Generation & Chunked World — STATUS

Shipped. `StubWorld` is gone; `WorldSystem` is the real `IWorld` and is registered in `main.ts`.

Read the **Handshakes** section if you are WS2, WS4 or WS5 — the array layout and the vertex
attributes are contracts, and one of them (the quad diagonal) is not what the original plan assumed.

---

## Files

| File | Contents |
| --- | --- |
| `src/world/noise.ts` | `makeNoise2D`, `fbm2`, `ridged2`, `warpX`/`warpZ`. Worker-safe. |
| `src/world/TerrainGenerator.ts` | `generateTerrain` — the one function that turns a seed into the island. Also declares the worker message protocol. |
| `src/world/RiverNetwork.ts` | Depression fill, source picking, flow tracing, spline smoothing, valley carving, river mask. |
| `src/world/terrain.worker.ts` | Web Worker wrapper. Streams progress, transfers the buffers back. |
| `src/world/HeightSampler.ts` | The concrete `IWorld`. Every height/normal/slope/biome/river query resolves here. |
| `src/world/TerrainChunk.ts` | Chunk mesh buffers at a chosen LOD stride, skirts, and the anti-drift assertion. |
| `src/world/WorldSystem.ts` | The `System`: generation lifecycle, chunk grid, LOD selection, merged distant mesh. |

Appended to shared files (nothing rewritten):

- `types.ts` — `WorldData.riverMask?`, `IWorld.sampleRiverInfluence?()`, `TERRAIN_ATTRIBUTES.river`.
  All three are optional/additive so `StubWorld` stayed a valid `IWorld` throughout.
- `main.ts` — the WS1 registration slot only.

`src/world/scatter.ts` is WS5's, not ours.

---

## How the terrain works

Generation is one pure function, `generateTerrain(params)`, run inside `terrain.worker.ts`. Per cell:

1. **`shore`** — radial falloff whose radius is perturbed by low-frequency noise, so the circle
   becomes a coastline with bays and headlands. Heights sink to a −38 m sea floor at the rim, which
   bounds the world without invisible walls.
2. **`hills`** — domain-warped fBm, 0–70 m of rolling grassland relief.
3. **`massif`** — a low-frequency mask deciding *where* mountains may exist, so the range clusters.
4. **`bulk` + `ridge`** — mountains are a broad fBm mass with ridged-multifractal crests on top.
5. **Rivers** — traced and carved into `heights` **before** normals and biomes are computed, so the
   valley is real geometry that physics and scatter both see.
6. **Biomes** — `[grass, rock, snow, sand]` from height, slope, moisture and the river mask.

### Two things worth knowing before you retune it

**Mountains are `bulk + ridge`, not ridge alone.** A ridged multifractal scaled straight to
`maxHeight` gives knife edges — the `1 - |noise|` fold has a slope discontinuity, so with the full
320 m on the base octave the crests come out near-vertical. Measured: high ground was 88% steeper
than 46°, so nothing could hold snow and only 0.05% of the map ended up snow-capped. Splitting the
amplitude between a broad `bulk` term and a smaller `ridge` term gives the peaks shoulders. High
ground is now 57% walkable and snow covers 0.8–3.9% depending on seed.

**Long-wavelength fields are computed on a coarse grid.** `shore`, `massif`, `bulk`, the warp offsets
and `moisture` all have wavelengths of 800 m+, so they are evaluated on a `MACRO_STRIDE`-spaced grid
(1/16 the samples) and bilinearly reconstructed. Only `hills`, `ridge` and `detail` are per cell.
That took the noise budget from ~7.1M evaluations to ~3.2M and generation from 2.1 s to ~250 ms, with
no visible difference. If you add a new low-frequency field, put it in `buildMacroField`.

### Rivers

Steepest descent on a raw fBm heightmap stops in the first closed basin, and ad-hoc escapes (ring
search, then "head for the coast anyway") strand the run on a saddle — measured, only 1 of 4 rivers
reached the water. So the heightmap is **depression-filled first** (Barnes' priority flood with an ε
lift, O(n log n), ~40 ms). The filled surface is everywhere ≥ the real terrain and provably has no
interior minima, so descent on it *cannot* get stuck. Water heights still come from real terrain; the
filled surface only chooses the route.

A run that steps onto a channel an earlier river claimed stops there and becomes a **tributary**,
inheriting that trunk's outcome. That is hydrologically right and it stops two ribbons being drawn
down the same channel (which would z-fight). Seed 1337 gives 3 trunks reaching the coast plus 1
tributary; every seed tested gives ≥3 reaching the sea.

### Chunks and LOD

16×16 chunks of 128 m. Level is chosen from the horizontal distance to the chunk's nearest *edge*
(not its centre — standing in the corner of a chunk should still give full detail underfoot), with
24 m of hysteresis so a chunk on a boundary cannot oscillate.

Only levels 0–1 (inside 320 m) get their own `THREE.Mesh`. Everything beyond is concatenated into
**one** merged mesh at its own stride. This matters: `PERF.distantMeshBeyond` is 900 m, so on a 2 km
island most of the 256 chunks are inside it from anywhere — drawing each individually was ~200 draw
calls against PLAN.md's 60-call terrain target. Measured worst case is now **33 draw calls and 68k
triangles** before frustum culling.

Cracks between adjacent levels are hidden by a skirt: each chunk is built as an `(n+2)²` grid whose
outer ring shares the edge vertices' XZ but hangs `skirtDepth` metres lower.

---

## Handshakes

### → WS2 (physics)

**`WorldData.heights`** is `Float32Array(resolution²)`, **row-major**, `index = z * resolution + x`.
World position of vertex `(xi, zi)` is `x = -size/2 + xi * cell`, `z = -size/2 + zi * cell`, where
`cell = size / (resolution - 1)` = 4 m. Same indexing for `biomes` (stride 4) and `riverMask`.

Array **identity never changes.** `WorldSystem` allocates the final-size arrays in its constructor
and copies worker results *into* them, so anything that captured `ctx.world.data.heights` early stays
valid. Rapier copies into WASM memory anyway, so rebuild on `world:ready` — which you already do.

**The quad diagonal is the important part, and it is not bilinear.** `types.ts` describes
`sampleHeight` as "bilinear-interpolated", and `Heightfield.ts` notes that a bilinear-vs-triangulated
disagreement of `(h00 + h11 - h01 - h10)/4` is expected and not a bug. That is no longer necessary:
`sampleHeight` interpolates over **the same two triangles the mesh is built from** (diagonal from
`(x+1, z)` to `(x, z+1)`), and Rapier 0.19.3 turns out to split its quads on that same diagonal.
Measured against a real collider built with your own `createHeightfieldDesc`, over 4000 raycasts on
seed 1337:

| Sampler | Max error vs Rapier | Mean |
| --- | --- | --- |
| `sampleHeight` (triangle) | **0.000186 m** | 0.000039 m |
| `sampleHeightBilinear` | 0.881098 m | 0.015694 m |

So `verifySamplerAgreement` should now come in at float noise, not at the 0.01 m tolerance. **If it
ever reports ~0.1–1 m again, something changed the diagonal** — that is a real bug, not interpolation
error. `sampleHeightBilinear` is still exported for gradients and normals, which genuinely want a
smooth field; never use it for ground contact.

### → WS4 (rendering)

Chunk geometry publishes exactly what `TerrainMaterial.ts` asks for:

- `position` vec3 — **world space** (meshes sit at the origin with an identity matrix)
- `normal` vec3 — central differences at stride 1, so identical at every LOD
- `aBiome` vec4 — `[grass, rock, snow, sand]`, **sums to 1** (max observed error 4.5e-8)
- `aRiver` float — 0 dry → 1 river-bed centre
- **no `uv`, no vertex colours**, as your contract asks

`aBiome` is never exactly `(0,0,0,1)`. Your shader uses that value to detect an unbound attribute and
falls back to procedural biomes; pure sea bed would have hit it exactly, silently disabling the real
biome map, so a 0.002 sliver of grass is always left in the mix.

`WorldSystem` calls your `createTerrainMaterial(ctx)` once and shares the single instance across every
chunk and the merged mesh, so one program is compiled. `setTerrainMaterial(m)` swaps it everywhere if
WS8 wants a cheaper preset.

Rivers are published on `WorldData.rivers` as `THREE.Vector3[]` control points, spring → mouth, `y` =
water surface. Decimated to ≤72 points so your Catmull-Rom resample at `WATER.riverSegments` does not
cut corners. The carve reproduces your `0.65 + 0.35·t` width taper, so the rendered ribbon sits inside
the channel that was cut for it — **if you change that taper, change `WIDTH_TAPER_*` in
`RiverNetwork.ts` to match**, or the water will overflow the bank or leave a dry gutter.

Note that tributary splines end inland at their confluence, not at sea level.

### → WS5 (scatter)

`ctx.world` is the full sampler. `sampleHeight` is exact against rendered geometry, so scattered
objects will not float. `sampleRiverInfluence(x, z)` (0 dry → 1 bed centre) lets you refuse to plant
grass in a channel without re-deriving it from the splines — it is optional on `IWorld`, so keep the
`?.() ?? 0` guard. `findSpawnPoint(rng)` rejection-samples dry, gentle, grass-dominant, out-of-channel
ground. `world:ready` fires after everything is built, which is your cue to invalidate stub-era
scatter.

---

## Measured

Seed 1337, 513² grid, 2048 m island:

| | |
| --- | --- |
| Generation | 253 ms in Node, **274 ms in-browser in the worker** (budget 1.5 s) |
| Height range | −38 m to 297 m |
| Land | 63.6% |
| Snow-dominant | 3.5% |
| Rivers | 4 traced, 4 reach the sea (3 trunks + 1 tributary) |
| River mask coverage | 2.0% of the map |
| Terrain draw calls | 33 worst case, before culling (target ≤ 60) |
| Terrain triangles | 68k worst case (budget 500k) |
| `sampleHeight` vs rendered LOD0 geometry | 6.5e-13 m over 36 000 points (budget 0.01 m) |
| `sampleHeight` vs Rapier collider | 1.9e-4 m over 4000 raycasts |
| LOD churn | 16 level changes over a 400 m walk |

Verified across 10 seeds: generation 200–260 ms, peaks 277–322 m, land 58–65%, snow 0.8–3.9%, ≥3
rivers reaching the sea every time. Deterministic per seed.

A dev-only self-check logs the generation stats, the draw-call count and the sampler-vs-geometry
error to the console on startup, and `console.error`s if the 0.01 m budget is ever breached.

---

## Deviations from PLAN.md

1. **`sampleHeight` is triangle-interpolated, not bilinear** — see the WS2 handshake. This is a
   deliberate contract sharpening: it makes the sampler exact against both the mesh and the collider
   instead of approximately right against neither.
2. **Individual chunk meshes stop at 320 m**, not at `PERF.distantMeshBeyond` (900 m). Necessary to
   meet the 60-draw-call target; the LOD *strides* still follow `PERF.lodDistances` exactly.
3. **`RiverNetwork` emits no ribbon geometry.** PLAN.md listed it here, but WS4's `WaterSystem`
   builds ribbons from the published splines, and two ribbons per river would z-fight. WS1 emits
   splines and the carved channel only.
4. **Rivers may be tributaries.** PLAN.md implies `riverCount` independent runs; joining a trunk is
   both more realistic and avoids overlapping ribbons. ≥3 still reach the coast directly.
5. **Depression filling was added** — not in PLAN.md, but the described steepest-descent walk
   provably cannot work on a noise heightmap without it.

## Blockers

None for WS1. Its files typecheck clean and the app bundles.

⚠ `npm run typecheck` / `npm run build` currently fail on **one line in another workstream's file**:

```
src/features/CairnSystem.ts(358,5): error TS2322: Type 'number' is not assignable to type '1337'.
```

`CairnSystem.seed` is initialised from `WORLD.seed`, and because `WORLD` is `as const` TypeScript
infers the literal type `1337` rather than `number`; assigning `ctx.world.data.seed` (a plain
`number`, unchanged in the shared contract) then fails. Fix is `private seed: number = WORLD.seed`.
Left alone because `src/features/` is not WS1's to edit. `npx vite build` succeeds, so this is purely
a type-level break. The same pattern bit `WorldSystem` and is worth grepping for elsewhere.
