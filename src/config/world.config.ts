/**
 * src/config/world.config.ts
 *
 * ★ EVERY TUNABLE CONSTANT IN THE GAME LIVES HERE. No magic numbers in system code.
 *
 * Contents: world/terrain dimensions, player locomotion + stamina tuning, camera rig tuning,
 * performance budgets and LOD radii, render defaults, and the day/night clock.
 *
 * Purpose: a single place to tune the game (WS8's job) and a single place for parallel workstreams
 * to agree on shared numbers (grid resolution, snow line, budgets) without importing each other.
 *
 * RULES (from PLAN.md): APPEND-ONLY after WS0. Adding a key is free; renaming or removing one
 * breaks other workstreams. WS8 may change *values* during the tuning pass.
 */

export const WORLD = {
  seed: 1337,
  /** Metres per side of the square island. */
  size: 2048,
  /** Vertices per side. (2^9)+1 → divides cleanly into 16 chunks of 32 quads. */
  resolution: 513,
  /** 16×16 = 256 chunks, 128 m each. */
  chunkGrid: 16,
  maxHeight: 400,
  seaLevel: 0,
  snowLine: 220,
  rockSlopeDeg: 38,
  riverCount: 4,
} as const;

export const PLAYER = {
  radius: 0.5,
  height: 1.0,
  walkSpeed: 4.5,
  sprintSpeed: 8.0,
  airControl: 0.25,
  jumpSpeed: 6.5,
  gravity: -22,
  maxSlopeClimbDeg: 47,
  minSlopeSlideDeg: 52,
  autoStep: 0.4,
  snapToGround: 0.35,
  staminaDrainSprint: 0.14,
  staminaDrainSlope: 0.3,
  staminaRegen: 0.22,
} as const;

export const CAMERA = {
  distance: 7,
  height: 2.2,
  fov: 60,
  near: 0.1,
  far: 2600,
  followDamp: 8,
  rotateDamp: 14,
  minPitch: -0.55,
  maxPitch: 1.15,
  collisionPad: 0.4,
} as const;

export const PERF = {
  maxPixelRatio: 2,
  /** LOD0/1/2/3 switch radii in metres. */
  lodDistances: [140, 320, 700],
  /** Single merged low-res mesh past this distance. */
  distantMeshBeyond: 900,
  grassRadius: 90,
  grassPerChunk: 6000,
  budgetDrawCalls: 150,
  budgetTriangles: 500_000,
  /** WS7 addition: the F1 overlay turns red below this framerate. */
  budgetFps: 55,
  /** WS7 addition: ...and above this frame time. 18 ms is the PLAN.md manual-perf target. */
  budgetFrameMs: 18,
} as const;

// ---------------------------------------------------------------------------
// WS0 additions — defaults the bootstrap needs. WS4 owns the final look; treat the fog/sky values
// here as placeholders it is free to drive from the sky gradient.
// ---------------------------------------------------------------------------

export const RENDER = {
  /** Placeholder horizon colour, replaced by WS4's sky dome. */
  clearColor: 0x9fb8c8,
  fogColor: 0x9fb8c8,
  /** Linear fog; `fogFar` deliberately sits just inside `CAMERA.far`. */
  fogNear: 350,
  fogFar: 2400,
  antialias: true,
  shadowMapSize: 2048,
  /** Physics accumulator safety valve — see PLAN.md WS2 ("prevents spiral of death"). */
  maxFixedStepsPerFrame: 5,
  fixedTimestep: 1 / 60,
} as const;

export const TIME = {
  /** Real seconds for a full 24 h cycle. */
  dayLengthSeconds: 600,
  /** 0..1; 0.32 ≈ mid-morning, a flattering starting light. */
  startTimeOfDay: 0.32,
} as const;

// ---------------------------------------------------------------------------
// WS7 additions — HUD and loading screen tuning. Layout and colour live in `src/ui/hud.css`;
// only behaviour that code has to know about is here.
// ---------------------------------------------------------------------------

export const HUD = {
  /** First-run control hints fade this many seconds after the world becomes playable. */
  hintsFadeAfterSeconds: 20,
  /** Default lifetime of a `hud:toast` with no explicit `ms`. */
  toastDefaultMs: 2600,
  /** Older toasts are evicted past this count, so a burst cannot fill the screen. */
  maxToasts: 3,
  /** Text/readout refresh rate. The compass itself still rotates every frame. */
  readoutHz: 10,
  /** Degrees of heading visible across the full width of the compass strip. */
  compassSpanDeg: 150,
  /** Diamond markers drawn at once — the nearest N of `maxMarkers`. */
  markerSlots: 6,
  /** Hard cap on tracked points of interest; the oldest is dropped past this. */
  maxMarkers: 32,
} as const;

