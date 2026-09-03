/**
 * src/features/CairnSystem.ts
 *
 * Contents: the `CairnSystem` — WS6 feature ①, "the cairn network". Placing a cairn with `C`,
 * persisting them in `localStorage` keyed by world seed, the rise-from-the-ground animation they
 * play on load, the ~15 procedurally sited phantom cairns left by travelers who came before, the
 * proximity messages, and the light-beam / capstone glow that answers an Odradek ping.
 *
 * Purpose: give the world memory. It is the cheapest emotional beat in the game — three instanced
 * meshes and a JSON blob — and it is the only thing here that survives closing the tab.
 *
 * Cost: 3 draw calls total, regardless of cairn count (stones, capstones, beams are each one
 * `InstancedMesh` sized to `CAIRN.maxCairns`). Instance matrices are only rewritten on the frames
 * where something is actually rising or pinging.
 *
 * Integration:
 *   - reads  `ctx.input.state.actions` for `'cairn'`, `ctx.player`, `ctx.world` (heights + rivers)
 *   - emits  `cairn:placed` (WS7 draws a compass marker; dashed when `isGhost`) and `hud:toast`
 *   - listens `scan:pulse` (WS6's scanner) → cairns light up as the ring reaches them,
 *             `photo:toggle` → placement and animation freeze,
 *             `world:ready`  → re-ground everything against the real island
 *
 * Ghost semantics: every cairn that already existed when the session started — phantom *and*
 * restored-from-storage — is announced with `isGhost: true`. They are all traces of somebody who
 * is no longer here, including your past self, and it keeps a reload from firing a burst of
 * "a cairn stands here" toasts. Only a cairn stacked live this session reports `isGhost: false`.
 */

import * as THREE from 'three';
import { CAIRN, SCANNER, WORLD } from '../config/world.config';
import type { Unsubscribe } from '../core/EventBus';
import type { GameContext, IWorld, Rng, System } from '../core/types';
import { clamp01, degToRad, hashString, mulberry32, randomRange, smoothstep } from '../utils/math';

/** Where a cairn stands, which decides both its message and how it was chosen. */
type CairnKind = 'player' | 'ridge' | 'peak' | 'river';

/** The `localStorage` payload. Deliberately terse — it is rewritten on every placement. */
interface StoredCairn {
  x: number;
  z: number;
  /** Message. */
  m: string;
  /** Placement time, epoch ms. Used to evict the oldest when the world is full. */
  t: number;
}

interface StoredBlob {
  v: number;
  seed: number;
  cairns: StoredCairn[];
}

/** One stone's placement relative to its cairn's base. Computed once, then only translated. */
interface Stone {
  offset: THREE.Vector3;
  scale: THREE.Vector3;
  quat: THREE.Quaternion;
}

interface Cairn {
  position: THREE.Vector3;
  message: string;
  ghost: boolean;
  kind: CairnKind;
  stones: Stone[];
  /** 0 = still buried, 1 = fully emerged. */
  rise: number;
  riseDelay: number;
  /** Seconds until an Odradek ring arrives; 0 when nothing is inbound. */
  pingDelay: number;
  /** 1 → 0 decay of the ping highlight. */
  ping: number;
  messageShown: boolean;
  placedAt: number;
}

interface ScenicSite {
  position: THREE.Vector3;
  kind: CairnKind;
  score: number;
}

const MESSAGES: Readonly<Record<CairnKind, readonly string[]>> = {
  ridge: [
    'the highest stone. someone stood here first.',
    'nothing above this but weather.',
    'a traveler counted the peaks from here.',
  ],
  peak: [
    'a traveler rested here.',
    'they stopped to look back at the way they came.',
    'built in wind, and it held.',
    'the climb was worth it, they decided.',
  ],
  river: [
    'they filled a bottle here and went on.',
    'the crossing is easier upstream.',
    'water knows the way down. follow it.',
    'a traveler waited out the timefall here.',
  ],
  player: [
    'you were here.',
    'you stacked these stones.',
    'a mark for whoever comes next.',
  ],
};

