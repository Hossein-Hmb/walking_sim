/**
 * src/world/WorldSystem.ts
 *
 * Contents: `WorldSystem` — the WS1 entry point. It is simultaneously
 *   - the `IWorld` service in `GameContext` (delegating every query to `HeightSampler`), and
 *   - a `System` that owns the visual terrain: the 16×16 chunk grid, LOD selection with hysteresis,
 *     and the single merged mesh that draws everything past `PERF.distantMeshBeyond`.
 *
 * Purpose: replaces WS0's `StubWorld`. Generation runs in `terrain.worker.ts`, so `init()` is async
 * and WS7's loading screen keeps animating; once the arrays are back it publishes `world:ready`,
 * which is what tells WS2 to build the Rapier heightfield, WS4 to build the river ribbons and WS5 to
 * throw away scatter it placed against the stub.
 *
 * ── What this system does NOT own ───────────────────────────────────────────
 *   - the terrain *material*: WS4's `createTerrainMaterial(ctx)`, imported and shared by every chunk
 *     so one shader program is compiled for the whole island,
 *   - the water: WS4's `WaterSystem` builds the sea and the river ribbons from `WorldData.rivers`,
 *   - lights, sky and fog: WS4's `SkySystem` / `Lighting`.
 * WS1 publishes data and geometry; everything visual beyond that belongs to WS4.
 *
 * ── Lifecycle ───────────────────────────────────────────────────────────────
 *   constructor : allocates the final-size `heights` / `biomes` / `riverMask` arrays (zeroed), so
 *                 `ctx.world.data` is a stable, correctly-shaped object from the first line of
 *                 `main.ts`. Worker results are copied *into* these arrays, so array identity never
 *                 changes and anything that captured a reference early stays valid.
 *   init()      : generate → stamp Naqsh-e Jahan → sampler → chunk grid → emit `world:ready`.
 *   update()    : re-select chunk LODs, but only when the camera has actually moved.
 */

import * as THREE from "three";
import { PERF, WORLD } from "../config/world.config";
import type { EventBus } from "../core/EventBus";
import { TERRAIN_ATTRIBUTES } from "../core/types";
import type {
  BiomeWeights,
  GameContext,
  IWorld,
  Rng,
  System,
  WorldData,
} from "../core/types";
import { createTerrainMaterial } from "../render/TerrainMaterial";
import { mulberry32 } from "../utils/math";
import { perf } from "../utils/Perf";
import { HeightSampler } from "./HeightSampler";
import {
  buildChunkMeshData,
  chunkMeshDataToGeometry,
  verifyChunkAgainstSampler,
  type ChunkMeshData,
  type TerrainSource,
} from "./TerrainChunk";
import { generateTerrain } from "./TerrainGenerator";
import { applyIsfahanStamp } from "../landmarks/isfahanStamp";
import type {
  TerrainStats,
  TerrainWorkerRequest,
  TerrainWorkerResponse,
} from "./TerrainGenerator";
import type { GeneratedRiver } from "./RiverNetwork";

/** Vertex strides per LOD level. Each must divide `quadsPerChunk` (32). */
const LOD_STRIDES = [1, 2, 4, 8] as const;
/**
 * Pseudo-level for "further than `PERF.distantMeshBeyond`". Levels are ordered coarse-ascending
 * (0 = finest, `FAR_LEVEL` = coarsest) so the hysteresis comparison is a plain numeric one; using
 * -1 for "far" would make `desired > current` mean the opposite of what it reads like.
 */
const FAR_LEVEL: number = LOD_STRIDES.length;
/** Level assigned to a chunk that has never been built. */
const UNBUILT_LEVEL = -1;
/**
 * Levels at or above this are concatenated into the merged mesh instead of getting a `THREE.Mesh` of
 * their own. `PERF.distantMeshBeyond` is 900 m, so on a 2 km island *most* of the 256 chunks are
 * inside it from anywhere — drawing each one individually would be ~200 draw calls against PLAN.md's
 * 60-call terrain target. Merging from level 2 leaves only the ~38 chunks inside 320 m as individual
 * meshes (a dozen or so after frustum culling) plus one call for everything else.
 */