export const LOADING = {
  /** Never flash: once shown, the loading screen stays up at least this long. */
  minVisibleMs: 650,
  /** Must match the `.loading` opacity transition in hud.css. */
  fadeMs: 550,
  /** Grace period after `loading:done` so the bar is visibly at 100 % before the fade starts. */
  settleMs: 280,
  /** How long each traveler's-log line stays on screen. */
  logIntervalMs: 3400,
  /** Progress-bar easing rate; see `damp` in utils/math.ts. */
  easeLambda: 6,
} as const;

// ---------------------------------------------------------------------------
// WS5 additions — vegetation & scatter. Consumed by `src/world/scatter.ts` (placement) and
// `src/render/VegetationSystem.ts` (rendering). Areal densities are restated per terrain chunk so
// they stay comparable with `PERF.grassPerChunk`; cell sizes are an implementation detail of the
// incremental generator and may be tuned freely.
// ---------------------------------------------------------------------------

export const VEGETATION = {
  /** Wall-clock budget per frame for generating newly-visible scatter cells. */
  cellBudgetMs: 0.9,
  /** The player must move this far (metres) before instance buffers are repacked. */
  rebuildEpsilon: 3,
  /** Safety headroom on every preallocated instance buffer. */
  capacityHeadroom: 1.15,

  grass: {
    /** Metres per generation cell. Must divide the terrain chunk size for density to restate cleanly. */
    cellSize: 64,
    /** Candidates per 128 m terrain chunk — the PERF budget, restated at the point of use. */
    perChunk: PERF.grassPerChunk,
    radius: PERF.grassRadius,
    /** Metres over which blades shrink to nothing at the edge of `radius`, instead of popping. */
    fadeBand: 22,
    minScale: 0.36,
    maxScale: 0.72,
    minStretch: 0.85,
    maxStretch: 1.6,
    /**
     * Width of a tuft's cross-quads relative to its height. Above 1 a single instance covers more
     * ground, which is the cheapest way to close the gaps between tufts — far cheaper than raising
     * `perChunk`, since it costs no extra instances, matrices or draw calls.
     */
    quadAspect: 1.7,
    maxSlopeDeg: 34,
    /** Grass thins out across this many metres below `WORLD.snowLine`. */
    snowFade: 30,
    /** ...and across this many metres below `WORLD.seaLevel`. */
    shoreFade: 1,
    densityScale: 1,
    /** Fraction of blade height buried, so nothing floats on a slope. */
    sink: 0.06,
    /** Alpha-TESTED, never alpha-blended — no sort cost, no transparency artefacts (PLAN.md WS5). */
    alphaTest: 0.34,
    castShadow: false,
    receiveShadow: true,
    windStrength: 0.3,
    windFrequency: 1.5,
    /** Spatial frequency of the travelling wind wave (radians per metre). */
    windWaveScale: 0.085,
    /** Spatial frequency of the slow gust envelope (radians per metre). */
    gustScale: 0.013,
    colorA: 0x8aa353,
    colorB: 0xc3c67e,
  },

  rocks: {
    cellSize: 128,
    perChunk: 260,
    radius: 220,
    fadeBand: 34,
    minScale: 0.35,
    maxScale: 1.9,
    minStretch: 0.45,
    maxStretch: 1,
    maxSlopeDeg: 58,
    densityScale: 0.34,
    sink: 0.3,
    variants: 3,
    /** Biome affinities, multiplied by the matching `BiomeWeights` component. Each must be <= 1. */
    weightRock: 1,
    weightSnow: 0.4,
    weightSand: 0.15,
    weightGrass: 0.07,
    castShadow: true,
    receiveShadow: true,
    color: 0x8d8578,
    /** Rocks inside this radius and at least `colliderMinScale` big get a physics collider. */
    colliderRadius: 60,
    colliderMinScale: 0.9,
    maxColliders: 40,
  },

  driftwood: {
    cellSize: 128,
    /** Low by design: driftwood is punctuation on a beach, not ground cover. */
    perChunk: 24,
    radius: 150,
    fadeBand: 26,
    minScale: 1.2,
    maxScale: 3,
    minStretch: 0.7,
    maxStretch: 1.1,
    maxSlopeDeg: 22,
    /** Only within this many metres above sea level. */
    shoreBand: 9,
    densityScale: 1,
    weightSand: 0.9,
    weightGrass: 0.05,
    sink: 0.12,
    variants: 2,
    castShadow: true,
    receiveShadow: true,
    color: 0x93876f,
  },
} as const;

// ---------------------------------------------------------------------------
// WS4 additions — the look. Sky palette, sun/shadow rig, terrain palette, water.
// Appended per the append-only rule; nothing above was touched.
// ---------------------------------------------------------------------------

