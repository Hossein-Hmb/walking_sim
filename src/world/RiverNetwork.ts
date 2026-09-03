/**
 * src/world/RiverNetwork.ts
 *
 * Contents: the whole river pipeline, operating directly on the raw heightmap —
 *   1. `buildRoutingSurface`: depression-fill the heightmap so every land cell has a downhill path
 *                        to the sea (priority flood). This is what makes tracing infallible.
 *   2. `pickSources`   : choose well-separated high-elevation springs.
 *   3. `traceFlow`     : steepest-descent walk down the routing surface, to the sea or to a
 *                        confluence with an already-traced river.
 *   4. `resampleSpline`: simplify + Catmull-Rom smooth the jagged cell path into a flowing curve.
 *   5. `carve`         : cut a U-shaped valley into the heightmap by distance-to-spline, and
 *                        produce a 0..1 river-influence mask as a by-product.
 *
 * ── Why a routing surface ───────────────────────────────────────────────────
 * A raw fBm heightmap is full of closed basins, and plain steepest descent stops in the first one it
 * meets. Ad-hoc escapes (ring-search for a lower cell, then "head for the coast anyway") get a river
 * *most* of the way and then strand it on a saddle — measured on seed 1337, only 1 of 4 rivers
 * reached the water. So the heightmap is depression-filled first, with Barnes' priority flood: the
 * result is a surface that is everywhere >= the real terrain and provably has no interior minima, so
 * a river routed on it *cannot* get stuck. Water still sits at real terrain height; the filled
 * surface is used only to choose the route.
 *
 * Purpose: PLAN.md requires river valleys to be *real geometry* rather than a decal, so the carving
 * must happen on the same `Float32Array` that both the visual mesh and the Rapier heightfield are
 * built from. Carving therefore runs BEFORE normals and biomes are computed.
 *
 * ── Who renders the water ───────────────────────────────────────────────────
 * Nobody here. WS4's `WaterSystem.buildRiverRibbon` builds the water-surface mesh straight from the
 * published `WorldData.rivers` splines, so this module deliberately does not emit a second ribbon.
 * What it *does* do is match WS4's geometry: the published width and the `0.65 + 0.35·t` taper WS4
 * applies along the ribbon are reproduced in the carve profile, so the rendered water always sits
 * inside the channel that was cut for it.
 *
 * ⚠ Runs inside `terrain.worker.ts`. No three.js — splines leave here as flat `Float32Array`s of
 * xyz triples and become `THREE.Vector3`s on the main thread.
 */

import { clamp01, lerp, smootherstep } from '../utils/math';
import type { Rng } from '../core/types';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Minimum spacing between two river springs, in metres. Keeps the rivers spread around the island. */
const SOURCE_MIN_SEPARATION = 330;
/** A spring must sit at least this fraction of the island's observed peak height. */
const SOURCE_MIN_HEIGHT_FRAC = 0.42;
/** How many springs to try before giving up on hitting `riverCount` successful runs. */
const MAX_SOURCE_CANDIDATES = 28;
/** A run counts as reaching the sea once the terrain under it is this far below sea level. */
const SEA_ARRIVAL_DEPTH = 2.5;
/**
 * Metres the routing surface is lifted per flood step. Any value > 0 guarantees the filled surface
 * strictly decreases toward the sea, which is what makes steepest descent terminate; keeping it tiny
 * means the route through a filled basin still follows the basin's real shape.
 */
const FILL_EPSILON = 0.002;
/** A traced run shorter than this (metres) is discarded and the next spring is tried instead. */
const MIN_RIVER_LENGTH = 320;
/** Tributaries — runs that end at a confluence rather than the coast — are this much narrower. */
const TRIBUTARY_WIDTH_SCALE = 0.72;