const BEAM_VERTEX = /* glsl */ `
attribute float aGlow;
attribute vec3 aTint;

varying float vGlow;
varying vec3 vTint;
varying float vHeight;
varying float vFade;
varying vec3 vNormalView;
varying vec3 vViewDir;

uniform float uNearStart;
uniform float uNearEnd;
uniform float uFadeStart;
uniform float uFadeEnd;

void main() {
  vGlow = aGlow;
  vTint = aTint;
  vHeight = uv.y;

  #ifdef USE_INSTANCING
    vec4 local = instanceMatrix * vec4( position, 1.0 );
    vec3 localNormal = mat3( instanceMatrix ) * normal;
  #else
    vec4 local = vec4( position, 1.0 );
    vec3 localNormal = normal;
  #endif

  vec4 mvPosition = modelViewMatrix * local;
  vNormalView = normalize( normalMatrix * localNormal );
  vViewDir = normalize( -mvPosition.xyz );

  // Additive geometry cannot be fogged (fog would *add* haze colour), so beams fade out with
  // distance on their own. They are beacons, so the far range is generous; the near fade keeps a
  // beam you are standing next to from becoming an opaque wall across the view.
  float depth = -mvPosition.z;
  vFade = smoothstep( uNearStart, uNearEnd, depth ) * ( 1.0 - smoothstep( uFadeStart, uFadeEnd, depth ) );

  gl_Position = projectionMatrix * mvPosition;
}
`;