/** Sky dome gradient + celestial bodies. Colours are keyframes blended by sun altitude. */
export const SKY = {
  /** Unit dome is pinned to the camera and forced to the far plane, so this is just tessellation. */
  domeSegments: 32,
  /** Radians the sun's great circle is tilted off the zenith, so noon isn't dead overhead. */
  sunTilt: 0.3,

  dayZenith: 0x2f6fc4,
  dayHorizon: 0xb8d4ea,
  duskZenith: 0x2c3a70,
  duskHorizon: 0xf08a4b,
  nightZenith: 0x03060f,
  nightHorizon: 0x0d1730,
  /** Colour looking straight down — the haze the terrain melts into. */
  groundHaze: 0x8a8f92,

  sunColorNoon: 0xfff4e2,
  sunColorHorizon: 0xff8b42,
  moonColor: 0xbcccdd,

  /** Angular radius of each disc, as `1 - cos(theta)`. */
  sunDiscSize: 0.00025,
  moonDiscSize: 0.0004,
  sunGlowExponent: 6.0,
  sunGlowStrength: 0.55,

  /** Linear fog distances at noon; both shrink at night and in bad weather. */
  fogNearDay: 220,
  fogFarDay: 2300,
  fogNearNight: 90,
  fogFarNight: 1200,
  /** How much of the horizon colour bleeds into the fog (1 = pure horizon colour). */
  fogHorizonMix: 0.85,
} as const;

/** Directional/ambient rig and the single shadow cascade. */
export const LIGHT = {
  sunIntensityNoon: 3.6,
  sunIntensityHorizon: 1.6,
  moonIntensity: 0.32,
  hemiIntensityDay: 0.7,
  hemiIntensityNight: 0.16,
  ambientDay: 0.14,
  ambientNight: 0.05,
  /**
   * Extra hemisphere/ambient bounce at sunrise and sunset. Without it the ground goes black the
   * moment the sun clips the horizon, even though the sky behind it is at its brightest — which
   * is exactly backwards, because a glowing sky is a huge area light.
   */
  goldenHourBounce: 0.5,
  /**
   * Sun altitudes (as sin of elevation) over which direct sunlight fades out. Ends slightly above
   * the geometric horizon and starts well below it, so dusk is a long warm ramp, not a light
   * switch.
   */
  sunFadeStart: -0.22,
  sunFadeEnd: 0.04,

  /** Half-width of the ortho shadow frustum, centred on the player. */
  shadowRadius: 55,
  /** How far up the sun light sits above the player — must exceed the tallest caster nearby. */
  shadowDistance: 300,
  shadowBias: -0.0006,
  shadowNormalBias: 0.06,
  /** Below this sun intensity the shadow pass is skipped entirely (dusk → dawn). */
  shadowMinSunIntensity: 0.35,
} as const;

/** Terrain palette + the blend rules that make biomes read as biomes. */
export const TERRAIN_LOOK = {
  grassLush: 0x455f2b,
  grassDry: 0x7c7f43,
  rockLight: 0x74706a,
  rockDark: 0x3b3934,
  snowBright: 0xeef3fa,
  snowShade: 0xc3d2e2,
  sandLight: 0xcbb68d,
  sandDark: 0x9a8560,

  /** World-space frequency of the large colour variation and the close-up grain. */
  macroNoiseScale: 0.011,
  detailNoiseScale: 0.42,
  /**
   * Distances (m) over which the close-up grain and rock strata fade out. Beyond `detailFadeEnd`
   * their features are far smaller than a pixel, so keeping them only buys shimmer — and the
   * shader skips the triplanar noise entirely out there, which is the cheapest win in the file.
   */
  detailFadeStart: 130,
  detailFadeEnd: 520,
  /** Amplitude of the rock strata banding, and its vertical frequency in radians per metre. */
  strataStrength: 0.09,
  strataFrequency: 0.22,

  /** Slope (degrees) over which bare rock takes over from whatever the biome says. */
  rockSlopeStartDeg: 30,
  rockSlopeFullDeg: 50,
  /** Slope (degrees) over which snow slides off a cliff instead of sticking. */
  snowSlopeKeepDeg: 32,
  snowSlopeGoneDeg: 52,

  /** Wet ground: albedo multiplier and target roughness. */
  wetDarkening: 0.55,
  wetRoughness: 0.12,
  /** Metres above sea level over which the shoreline dries out. */
  shoreWetHeight: 2.4,

  /** Odradek scan ring width (m) and how far the tint trails behind it (m). */
  scanRingWidth: 5,
  scanTrail: 70,
  scanRingGain: 1.8,
  scanTrailGain: 0.28,
  scanWalkableDeg: 25,
  scanCostlyDeg: 40,
  scanFallDeg: 55,
  scanColorGood: 0x35e08a,
  scanColorWarn: 0xf0b23a,
  scanColorBad: 0xef4a4a,
} as const;

