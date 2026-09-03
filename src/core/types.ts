/**
 * src/core/types.ts
 *
 * ★ THE SHARED CONTRACT FILE. Every workstream codes against these interfaces.
 *
 * Contents: the `System` lifecycle interface, the `GameContext` service container, the world /
 * physics / input / player service interfaces, and the plain data shapes that cross workstream
 * boundaries (`WorldData`, `BiomeWeights`, `RiverSpline`, `InputState`, ...).
 *
 * Purpose: this file is the coordination mechanism between the parallel workstreams described in
 * PLAN.md. Systems never import each other; they only ever depend on the types declared here and
 * reach one another through `GameContext` and the `EventBus`.
 *
 * RULES (from PLAN.md):
 *   - This file is APPEND-ONLY after WS0. Do not change an existing signature without announcing it.
 *   - Types only. No runtime values, no implementations — so that importing it can never create an
 *     import cycle at runtime.
 */

import type * as THREE from "three";
import type * as RAPIER from "@dimforge/rapier3d-compat";
import type { EventBus } from "./EventBus";

// ---------------------------------------------------------------------------
// Engine / system lifecycle
// ---------------------------------------------------------------------------

/**
 * A unit of game behaviour. The Engine owns an ordered list of these and drives them.
 *
 * Execution order per frame:
 *   1. `ctx.input.beginFrame()`
 *   2. 0..N fixed steps of `fixedUpdate(1/60)` in registration order
 *   3. `update(dt)` in registration order
 *   4. render
 *   5. `ctx.input.endFrame()`
 */
export interface System {
  readonly name: string;
  init(ctx: GameContext): Promise<void> | void;
  /** Fixed 1/60 s timestep, physics-locked. May run 0..N times per rendered frame. */
  fixedUpdate?(dt: number, ctx: GameContext): void;
  /** Variable timestep, render-locked. Runs exactly once per rendered frame. */
  update?(dt: number, ctx: GameContext): void;
  dispose?(): void;
}

/** The shared service container handed to every system. */
export interface GameContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  events: EventBus;
  physics: IPhysics; // WS2 (WS0 ships StubPhysics)
  world: IWorld; // WS1 (WS0 ships StubWorld)
  input: IInput; // WS3 (WS0 ships a real StubInput)
  player: IPlayerState; // WS3 (WS0 ships a stub player)
  time: TimeState;
  /**
   * WS0 ADDITION (not in the original PLAN.md sketch): shader uniform objects shared between the
   * terrain material (WS4) and the feature systems that drive it (WS6). See `SharedUniforms`.
   */
  uniforms: SharedUniforms;
}

export interface TimeState {
  /** Seconds since the engine started. */
  elapsed: number;
  /** Seconds since the previous rendered frame. */
  dt: number;
  /** 0..1 — 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset. */
  timeOfDay: number;
}

// ---------------------------------------------------------------------------
// World (WS1)
// ---------------------------------------------------------------------------

/** Biome weights always sum to 1. Order is fixed: grass, rock, snow, sand. */
export type BiomeWeights = [
  grass: number,
  rock: number,
  snow: number,
  sand: number,
];

/** Human-readable biome identity, used by events and the HUD. */
export type BiomeName = "grass" | "rock" | "snow" | "sand" | "water";

export interface WorldData {
  seed: number;
  /** Metres, square. */
  size: number;
  /** Vertices per side (513). */
  resolution: number;
  /** resolution², row-major, index = z * res + x. */
  heights: Float32Array;
  /** resolution² * 4, same indexing, stride 4 = [grass, rock, snow, sand]. */
  biomes: Float32Array;
  rivers: RiverSpline[];
  seaLevel: number;
  /**
   * WS1 ADDITION (optional, so `StubWorld` stays valid): resolution², same indexing as `heights`.
   * 0 = dry land, 1 = the centre of a carved river bed. Lets WS4 drive wetness/foam near water and
   * WS5 refuse to scatter grass in a channel, without either of them re-deriving it from the splines.
   */
  riverMask?: Float32Array;
  /**
   * Authored landmark stamps (Naqsh-e Jahan, …). Optional so older `WorldData` producers stay valid.
   * Written by WS1 after generation, before the sampler / chunks / heightfield are built.
   */
  landmarks?: LandmarkSite[];
}