const BEAM_FRAGMENT = /* glsl */ `
uniform float uOpacity;

varying float vGlow;
varying vec3 vTint;
varying float vHeight;
varying float vFade;
varying vec3 vNormalView;
varying vec3 vViewDir;

void main() {
  // A hollow tube reads as a volume if the grazing silhouette is denser than the face-on middle.
  float rim = 1.0 - abs( dot( normalize( vNormalView ), normalize( vViewDir ) ) );
  float vertical = pow( 1.0 - vHeight, 1.8 );
  // rim² keeps the face-on middle nearly clear so the tube reads as a shaft of light rather than a
  // painted slab; the two silhouette edges carry almost all of the brightness.
  float alpha = uOpacity * vGlow * vertical * ( 0.06 + 0.94 * rim * rim ) * vFade;
  if ( alpha <= 0.002 ) discard;

  gl_FragColor = vec4( vTint * ( 0.55 + 0.75 * vGlow ), alpha );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class CairnSystem implements System {
  readonly name = 'cairn';

  private readonly cairns: Cairn[] = [];
  private readonly subscriptions: Unsubscribe[] = [];

  private group: THREE.Group | null = null;
  private stoneMesh: THREE.InstancedMesh | null = null;
  private capMesh: THREE.InstancedMesh | null = null;
  private beamMesh: THREE.InstancedMesh | null = null;
  private beamGlow: THREE.InstancedBufferAttribute | null = null;
  private beamTint: THREE.InstancedBufferAttribute | null = null;

  private readonly disposables: Array<{ dispose(): void }> = [];

  private seed: number = WORLD.seed;
  private frozen = false;
  private cooldown = 0;

  // Scratch — allocated once, never in the update loop.
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpScale = new THREE.Vector3();
  private readonly tmpColor = new THREE.Color();
  private readonly colorPlayer = new THREE.Color(CAIRN.colorPlayer);
  private readonly colorGhost = new THREE.Color(CAIRN.colorGhost);
  private static readonly IDENTITY_QUAT = new THREE.Quaternion();

  init(ctx: GameContext): void {
    this.buildMeshes(ctx);
    this.rebuild(ctx);

    this.subscriptions.push(
      // WS1 generates in a worker. Today `world:ready` has already fired by the time WS6 inits, but
      // if that ever changes — or the island is regenerated — every cairn has to be re-grounded.
      ctx.events.on('world:ready', () => this.rebuild(ctx)),
      ctx.events.on('scan:pulse', ({ origin }) => this.schedulePings(origin)),
      ctx.events.on('photo:toggle', ({ active }) => {
        this.frozen = active;
      }),
    );
  }

  update(dt: number, ctx: GameContext): void {
    if (!this.frozen) {
      this.cooldown = Math.max(0, this.cooldown - dt);
      if (ctx.input.state.actions.has('cairn')) this.tryPlace(ctx);
    }

    let animating = false;
    for (const cairn of this.cairns) {
      if (this.frozen) break;

      if (cairn.rise < 1) {
        if (cairn.riseDelay > 0) cairn.riseDelay -= dt;
        else cairn.rise = clamp01(cairn.rise + dt / CAIRN.riseSeconds);
        animating = true;
      }
      if (cairn.pingDelay > 0) {
        cairn.pingDelay -= dt;
        if (cairn.pingDelay <= 0) {
          cairn.pingDelay = 0;
          cairn.ping = 1;
        }
        animating = true;
      } else if (cairn.ping > 0) {
        cairn.ping = Math.max(0, cairn.ping - dt / CAIRN.pingSeconds);
        animating = true;
      }
    }

    if (animating) this.syncInstances();
    if (!this.frozen) this.updateProximity(ctx);
  }

  dispose(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
    this.group?.removeFromParent();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.cairns.length = 0;
    this.group = null;
    this.stoneMesh = null;
    this.capMesh = null;
    this.beamMesh = null;
  }

  // -------------------------------------------------------------------------
  // Rendering resources
  // -------------------------------------------------------------------------

  private buildMeshes(ctx: GameContext): void {
    const group = new THREE.Group();
    group.name = 'cairns';
    this.group = group;

    const stoneGeom = new THREE.IcosahedronGeometry(1, 0);
    const stoneMat = new THREE.MeshStandardMaterial({
      color: CAIRN.stoneColor,
      roughness: 0.92,
      metalness: 0.02,
      flatShading: true,
    });
    const stoneMesh = new THREE.InstancedMesh(
      stoneGeom,
      stoneMat,
      CAIRN.maxCairns * CAIRN.stonesPerCairn,
    );
    stoneMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    stoneMesh.castShadow = true;
    stoneMesh.receiveShadow = true;
    stoneMesh.frustumCulled = false;
    stoneMesh.count = 0;
    this.stoneMesh = stoneMesh;
    group.add(stoneMesh);

    const capGeom = new THREE.IcosahedronGeometry(CAIRN.capstoneRadius, 1);
    const capMat = new THREE.MeshBasicMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: true,
    });
    const capMesh = new THREE.InstancedMesh(capGeom, capMat, CAIRN.maxCairns);
    capMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    capMesh.frustumCulled = false;
    capMesh.count = 0;
    // Allocate `instanceColor` up front so the first `setColorAt` is not a reallocation mid-frame.
    capMesh.setColorAt(0, this.colorGhost);
    capMesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
    this.capMesh = capMesh;
    group.add(capMesh);

    // Unit-height open tube with its base at the origin, so the instance matrix's Y scale is the
    // beam height in metres and its translation is the ground point.
    const beamGeom = new THREE.CylinderGeometry(
      CAIRN.beamRadius * 0.55,
      CAIRN.beamRadius,
      1,
      12,
      1,
      true,
    );
    beamGeom.translate(0, 0.5, 0);
    const glow = new THREE.InstancedBufferAttribute(new Float32Array(CAIRN.maxCairns), 1);
    const tint = new THREE.InstancedBufferAttribute(new Float32Array(CAIRN.maxCairns * 3), 3);
    glow.setUsage(THREE.DynamicDrawUsage);
    tint.setUsage(THREE.DynamicDrawUsage);
    beamGeom.setAttribute('aGlow', glow);
    beamGeom.setAttribute('aTint', tint);
    this.beamGlow = glow;
    this.beamTint = tint;

    const beamMat = new THREE.ShaderMaterial({
      vertexShader: BEAM_VERTEX,
      fragmentShader: BEAM_FRAGMENT,
      uniforms: {
        uOpacity: { value: CAIRN.beamOpacity },
        uNearStart: { value: CAIRN.beamNearFadeStart },
        uNearEnd: { value: CAIRN.beamNearFadeEnd },
        uFadeStart: { value: CAIRN.beamFarFadeStart },
        uFadeEnd: { value: CAIRN.beamFarFadeEnd },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const beamMesh = new THREE.InstancedMesh(beamGeom, beamMat, CAIRN.maxCairns);
    beamMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    beamMesh.frustumCulled = false;
    beamMesh.renderOrder = 2;
    beamMesh.count = 0;
    this.beamMesh = beamMesh;
    group.add(beamMesh);

    this.disposables.push(stoneGeom, stoneMat, capGeom, capMat, beamGeom, beamMat);
    ctx.scene.add(group);
  }

  // -------------------------------------------------------------------------
  // Population
  // -------------------------------------------------------------------------

  /** Wipe and repopulate from storage + the scenic sites of the current world. */
  private rebuild(ctx: GameContext): void {
    this.cairns.length = 0;
    this.seed = ctx.world.data.seed;

    const rng = mulberry32(this.seed ^ 0x6ca1c0de);
    for (const site of findScenicSites(ctx.world, CAIRN.phantomCount, rng)) {
      this.cairns.push(
        this.makeCairn(site.position, pick(MESSAGES[site.kind], rng), true, site.kind, 0),
      );
    }

    for (const stored of this.loadStored()) {
      const position = new THREE.Vector3(stored.x, ctx.world.sampleHeight(stored.x, stored.z), stored.z);
      // Still yours after a reload: `ghost` drives the warm/cold tint, not how it got here.
      this.cairns.push(this.makeCairn(position, stored.m, false, 'player', stored.t));
    }

    // Surface in a wave rather than all at once — 60 cairns erupting on the same frame reads as a
    // glitch, a staggered ripple reads as the world remembering.
    this.cairns.forEach((cairn, i) => {
      cairn.riseDelay = i * CAIRN.riseStagger;
    });

    this.syncInstances();

    for (const cairn of this.cairns) {
      ctx.events.emit('cairn:placed', { position: cairn.position.clone(), isGhost: cairn.ghost });
    }
  }

  private makeCairn(
    position: THREE.Vector3,
    message: string,
    ghost: boolean,
    kind: CairnKind,
    placedAt: number,
  ): Cairn {
    const rng = mulberry32(hashString(`${this.seed}:${position.x.toFixed(2)}:${position.z.toFixed(2)}`));
    const stones: Stone[] = [];
    let radius = CAIRN.stoneRadius;
    let y = 0;

    for (let i = 0; i < CAIRN.stonesPerCairn; i++) {
      const flat = randomRange(rng, 0.5, 0.78);
      const height = radius * flat;
      y += height;
      stones.push({
        offset: new THREE.Vector3(
          randomRange(rng, -0.25, 0.25) * radius,
          y,
          randomRange(rng, -0.25, 0.25) * radius,
        ),
        scale: new THREE.Vector3(
          radius * randomRange(rng, 0.85, 1.15),
          height,
          radius * randomRange(rng, 0.85, 1.15),
        ),
        quat: new THREE.Quaternion().setFromEuler(
          new THREE.Euler(
            randomRange(rng, -0.18, 0.18),
            randomRange(rng, 0, Math.PI * 2),
            randomRange(rng, -0.18, 0.18),
          ),
        ),
      });
      y += height;
      radius *= CAIRN.stoneTaper;
    }

    return {
      position,
      message,
      ghost,
      kind,
      stones,
      rise: 0,
      riseDelay: 0,
      pingDelay: 0,
      ping: 0,
      messageShown: false,
      placedAt,
    };
  }

  /** Total stacked height of a cairn, used to place the capstone. */
  private stackHeight(cairn: Cairn): number {
    const top = cairn.stones[cairn.stones.length - 1];
    return top ? top.offset.y + top.scale.y : 0;
  }

  // -------------------------------------------------------------------------
  // Instance buffers
  // -------------------------------------------------------------------------

  private syncInstances(): void {
    const stoneMesh = this.stoneMesh;
    const capMesh = this.capMesh;
    const beamMesh = this.beamMesh;
    const glowAttr = this.beamGlow;
    const tintAttr = this.beamTint;
    if (!stoneMesh || !capMesh || !beamMesh || !glowAttr || !tintAttr) return;

    let stoneIndex = 0;
    let cairnIndex = 0;

    for (const cairn of this.cairns) {
      if (cairnIndex >= CAIRN.maxCairns) break;

      const emerged = smoothstep(0, 1, cairn.rise);
      const sink = -CAIRN.riseDepth * (1 - emerged);
      const glow = CAIRN.glowBase * emerged * (1 + CAIRN.pingGain * cairn.ping);
      const tint = cairn.ghost ? this.colorGhost : this.colorPlayer;

      for (const stone of cairn.stones) {
        this.tmpPos.copy(cairn.position).add(stone.offset);
        this.tmpPos.y += sink;
        this.tmpMatrix.compose(this.tmpPos, stone.quat, stone.scale);
        stoneMesh.setMatrixAt(stoneIndex++, this.tmpMatrix);
      }

      this.tmpPos.copy(cairn.position);
      this.tmpPos.y += sink + this.stackHeight(cairn) + CAIRN.capstoneRadius * 0.6;
      this.tmpScale.setScalar(1 + 0.35 * cairn.ping);
      this.tmpMatrix.compose(this.tmpPos, CairnSystem.IDENTITY_QUAT, this.tmpScale);
      capMesh.setMatrixAt(cairnIndex, this.tmpMatrix);
      this.tmpColor.copy(tint).multiplyScalar(clamp01(glow));
      capMesh.setColorAt(cairnIndex, this.tmpColor);

      this.tmpPos.copy(cairn.position);
      this.tmpPos.y += sink;
      this.tmpScale.set(1, CAIRN.beamHeight, 1);
      this.tmpMatrix.compose(this.tmpPos, CairnSystem.IDENTITY_QUAT, this.tmpScale);
      beamMesh.setMatrixAt(cairnIndex, this.tmpMatrix);
      glowAttr.setX(cairnIndex, glow);
      tintAttr.setXYZ(cairnIndex, tint.r, tint.g, tint.b);

      cairnIndex++;
    }

    stoneMesh.count = stoneIndex;
    capMesh.count = cairnIndex;
    beamMesh.count = cairnIndex;
    stoneMesh.instanceMatrix.needsUpdate = true;
    capMesh.instanceMatrix.needsUpdate = true;
    beamMesh.instanceMatrix.needsUpdate = true;
    if (capMesh.instanceColor) capMesh.instanceColor.needsUpdate = true;
    glowAttr.needsUpdate = true;
    tintAttr.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  private tryPlace(ctx: GameContext): void {
    if (this.cooldown > 0) return;
    const player = ctx.player;

    if (player.isTumbling || !player.grounded) {
      ctx.events.emit('hud:toast', { text: 'you need steady ground to stack stones' });
      this.cooldown = CAIRN.placeCooldown;
      return;
    }

    // Stack it an arm's length ahead of where you stand, not inside your own body — otherwise the
    // avatar swallows the stones and you never see what you built.
    const heading = player.cameraYaw ?? 0;
    const x = player.position.x - Math.sin(heading) * CAIRN.placeReach;
    const z = player.position.z - Math.cos(heading) * CAIRN.placeReach;
    const y = ctx.world.sampleHeight(x, z);
    if (y <= ctx.world.data.seaLevel + 0.2) {
      ctx.events.emit('hud:toast', { text: 'the water would take it' });
      this.cooldown = CAIRN.placeCooldown;
      return;
    }

    for (const cairn of this.cairns) {
      const dx = cairn.position.x - x;
      const dz = cairn.position.z - z;
      if (dx * dx + dz * dz < CAIRN.minSpacing * CAIRN.minSpacing) {
        ctx.events.emit('hud:toast', { text: 'a cairn already stands here' });
        this.cooldown = CAIRN.placeCooldown;
        return;
      }
    }

    this.evictIfFull();

    const rng = mulberry32(hashString(`${this.seed}:msg:${x.toFixed(1)}:${z.toFixed(1)}`));
    const cairn = this.makeCairn(
      new THREE.Vector3(x, y, z),
      pick(MESSAGES.player, rng),
      false,
      'player',
      Date.now(),
    );
    // Player cairns are stacked by hand, not exhumed: they start most of the way up.
    cairn.rise = 0.55;
    cairn.messageShown = true;
    this.cairns.push(cairn);

    this.syncInstances();
    this.persist();
    this.cooldown = CAIRN.placeCooldown;
    ctx.events.emit('cairn:placed', { position: cairn.position.clone(), isGhost: false });
  }

  /** Make room for one more cairn, preferring to forget the oldest thing you built yourself. */
  private evictIfFull(): void {
    if (this.cairns.length < CAIRN.maxCairns) return;
    let victim = -1;
    let oldest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.cairns.length; i++) {
      const c = this.cairns[i]!;
      if (c.ghost && c.kind !== 'player') continue;
      if (c.placedAt < oldest) {
        oldest = c.placedAt;
        victim = i;
      }
    }
    this.cairns.splice(victim >= 0 ? victim : 0, 1);
  }

  private updateProximity(ctx: GameContext): void {
    const px = ctx.player.position.x;
    const pz = ctx.player.position.z;
    const near = CAIRN.messageRadius * CAIRN.messageRadius;
    const far = near * CAIRN.messageRearmScale * CAIRN.messageRearmScale;

    for (const cairn of this.cairns) {
      const dx = cairn.position.x - px;
      const dz = cairn.position.z - pz;
      const d2 = dx * dx + dz * dz;
      if (!cairn.messageShown && d2 < near && cairn.rise > 0.6) {
        cairn.messageShown = true;
        ctx.events.emit('hud:toast', { text: cairn.message, ms: 4200 });
      } else if (cairn.messageShown && d2 > far) {
        cairn.messageShown = false;
      }
    }
  }

  /** An Odradek ring reaches each cairn at its own moment — the delay is what sells the sweep. */
  private schedulePings(origin: THREE.Vector3): void {
    for (const cairn of this.cairns) {
      const dx = cairn.position.x - origin.x;
      const dz = cairn.position.z - origin.z;
      const distance = Math.hypot(dx, dz);
      if (distance > SCANNER.maxRadius) continue;
      cairn.pingDelay = Math.max(0.001, distance / SCANNER.speed);
      cairn.ping = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private get storageKey(): string {
    return `${CAIRN.storageKey}.${this.seed}`;
  }

  private loadStored(): StoredCairn[] {
    try {
      const raw = window.localStorage.getItem(this.storageKey);
      if (!raw) return [];
      const blob = JSON.parse(raw) as Partial<StoredBlob>;
      if (blob.v !== CAIRN.storageVersion || !Array.isArray(blob.cairns)) return [];
      const half = WORLD.size / 2;
      return blob.cairns
        .filter(
          (c): c is StoredCairn =>
            c != null &&
            Number.isFinite(c.x) &&
            Number.isFinite(c.z) &&
            Math.abs(c.x) <= half &&
            Math.abs(c.z) <= half,
        )
        .slice(-(CAIRN.maxCairns - CAIRN.phantomCount))
        .map((c) => ({ x: c.x, z: c.z, m: typeof c.m === 'string' ? c.m : 'you were here.', t: c.t ?? 0 }));
    } catch (err) {
      console.warn('[cairn] could not read saved cairns:', err);
      return [];
    }
  }

  /** Only the player's own cairns are written; phantoms are regenerated from the seed every load. */
  private persist(): void {
    const blob: StoredBlob = {
      v: CAIRN.storageVersion,
      seed: this.seed,
      cairns: this.cairns
        .filter((c) => c.kind === 'player')
        .map((c) => ({ x: c.position.x, z: c.position.z, m: c.message, t: c.placedAt })),
    };
    try {
      window.localStorage.setItem(this.storageKey, JSON.stringify(blob));
    } catch (err) {
      console.warn('[cairn] could not save cairns:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Scenic siting — where a traveler would actually have stopped
// ---------------------------------------------------------------------------

function pick<T>(list: readonly T[], rng: Rng): T {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))]!;
}

/**
 * Choose `count` places worth marking: the single highest reachable point, local maxima with real
 * prominence, and river sites (confluences, fords, the mouth).
 *
 * @complexity Time: O((res / stride)² · window²) ≈ 350 k comparisons at 513² with the default
 * stride of 6 and window of 3 — a few milliseconds, once, during `init`.
 */
function findScenicSites(world: IWorld, count: number, rng: Rng): ScenicSite[] {
  const data = world.data;
  const res = data.resolution;
  const size = data.size;
  const half = size / 2;
  const cell = size / (res - 1);
  const heights = data.heights;
  const stride = CAIRN.scenicStride;
  const window = CAIRN.scenicWindow;
  const maxSlope = degToRad(CAIRN.scenicMaxSlopeDeg);
  const minHeight = data.seaLevel + CAIRN.scenicMinAltitude;

  const toWorldX = (i: number): number => -half + i * cell;
  const usable = (x: number, z: number, y: number): boolean =>
    y >= minHeight && world.sampleSlope(x, z) <= maxSlope;

  const peaks: ScenicSite[] = [];
  let best: ScenicSite | null = null;
  const span = window * stride;

  for (let z = span; z < res - span; z += stride) {
    for (let x = span; x < res - span; x += stride) {
      const h = heights[z * res + x];
      if (h < minHeight) continue;

      let isMax = true;
      let low = h;
      for (let dz = -window; dz <= window && isMax; dz++) {
        for (let dx = -window; dx <= window; dx++) {
          if (dx === 0 && dz === 0) continue;
          const n = heights[(z + dz * stride) * res + (x + dx * stride)];
          if (n > h) {
            isMax = false;
            break;
          }
          if (n < low) low = n;
        }
      }
      if (!isMax) continue;

      const wx = toWorldX(x);
      const wz = toWorldX(z);
      if (!usable(wx, wz, h)) continue;

      // Prominence is what separates a summit from a bump on a slope; height alone would put every
      // phantom cairn on the same mountain.
      const prominence = h - low;
      const site: ScenicSite = {
        position: new THREE.Vector3(wx, h, wz),
        kind: 'peak',
        score: (prominence + h * 0.2) * (0.85 + 0.3 * rng()),
      };
      peaks.push(site);
      if (!best || h > best.position.y) best = { ...site, kind: 'ridge', score: Number.MAX_VALUE };
    }
  }

  if (best) peaks.push(best);

  // River sites: where two channels meet, plus a ford partway down and the mouth at the sea.
  const rivers: ScenicSite[] = [];
  const splines = data.rivers;
  for (let i = 0; i < splines.length; i++) {
    const points = splines[i]!.points;
    if (points.length < 3) continue;

    for (const fraction of [0.35, 0.65, 0.92]) {
      const p = points[Math.min(points.length - 1, Math.floor(points.length * fraction))]!;
      // Stand on the bank, not in the channel.
      const wx = p.x + (rng() - 0.5) * splines[i]!.width * 3;
      const wz = p.z + (rng() - 0.5) * splines[i]!.width * 3;
      const y = world.sampleHeight(wx, wz);
      if (!usable(wx, wz, y)) continue;
      rivers.push({
        position: new THREE.Vector3(wx, y, wz),
        kind: 'river',
        score: (40 + y * 0.5) * (0.85 + 0.3 * rng()),
      });
    }

    for (let j = i + 1; j < splines.length; j++) {
      const other = splines[j]!.points;
      let bestDistance = Number.POSITIVE_INFINITY;
      let meeting: THREE.Vector3 | null = null;
      for (const a of points) {
        for (const b of other) {
          const d = a.distanceToSquared(b);
          if (d < bestDistance) {
            bestDistance = d;
            meeting = a;
          }
        }
      }
      if (!meeting || bestDistance > 80 * 80) continue;
      const wx = meeting.x + (rng() - 0.5) * 24;
      const wz = meeting.z + (rng() - 0.5) * 24;
      const y = world.sampleHeight(wx, wz);
      if (!usable(wx, wz, y)) continue;
      rivers.push({
        position: new THREE.Vector3(wx, y, wz),
        kind: 'river',
        score: 220 * (0.85 + 0.3 * rng()),
      });
    }
  }

  peaks.sort((a, b) => b.score - a.score);
  rivers.sort((a, b) => b.score - a.score);

  const accepted: ScenicSite[] = [];
  let separation = CAIRN.scenicSeparation * CAIRN.scenicSeparation;
  const tryAccept = (site: ScenicSite): boolean => {
    if (accepted.includes(site)) return false;
    for (const existing of accepted) {
      const dx = existing.position.x - site.position.x;
      const dz = existing.position.z - site.position.z;
      if (dx * dx + dz * dz < separation) return false;
    }
    accepted.push(site);
    return true;
  };

  const riverQuota = Math.round(count * CAIRN.scenicRiverShare);
  let riversTaken = 0;
  for (const site of rivers) {
    if (riversTaken >= riverQuota || accepted.length >= count) break;
    if (tryAccept(site)) riversTaken++;
  }

  // Peaks first, then whatever the peaks could not fill goes to the rivers, then — on a seed too
  // flat or too crowded to place `count` sites this far apart — the spacing is relaxed rather than
  // shipping a world with four phantom cairns in it.
  for (let pass = 0; pass < 3 && accepted.length < count; pass++) {
    if (pass > 0) separation *= 0.3;
    for (const site of peaks) {
      if (accepted.length >= count) break;
      tryAccept(site);
    }
    for (const site of rivers) {
      if (accepted.length >= count) break;
      tryAccept(site);
    }
  }

  return accepted;
}