/** Water surface sits this far below the original ground line, so the river reads as *in* a channel. */
const RIVER_SINKAGE = 1.1;
/** Depth from water surface down to the carved bed. */
const RIVER_DEPTH = 2.7;
/** How high the valley shoulders rise above the water at the outer edge of the carve. */
const VALLEY_RISE = 12;
/** Valley half-width as a multiple of the river's own width. */
const VALLEY_RADIUS_FACTOR = 4.5;
/** Channel width at the mouth, in metres. Jittered per river so they are not identical. */
const WIDTH_MIN = 13;
const WIDTH_MAX = 18;
/**
 * Lengthwise width taper, `base + gain · t`. These MUST stay equal to the taper WS4 applies in
 * `WaterSystem.buildRiverRibbon` (`halfWidth * (0.65 + 0.35 * t)`); if the two drift apart the
 * rendered water either overflows the carved bank or leaves a dry gutter along it.
 */
const WIDTH_TAPER_BASE = 0.65;
const WIDTH_TAPER_GAIN = 0.35;
/** Spacing of the smoothed spline points used for carving, in metres. */
const SPLINE_SPACING = 7;
/**
 * Control points published on `WorldData.rivers`. WS4 fits a Catmull-Rom curve through *all* of them
 * and resamples it at `WATER.riverSegments` (120) steps, so publishing more points than that makes
 * its ribbon cut corners. Carving still uses the dense spline.
 */
const PUBLISHED_POINTS_MAX = 72;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface RiverParams {
  /** Island side length in metres. */
  size: number;
  /** Heightmap vertices per side. */
  resolution: number;
  seaLevel: number;
  riverCount: number;
}

export interface GeneratedRiver {
  /**
   * Flattened xyz triples, ordered spring → sea, decimated to at most `PUBLISHED_POINTS_MAX`
   * control points. `y` is the water surface height, which descends monotonically and flattens to
   * sea level at the estuary.
   */
  points: Float32Array;
  /** Channel width at the mouth, in metres — the value WS4's ribbon taper is relative to. */
  width: number;
  /** Polyline length in metres. */
  length: number;
  /** True when the run actually made it below sea level. */
  reachedSea: boolean;
}

export interface RiverNetworkResult {
  rivers: GeneratedRiver[];
  /** `resolution²`, row-major. 0 = dry land, 1 = river bed centre. */
  mask: Float32Array;
}