/** One shader, two meshes: the sea plane and the river ribbons. */
export const WATER = {
  /** Sea plane side length in metres — must reach past `CAMERA.far` so there is no visible edge. */
  seaExtent: 8000,
  seaSegments: 64,
  /** Depth (m) assumed for open ocean outside the heightmap. */
  openOceanDepth: 40,
  /** Distance (m) past the island bounds over which the sea ramps to `openOceanDepth`. */
  openOceanRamp: 140,

  shallowColor: 0x2c7f84,
  deepColor: 0x06202c,
  foamColor: 0xdff0f2,
  maxOpacity: 0.9,

  waveScale: 0.07,
  waveSpeed: 0.055,
  waveStrength: 0.5,
  /** Vertical displacement of the sea surface, metres. */
  swellHeight: 0.12,
  fresnelPower: 4.0,
  specularPower: 90,

  /** Depth (m) below which the shoreline foam band appears. */
  foamDepth: 0.9,
  /** Depth (m) at which the colour ramp reaches `deepColor`. */
  colorDepth: 7,

  /**
   * Upper bound on lengthwise samples per river. The actual count is derived from the channel's
   * arc length so that steps stay roughly `0.6 × width` apart whatever WS1's spline looks like.
   */
  riverSegments: 220,
  riverSurfaceOffset: 0.06,
  /** Fraction of the river width used as the deepest part of the channel. */
  riverDepthFactor: 0.35,
  riverFlowSpeed: 0.9,
  /**
   * Channel cross-section, left bank → right bank: `offset` is a fraction of the half-width and
   * `depth` a fraction of the maximum. A three-point (bank/centre/bank) profile would make the
   * whole ribbon shallower than `foamDepth` and turn every river into a strip of white water, so
   * the channel has a flat bed and the foam is confined to the last few metres of each bank.
   */
  riverProfile: [
    { offset: -1, depth: 0.02 },
    { offset: -0.55, depth: 0.9 },
    { offset: 0, depth: 1 },
    { offset: 0.55, depth: 0.9 },
    { offset: 1, depth: 0.02 },
  ],
} as const;

/**
 * The stand-in island WS4 renders while WS1's `WorldSystem` does not exist yet. Delete-on-arrival:
 * the preview removes itself the moment a real world lands (see `TerrainPreviewSystem`).
 */
export const TERRAIN_PREVIEW = {
  segments: 192,
  /** Feature size (m) of the synthetic biome field painted onto a flat stub world. */
  biomeNoiseScale: 260,
  /** A synthetic river drawn across the flat stub so the water shader has something to render. */
  stubRiverWidth: 14,
} as const;

// ---------------------------------------------------------------------------
// WS2 additions — Rapier world, heightfield collider and character controller tuning.
// Locomotion feel (speeds, slope limits, autostep height) stays in `PLAYER`; these are the
// numbers that only the physics layer cares about.
// ---------------------------------------------------------------------------

export const PHYSICS = {
  /**
   * Gap the KinematicCharacterController preserves between the capsule and everything else.
   * Must be > 0 for numerical stability, and small enough not to look like hovering.
   */
  characterOffset: 0.02,
  /** kg. Only used when the character pushes dynamic bodies. */
  characterMass: 80,
  /** Minimum free width required beyond a step before the controller will auto-step onto it. */
  autostepMinWidth: 0.25,
  /** Friction of the terrain heightfield collider. */
  terrainFriction: 1.0,
  /**
   * Backstop: if the capsule centre ends up this far *below* `IWorld.sampleHeight`, it has
   * tunnelled through the terrain and gets snapped back to the surface. Should never fire.
   */
  rescueDepth: 5,
  /** The character is kept this far inside the heightfield's outer edge (it has no walls). */
  boundsMargin: 2,
  /** Half-width, in metres, of the terrain wireframe window drawn around the player on F1. */
  debugWireframeRadius: 56,
  /** Hard cap on debug line segments so F1 can never tank the frame rate. */
  debugMaxSegments: 40_000,
  /** How far the player must move before the F1 terrain wireframe window is rebuilt. */
  debugRebuildDistance: 8,
  /** Sample count for the `sampleHeight`-vs-raycast agreement test (PLAN.md §Risks 1). */
  samplerTestPoints: 1000,
  /** Metres. Above this the agreement test warns (bilinear vs triangulated surface). */
  samplerTolerance: 0.01,
  /** Metres. Above this the disagreement is a row/column-order bug, not interpolation. */
  samplerConventionThreshold: 1.0,
} as const;

// ---------------------------------------------------------------------------
// WS3 additions — input, locomotion feel, balance/tumble, avatar and camera rig.
// Appended as new blocks rather than as keys inside PLAYER/CAMERA so that two workstreams editing
// this file never touch the same lines. Nothing above was changed.
// ---------------------------------------------------------------------------

