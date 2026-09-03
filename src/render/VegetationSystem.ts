/**
 * src/render/VegetationSystem.ts
 *
 * Contents: WS5's renderer. Owns the procedural geometry and materials for the three scatter
 * layers (wind-bent instanced grass, biome-placed rocks, shoreline driftwood), the incremental
 * cell-streaming machinery that keeps them populated around the player, the GLSL injected into
 * their materials for wind and distance fade, and the physics colliders given to nearby rocks.
 *
 * Purpose: this is the "how it is drawn" half of WS5; `src/world/scatter.ts` is the "where it goes"
 * half. Everything here is procedural — no textures or meshes are downloaded — and everything is
 * instanced, so the entire vegetation pass costs **6 draw calls** regardless of instance count.
 *
 * Design notes (the parts that are not obvious):
 *
 *   1. ONE `InstancedMesh` PER GEOMETRY VARIANT, NOT PER CHUNK. A per-chunk mesh would let the GPU
 *      frustum-cull chunks, but it also multiplies draw calls by the number of live chunks and blows
 *      PLAN.md's 150-call budget (Risk #3). Because every layer is a disc centred on the player,
 *      whole-mesh culling would never fire anyway, so `frustumCulled` is off and the vertex shader
 *      eats the ~60 % of instances that are behind the camera. That is the right trade at this
 *      vertex count and the wrong one at 256 separate meshes.
 *
 *   2. TWO SEPARATE CLOCKS. Generating a cell means thousands of `sampleHeight`/`sampleBiome` calls,
 *      so cells are generated at most `VEGETATION.cellBudgetMs` worth per frame, nearest first, and
 *      cached. Repacking the instance matrices is comparatively cheap and only happens once the
 *      player has moved `VEGETATION.rebuildEpsilon` metres. Neither ever runs long enough to hitch.
 *
 *   3. POP-FREE BY CONSTRUCTION. The CPU keeps every instance within `radius + rebuildEpsilon` of
 *      the last repack anchor; the vertex shader scales instances to zero over the last
 *      `fadeBand` metres measured from `uVegCenter`, which tracks the player *every* frame. Since
 *      the anchor and the player differ by at most `rebuildEpsilon`, anything the shader would draw
 *      is guaranteed to be in the buffer — so there is no radius at which an instance can appear or
 *      vanish at non-zero size.
 *
 *   4. ALPHA-TESTED, NEVER ALPHA-BLENDED (PLAN.md WS5) and `MeshLambertMaterial` rather than
 *      `MeshStandardMaterial` — grass is the most fragment-bound thing in the scene and PBR buys
 *      nothing on a blade of grass.
 */

import * as THREE from 'three';
import { QUALITY, VEGETATION, WORLD } from '../config/world.config';
import type { GameContext, IWorld, System } from '../core/types';
import type { Unsubscribe } from '../core/EventBus';
import { hash2, mulberry32 } from '../utils/math';
import { perf } from '../utils/Perf';
import {
  CHUNK_SIZE,
  DRIFTWOOD_RULES,
  GRASS_RULES,
  ROCK_RULES,
  SCATTER,
  arealDensity,
  cellKey,
  generateScatterCell,
} from '../world/scatter';
import type { ScatterCell, ScatterRules } from '../world/scatter';

const GRASS = VEGETATION.grass;
const ROCKS = VEGETATION.rocks;
const WOOD = VEGETATION.driftwood;

/** Hard ceiling on any single instance buffer, so a bad config value cannot allocate a gigabyte. */
const MAX_INSTANCES = 65_536;

/** Slack on a per-variant buffer, since variant assignment is random rather than perfectly even. */
const VARIANT_HEADROOM = 1.7;

/** Cells are kept cached this much further out than they are drawn, to prefetch and to avoid thrash. */
const KEEP_MARGIN = 1.0;

// ===========================================================================
// Shader injection — distance fade (all layers) + wind bend and tint (grass)
// ===========================================================================

/**
 * The uniform objects shared by every vegetation material. `uVegTime` is the engine-owned
 * `ctx.uniforms.uTime` assigned by reference (WS0_STATUS §Deviations 1), so nothing has to be
 * written per frame for the wind to animate.
 */
interface VegetationUniforms {
  uVegTime: { value: number };
  uVegCenter: { value: THREE.Vector3 };
  uVegWind: { value: THREE.Vector2 };
  /** x = strength, y = temporal frequency, z = wave spatial scale, w = gust spatial scale. */
  uVegWindParams: { value: THREE.Vector4 };
  uVegTintA: { value: THREE.Color };
  uVegTintB: { value: THREE.Color };
}

interface FadeUniform {
  /** x = distance at which the fade starts, y = 1 / fade band width. */
  uVegFade: { value: THREE.Vector2 };
}

interface InjectionOptions {
  wind: boolean;
  tint: boolean;
}