/** One smoothed spline vertex. */
interface SplinePoint {
  x: number;
  z: number;
  /** Water surface height. */
  y: number;
  /** Full channel width in metres at this point. */
  width: number;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Traces, smooths and carves the whole river network. **Mutates `heights` in place.**
 *
 * @param heights - `resolution²` row-major heightmap, `index = z * resolution + x`.
 * @param params - Island dimensions and the desired river count.
 * @param rng - Deterministic RNG; only used for width jitter, so the network is reproducible.
 * @returns The published splines and a river-influence mask over the same grid.
 *
 * @complexity Time: O(n log n) for the one-off depression fill (n = resolution²), then
 * O(riverCount × pathLength × valleyArea) for tracing and carving. Space: O(resolution²) for the
 * routing surface plus four scratch grids.
 */
export function buildRiverNetwork(
  heights: Float32Array,
  params: RiverParams,
  rng: Rng,
): RiverNetworkResult {
  const { resolution: res, size, seaLevel } = params;
  const cells = res * res;
  const cell = size / (res - 1);
  const half = size * 0.5;

  const mask = new Float32Array(cells);
  const rivers: GeneratedRiver[] = [];

  // Nearest-river bookkeeping, filled by every carve pass and applied once at the end. Recording
  // the *nearest* spline instead of carving immediately stops two rivers that run close together
  // from double-carving a trench twice as deep as either one wants.
  const nearDist = new Float32Array(cells).fill(Infinity);
  const nearSurface = new Float32Array(cells);
  const nearWidth = new Float32Array(cells);

  const routing = buildRoutingSurface(heights, res, seaLevel);

  // Which cells an accepted river already occupies. A later run that steps onto one of these has
  // found a confluence: it stops there and inherits that trunk's fate, which is both hydrologically
  // right and stops two ribbons from being drawn down the same channel (WS4 would z-fight).
  const claim = new Uint8Array(cells);
  const sources = pickSources(heights, res, cell, seaLevel);

  for (const source of sources) {
    if (rivers.length >= params.riverCount) break;

    const path = traceFlow(heights, routing, res, seaLevel, source, claim);
    if (path.cells.length < 12) continue;

    const spline = resampleSpline(path.cells, heights, res, cell, half, seaLevel, rng, path.tributary);
    if (spline.length < 4) continue;
    const length = splineLength(spline);
    // Reject stubs *before* claiming any ground, so a better spring can still use this valley.
    if (length < MIN_RIVER_LENGTH) continue;

    for (const ci of path.cells) claim[ci] = path.reachedSea ? CLAIM_TO_SEA : CLAIM_STRANDED;
    accumulateCarve(spline, nearDist, nearSurface, nearWidth, res, cell, half);

    rivers.push({
      points: publishControlPoints(spline),
      width: spline[spline.length - 1]!.width,
      length,
      reachedSea: path.reachedSea,
    });
  }

  applyCarve(heights, mask, nearDist, nearSurface, nearWidth);
  return { rivers, mask };
}

// ---------------------------------------------------------------------------
// 1. Routing surface (depression filling)
// ---------------------------------------------------------------------------

/** `claim` grid values. */
const CLAIM_FREE = 0;
const CLAIM_TO_SEA = 1;
const CLAIM_STRANDED = 2;

/**
 * Depression-fills the heightmap (Barnes/Planchon priority flood with an ε lift) to produce a
 * *routing* surface: pointwise >= `heights`, with no interior local minima.
 *
 * Every cell at or below sea level, plus the whole map border, is a seed and keeps its real height.
 * The flood then grows inland from the lowest frontier cell outward, assigning
 * `filled[n] = max(heights[n], filled[parent] + ε)`. Because a cell is always resolved from a
 * strictly lower parent, following the steepest descent of `filled` from anywhere is guaranteed to
 * reach a seed — no pit escapes, no uphill fallbacks, no step limits.
 *
 * @param heights - Raw heightmap, `resolution²`, row-major. Not modified.
 * @param res - Vertices per side.
 * @param seaLevel - Cells at or below this are flood seeds.
 * @returns A new `resolution²` surface for routing only. Water heights still come from `heights`.
 *
 * @complexity Time: O(n log n) — each of the `res²` cells is pushed and popped exactly once from a
 * binary heap. Space: O(n) — one Float32Array, one Uint8Array and a `res²` heap.
 */
function buildRoutingSurface(heights: Float32Array, res: number, seaLevel: number): Float32Array {
  const cells = res * res;
  const filled = new Float32Array(cells);
  const resolved = new Uint8Array(cells);

  // Explicit binary min-heap over (key, cellIndex). Every cell is pushed at most once — it is marked
  // resolved as it is pushed — so `cells` slots is an exact upper bound.
  const heapKey = new Float32Array(cells);
  const heapCell = new Int32Array(cells);
  let heapSize = 0;

  function push(cellIndex: number, key: number): void {
    let c = heapSize++;
    heapKey[c] = key;
    heapCell[c] = cellIndex;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heapKey[p] <= heapKey[c]) break;
      const tk = heapKey[p];
      const tc = heapCell[p];
      heapKey[p] = heapKey[c];
      heapCell[p] = heapCell[c];
      heapKey[c] = tk;
      heapCell[c] = tc;
      c = p;
    }
  }

  function pop(): number {
    const top = heapCell[0];
    heapSize--;
    if (heapSize > 0) {
      heapKey[0] = heapKey[heapSize];
      heapCell[0] = heapCell[heapSize];
      let c = 0;
      for (;;) {
        const l = c * 2 + 1;
        if (l >= heapSize) break;
        const r = l + 1;
        let s = r < heapSize && heapKey[r] < heapKey[l] ? r : l;
        if (heapKey[s] >= heapKey[c]) break;
        const tk = heapKey[s];
        const tc = heapCell[s];
        heapKey[s] = heapKey[c];
        heapCell[s] = heapCell[c];
        heapKey[c] = tk;
        heapCell[c] = tc;
        c = s;
      }
    }
    return top;
  }

  // Seeds: the ocean, and the border (belt-and-braces — the island mask already sinks the rim).
  for (let z = 0; z < res; z++) {
    const row = z * res;
    const borderRow = z === 0 || z === res - 1;
    for (let x = 0; x < res; x++) {
      const i = row + x;
      if (!borderRow && x !== 0 && x !== res - 1 && heights[i] > seaLevel) continue;
      resolved[i] = 1;
      filled[i] = heights[i];
      push(i, heights[i]);
    }
  }

  while (heapSize > 0) {
    const c = pop();
    const floor = filled[c] + FILL_EPSILON;
    const cx = c % res;
    const cz = (c - cx) / res;
    const zLo = cz > 0 ? -1 : 0;
    const zHi = cz < res - 1 ? 1 : 0;
    const xLo = cx > 0 ? -1 : 0;
    const xHi = cx < res - 1 ? 1 : 0;

    for (let dz = zLo; dz <= zHi; dz++) {
      const nrow = (cz + dz) * res;
      for (let dx = xLo; dx <= xHi; dx++) {
        if (dx === 0 && dz === 0) continue;
        const n = nrow + cx + dx;
        if (resolved[n]) continue;
        resolved[n] = 1;
        const h = heights[n];
        const value = h > floor ? h : floor;
        filled[n] = value;
        push(n, value);
      }
    }
  }

  return filled;
}