export const INPUT = {
  /** Radians of yaw/pitch per pixel of pointer movement. */
  lookSensitivity: 0.0035,
  /** Poll `navigator.getGamepads()` — free when nothing is plugged in. */
  gamepadEnabled: true,
  /** Sticks below this magnitude read as zero. */
  gamepadDeadzone: 0.18,
  /** Right stick → look, expressed in the same "pixels" unit as the pointer, per second. */
  gamepadLookPixelsPerSecond: 900,
} as const;

export const LOCOMOTION = {
  /** Exponential approach rate for horizontal velocity while grounded / airborne. */
  groundAccelLambda: 14,
  airAccelLambda: 14 * PLAYER.airControl,
  /** A Space press stays queued this long, so jumping just before landing still fires. */
  jumpBufferSeconds: 0.15,
  /** Grace period after walking off a ledge during which a jump is still allowed. */
  coyoteSeconds: 0.12,
  jumpStaminaCost: 0.06,
  /** Sprint cannot start below this stamina... */
  sprintStaminaFloor: 0.05,
  /** ...and once exhausted, stamina must climb back to here before sprinting is allowed again. */
  sprintResumeStamina: 0.25,
  /** Downward speed clamp, m/s. */
  terminalVelocity: 60,
  /** Fraction of speed lost when climbing straight up the steepest walkable slope. */
  slopeSlowdown: 0.75,
  /** Extra stamina drain multiplier while sprinting uphill. */
  sprintSlopeScale: 1.6,
  /** Speed multiplier while wading below sea level. */
  wadeSpeedScale: 0.35,
  /** Stick/keyboard magnitudes below this count as "no input". */
  moveDeadzone: 0.01,
} as const;

export const BALANCE = {
  /** Balance recovered per second on safe ground. */
  regenPerSecond: 0.45,
  /** Balance lost per second at maximum steepness and full speed. */
  slopeDrainPerSecond: 0.9,
  /** Slopes gentler than this never cost balance. */
  safeSlopeDeg: 40,
  /** Slope at which drain saturates. */
  criticalSlopeDeg: 62,
  /** Drain multiplier while sprinting. */
  sprintPenalty: 1.6,
  /** Drain multiplier while stamina is empty — exhaustion makes you clumsy. */
  exhaustionPenalty: 1.5,
  /** Landings faster than this (m/s) cost balance. */
  landingImpactThreshold: 12,
  /** Balance lost per m/s of impact above the threshold. */
  landingImpactScale: 0.05,
  /** A tumble always lasts at least this long... */
  tumbleMinSeconds: 0.9,
  /** ...and is force-ended after this long, so a tumble can never soft-lock the player. */
  tumbleMaxSeconds: 4,
  /** Getting back up: input is ignored, then control returns. */
  recoverSeconds: 0.7,
  /** Balance the player stands up with. */
  recoveredBalance: 0.55,
  /** Horizontal drag while rolling, per second (exponential lambda). */
  tumbleDrag: 1.2,
  /** Downhill acceleration applied while rolling, m/s². */
  tumbleSlideAccel: 9,
  /** A tumble can end once horizontal speed drops below this. */
  tumbleStopSpeed: 1.2,
} as const;

export const AVATAR = {
  /** IcosahedronGeometry subdivision. 2 = 320 tris, plenty for a flat-shaded pebble. */
  detail: 2,
  /** How fast the rendered mesh chases the 60 Hz physics position (hides fixed-step quantisation). */
  followLambda: 40,
  /** Radians of lean at full slope / acceleration. */
  leanMax: 0.35,
  leanLambda: 6,
  /** Extra spin while tumbling, rad/s. */
  tumbleSpin: 7,
  trailPoints: 48,
  trailIntervalSeconds: 0.06,
  trailMinSpeed: 1.2,
  trailFadeSeconds: 1.6,
  trailColor: 0xf2ede0,
  /** Metres of travel per full walk cycle (left + right step). */
  strideLength: 1.55,
  /** Peak leg swing at walk speed, radians. */
  legSwing: 0.72,
  /** Peak arm swing at walk speed, radians. */
  armSwing: 0.48,
  /** How fast the figure yaws to face travel. */
  headingLambda: 14,
  /** Vertical bounce at mid-stride, metres. */
  bobHeight: 0.05,
  /** Porter palette. Saturated on purpose — gray-khaki vanished against grassland. */
  cloakColor: 0x1e8f9c,
  suitColor: 0x24344a,
  packColor: 0xf0c14a,
  accentColor: 0xff5a24,
  bootColor: 0x5a2e16,
} as const;