/** One authored place sitting on the island: a flattened plateau plus a spawn facing it. */
export interface LandmarkSite {
  id: "isfahan";
  x: number;
  z: number;
  /** Plaza surface height, metres. */
  y: number;
  /** Yaw that maps local +Z (south, the Shah Mosque) onto world XZ. */
  yaw: number;
  spawnX: number;
  spawnZ: number;
  /** Camera boom yaw so default "forward" walks into the square, toward the mosque. */
  spawnYaw: number;
  halfWidth: number;
  halfLength: number;
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
  /**
   * WS1 ADDITION (optional): bilinear sample of `WorldData.riverMask`. 0 = dry, 1 = river bed centre.
   * Optional so `StubWorld` remains a valid `IWorld`; treat a missing method as "always 0".
   */
  sampleRiverInfluence?(x: number, z: number): number;
}

export interface RiverSpline {
  /** Ordered peak → sea, y = water surface height. */
  points: THREE.Vector3[];
  width: number;
}

// ---------------------------------------------------------------------------
// Physics (WS2)
// ---------------------------------------------------------------------------

export interface IPhysics {
  readonly world: RAPIER.World;
  addHeightfield(data: WorldData): void;
  createCharacter(
    pos: THREE.Vector3,
    radius: number,
    height: number,
  ): ICharacterBody;
  raycast(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxToi: number,
  ): RaycastHit | null;
  /** Returns a handle usable with `removeCollider`. */
  addStaticTrimesh(geom: THREE.BufferGeometry, pos: THREE.Vector3): number;
  removeCollider(handle: number): void;
}

export interface RaycastHit {
  /** World-space point of impact. */
  point: THREE.Vector3;
  /** Surface normal at the impact point. */
  normal: THREE.Vector3;
  /** Distance along the ray (time of impact, ray direction assumed normalised). */
  distance: number;
  /** Rapier collider handle, or -1 when the hit came from an analytic stub surface. */
  colliderHandle: number;
}

export interface ICharacterBody {
  /** Read-only view, updated each fixedUpdate. Do not mutate — call `move`/`teleport`. */
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  grounded: boolean;
  groundNormal: THREE.Vector3;
  /** desiredTranslation is a per-step delta in world space. */
  move(desiredTranslation: THREE.Vector3): void;
  teleport(pos: THREE.Vector3): void;
}

// ---------------------------------------------------------------------------
// Input (WS3)
// ---------------------------------------------------------------------------

export type ActionId = "scan" | "cairn" | "photo" | "debug" | "pause" | "interact";

export interface InputState {
  /** Camera-relative, already normalised. x = strafe, y = forward. */
  move: THREE.Vector2;
  /** Pointer delta since the last frame, in pixels. */
  look: THREE.Vector2;
  /** Edge-triggered: true for exactly one frame per press. */
  jump: boolean;
  /** Held. */
  sprint: boolean;
  /** Edge-triggered, cleared at the end of every frame. */
  actions: Set<ActionId>;
}

export interface IInput {
  readonly state: InputState;
  /**
   * WS0 ADDITION: the Engine calls these around each frame so edge-triggered flags are visible for
   * exactly one whole frame (including every fixed step within it). Both are optional so a
   * stateless input implementation stays valid.
   */
  beginFrame?(): void;
  endFrame?(): void;
}

// ---------------------------------------------------------------------------
// Player (WS3)
// ---------------------------------------------------------------------------

export interface IPlayerState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  grounded: boolean;
  /** 0..1 */
  stamina: number;
  /** 1 = steady, 0 = about to fall. */
  balance: number;
  isTumbling: boolean;
  biome: BiomeWeights;
  altitude: number;
}

// ---------------------------------------------------------------------------
// Cross-workstream render contracts (WS1 → WS4 → WS6 handshakes)
// ---------------------------------------------------------------------------