// ---------------------------------------------------------------------------
// 2. Source selection
// ---------------------------------------------------------------------------

interface Cell {
  x: number;
  z: number;
}

/**
 * Picks candidate springs: the highest cells on the map, greedily thinned so no two are within
 * `SOURCE_MIN_SEPARATION` metres. Scanning on a stride keeps this cheap and, because it is a
 * deterministic descending-height sweep, it is fully reproducible for a given seed.
 *
 * @complexity Time: O(resolution² / stride² · log n + candidates²) | Space: O(candidates)
 */
function pickSources(heights: Float32Array, res: number, cell: number, seaLevel: number): Cell[] {
  let peak = -Infinity;
  for (let i = 0; i < heights.length; i++) if (heights[i] > peak) peak = heights[i];
  const threshold = seaLevel + (peak - seaLevel) * SOURCE_MIN_HEIGHT_FRAC;

  const stride = 3;
  const candidates: Array<Cell & { h: number }> = [];
  // Stay one full valley-width away from the map edge so a spring is never in the surf.
  const margin = 6;
  for (let z = margin; z < res - margin; z += stride) {
    for (let x = margin; x < res - margin; x += stride) {
      const h = heights[z * res + x];
      if (h >= threshold) candidates.push({ x, z, h });
    }
  }
  candidates.sort((a, b) => b.h - a.h);

  const minSepSq = (SOURCE_MIN_SEPARATION / cell) ** 2;
  const picked: Cell[] = [];
  for (const c of candidates) {
    if (picked.length >= MAX_SOURCE_CANDIDATES) break;
    let ok = true;
    for (const p of picked) {
      if ((p.x - c.x) ** 2 + (p.z - c.z) ** 2 < minSepSq) {
        ok = false;
        break;
      }
    }
    if (ok) picked.push({ x: c.x, z: c.z });
  }
  return picked;
}

// ---------------------------------------------------------------------------
// 3. Flow tracing
// ---------------------------------------------------------------------------

interface FlowPath {
  /** Row-major cell indices, ordered spring → mouth. */
  cells: number[];
  /** True when the water gets to the sea, either directly or by joining a trunk that does. */
  reachedSea: boolean;
  /** True when the run ended at a confluence rather than at the coast. */
  tributary: boolean;
}