export const CAMERA_RIG = {
  /** Fraction of `CAMERA.height` used as the look-at point above the player's centre. */
  focusHeightScale: 0.45,
  /** Never pull closer than this, even in a crevice. */
  minDistance: 1.2,
  /** Pull-in is near-instant; easing back out is slow so the camera does not pump. */
  pullInLambda: 30,
  pullOutLambda: 3.5,
  /** Poor man's sphere cast: 4 extra rays offset this far perpendicular to the boom. */
  probeRays: 4,
  probeOffset: 0.35,
  /** Degrees added to `CAMERA.fov` at full sprint. */
  sprintFovPunch: 8,
  fovLambda: 5,
  /** Boom length added while tumbling, metres. */
  tumbleDistanceBoost: 2,
  /** Camera drifts back behind the direction of travel at this rate... */
  autoAlignLambda: 1.2,
  /** ...but only when the player is not strafing hard (avoids a rotation feedback loop)... */
  autoAlignStrafeLimit: 0.35,
  /** ...and only after the player has stopped moving the pointer for this long. */
  autoAlignIdleSeconds: 0.5,
} as const;

// ---------------------------------------------------------------------------
// WS6 additions — the four signature features: the cairn network, timefall, the Odradek scan and
// photo mode. Appended as four new blocks; nothing above was changed. Colours are 0xRRGGBB.
// ---------------------------------------------------------------------------

/** The cairn network: player-placed markers, their persistence, and the phantom travelers. */
export const CAIRN = {
  /** Hard cap on cairns in the world at once. The oldest player cairn is evicted past this. */
  maxCairns: 64,
  /** Phantom cairns seeded at scenic points so a first-time player finds the world inhabited. */
  phantomCount: 15,
  /** Stones stacked per cairn. Also the instance multiplier on the stone `InstancedMesh`. */
  stonesPerCairn: 5,
  /** Radius (m) of the bottom stone; each stone above is `stoneTaper` times the one below. */
  stoneRadius: 0.34,
  stoneTaper: 0.82,
  /** Vertical gap between stone centres, as a fraction of the stone below's radius. */
  stoneStackFactor: 1.35,
  stoneColor: 0x6d6459,

  /** Rise-from-ground on load: how deep a cairn starts and how long it takes to emerge. */
  riseDepth: 2.2,
  riseSeconds: 2.4,
  /** Extra delay per cairn index, so they surface in a wave rather than all at once. */
  riseStagger: 0.09,

  /** The thin vertical light beam. */
  beamRadius: 0.26,
  beamHeight: 30,
  beamOpacity: 0.42,
  /**
   * A beam is a landmark, so it has to be legible at a kilometre — but at arm's length that same
   * tube fills the screen with an opaque slab and hides the stones you just stacked. Fade it in
   * over these distances (m) so the cairn itself, not its beacon, is what you see up close.
   */
  beamNearFadeStart: 3,
  beamNearFadeEnd: 13,
  beamFarFadeStart: 420,
  beamFarFadeEnd: 1100,
  /** Resting beam/capstone brightness, and the multiplier an Odradek ping adds on top. */
  glowBase: 0.55,
  pingGain: 2.2,
  pingSeconds: 1.4,
  capstoneRadius: 0.16,
  /** Warm for cairns you placed, cold for the ones that were already here. */
  colorPlayer: 0xffcf8a,
  colorGhost: 0x8fc8ff,

  /** Walking inside this radius (m) reveals a cairn's message... */
  messageRadius: 13,
  /** ...and you must get this many times further away before it can be shown again. */
  messageRearmScale: 1.7,
  /** Refuse to place a new cairn within this many metres of an existing one. */
  minSpacing: 9,
  /** Seconds between accepted placements, so a held key cannot spam the world. */
  placeCooldown: 0.35,
  /** How far ahead of the player (m) a new cairn is stacked. */
  placeReach: 3.2,

  /** Scenic-point search: vertex stride of the coarse scan and the local-maximum window. */
  scenicStride: 6,
  scenicWindow: 3,
  /** Phantom cairns are kept at least this far apart (m). */
  scenicSeparation: 165,
  /** Ground steeper than this (degrees) is never chosen — nobody stacks stones on a cliff. */
  scenicMaxSlopeDeg: 28,
  /** Phantoms must stand at least this far above sea level. */
  scenicMinAltitude: 3,
  /** Share of the phantoms reserved for river sites (confluences, mouths, fords). */
  scenicRiverShare: 0.35,

  /** localStorage key prefix; the world seed is appended so two seeds never share cairns. */
  storageKey: "strandfall.cairns",
  storageVersion: 1,
} as const;