/**
 * Vertex attribute names written by WS1's terrain chunks and read by WS4's terrain shader.
 * Agreeing on these up front is one of the "soft handshakes" called out in PLAN.md.
 */
export const TERRAIN_ATTRIBUTES = {
  /** vec4 — [grass, rock, snow, sand], sums to 1. */
  biome: "aBiome",
  /**
   * WS4 ADDITION, OPTIONAL. float 0..1 — "this vertex is permanently damp": river banks, seep
   * lines, tidal flats. WS4's terrain shader darkens and glosses it exactly like rain does.
   *
   * A geometry that omits it is fine: an unbound float attribute reads as 0 (dry), so the shader
   * falls back to a sea-level proximity estimate. WS1 should supply it for carved river channels
   * because those sit well above sea level and the fallback cannot see them.
   */
  wetness: "aWet",
  /**
   * WS1 ADDITION, OPTIONAL. float 0..1 — distance-to-river-channel mask, 0 = dry ground,
   * 1 = the centre of a carved river bed. WS4's terrain shader treats it exactly like `aWet`
   * (the two are combined with `max`), so river banks read as damp stone and silt.
   *
   * Also defaults to 0 when the geometry omits it.
   */
  river: "aRiver",
} as const;

/** Minimal shape of a THREE uniform, declared locally so this file stays runtime-free. */
export interface Uniform<T> {
  value: T;
}

/**
 * Uniform objects created once by WS0 and shared by reference:
 *   - WS4 assigns them into the terrain/water shaders inside `onBeforeCompile`.
 *   - WS6 mutates `.value` to drive weather wetness and the Odradek scan pulse.
 * Because they are shared object references, neither side has to know about the other.
 */
export interface SharedUniforms {
  /** Seconds since start; drives water scroll, wind, and grass sway. */
  uTime: Uniform<number>;
  /** 0 = bone dry, 1 = soaked. Driven by WS6's timefall. */
  uWetness: Uniform<number>;
  /** World-space origin of the active Odradek scan pulse. */
  uScanOrigin: Uniform<THREE.Vector3>;
  /** Current radius of the scan ring in metres; <= 0 means no active scan. */
  uScanRadius: Uniform<number>;
  /** Horizontal wind vector in m/s; drives grass and rain streak shear. */
  uWind: Uniform<THREE.Vector2>;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Quality preset selected in WS8's settings dropdown. */
export type QualityLevel = "low" | "medium" | "high";

/** Deterministic 0..1 random source. Always pass one around instead of using `Math.random`. */
export type Rng = () => number;

// ---------------------------------------------------------------------------
// WS3 additions (append-only). Nothing above was modified.
// ---------------------------------------------------------------------------

/**
 * Coarse locomotion state published by WS3's `PlayerSystem`. Consumed by WS7's HUD (which verb to
 * show, whether to flash the stamina arc) and available to WS6 (footstep-ish effects, scan gating).
 */
export type PlayerLocomotion =
  | "idle"
  | "walk"
  | "sprint"
  | "air"
  | "tumble"
  | "recover";

/**
 * Extra locomotion telemetry, merged into `IPlayerState` above by TypeScript's interface declaration
 * merging. Every field is OPTIONAL, so `createPlayerState()` and any other existing producer of an
 * `IPlayerState` keeps type-checking unchanged — this is purely additive, per the append-only rule.
 *
 * WS3's `PlayerSystem` populates all of them every fixed step (except `cameraYaw`, written by
 * `ThirdPersonCamera`), so consumers may treat them as present at runtime while still coding
 * defensively against `undefined`.
 */
export interface IPlayerState {
  /** Speed on the XZ plane in m/s. */
  horizontalSpeed?: number;
  /** What the player is doing right now. */
  locomotion?: PlayerLocomotion;
  /** Slope of the ground beneath the player, radians. 0 = flat. */
  slope?: number;
  /** True while the sprint key is held AND sprinting is actually being applied. */
  sprinting?: boolean;
  /** True while the player's feet are below sea level (movement is slowed to a wade). */
  wading?: boolean;
  /** Follow-camera yaw in radians around world Y — the heading a compass should display. */
  cameraYaw?: number;
}