/**
 * Walks from a spring to the sea by steepest descent on the depression-filled routing surface.
 *
 * Because `routing` provably has no interior minima, a strictly lower neighbour always exists until
 * the run reaches the ocean or the map edge — so this is a single unconditional loop with no pit
 * handling. It ends early if it meets a channel an earlier river already claimed, which turns the
 * network into a proper set of trunks and tributaries.
 *
 * @param heights - Real terrain, for the sea-arrival test and the published water heights.
 * @param routing - Depression-filled surface from `buildRoutingSurface`; drives the route only.
 * @param res - Vertices per side.
 * @param seaLevel - Sea level in metres.
 * @param source - Spring cell.
 * @param claim - Cells already taken by accepted rivers (`CLAIM_*`). Not modified here.
 *
 * @complexity Time: O(pathLength), 8 neighbour tests per step | Space: O(pathLength)
 */
function traceFlow(
  heights: Float32Array,
  routing: Float32Array,
  res: number,
  seaLevel: number,
  source: Cell,
  claim: Uint8Array,
): FlowPath {
  const cellsOut: number[] = [];
  // Descent is strictly monotonic in `routing`, so a cell can never repeat; this bound only guards
  // against a pathological heightmap (all-NaN, say) rather than against cycles.
  const maxSteps = res * 8;
  let cx = source.x;
  let cz = source.z;

  for (let step = 0; step < maxSteps; step++) {
    const ci = cz * res + cx;
    cellsOut.push(ci);

    if (heights[ci] <= seaLevel - SEA_ARRIVAL_DEPTH) {
      return { cells: cellsOut, reachedSea: true, tributary: false };
    }
    // Confluence: adopt the trunk's outcome and stop, so we do not re-carve its channel.
    if (step > 0 && claim[ci] !== CLAIM_FREE) {
      return { cells: cellsOut, reachedSea: claim[ci] === CLAIM_TO_SEA, tributary: true };
    }

    const here = routing[ci];
    let best = -1;
    let bestValue = here;
    const zLo = cz > 0 ? -1 : 0;
    const zHi = cz < res - 1 ? 1 : 0;
    const xLo = cx > 0 ? -1 : 0;
    const xHi = cx < res - 1 ? 1 : 0;
    for (let dz = zLo; dz <= zHi; dz++) {
      const nrow = (cz + dz) * res;
      for (let dx = xLo; dx <= xHi; dx++) {
        if (dx === 0 && dz === 0) continue;
        const ni = nrow + cx + dx;
        if (routing[ni] < bestValue) {
          bestValue = routing[ni];
          best = ni;
        }
      }
    }
    if (best < 0) break; // only reachable at a border seed, i.e. already at the map edge
    cx = best % res;
    cz = (best - cx) / res;
  }

  return { cells: cellsOut, reachedSea: false, tributary: false };
}

// ---------------------------------------------------------------------------
// 4. Spline smoothing
// ---------------------------------------------------------------------------

/**
 * Turns the jagged cell path into a smooth, strictly-descending spline of world-space points.
 *
 * Steps: trim the tail once it is well out to sea → convert to world space → force a monotonic
 * descent (water cannot flow uphill, and the raw path can step sideways across a saddle) →
 * decimate to control points → uniform Catmull-Rom resample at `SPLINE_SPACING` → assign widths
 * that grow toward the mouth → clamp the surface to sea level so the estuary sits flat.
 *
 * @complexity Time: O(pathLength) | Space: O(pathLength)
 */