const MERGED_FROM_LEVEL = 2;
/** Metres of slack around every LOD boundary, so a chunk cannot flip back and forth on the edge. */
const LOD_HYSTERESIS = 24;
/** Only re-evaluate LODs once the camera has moved this far, or this long has passed. */
const LOD_RECHECK_DISTANCE = 6;
const LOD_RECHECK_SECONDS = 0.5;
/** Skirt depth as a multiple of the LOD's own sample spacing. */
const SKIRT_FACTOR = 1.5;
/** Chunks at or below this LOD cast shadows. WS4's shadow frustum is only ~55 m wide. */
const SHADOW_CASTING_LOD = 1;
/** Loading progress is reported into this slice of the bar (main.ts owns 0–0.4 and 0.7–1). */
const PROGRESS_FROM = 0.4;
const PROGRESS_TO = 0.68;

/** One cell of the chunk grid. */
interface ChunkSlot {
  readonly cx: number;
  readonly cz: number;
  readonly centreX: number;
  readonly centreZ: number;
  /** `UNBUILT_LEVEL`, or 0..`FAR_LEVEL`. Below `MERGED_FROM_LEVEL` it has its own `mesh`. */
  level: number;
  mesh: THREE.Mesh | null;
}

/** What `generate()` resolves to, whether it came from the worker or the synchronous fallback. */
interface GeneratedWorld {
  heights: Float32Array;
  biomes: Float32Array;
  riverMask: Float32Array;
  rivers: GeneratedRiver[];
  stats: TerrainStats;
}

export class WorldSystem implements IWorld, System {
  readonly name = "world";
  readonly data: WorldData;

  /** Populated in `init()`. Until then the world reads as a flat plane at sea level. */
  private sampler: HeightSampler | null = null;
  private stats: TerrainStats | null = null;

  private readonly chunkGrid = WORLD.chunkGrid;
  private readonly quadsPerChunk = (WORLD.resolution - 1) / WORLD.chunkGrid;
  private readonly chunkSize = WORLD.size / WORLD.chunkGrid;
  private readonly chunks: ChunkSlot[] = [];
  /**
   * Buffers for the merged mesh, precomputed once per chunk for each mergeable stride and indexed
   * `[level - MERGED_FROM_LEVEL][chunkIndex]`. Precomputing costs ~2 MB and makes a merge rebuild a
   * handful of `TypedArray.set` calls rather than a re-walk of the heightmap.
   */
  private readonly mergedData: ChunkMeshData[][] = [];

  private readonly terrainGroup = new THREE.Group();
  private terrainMaterial: THREE.Material | null = null;
  private farMesh: THREE.Mesh | null = null;
  private farNeedsRebuild = true;

  private readonly ownedGeometries = new Set<THREE.BufferGeometry>();
  private readonly lastLodOrigin = new THREE.Vector3(
    Infinity,
    Infinity,
    Infinity,
  );
  private lodTimer = 0;

  constructor(private readonly seed: number = WORLD.seed) {
    const res = WORLD.resolution;
    const cells = res * res;
    this.data = {
      seed,
      size: WORLD.size,
      resolution: res,
      heights: new Float32Array(cells),
      biomes: new Float32Array(cells * 4),
      riverMask: new Float32Array(cells),
      rivers: [],
      seaLevel: WORLD.seaLevel,
      landmarks: [],
    };
    // 100 % grass until the real biomes arrive, matching StubWorld's behaviour.
    for (let i = 0; i < cells; i++) this.data.biomes[i * 4] = 1;
    this.terrainGroup.name = "ws1:terrain";
  }

  // -------------------------------------------------------------------------
  // System lifecycle
  // -------------------------------------------------------------------------

  async init(ctx: GameContext): Promise<void> {
    const generated = await this.generate(ctx.events);

    // Copy rather than reassign: `data.heights` identity is part of the WS1 → WS2 contract.
    this.data.heights.set(generated.heights);
    this.data.biomes.set(generated.biomes);
    this.data.riverMask?.set(generated.riverMask);
    this.data.rivers.length = 0;
    for (const river of generated.rivers) {
      const points: THREE.Vector3[] = [];
      for (let i = 0; i < river.points.length; i += 3) {
        points.push(
          new THREE.Vector3(
            river.points[i],
            river.points[i + 1],
            river.points[i + 2],
          ),
        );
      }
      this.data.rivers.push({ points, width: river.width });
    }
    this.stats = generated.stats;

    applyIsfahanStamp(this.data);

    this.sampler = new HeightSampler(this.data);

    this.terrainMaterial = createTerrainMaterial(ctx);
    ctx.scene.add(this.terrainGroup);
    this.buildChunkGrid();
    this.refreshChunkLods(ctx.camera.position, true);

    // Publish last, so every listener sees a fully built world. WS2 rebuilds its heightfield here,
    // WS4 rebuilds the water, WS5 discards stub-era scatter.
    ctx.events.emit("world:ready", { data: this.data });

    if (import.meta.env.DEV) this.logSelfCheck();
  }