function vertexHead(opts: InjectionOptions): string {
  const lines = ['uniform vec3 uVegCenter;', 'uniform vec2 uVegFade;'];
  if (opts.wind) {
    lines.push('uniform float uVegTime;', 'uniform vec2 uVegWind;', 'uniform vec4 uVegWindParams;');
  }
  if (opts.tint) {
    lines.push('uniform vec3 uVegTintA;', 'uniform vec3 uVegTintB;', 'varying vec3 vVegTint;');
  }
  return lines.join('\n');
}

function vertexBody(opts: InjectionOptions): string {
  const lines = [
    'vec3 transformed = vec3( position );',
    '#ifdef USE_INSTANCING',
    '\tvec3 vegOrigin = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;',
    '#else',
    '\tvec3 vegOrigin = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;',
    '#endif',
    // Shrink toward the instance origin (which sits at ground level) rather than clipping, so the
    // far edge of the field dissolves instead of popping.
    'float vegFade = 1.0 - clamp( ( length( vegOrigin.xz - uVegCenter.xz ) - uVegFade.x ) * uVegFade.y, 0.0, 1.0 );',
    'vegFade = vegFade * vegFade * ( 3.0 - 2.0 * vegFade );',
  ];

  if (opts.wind) {
    lines.push(
      // Local geometry is a unit-height blade, so `position.y` is already the 0..1 bend weight.
      // Squaring it anchors the base and throws the motion into the tip.
      'float vegBend = position.y * position.y;',
      'float vegWindLen = length( uVegWind );',
      'vec2 vegWindDir = vegWindLen > 1e-4 ? uVegWind / vegWindLen : vec2( 1.0, 0.0 );',
      // A travelling wave along the wind direction reads as a gust crossing the field; the second
      // harmonic keeps it from looking like a sine.
      'float vegPhase = dot( vegOrigin.xz, vegWindDir ) * uVegWindParams.z + uVegTime * uVegWindParams.y;',
      'float vegSway = sin( vegPhase ) + 0.35 * sin( vegPhase * 2.17 + 1.3 );',
      'float vegGust = 0.5 + 0.5 * sin( dot( vegOrigin.xz, vec2( 0.71, 0.43 ) ) * uVegWindParams.w + uVegTime * 0.35 );',
      'float vegAmp = uVegWindParams.x * ( 0.4 + 0.6 * vegGust ) * min( 1.6, 0.35 + vegWindLen * 0.45 );',
      'transformed.xz += vegWindDir * ( vegSway * vegAmp * vegBend );',
      // Bending must not stretch the blade, or tall grass visibly grows as it leans.
      'transformed.y -= abs( vegSway ) * vegAmp * vegBend * 0.22;',
    );
  }

  if (opts.tint) {
    lines.push(
      'float vegHash = fract( sin( dot( vegOrigin.xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );',
      'vVegTint = mix( uVegTintA, uVegTintB, vegHash );',
    );
  }

  lines.push('transformed *= vegFade;');
  return lines.join('\n\t');
}

/** The one line guaranteed to exist in every lit material's `main()`, and our fragment hook. */
const DIFFUSE_INIT = 'vec4 diffuseColor = vec4( diffuse, opacity );';

/**
 * Patch wind / fade / tint into a stock three material.
 *
 * @param material  the material to patch, in place.
 * @param uniforms  shared uniform objects, assigned by reference so `.value` writes are enough.
 * @param fade      this layer's fade window.
 * @param opts      which effects to inject.
 *
 * @complexity O(1) at call time; the string surgery runs once per compiled program.
 */