function resampleSpline(
  pathCells: number[],
  heights: Float32Array,
  res: number,
  cell: number,
  half: number,
  seaLevel: number,
  rng: Rng,
  tributary: boolean,
): SplinePoint[] {
  // Trim: stop a few points after the path is convincingly underwater.
  let end = pathCells.length;
  for (let i = 0; i < pathCells.length; i++) {
    if (heights[pathCells[i]!] <= seaLevel - SEA_ARRIVAL_DEPTH) {
      end = Math.min(pathCells.length, i + 5);
      break;
    }
  }

  const raw: SplinePoint[] = [];
  let running = Infinity;
  for (let i = 0; i < end; i++) {
    const ci = pathCells[i]!;
    const gx = ci % res;
    const gz = (ci - gx) / res;
    // Monotonic descent with a small guaranteed drop per cell, so the ribbon always flows.
    running = Math.min(running, heights[ci] - 0.02 * i);
    raw.push({ x: -half + gx * cell, z: -half + gz * cell, y: running, width: 0 });
  }
  if (raw.length < 4) return [];

  // Decimate to control points; ~10 cells apart is enough to keep the route but drop the staircase.
  const controls: SplinePoint[] = [];
  const decimation = 8;
  for (let i = 0; i < raw.length; i += decimation) controls.push(raw[i]!);
  const last = raw[raw.length - 1]!;
  if (controls[controls.length - 1] !== last) controls.push(last);
  if (controls.length < 4) return [];

  // Uniform Catmull-Rom resample.
  const out: SplinePoint[] = [];
  const n = controls.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = controls[Math.max(0, i - 1)]!;
    const p1 = controls[i]!;
    const p2 = controls[i + 1]!;
    const p3 = controls[Math.min(n - 1, i + 2)]!;
    const segLen = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const steps = Math.max(1, Math.round(segLen / SPLINE_SPACING));
    const lastSegment = i === n - 2;
    for (let s = 0; s < steps + (lastSegment ? 1 : 0); s++) {
      const t = s / steps;
      out.push({
        x: catmullRom(p0.x, p1.x, p2.x, p3.x, t),
        z: catmullRom(p0.z, p1.z, p2.z, p3.z, t),
        y: catmullRom(p0.y, p1.y, p2.y, p3.y, t),
        width: 0,
      });
    }
  }
  if (out.length < 4) return [];

  // Smoothing can re-introduce tiny uphill wiggles; flatten them and drop to the water surface.
  const mouthWidth = (WIDTH_MIN + rng() * (WIDTH_MAX - WIDTH_MIN)) * (tributary ? TRIBUTARY_WIDTH_SCALE : 1);
  let surface = Infinity;
  for (let i = 0; i < out.length; i++) {
    const p = out[i]!;
    surface = Math.min(surface, p.y - RIVER_SINKAGE);
    // Estuaries are flat: once we hit the sea, the surface stops descending.
    p.y = Math.max(surface, seaLevel + 0.05);
    const t = i / (out.length - 1);
    p.width = mouthWidth * (WIDTH_TAPER_BASE + WIDTH_TAPER_GAIN * t);
  }
  return out;
}

/** Uniform Catmull-Rom basis on four scalars. */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

function splineLength(spline: SplinePoint[]): number {
  let len = 0;
  for (let i = 1; i < spline.length; i++) {
    len += Math.hypot(spline[i]!.x - spline[i - 1]!.x, spline[i]!.z - spline[i - 1]!.z);
  }
  return len;
}

/**
 * Decimates the dense carving spline down to the control points published on `WorldData.rivers`,
 * always keeping the spring and the mouth. Consumers (WS4's ribbon, WS6's scenic cairn placement)
 * re-smooth these, so fewer, well-spread points beat many crowded ones.
 *
 * @complexity Time: O(points) | Space: O(min(points, PUBLISHED_POINTS_MAX))
 */