  update(dt: number, ctx: GameContext): void {
    if (!this.sampler) return;
    const t0 = performance.now();

    this.lodTimer += dt;
    const origin = ctx.camera.position;
    if (
      this.lodTimer >= LOD_RECHECK_SECONDS ||
      origin.distanceToSquared(this.lastLodOrigin) >
        LOD_RECHECK_DISTANCE * LOD_RECHECK_DISTANCE
    ) {
      this.lodTimer = 0;
      this.refreshChunkLods(origin, false);
    }

    perf.mark("world", performance.now() - t0);
  }

  dispose(): void {
    for (const chunk of this.chunks) this.releaseChunk(chunk);
    this.terrainGroup.removeFromParent();
    for (const geometry of this.ownedGeometries) geometry.dispose();
    this.ownedGeometries.clear();
    this.terrainMaterial?.dispose();
    this.terrainMaterial = null;
    this.farMesh = null;
  }

  // -------------------------------------------------------------------------
  // IWorld — everything delegates to the sampler, so there is one implementation, not two.
  // -------------------------------------------------------------------------

  sampleHeight(x: number, z: number): number {
    return this.sampler ? this.sampler.sampleHeight(x, z) : this.data.seaLevel;
  }

  sampleNormal(x: number, z: number, out?: THREE.Vector3): THREE.Vector3 {
    return this.sampler
      ? this.sampler.sampleNormal(x, z, out)
      : (out ?? new THREE.Vector3()).set(0, 1, 0);
  }

  sampleSlope(x: number, z: number): number {
    return this.sampler ? this.sampler.sampleSlope(x, z) : 0;
  }

  sampleBiome(x: number, z: number): BiomeWeights {
    return this.sampler ? this.sampler.sampleBiome(x, z) : [1, 0, 0, 0];
  }

  sampleRiverInfluence(x: number, z: number): number {
    return this.sampler ? this.sampler.sampleRiverInfluence(x, z) : 0;
  }

  findSpawnPoint(rng: Rng): THREE.Vector3 {
    const site = this.data.landmarks?.[0];
    if (this.sampler && site) {
      return new THREE.Vector3(
        site.spawnX,
        this.sampler.sampleHeight(site.spawnX, site.spawnZ),
        site.spawnZ,
      );
    }
    if (this.sampler) return this.sampler.findSpawnPoint(rng);
    return new THREE.Vector3(0, this.data.seaLevel, 0);
  }

  /** Generation stats — island min/max height, land fraction, rivers that reached the sea. */
  get terrainStats(): TerrainStats | null {
    return this.stats;
  }