/** Timefall: drifting rain cells, the haze wall you see coming, and the high-altitude blizzard. */
export const WEATHER = {
  /** Cells alive at once. Each is a soft-edged disc drifting downwind across the island. */
  cellCount: 3,
  cellRadiusMin: 230,
  cellRadiusMax: 470,
  cellStrengthMin: 0.55,
  cellStrengthMax: 1,
  /** Fraction of the radius over which a cell fades in — a hard edge reads as a bug. */
  cellEdgeSoftness: 0.42,
  /**
   * Drift speed (m/s). 17 m/s crosses the 2048 m island in ~2 minutes, which is PLAN.md's
   * acceptance criterion. Cells deliberately move faster than the reported surface wind.
   */
  cellDriftSpeed: 17,
  /** Extra metres past the island edge a cell travels before it is recycled upwind. */
  cellRecycleMargin: 260,
  /**
   * One cell starts this far upwind of the player: near enough that the first timefall is not a
   * ten-minute wait, far enough that you watch it cross the valley for a minute before it lands.
   */
  firstCellDistance: 1400,

  /** Surface wind reported on `weather:changed`: calm baseline → full gale inside a cell. */
  windBreeze: 1.7,
  windGale: 8.5,
  /** Radians per second the prevailing wind direction wanders. */
  windTurnRate: 0.05,

  /** Ground wetting: fast to soak, slow to dry (exponential `damp` lambdas). */
  wetRiseLambda: 0.3,
  wetDryLambda: 0.055,
  wetMax: 0.95,
  /** Snow wets the ground far less than rain does. */
  wetFromSnow: 0.25,

  /** Rain: GPU streaks wrapped inside a box that follows the camera. One draw call. */
  rainCount: 5200,
  rainBox: [58, 34, 58] as const,
  rainFallSpeed: 26,
  rainStreakLength: 1.6,
  rainColor: 0xbcd3e6,
  rainOpacity: 0.3,
  /** Streaks start fading this far from the camera so the box edge is never visible. */
  rainFadeStart: 14,

  /** Snow: the same box, as slower, larger, drifting flakes. */
  snowCount: 3000,
  snowBox: [54, 30, 54] as const,
  snowFallSpeed: 2.6,
  snowColor: 0xf3f8ff,
  snowOpacity: 0.85,
  snowPointSize: 3.4,
  snowFadeStart: 10,
  /** Lateral wander of a flake, in metres and radians per second. */
  snowSwayAmplitude: 0.9,
  snowSwaySpeed: 0.7,

  /** Rain becomes snow across this altitude band, centred on `WORLD.snowLine`. */
  snowBandBelow: 70,
  snowBandAbove: 15,

  /**
   * The approaching wall of haze: an open, slightly flared shell drawn at each cell's boundary.
   * The flare matters — a straight cylinder reads as a box in the sky, a cone reads as a squall.
   */
  curtainHeight: 380,
  curtainTopFlare: 1.3,
  curtainSegments: 32,
  /**
   * Deliberately darker than `rainFogColor`: at a kilometre the fog has already washed most of the
   * contrast out of anything sky-coloured, so a storm has to be a *dark* wall to be legible at all.
   */
  curtainOpacity: 0.85,
  curtainColor: 0x5d6a78,
  /** The curtain fades out between these multiples of the cell radius as you step inside it. */
  curtainInsideFade: [1.15, 0.7] as const,

  /** Visibility collapse. Fog is pulled in toward these values as rain / snow saturate. */
  rainFogFar: 620,
  blizzardFogFar: 95,
  fogNearFactor: 0.12,
  rainFogColor: 0x9aa6b2,
  blizzardFogColor: 0xe6edf5,
  /** How far the fog colour is allowed to move toward the storm colour (1 = fully). */
  fogColorMix: 0.8,

  /** `weather:changed` is emitted on this interval, or sooner if a value moves by `emitDelta`. */
  emitIntervalSeconds: 1.2,
  emitDelta: 0.04,
} as const;

/** The Odradek scan pulse. The ring itself is drawn by WS4's terrain shader. */
export const SCANNER = {
  /** How far the ring travels (m) and how fast (m/s). 300 m at 150 m/s = a 2 s sweep. */
  maxRadius: 300,
  speed: 150,
  /** Seconds after a pulse finishes before another can be fired. */
  cooldown: 0.4,
  /** The pulse originates at the player's feet, lifted slightly so it clears the ground. */
  originLift: 0.4,
} as const;

/** Photo mode: frozen time, a free camera, a filmic grade and a PNG export. */
export const PHOTO = {
  /** Free-fly speed (m/s) and the multiplier while Shift is held. */
  moveSpeed: 16,
  boostMultiplier: 3.5,
  /** Exponential approach rate of the camera toward its target velocity — heavier than the player. */
  moveDamp: 7,
  /** Radians of look per pixel of pointer movement. */
  lookSensitivity: 0.0028,
  lookDamp: 22,
  /** Pitch is clamped just short of straight up/down so the horizon never flips. */
  maxPitch: 1.5,
  /** The camera is kept inside the island footprint plus this margin, and below this altitude. */
  boundsMargin: 200,
  maxAltitude: 900,
  minAltitude: -30,

  /** Grade: fraction of the frame height each letterbox bar covers. */
  letterbox: 0.11,
  /** Vignette: strength at the corners, and the normalised radius where it starts. */
  vignetteStrength: 0.62,
  vignetteRadius: 0.55,
  /** Multiplied into the shadows for a cool filmic toe. */
  shadowTint: 0x93a7bd,
  shadowTintStrength: 0.22,
  /** Exposure multiplier applied to the renderer while photo mode is active. */
  exposure: 1.06,

  /** Downloaded file name prefix. The seed and a timestamp are appended. */
  fileNamePrefix: "strandfall",
} as const;