function publishControlPoints(spline: SplinePoint[]): Float32Array {
  const step = Math.max(1, Math.ceil(spline.length / PUBLISHED_POINTS_MAX));
  const kept: SplinePoint[] = [];
  for (let i = 0; i < spline.length; i += step) kept.push(spline[i]!);
  const last = spline[spline.length - 1]!;
  if (kept[kept.length - 1] !== last) kept.push(last);

  const out = new Float32Array(kept.length * 3);
  for (let i = 0; i < kept.length; i++) {
    const p = kept[i]!;
    out[i * 3] = p.x;
    out[i * 3 + 1] = p.y;
    out[i * 3 + 2] = p.z;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. Valley carving
// ---------------------------------------------------------------------------

/**
 * Records, for every grid cell inside this river's valley footprint, the distance to the spline and
 * the water surface / width at the closest point. Only the *nearest* river wins each cell.
 *
 * @complexity Time: O(splineSegments × valleyFootprintCells) | Space: O(1) (writes into the caller's grids)
 */
function accumulateCarve(
  spline: SplinePoint[],
  nearDist: Float32Array,
  nearSurface: Float32Array,
  nearWidth: Float32Array,
  res: number,
  cell: number,
  half: number,
): void {
  for (let s = 0; s < spline.length - 1; s++) {
    const a = spline[s]!;
    const b = spline[s + 1]!;
    const reach = Math.max(a.width, b.width) * VALLEY_RADIUS_FACTOR;

    const minX = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach + half) / cell));
    const maxX = Math.min(res - 1, Math.ceil((Math.max(a.x, b.x) + reach + half) / cell));
    const minZ = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach + half) / cell));
    const maxZ = Math.min(res - 1, Math.ceil((Math.max(a.z, b.z) + reach + half) / cell));

    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const lenSq = ex * ex + ez * ez;
    if (lenSq < 1e-9) continue;

    for (let gz = minZ; gz <= maxZ; gz++) {
      const wz = -half + gz * cell;
      for (let gx = minX; gx <= maxX; gx++) {
        const wx = -half + gx * cell;
        const t = clamp01(((wx - a.x) * ex + (wz - a.z) * ez) / lenSq);
        const d = Math.hypot(wx - (a.x + ex * t), wz - (a.z + ez * t));
        if (d > reach) continue;
        const i = gz * res + gx;
        if (d >= nearDist[i]) continue;
        nearDist[i] = d;
        nearSurface[i] = lerp(a.y, b.y, t);
        nearWidth[i] = lerp(a.width, b.width, t);
      }
    }
  }
}

/**
 * Applies the accumulated valley profile to the heightmap and fills the river-influence mask.
 *
 * Profile at distance `d` from the channel centreline:
 *   bed      = surface − depth, easing back up to the surface by `1.35 × bedRadius`
 *   shoulder = 0 at the bed edge, rising to `VALLEY_RISE` at the valley rim
 *   blend    = 1 in the channel → 0 at the rim, so the carve fades into the untouched terrain
 * Only ever lowers terrain (`min(h, desired)`), which keeps ridgelines outside the valley intact.
 *
 * @complexity Time: O(resolution²) | Space: O(1)
 */
function applyCarve(
  heights: Float32Array,
  mask: Float32Array,
  nearDist: Float32Array,
  nearSurface: Float32Array,
  nearWidth: Float32Array,
): void {
  for (let i = 0; i < heights.length; i++) {
    const d = nearDist[i];
    if (!Number.isFinite(d)) continue;
    const width = nearWidth[i];
    const bedRadius = width * 0.5;
    const valleyRadius = width * VALLEY_RADIUS_FACTOR;
    if (d > valleyRadius) continue;

    const surface = nearSurface[i];
    const bed = surface - RIVER_DEPTH * (1 - smootherstep(0, bedRadius * 1.35, d));
    const shoulder = VALLEY_RISE * smootherstep(bedRadius, valleyRadius, d);
    const desired = bed + shoulder;
    const blend = 1 - smootherstep(bedRadius * 0.85, valleyRadius, d);

    const h = heights[i];
    heights[i] = lerp(h, Math.min(h, desired), blend);
    const influence = 1 - smootherstep(bedRadius, bedRadius * 2.4, d);
    if (influence > mask[i]) mask[i] = influence;
  }
}

/** Exposed so the generator's stats block can report how much of the network reached the sea. */
export function countRiversReachingSea(rivers: readonly GeneratedRiver[]): number {
  let count = 0;
  for (const r of rivers) if (r.reachedSea) count++;
  return count;
}