  /**
   * Swaps the material on every terrain mesh, present and future. WS8's quality presets can use this
   * to drop to something cheaper without WS1 knowing what "cheaper" means.
   *
   * @example
   * const w = ctx.world as { setTerrainMaterial?: (m: THREE.Material) => void };
   * w.setTerrainMaterial?.(lowQualityMaterial);
   */
  setTerrainMaterial(material: THREE.Material): void {
    if (material === this.terrainMaterial) return;
    const previous = this.terrainMaterial;
    this.terrainMaterial = material;
    this.terrainGroup.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) mesh.material = material;
    });
    previous?.dispose();
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  /**
   * Runs the terrain worker, falling back to synchronous generation if workers are unavailable or
   * the worker fails for any reason — a stalled frame is a much smaller problem than no island.
   *
   * @complexity Dominated by `generateTerrain`: ~250–450 ms at 513², off the main thread.
   */
  private generate(events: EventBus): Promise<GeneratedWorld> {
    const params = {
      seed: this.seed,
      size: WORLD.size,
      resolution: WORLD.resolution,
      maxHeight: WORLD.maxHeight,
      seaLevel: WORLD.seaLevel,
      snowLine: WORLD.snowLine,
      rockSlopeDeg: WORLD.rockSlopeDeg,
      riverCount: WORLD.riverCount,
    };

    const report = (progress: number, label: string): void => {
      events.emit("loading:progress", {
        progress: PROGRESS_FROM + (PROGRESS_TO - PROGRESS_FROM) * progress,
        label,
      });
    };

    if (typeof Worker === "undefined") {
      return Promise.resolve(generateTerrain(params, report));
    }

    return new Promise<GeneratedWorld>((resolve) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL("./terrain.worker.ts", import.meta.url), {
          type: "module",
        });
      } catch (err) {
        console.warn(
          "[world] worker unavailable, generating on the main thread:",
          err,
        );
        resolve(generateTerrain(params, report));
        return;
      }

      let settled = false;
      const finishOnMainThread = (reason: string): void => {
        if (settled) return;
        settled = true;
        console.warn(
          `[world] terrain worker failed (${reason}); regenerating on the main thread.`,
        );
        worker.terminate();
        resolve(generateTerrain(params, report));
      };

      worker.onmessage = (event: MessageEvent<TerrainWorkerResponse>) => {
        const message = event.data;
        if (message.type === "progress") {
          report(message.progress, message.label);
          return;
        }
        if (message.type === "error") {
          finishOnMainThread(message.message);
          return;
        }
        if (settled) return;
        settled = true;
        worker.terminate();
        resolve({
          heights: message.heights,
          biomes: message.biomes,
          riverMask: message.riverMask,
          rivers: message.rivers,
          stats: message.stats,
        });
      };
      worker.onerror = (event) =>
        finishOnMainThread(event.message || "worker error");

      const request: TerrainWorkerRequest = { type: "generate", params };
      worker.postMessage(request);
    });
  }

  // -------------------------------------------------------------------------
  // Chunk grid
  // -------------------------------------------------------------------------

  private buildChunkGrid(): void {
    const source = this.terrainSource();
    const half = WORLD.size * 0.5;
    for (let level = MERGED_FROM_LEVEL; level <= FAR_LEVEL; level++)
      this.mergedData.push([]);

    for (let cz = 0; cz < this.chunkGrid; cz++) {
      for (let cx = 0; cx < this.chunkGrid; cx++) {
        this.chunks.push({
          cx,
          cz,
          centreX: -half + (cx + 0.5) * this.chunkSize,
          centreZ: -half + (cz + 0.5) * this.chunkSize,
          level: UNBUILT_LEVEL,
          mesh: null,
        });
        for (let level = MERGED_FROM_LEVEL; level <= FAR_LEVEL; level++) {
          this.mergedData[level - MERGED_FROM_LEVEL]!.push(
            buildChunkMeshData(
              source,
              cx,
              cz,
              this.quadsPerChunk,
              this.stride(level),
              this.skirtDepth(level),
            ),
          );
        }
      }
    }
    this.buildFarMesh();
  }

  /**
   * Allocates the merged mesh once, at its worst-case size (every chunk folded in at the *finest*
   * mergeable stride). Rebuilds only ever write into these buffers and move the draw range — no
   * reallocation, no GC churn.
   */
  private buildFarMesh(): void {
    const perChunk = this.mergedData[0]![0]!;
    const chunkCount = this.chunks.length;
    const vertices = perChunk.vertexCount * chunkCount;
    const indices = perChunk.indexCount * chunkCount;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(vertices * 3), 3),
    );
    geometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(new Float32Array(vertices * 3), 3),
    );
    geometry.setAttribute(
      TERRAIN_ATTRIBUTES.biome,
      new THREE.BufferAttribute(new Float32Array(vertices * 4), 4),
    );
    geometry.setAttribute(
      TERRAIN_ATTRIBUTES.river,
      new THREE.BufferAttribute(new Float32Array(vertices), 1),
    );
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    // Fixed: the merged mesh always spans the whole island, so this never needs recomputing.
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(0, WORLD.maxHeight * 0.25, 0),
      WORLD.size * 0.75,
    );

    const mesh = new THREE.Mesh(geometry, this.terrainMaterial!);
    mesh.name = "ws1:terrain-distant";
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // It *is* the horizon: culling it can never help, and testing it risks popping.
    mesh.frustumCulled = false;
    this.farMesh = mesh;
    this.ownedGeometries.add(geometry);
    this.terrainGroup.add(mesh);
  }

  private terrainSource(): TerrainSource {
    return {
      heights: this.data.heights,
      biomes: this.data.biomes,
      riverMask:
        this.data.riverMask ??
        new Float32Array(this.data.resolution * this.data.resolution),
      resolution: this.data.resolution,
      size: this.data.size,
    };
  }

  /** Vertex stride for a level. `FAR_LEVEL` reuses the coarsest real stride. */
  private stride(level: number): number {
    return LOD_STRIDES[Math.min(level, LOD_STRIDES.length - 1)]!;
  }

  private skirtDepth(level: number): number {
    const cell = this.data.size / (this.data.resolution - 1);
    return Math.max(3, this.stride(level) * cell * SKIRT_FACTOR);
  }

  /**
   * Chooses a level for every chunk from the horizontal distance to the camera, with
   * `LOD_HYSTERESIS` metres of slack so a chunk sitting on a boundary cannot oscillate.
   *
   * @param origin - Usually the camera position; distance is measured to the chunk's nearest edge.
   * @param force - Rebuild every chunk regardless of its current level (used once, at init).
   *
   * @complexity Time: O(chunks) per check, plus O(n²) geometry construction for the few near chunks
   * that actually changed level. Space: O(1)
   */
  private refreshChunkLods(origin: THREE.Vector3, force: boolean): void {
    const bounds = [
      PERF.lodDistances[0]!,
      PERF.lodDistances[1]!,
      PERF.lodDistances[2]!,
      PERF.distantMeshBeyond,
    ];
    const source = this.terrainSource();
    const halfChunk = this.chunkSize * 0.5;
    this.lastLodOrigin.copy(origin);
    let mergeChanged = force;

    for (const chunk of this.chunks) {
      // Distance to the chunk's nearest edge rather than its centre: standing in the corner of a
      // 128 m chunk should still give you full detail underfoot.
      const dx = Math.max(0, Math.abs(chunk.centreX - origin.x) - halfChunk);
      const dz = Math.max(0, Math.abs(chunk.centreZ - origin.z) - halfChunk);
      const d = Math.hypot(dx, dz);

      let desired = FAR_LEVEL;
      for (let level = 0; level < bounds.length; level++) {
        if (d < bounds[level]!) {
          desired = level;
          break;
        }
      }
      if (desired === chunk.level) continue;

      if (!force && chunk.level !== UNBUILT_LEVEL) {
        // Require the distance to be past the boundary by the hysteresis margin before switching, in
        // whichever direction the switch would go. Levels are coarse-ascending, so the boundary that
        // matters is the one belonging to whichever of the two levels is finer.
        const finer = Math.min(desired, chunk.level);
        const edge = bounds[finer]!;
        if (
          desired > chunk.level
            ? d < edge + LOD_HYSTERESIS
            : d > edge - LOD_HYSTERESIS
        )
          continue;
      }

      if (chunk.level >= MERGED_FROM_LEVEL || desired >= MERGED_FROM_LEVEL)
        mergeChanged = true;
      this.releaseChunk(chunk);
      chunk.level = desired;
      if (desired >= MERGED_FROM_LEVEL) continue;

      const data = buildChunkMeshData(
        source,
        chunk.cx,
        chunk.cz,
        this.quadsPerChunk,
        this.stride(desired),
        this.skirtDepth(desired),
      );
      const geometry = chunkMeshDataToGeometry(data);
      this.ownedGeometries.add(geometry);
      const mesh = new THREE.Mesh(geometry, this.terrainMaterial!);
      mesh.name = `ws1:chunk-${chunk.cx}-${chunk.cz}`;
      mesh.receiveShadow = true;
      // Terrain shadowing itself is what gives ridges their shape at low sun, but only close chunks
      // are inside WS4's shadow frustum, so anything further is pure cost.
      mesh.castShadow = desired <= SHADOW_CASTING_LOD;
      chunk.mesh = mesh;
      this.terrainGroup.add(mesh);
    }

    if (mergeChanged) this.farNeedsRebuild = true;
    if (this.farNeedsRebuild) this.rebuildFarMesh();
  }

  /** Terrain draw calls this frame, before frustum culling. Read by the dev self-check. */
  private get terrainDrawCalls(): number {
    let individual = 0;
    for (const chunk of this.chunks) if (chunk.mesh) individual++;
    return individual + (this.farMesh?.visible ? 1 : 0);
  }

  private releaseChunk(chunk: ChunkSlot): void {
    const mesh = chunk.mesh;
    if (!mesh) return;
    mesh.removeFromParent();
    this.ownedGeometries.delete(mesh.geometry);
    mesh.geometry.dispose();
    chunk.mesh = null;
  }

  /**
   * Concatenates the precomputed buffers of every chunk not drawn individually into the single merged
   * mesh, each at its own selected stride, then moves the draw range. One draw call for everything
   * past 320 m, which is most of how the terrain stays inside PLAN.md's draw-call budget.
   *
   * @complexity Time: O(mergedChunks × verticesPerChunk) — ~31 k vertices worst case, well under a
   * millisecond, and only when a chunk changed level. Space: O(1) (buffers are preallocated).
   */
  private rebuildFarMesh(): void {
    const mesh = this.farMesh;
    if (!mesh) return;
    this.farNeedsRebuild = false;

    const geometry = mesh.geometry;
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const normal = geometry.getAttribute("normal") as THREE.BufferAttribute;
    const biome = geometry.getAttribute(
      TERRAIN_ATTRIBUTES.biome,
    ) as THREE.BufferAttribute;
    const river = geometry.getAttribute(
      TERRAIN_ATTRIBUTES.river,
    ) as THREE.BufferAttribute;
    const index = geometry.getIndex()!;

    const posArray = position.array as Float32Array;
    const normArray = normal.array as Float32Array;
    const biomeArray = biome.array as Float32Array;
    const riverArray = river.array as Float32Array;
    const indexArray = index.array as Uint32Array;

    let vertexOffset = 0;
    let indexOffset = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const level = this.chunks[i]!.level;
      if (level < MERGED_FROM_LEVEL) continue;
      const data = this.mergedData[level - MERGED_FROM_LEVEL]![i]!;
      posArray.set(data.positions, vertexOffset * 3);
      normArray.set(data.normals, vertexOffset * 3);
      biomeArray.set(data.biome, vertexOffset * 4);
      riverArray.set(data.river, vertexOffset);
      for (let k = 0; k < data.indexCount; k++) {
        indexArray[indexOffset + k] = data.indices[k]! + vertexOffset;
      }
      vertexOffset += data.vertexCount;
      indexOffset += data.indexCount;
    }

    position.needsUpdate = true;
    normal.needsUpdate = true;
    biome.needsUpdate = true;
    river.needsUpdate = true;
    index.needsUpdate = true;
    geometry.setDrawRange(0, indexOffset);
    mesh.visible = indexOffset > 0;
  }

  // -------------------------------------------------------------------------
  // Dev self-check
  // -------------------------------------------------------------------------

  /**
   * PLAN.md WS1 acceptance, verified at runtime in dev: the sampler must agree with the geometry the
   * player actually sees — and, through the same array, with WS2's Rapier heightfield. Runs against a
   * throwaway LOD0 chunk from the middle of the island.
   */
  private logSelfCheck(): void {
    const stats = this.stats;
    if (stats) {
      console.info(
        `[world] seed ${this.seed}: generated in ${stats.generateMs.toFixed(0)} ms, ` +
          `height ${stats.minHeight.toFixed(1)}..${stats.maxHeight.toFixed(1)} m, ` +
          `land ${(stats.landFraction * 100).toFixed(1)}%, snow ${(stats.snowFraction * 100).toFixed(1)}%, ` +
          `${stats.riversReachingSea}/${stats.riverCount} rivers reaching the sea`,
      );
      if (stats.riversReachingSea < 3) {
        console.warn(
          `[world] only ${stats.riversReachingSea} rivers reached the sea; PLAN.md asks for >= 3`,
        );
      }
    }

    console.info(
      `[world] ${this.terrainDrawCalls} terrain draw calls before frustum culling ` +
        `(PLAN.md target <= 60 at ground level)`,
    );

    const mid = Math.floor(this.chunkGrid / 2);
    const probe = buildChunkMeshData(
      this.terrainSource(),
      mid,
      mid,
      this.quadsPerChunk,
      this.stride(0),
      this.skirtDepth(0),
    );
    const geometry = chunkMeshDataToGeometry(probe);
    const result = verifyChunkAgainstSampler(
      geometry,
      (x, z) => this.sampleHeight(x, z),
      mulberry32(this.seed ^ 0xa11e),
      1000,
    );
    geometry.dispose();

    const line =
      `[world] sampler vs rendered geometry over ${result.tested} points: ` +
      `max ${result.maxError.toFixed(5)} m, mean ${result.meanError.toFixed(6)} m`;
    if (result.ok) console.info(`${line} — OK (budget 0.01 m)`);
    else console.error(`${line} — FAILED the 0.01 m budget`);
  }
}