function injectVegetationShader(
  material: THREE.Material,
  uniforms: VegetationUniforms,
  fade: FadeUniform,
  opts: InjectionOptions,
): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, fade);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexHead(opts)}`)
      .replace('#include <begin_vertex>', vertexBody(opts));
    if (opts.tint) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vVegTint;')
        .replace(DIFFUSE_INIT, `${DIFFUSE_INIT}\n\tdiffuseColor.rgb *= vVegTint;`);
    }
  };
  // Without this, three would hand a patched material the cached program of an unpatched one.
  material.customProgramCacheKey = () => `veg|${opts.wind ? 'w' : ''}${opts.tint ? 't' : ''}`;
}

// ===========================================================================
// Procedural geometry
// ===========================================================================

/**
 * A three-plane cross-quad, 1 unit tall and `GRASS.quadAspect` units wide, origin at the base.
 * Planes are spread over 180° (not 360°) because the quads are double-sided, so three of them
 * already cover every viewing direction evenly.
 *
 * Normals are biased hard toward +Y: a physically-correct plane normal makes side-on blades read as
 * black slabs, whereas shading grass roughly like the ground under it is the standard cheat and
 * looks right from every angle.
 *
 * @complexity 12 vertices, 6 triangles per instance.
 */
function createGrassGeometry(): THREE.BufferGeometry {
  const planes = 3;
  const positions = new Float32Array(planes * 4 * 3);
  const normals = new Float32Array(planes * 4 * 3);
  const uvs = new Float32Array(planes * 4 * 2);
  const indices: number[] = [];

  const halfWidth = GRASS.quadAspect * 0.5;
  // [localX, localY] of the quad corners, counter-clockwise from the bottom-left.
  const corners: ReadonlyArray<readonly [number, number]> = [
    [-halfWidth, 0],
    [halfWidth, 0],
    [halfWidth, 1],
    [-halfWidth, 1],
  ];

  for (let p = 0; p < planes; p++) {
    const angle = (p / planes) * Math.PI;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const base = p * 4;

    const nx = -s * 0.35;
    const nz = c * 0.35;
    const nl = Math.hypot(nx, 1, nz);

    for (let i = 0; i < 4; i++) {
      const [lx, ly] = corners[i];
      const v3 = (base + i) * 3;
      positions[v3] = lx * c;
      positions[v3 + 1] = ly;
      positions[v3 + 2] = lx * s;
      normals[v3] = nx / nl;
      normals[v3 + 1] = 1 / nl;
      normals[v3 + 2] = nz / nl;
      const v2 = (base + i) * 2;
      uvs[v2] = lx / GRASS.quadAspect + 0.5;
      uvs[v2 + 1] = ly;
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

/** Deterministic 0..1 hash of a vertex position. */
function hashPosition(x: number, y: number, z: number, salt: number): number {
  const xi = Math.round(x * 1024);
  const yi = Math.round(y * 1024);
  const zi = Math.round(z * 1024);
  return hash2(hash2(xi, yi), zi ^ salt) / 4294967296;
}

/**
 * A low-poly boulder: an icosahedron pushed around by a position hash, squashed, tilted, and
 * translated so its lowest point sits at y = 0.
 *
 * The displacement is keyed off the *position* rather than the vertex index because
 * `IcosahedronGeometry` is non-indexed — every face carries its own copy of each corner, so a
 * per-vertex random value would tear the hull apart along every edge.
 *
 * @param variant 0 gets one subdivision (80 triangles, the hero boulder); 1 and 2 stay at 20.
 * @complexity 20–80 triangles per instance.
 */
function createRockGeometry(variant: number, seed: number): THREE.BufferGeometry {
  const detail = variant === 0 ? 1 : 0;
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const rng = mulberry32(seed ^ (variant * 0x9e3779b1));
  const salt = (rng() * 0xffffffff) | 0;

  const squashY = 0.52 + rng() * 0.26;
  const bulgeX = 0.85 + rng() * 0.4;
  const roughness = 0.22 + rng() * 0.22;

  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const k = 1 + (hashPosition(x, y, z, salt) - 0.5) * 2 * roughness;
    pos.setXYZ(i, x * k * bulgeX, y * k * squashY, z * k);
  }
  pos.needsUpdate = true;

  // A baked tilt per variant means Y rotation alone is enough to make the field look unaligned,
  // which keeps the per-instance transform down to 8 floats (see SCATTER in scatter.ts).
  geo.rotateX((rng() - 0.5) * 0.5);
  geo.rotateZ((rng() - 0.5) * 0.5);

  geo.computeBoundingBox();
  const minY = geo.boundingBox?.min.y ?? 0;
  geo.translate(0, -minY, 0);

  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * A weathered log lying along local X, resting on the ground. Length scales with the instance's
 * XZ scale and thickness with its baked radius, so a single Y rotation aims it convincingly.
 *
 * @complexity ~24 triangles per instance.
 */
function createDriftwoodGeometry(variant: number, seed: number): THREE.BufferGeometry {
  const rng = mulberry32(seed ^ (variant * 0x85ebca6b));
  const rTop = 0.07 + rng() * 0.05;
  const rBot = 0.11 + rng() * 0.07;
  const geo = new THREE.CylinderGeometry(rTop, rBot, 1, 6, 1, false);
  geo.rotateZ(Math.PI / 2);
  geo.rotateX((rng() - 0.5) * 0.6);
  geo.translate(0, rBot * 0.8, 0);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * The grass alpha mask, drawn once into a 2D canvas: a handful of tapered blades, white at the tip
 * and dark at the base so the texture supplies the vertical shading gradient for free.
 *
 * Procedural rather than downloaded, per PLAN.md's "no asset pipeline" decision — this costs one
 * 64×128 canvas at startup and nothing at runtime.
 */
function createBladeTexture(): THREE.CanvasTexture {
  // 2:1 and power-of-two, to stay close to the quad's aspect without giving up cheap mipmaps.
  const w = 256;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('[vegetation] 2D canvas context unavailable');

  g.clearRect(0, 0, w, h);
  const rng = mulberry32(0x9e37c1a5);
  const blades = 12;

  for (let i = 0; i < blades; i++) {
    const baseX = ((i + 0.5) / blades) * w + (rng() - 0.5) * 14;
    const tipX = baseX + (rng() - 0.5) * 62;
    const tipY = h * (0.05 + rng() * 0.34);
    const halfW = 2.2 + rng() * 2.6;
    const ctrlX = (baseX + tipX) * 0.5 + (rng() - 0.5) * 22;
    const ctrlY = h * 0.45;

    // Dark at the root, bright at the tip: this gradient is the whole of the grass's vertical
    // shading, which is why the vertex shader does not add an ambient-occlusion term of its own.
    const grad = g.createLinearGradient(0, h, 0, tipY);
    grad.addColorStop(0, 'rgb(168,168,168)');
    grad.addColorStop(0.55, 'rgb(216,216,216)');
    grad.addColorStop(1, 'rgb(255,255,255)');
    g.fillStyle = grad;

    g.beginPath();
    g.moveTo(baseX - halfW, h);
    g.quadraticCurveTo(ctrlX - halfW * 0.5, ctrlY, tipX, tipY);
    g.quadraticCurveTo(ctrlX + halfW * 0.5, ctrlY, baseX + halfW, h);
    g.closePath();
    g.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

// ===========================================================================
// ScatterLayer — cell cache + instance buffers for one kind of prop
// ===========================================================================

interface WantedCell {
  cx: number;
  cz: number;
  key: number;
  /** Squared distance from the player to the cell centre; the generation priority. */
  d2: number;
}

interface LayerSpec {
  rules: ScatterRules;
  /** Instances further than this from the repack anchor are dropped. */
  radius: number;
  /** Metres over which instances shrink to nothing at the edge of `radius`. */
  fadeBand: number;
  /** The layer's fade uniform, so a quality change can move the shader edge with the cull edge. */
  fade: FadeUniform;
  geometries: THREE.BufferGeometry[];
  material: THREE.Material;
  castShadow: boolean;
  receiveShadow: boolean;
}

/**
 * Writes a translation · Y-rotation · non-uniform-scale matrix straight into an instance buffer.
 *
 * Column-major, matching `Matrix4.elements`. Written out longhand rather than via
 * `Matrix4.compose` because this is the inner loop of every repack: composing 11 000 grass
 * matrices through `Quaternion`/`Matrix4` costs roughly 4× what 16 stores do.
 *
 * @complexity O(1) — 16 stores, no allocation, no trigonometry.
 */
function writeInstanceMatrix(
  target: Float32Array,
  offset: number,
  x: number,
  y: number,
  z: number,
  scaleXZ: number,
  scaleY: number,
  cos: number,
  sin: number,
): void {
  target[offset] = cos * scaleXZ;
  target[offset + 1] = 0;
  target[offset + 2] = -sin * scaleXZ;
  target[offset + 3] = 0;
  target[offset + 4] = 0;
  target[offset + 5] = scaleY;
  target[offset + 6] = 0;
  target[offset + 7] = 0;
  target[offset + 8] = sin * scaleXZ;
  target[offset + 9] = 0;
  target[offset + 10] = cos * scaleXZ;
  target[offset + 11] = 0;
  target[offset + 12] = x;
  target[offset + 13] = y;
  target[offset + 14] = z;
  target[offset + 15] = 1;
}

/**
 * One scatter kind: a cache of generated cells around the player and one `InstancedMesh` per
 * geometry variant that those cells are repacked into.
 */
class ScatterLayer {
  readonly rules: ScatterRules;
  readonly meshes: THREE.InstancedMesh[] = [];

  /** True once a cell has been generated or evicted, forcing a repack even if the player is still. */
  private cellsChanged = true;
  /** Sticky "the cell set changed" signal, consumed by the collider rebuild. */
  private generated = true;

  private readonly cells = new Map<number, ScatterCell>();
  private readonly wanted: WantedCell[] = [];
  private readonly liveCounts: number[];
  /** `instanceMatrix.array` per variant, hoisted out of the repack inner loop. */
  private readonly matrixArrays: Float32Array[] = [];

  private cullRadius: number;
  private cullRadiusSq: number;
  private readonly keepRadius: number;
  private readonly pruneRadiusSq: number;
  private readonly variantCapacity: number;

  /** Full-quality values, so a scale change is always applied to the base rather than compounded. */
  private readonly baseRadius: number;
  private readonly baseFadeBand: number;
  private readonly fade: FadeUniform;
  private radiusScale = 1;

  private wantedCellX = Number.NaN;
  private wantedCellZ = Number.NaN;
  private anchorX = Number.POSITIVE_INFINITY;
  private anchorZ = Number.POSITIVE_INFINITY;

  constructor(spec: LayerSpec) {
    this.rules = spec.rules;
    this.baseRadius = spec.radius;
    this.baseFadeBand = spec.fadeBand;
    this.fade = spec.fade;
    this.cullRadius = spec.radius + VEGETATION.rebuildEpsilon;
    this.cullRadiusSq = this.cullRadius * this.cullRadius;
    this.keepRadius = this.cullRadius + this.rules.cellSize * KEEP_MARGIN;
    const pruneRadius = this.keepRadius + this.rules.cellSize;
    this.pruneRadiusSq = pruneRadius * pruneRadius;

    const total = Math.max(
      64,
      Math.min(
        MAX_INSTANCES,
        Math.ceil(
          Math.PI *
            this.cullRadiusSq *
            arealDensity(this.rules) *
            this.rules.maxDensity *
            VEGETATION.capacityHeadroom,
        ),
      ),
    );
    const variants = spec.geometries.length;
    this.variantCapacity =
      variants > 1 ? Math.ceil((total / variants) * VARIANT_HEADROOM) : total;
    this.liveCounts = new Array<number>(variants).fill(0);

    for (const geometry of spec.geometries) {
      const mesh = new THREE.InstancedMesh(geometry, spec.material, this.variantCapacity);
      mesh.name = `veg:${this.rules.id}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = spec.castShadow;
      mesh.receiveShadow = spec.receiveShadow;
      // See design note 1: the layer is a disc centred on the player, so whole-mesh culling can
      // never fire, and letting three lazily call computeBoundingSphere() would walk every instance.
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.visible = false;
      this.meshes.push(mesh);
      this.matrixArrays.push(mesh.instanceMatrix.array as Float32Array);
    }
  }

  /** Reads and clears the "cells were added or evicted" signal. */
  takeGeneratedFlag(): boolean {
    const value = this.generated;
    this.generated = false;
    return value;
  }

  /**
   * Shrink (or restore) the drawn radius for a quality preset. Instance count falls with the
   * square of `scale`.
   *
   * The cache, the prune radius and the preallocated buffers all stay sized for full quality, so
   * raising the preset again needs nothing but a repack — no regeneration, no reallocation. The
   * shader's fade edge is moved with the cull edge, which is what keeps the change pop-free.
   */
  setRadiusScale(scale: number): void {
    const clamped = Math.min(1, Math.max(0.2, scale));
    if (clamped === this.radiusScale) return;
    this.radiusScale = clamped;

    const radius = this.baseRadius * clamped;
    this.cullRadius = radius + VEGETATION.rebuildEpsilon;
    this.cullRadiusSq = this.cullRadius * this.cullRadius;

    const band = Math.min(this.baseFadeBand, radius * 0.5);
    this.fade.uVegFade.value.set(radius - band, 1 / band);
    this.cellsChanged = true;
  }

  /** Total instances currently drawn across every variant. */
  get liveCount(): number {
    let n = 0;
    for (const c of this.liveCounts) n += c;
    return n;
  }

  addTo(scene: THREE.Scene): void {
    for (const mesh of this.meshes) scene.add(mesh);
  }

  /** Drop every cached cell — used when WS1's real world replaces the stub mid-session. */
  invalidate(): void {
    this.cells.clear();
    this.wantedCellX = Number.NaN;
    this.wantedCellZ = Number.NaN;
    this.anchorX = Number.POSITIVE_INFINITY;
    this.cellsChanged = true;
    this.generated = true;
  }

  /**
   * Recompute the set of cells that should exist, if the player has crossed a cell boundary.
   *
   * @complexity O(cells in range) — ~30 for grass — and only on a boundary crossing.
   */
  refresh(px: number, pz: number): void {
    const size = this.rules.cellSize;
    const cx = Math.floor(px / size);
    const cz = Math.floor(pz / size);
    if (cx === this.wantedCellX && cz === this.wantedCellZ) return;
    this.wantedCellX = cx;
    this.wantedCellZ = cz;

    const r = this.keepRadius;
    // A cell counts as in range if any part of it could be: centre distance minus half a diagonal.
    const reachSq = (r + size * Math.SQRT1_2) ** 2;
    const minX = Math.floor((px - r) / size);
    const maxX = Math.floor((px + r) / size);
    const minZ = Math.floor((pz - r) / size);
    const maxZ = Math.floor((pz + r) / size);

    this.wanted.length = 0;
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = (x + 0.5) * size - px;
        const dz = (z + 0.5) * size - pz;
        const d2 = dx * dx + dz * dz;
        if (d2 > reachSq) continue;
        this.wanted.push({ cx: x, cz: z, key: cellKey(x, z), d2 });
      }
    }
    // Nearest first, so the budgeted generator always fills in what the player can actually see.
    this.wanted.sort((a, b) => a.d2 - b.d2);

    this.prune(px, pz);
  }

  /** Evict cells the player has walked away from, bounding cache memory. */
  private prune(px: number, pz: number): void {
    const size = this.rules.cellSize;
    for (const [key, cell] of this.cells) {
      const dx = (cell.cx + 0.5) * size - px;
      const dz = (cell.cz + 0.5) * size - pz;
      if (dx * dx + dz * dz <= this.pruneRadiusSq) continue;
      this.cells.delete(key);
      this.cellsChanged = true;
      this.generated = true;
    }
  }

  /**
   * Generate missing cells, nearest first, until the wall-clock budget runs out.
   *
   * @returns the budget left over, so layers downstream share one frame-wide allowance.
   * @complexity O(candidatesPerCell) per cell generated; at most one cell if the budget is tight.
   */
  pump(world: IWorld, worldSeed: number, budgetMs: number): number {
    if (budgetMs <= 0) return 0;
    let remaining = budgetMs;
    for (const want of this.wanted) {
      if (this.cells.has(want.key)) continue;
      const t0 = performance.now();
      this.cells.set(
        want.key,
        generateScatterCell(world, this.rules, want.cx, want.cz, worldSeed),
      );
      this.cellsChanged = true;
      this.generated = true;
      remaining -= performance.now() - t0;
      if (remaining <= 0) break;
    }
    return Math.max(0, remaining);
  }

  /**
   * Rewrite the instance matrices if the player has moved far enough (or the cache changed).
   *
   * @returns true if a repack happened.
   * @complexity O(cached instances within the cull disc) — cells that cannot possibly contribute
   *             are rejected whole by a bounds test first, leaving ~21 000 distance tests and
   *             ~11 000 matrix writes for grass. Well under a millisecond, roughly once a second.
   */
  repackIfNeeded(px: number, pz: number): boolean {
    const dx = px - this.anchorX;
    const dz = pz - this.anchorZ;
    const eps = VEGETATION.rebuildEpsilon;
    if (!this.cellsChanged && dx * dx + dz * dz < eps * eps) return false;

    this.anchorX = px;
    this.anchorZ = pz;
    this.cellsChanged = false;
    this.liveCounts.fill(0);

    const stride = SCATTER.STRIDE;
    const size = this.rules.cellSize;
    const capacity = this.variantCapacity;
    const cullSq = this.cullRadiusSq;
    const cellReachSq = (this.cullRadius + size * Math.SQRT1_2) ** 2;
    const single = this.meshes.length === 1;

    for (const cell of this.cells.values()) {
      // Whole-cell reject: the cache reaches further than the cull radius, so most cached cells
      // contribute nothing and should never be walked instance by instance.
      const cdx = (cell.cx + 0.5) * size - px;
      const cdz = (cell.cz + 0.5) * size - pz;
      if (cdx * cdx + cdz * cdz > cellReachSq) continue;

      const data = cell.data;
      for (let i = 0, o = 0; i < cell.count; i++, o += stride) {
        const x = data[o + SCATTER.X];
        const z = data[o + SCATTER.Z];
        const ddx = x - px;
        const ddz = z - pz;
        if (ddx * ddx + ddz * ddz > cullSq) continue;

        const variant = single ? 0 : data[o + SCATTER.VARIANT] | 0;
        const slot = this.liveCounts[variant];
        if (slot >= capacity) continue;

        writeInstanceMatrix(
          this.matrixArrays[variant],
          slot * 16,
          x,
          data[o + SCATTER.Y],
          z,
          data[o + SCATTER.SCALE_XZ],
          data[o + SCATTER.SCALE_Y],
          data[o + SCATTER.COS],
          data[o + SCATTER.SIN],
        );
        this.liveCounts[variant] = slot + 1;
      }
    }

    for (let v = 0; v < this.meshes.length; v++) {
      const mesh = this.meshes[v];
      const count = this.liveCounts[v];
      mesh.count = count;
      // A zero-count InstancedMesh still issues (and is billed for) a draw call.
      mesh.visible = count > 0;
      if (count > 0) {
        // Upload only the slots actually in use rather than the whole preallocated buffer.
        mesh.instanceMatrix.addUpdateRange(0, count * 16);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    return true;
  }

  /** Iterate the cached cells — used to build physics colliders from the raw placement data. */
  eachCell(visit: (cell: ScatterCell) => void): void {
    for (const cell of this.cells.values()) visit(cell);
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
      mesh.dispose();
    }
    this.meshes.length = 0;
    this.matrixArrays.length = 0;
    this.cells.clear();
  }
}