// ---------------------------------------------------------------------------
// WS8 additions — the Low / Medium / High presets the pause menu selects between.
// `QualitySystem` is the only reader; every value here is a tuning dial, not a contract.
// ---------------------------------------------------------------------------

export interface QualityPreset {
  /** Upper bound on `devicePixelRatio`. The single biggest fragment-cost lever on a laptop. */
  pixelRatio: number;
  /** Whether the shadow pass runs at all. */
  shadows: boolean;
  /** Shadow map resolution, applied to the sun's cascade. Ignored when `shadows` is false. */
  shadowMapSize: number;
  /**
   * Multiplier on the fog distances WS4's sky (and WS6's weather) ask for. Below 1 the world
   * closes in, which both looks like weather and hides the terrain the far plane then discards.
   */
  fogScale: number;
  /**
   * Multiplier on every vegetation layer's draw radius. Instance count scales with the SQUARE of
   * this, so 0.6 draws roughly a third of the grass.
   */
  vegetationScale: number;
  /**
   * Pull the camera's far plane in to just past the fog. Safe only when the fog is dense enough
   * that everything beyond it is already solid fog colour, so it is a Low-preset trick.
   */
  cullToFog: boolean;
}

export const QUALITY: Readonly<
  Record<"low" | "medium" | "high", QualityPreset>
> = {
  low: {
    pixelRatio: 1,
    shadows: false,
    shadowMapSize: 1024,
    fogScale: 0.5,
    vegetationScale: 0.55,
    cullToFog: true,
  },
  medium: {
    pixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 1024,
    fogScale: 0.8,
    vegetationScale: 0.8,
    cullToFog: false,
  },
  high: {
    pixelRatio: PERF.maxPixelRatio,
    shadows: true,
    shadowMapSize: RENDER.shadowMapSize,
    fogScale: 1,
    vegetationScale: 1,
    cullToFog: false,
  },
} as const;

/** How far past the fog's far plane the camera is allowed to see when `cullToFog` is on. */
export const QUALITY_FAR_PAD = 1.04;

// ---------------------------------------------------------------------------
// Landmarks — authored fragments sitting on the procedural island.
// Naqsh-e Jahan is near-real scale (a few minutes to walk), compressed just
// enough that it still fits north of a river on the 2 km island.
// ---------------------------------------------------------------------------

export const ISFAHAN = {
  plazaLength: 400,
  plazaWidth: 128,
  /** Shop depth on each side of the plaza, metres. */
  arcadeDepth: 9,
  /** Shah Mosque footprint south of the arcade, metres. */
  mosqueDepth: 52,
  /** Qeysarieh / bazaar stub north of the arcade, metres. */
  bazaarDepth: 36,
  /** Soft blend from plaza plateau back to raw terrain. */
  apron: 40,
  /** Gap from the river bank to the mosque's south wall. */
  riverGap: 70,
  minAboveSea: 14,
  maxHeight: 190,
  /** Keep the stamp this far inside the island rim. */
  edgeMargin: 90,
  portalWidth: 14,
  module: 8,
  /** Two-storey arcade bay height, metres. */
  bayHeight: 11.2,
  /** Walkable rectangular opening under each pointed arch, metres. */
  archClearance: 3.6,
  /** Clear width of the ground-floor arch, metres. */
  archWidth: 5.2,
  /** Collider / visual pier thickness each side of the arch, metres. */
  pierWidth: 1.4,
  /** Buff Safavid brick — the square is beige, not terracotta. */
  beige: 0xd6c4a4,
  beigeDeep: 0xc4ae86,
  plazaBeige: 0xd4b07c,
  /** Place a fanous every N arcade bays along the inner pavement. */
  lampEveryBays: 2,
  /** Flame height above the plaza, metres. */
  lampFlameY: 3.15,
  /** Inset from the arcade centreline toward the plaza, metres. */
  lampInset: 6.4,
  lampBrass: 0xb08a3a,
  lampFlame: 0xffc070,
  lampIntensity: 4.4,
  lampDistance: 32,
  /** How many real PointLights follow the nearest lanterns. */
  lampLightPool: 10,
} as const;

/** Proximity lore around Naqsh-e Jahan: plaques, NPCs, and the E-to-read prompt. */
export const LORE = {
  /** Metres. Inside this, E opens the fact. */
  interactRadius: 4,
  /** Metres. Inside this, the HUD shows "E read / listen". */
  promptRadius: 5.5,
  npcBobMetres: 0.025,
  npcLookLambda: 6,
} as const;