// ===========================================================================
// VegetationSystem
// ===========================================================================

export class VegetationSystem implements System {
  readonly name = 'vegetation';

  private readonly layers: ScatterLayer[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private rockGeometries: THREE.BufferGeometry[] = [];
  private bladeTexture: THREE.CanvasTexture | null = null;
  private rocks: ScatterLayer | null = null;

  private readonly uniforms: VegetationUniforms = {
    uVegTime: { value: 0 },
    uVegCenter: { value: new THREE.Vector3() },
    uVegWind: { value: new THREE.Vector2(1, 0) },
    uVegWindParams: {
      value: new THREE.Vector4(
        GRASS.windStrength,
        GRASS.windFrequency,
        GRASS.windWaveScale,
        GRASS.gustScale,
      ),
    },
    uVegTintA: { value: new THREE.Color(GRASS.colorA) },
    uVegTintB: { value: new THREE.Color(GRASS.colorB) },
  };

  /** Latest wind we are easing toward. Weather (WS6) overrides the engine default once it lands. */
  private readonly targetWind = new THREE.Vector2(1, 0);
  private weatherDriven = false;
  private readonly subscriptions: Unsubscribe[] = [];

  private readonly colliderHandles: number[] = [];
  private readonly colliderGeometries: THREE.BufferGeometry[] = [];
  private colliderChunkX = Number.NaN;
  private colliderChunkZ = Number.NaN;
  private collidersDirty = true;

  private worldSeed: number = WORLD.seed;

  init(ctx: GameContext): void {
    this.worldSeed = ctx.world.data.seed;

    // The engine advances `uTime` every frame; sharing the object by reference means the wind
    // animates with zero per-frame CPU work on our side (WS0_STATUS §Deviations 1).
    this.uniforms.uVegTime = ctx.uniforms.uTime;

    const maxAnisotropy = ctx.renderer.capabilities.getMaxAnisotropy();

    this.layers.push(this.createGrassLayer(maxAnisotropy));
    this.rocks = this.createRockLayer();
    this.layers.push(this.rocks);
    this.layers.push(this.createDriftwoodLayer());

    for (const layer of this.layers) layer.addTo(ctx.scene);

    this.subscriptions.push(
      ctx.events.on('weather:changed', ({ wind }) => {
        this.targetWind.copy(wind);
        this.weatherDriven = true;
      }),
      // WS1 swaps in the real island; everything placed against the stub is now wrong.
      ctx.events.on('world:ready', ({ data }) => {
        this.worldSeed = data.seed;
        for (const layer of this.layers) layer.invalidate();
        this.collidersDirty = true;
      }),
      // WS8's quality presets. Only the drawn radius moves — placement stays deterministic, so
      // switching Low → High restores exactly the field that was there before.
      ctx.events.on('quality:changed', ({ level }) => {
        const scale = QUALITY[level]?.vegetationScale ?? 1;
        for (const layer of this.layers) layer.setRadiusScale(scale);
      }),
    );
  }

  private createGrassLayer(maxAnisotropy: number): ScatterLayer {
    const geometry = createGrassGeometry();
    this.bladeTexture = createBladeTexture();
    this.bladeTexture.anisotropy = Math.min(4, maxAnisotropy);

    const material = new THREE.MeshLambertMaterial({
      map: this.bladeTexture,
      // Alpha *test*, not blend: no depth sorting, no order-dependent artefacts, and the blades
      // still write depth so terrain behind them is culled normally.
      alphaTest: GRASS.alphaTest,
      transparent: false,
      side: THREE.DoubleSide,
      color: 0xffffff,
    });
    const fade: FadeUniform = {
      uVegFade: {
        value: new THREE.Vector2(GRASS.radius - GRASS.fadeBand, 1 / GRASS.fadeBand),
      },
    };
    injectVegetationShader(material, this.uniforms, fade, { wind: true, tint: true });

    this.geometries.push(geometry);
    this.materials.push(material);

    return new ScatterLayer({
      rules: GRASS_RULES,
      radius: GRASS.radius,
      fadeBand: GRASS.fadeBand,
      fade,
      geometries: [geometry],
      material,
      castShadow: GRASS.castShadow,
      receiveShadow: GRASS.receiveShadow,
    });
  }

  private createRockLayer(): ScatterLayer {
    this.rockGeometries = [];
    for (let v = 0; v < ROCKS.variants; v++) {
      this.rockGeometries.push(createRockGeometry(v, this.worldSeed ^ 0x30c4));
    }
    this.geometries.push(...this.rockGeometries);

    const material = new THREE.MeshLambertMaterial({
      color: ROCKS.color,
      flatShading: true,
    });
    const fade: FadeUniform = {
      uVegFade: {
        value: new THREE.Vector2(ROCKS.radius - ROCKS.fadeBand, 1 / ROCKS.fadeBand),
      },
    };
    injectVegetationShader(material, this.uniforms, fade, { wind: false, tint: false });
    this.materials.push(material);

    return new ScatterLayer({
      rules: ROCK_RULES,
      radius: ROCKS.radius,
      fadeBand: ROCKS.fadeBand,
      fade,
      geometries: this.rockGeometries,
      material,
      castShadow: ROCKS.castShadow,
      receiveShadow: ROCKS.receiveShadow,
    });
  }

  private createDriftwoodLayer(): ScatterLayer {
    const geometries: THREE.BufferGeometry[] = [];
    for (let v = 0; v < WOOD.variants; v++) {
      geometries.push(createDriftwoodGeometry(v, this.worldSeed ^ 0x7f21));
    }
    this.geometries.push(...geometries);

    const material = new THREE.MeshLambertMaterial({
      color: WOOD.color,
      flatShading: true,
    });
    const fade: FadeUniform = {
      uVegFade: {
        value: new THREE.Vector2(WOOD.radius - WOOD.fadeBand, 1 / WOOD.fadeBand),
      },
    };
    injectVegetationShader(material, this.uniforms, fade, { wind: false, tint: false });
    this.materials.push(material);

    return new ScatterLayer({
      rules: DRIFTWOOD_RULES,
      radius: WOOD.radius,
      fadeBand: WOOD.fadeBand,
      fade,
      geometries,
      material,
      castShadow: WOOD.castShadow,
      receiveShadow: WOOD.receiveShadow,
    });
  }

  update(dt: number, ctx: GameContext): void {
    const t0 = performance.now();

    const p = ctx.player.position;
    // Tracked every frame, not per repack: this is what makes the shader fade pop-free (note 3).
    this.uniforms.uVegCenter.value.copy(p);

    if (!this.weatherDriven) this.targetWind.copy(ctx.uniforms.uWind.value);
    this.uniforms.uVegWind.value.lerp(this.targetWind, 1 - Math.exp(-1.5 * dt));

    // One frame-wide generation allowance, spent nearest-layer-first: grass is what the player is
    // standing in, so it always gets the budget before rocks and driftwood.
    let budget: number = VEGETATION.cellBudgetMs;
    for (const layer of this.layers) {
      layer.refresh(p.x, p.z);
      budget = layer.pump(ctx.world, this.worldSeed, budget);
      layer.repackIfNeeded(p.x, p.z);
    }

    if (this.rocks?.takeGeneratedFlag()) this.collidersDirty = true;
    this.syncRockColliders(ctx);

    perf.mark('veg', performance.now() - t0);
  }

  /**
   * Give the rocks nearest the player real collision, and take it away again when they are far
   * enough that the player cannot reach them before the next rebuild.
   *
   * Deliberately throttled to terrain-chunk crossings rather than the (much more frequent) instance
   * repack: building trimeshes is the single most expensive thing WS5 asks of the physics engine,
   * and PLAN.md scopes it to "rebuilt on chunk change".
   *
   * @complexity O(cached rock instances) on a chunk crossing, bounded to
   *             `VEGETATION.rocks.maxColliders` trimesh builds.
   */
  private syncRockColliders(ctx: GameContext): void {
    const rocks = this.rocks;
    if (!rocks) return;

    const p = ctx.player.position;
    const cx = Math.floor(p.x / CHUNK_SIZE);
    const cz = Math.floor(p.z / CHUNK_SIZE);
    if (!this.collidersDirty && cx === this.colliderChunkX && cz === this.colliderChunkZ) return;
    this.colliderChunkX = cx;
    this.colliderChunkZ = cz;
    this.collidersDirty = false;

    this.releaseColliders(ctx);

    const radiusSq = ROCKS.colliderRadius * ROCKS.colliderRadius;
    const stride = SCATTER.STRIDE;
    const at = new THREE.Vector3();
    let added = 0;

    rocks.eachCell((cell) => {
      if (added >= ROCKS.maxColliders) return;
      const data = cell.data;
      for (let i = 0, o = 0; i < cell.count; i++, o += stride) {
        if (added >= ROCKS.maxColliders) return;
        const scaleXZ = data[o + SCATTER.SCALE_XZ];
        // Pebbles are not worth a trimesh — the character controller steps over them anyway.
        if (scaleXZ < ROCKS.colliderMinScale) continue;

        const x = data[o + SCATTER.X];
        const z = data[o + SCATTER.Z];
        const dx = x - p.x;
        const dz = z - p.z;
        if (dx * dx + dz * dz > radiusSq) continue;

        const variant = data[o + SCATTER.VARIANT] | 0;
        const source = this.rockGeometries[variant];
        if (!source) continue;

        // `addStaticTrimesh` takes a position but no transform, so bake scale + rotation into a
        // throwaway clone. These are never uploaded to the GPU — they exist only for Rapier.
        const geom = source.clone();
        geom.scale(scaleXZ, data[o + SCATTER.SCALE_Y], scaleXZ);
        geom.rotateY(Math.atan2(data[o + SCATTER.SIN], data[o + SCATTER.COS]));

        at.set(x, data[o + SCATTER.Y], z);
        this.colliderHandles.push(ctx.physics.addStaticTrimesh(geom, at));
        this.colliderGeometries.push(geom);
        added++;
      }
    });
  }

  private releaseColliders(ctx: GameContext): void {
    for (const handle of this.colliderHandles) ctx.physics.removeCollider(handle);
    this.colliderHandles.length = 0;
    // Held until now in case the physics backend kept a view onto the geometry's buffers.
    for (const geom of this.colliderGeometries) geom.dispose();
    this.colliderGeometries.length = 0;
  }

  dispose(): void {
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions.length = 0;
    for (const layer of this.layers) layer.dispose();
    this.layers.length = 0;
    for (const geom of this.geometries) geom.dispose();
    this.geometries.length = 0;
    for (const geom of this.colliderGeometries) geom.dispose();
    this.colliderGeometries.length = 0;
    this.colliderHandles.length = 0;
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
    this.bladeTexture?.dispose();
    this.bladeTexture = null;
    this.rockGeometries = [];
    this.rocks = null;
  }
}
