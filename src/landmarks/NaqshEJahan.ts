/**
 * src/landmarks/NaqshEJahan.ts
 *
 * Contents: Naqsh-e Jahan Square — beige two-storey pointed-arch arcade you can walk through,
 * the four landmark volumes (Shah Mosque, Sheikh Lotfollah, Ali Qapu, Qeysarieh) with shallow
 * arched iwans, and the parterre layout (garden beds + reflecting pool).
 *
 * Purpose: a walkable fragment of Isfahan in the open world. Local space: +X east, +Z south
 * (mosque), −Z north (bazaar). `LandmarkSystem` poses the returned group with `LandmarkSite.yaw`.
 */

import * as THREE from "three";
import { ISFAHAN } from "../config/world.config";
import type { LandmarkSite } from "../core/types";

export interface IsfahanBuild {
  group: THREE.Group;
  /** World-ready after the group is posed; used as Rapier trimeshes. */
  colliderMeshes: THREE.Mesh[];
  /** Landmark-local positions of lantern flames, for the night light pool. */
  lampPositions: THREE.Vector3[];
  /** Shared glass material — LandmarkSystem drives emissive with the day/night cycle. */
  lampGlass: THREE.MeshStandardMaterial;
}

interface Mats {
  plaza: THREE.MeshStandardMaterial;
  masonry: THREE.MeshStandardMaterial;
  masonryDeep: THREE.MeshStandardMaterial;
  tile: THREE.MeshStandardMaterial;
  domeShah: THREE.MeshStandardMaterial;
  domeLotf: THREE.MeshStandardMaterial;
  stone: THREE.MeshStandardMaterial;
  cream: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  garden: THREE.MeshStandardMaterial;
  water: THREE.MeshStandardMaterial;
  brass: THREE.MeshStandardMaterial;
  lampGlass: THREE.MeshStandardMaterial;
}

interface Bay {
  x: number;
  z: number;
  yaw: number;
}

interface ArchHole {
  y0: number;
  halfW: number;
  springerY: number;
  apexY: number;
}

/**
 * @complexity Time: O(arcade modules) once at init | Space: O(1) shared materials, one InstancedMesh.
 */
export function buildNaqshEJahan(site: LandmarkSite): IsfahanBuild {
  const group = new THREE.Group();
  group.name = "landmark:isfahan";
  group.position.set(site.x, site.y, site.z);
  group.rotation.y = site.yaw;

  const colliderMeshes: THREE.Mesh[] = [];
  const mats = makeMaterials();
  const halfW = site.halfWidth;
  const halfL = site.halfLength;
  const arcade = ISFAHAN.arcadeDepth;
  const bays = arcadeBays(halfW, halfL, arcade);

  addPlaza(group, mats, halfW, halfL);
  addArcade(group, mats, bays, arcade);
  addArcadeColliders(group, colliderMeshes, mats, bays, arcade);
  addShahMosque(group, colliderMeshes, mats, halfL, arcade);
  addLotfollah(group, colliderMeshes, mats, halfW, arcade);
  addAliQapu(group, colliderMeshes, mats, halfW, arcade);
  addQeysarieh(group, colliderMeshes, mats, halfL, arcade);
  addParterres(group, colliderMeshes, mats, halfL);
  const lampPositions = addLamps(group, mats, bays, arcade, halfW, halfL);

  return { group, colliderMeshes, lampPositions, lampGlass: mats.lampGlass };
}

function makeMaterials(): Mats {
  const make = (
    color: number,
    extras: ConstructorParameters<typeof THREE.MeshStandardMaterial>[0] = {},
  ) =>
    new THREE.MeshStandardMaterial({
      color,
      roughness: 0.78,
      metalness: 0.04,
      flatShading: false,
      ...extras,
    });

  return {
    plaza: make(ISFAHAN.plazaBeige, {
      roughness: 0.88,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
    masonry: make(ISFAHAN.beige, { roughness: 0.84 }),
    masonryDeep: make(ISFAHAN.beigeDeep, { roughness: 0.86 }),
    tile: make(0x1a8a7a, { roughness: 0.42, metalness: 0.12 }),
    domeShah: make(0x2aa89a, { roughness: 0.38, metalness: 0.16 }),
    domeLotf: make(0xe8c97a, { roughness: 0.5, metalness: 0.08 }),
    stone: make(0xd4b896),
    cream: make(0xe8dcc4),
    wood: make(0x4a3020, { roughness: 0.9, flatShading: true }),
    garden: make(0x4f7c38, { roughness: 0.92 }),
    brass: make(ISFAHAN.lampBrass, { roughness: 0.38, metalness: 0.72 }),
    lampGlass: make(0xffe1a8, {
      roughness: 0.28,
      metalness: 0.04,
      emissive: ISFAHAN.lampFlame,
      emissiveIntensity: 0,
    }),
    water: make(0x3eb4c9, {
      roughness: 0.22,
      metalness: 0.04,
      emissive: 0x1a6a7a,
      emissiveIntensity: 0.45,
    }),
  };
}

function addPlaza(
  group: THREE.Group,
  mats: Mats,
  halfW: number,
  halfL: number,
): void {
  const geom = new THREE.PlaneGeometry(halfW * 2, halfL * 2, 1, 1);
  geom.rotateX(-Math.PI / 2);
  const mesh = part(geom, mats.plaza, 0, 0.03, 0);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  group.add(mesh);
}

function arcadeBays(halfW: number, halfL: number, arcade: number): Bay[] {
  const module = ISFAHAN.module;
  const portal = ISFAHAN.portalWidth * 0.5;
  const iwanGap = 14;
  const bays: Bay[] = [];
  const z0 = -halfL + module * 0.5;
  const z1 = halfL - module * 0.5;
  const xWest = -(halfW + arcade * 0.5);
  const xEast = halfW + arcade * 0.5;
  for (let z = z0; z <= z1 + 0.01; z += module) {
    bays.push({ x: xWest, z, yaw: Math.PI / 2 });
    bays.push({ x: xEast, z, yaw: Math.PI / 2 });
  }
  const x0 = -halfW + module * 0.5;
  const x1 = halfW - module * 0.5;
  const zNorth = -(halfL + arcade * 0.5);
  const zSouth = halfL + arcade * 0.5;
  const nearCorner = module * 0.45;
  for (let x = x0; x <= x1 + 0.01; x += module) {
    if (Math.abs(x) < portal) continue;
    if (Math.abs(Math.abs(x) - halfW) < nearCorner) continue;
    bays.push({ x, z: zNorth, yaw: 0 });
  }
  for (let x = x0; x <= x1 + 0.01; x += module) {
    if (Math.abs(x) < iwanGap) continue;
    if (Math.abs(Math.abs(x) - halfW) < nearCorner) continue;
    bays.push({ x, z: zSouth, yaw: 0 });
  }
  return bays;
}

function addArcade(
  group: THREE.Group,
  mats: Mats,
  bays: Bay[],
  arcade: number,
): void {
  const geom = makeBayGeometry(
    ISFAHAN.module,
    ISFAHAN.bayHeight,
    arcade,
    arcadeHoles(),
  );
  const mesh = new THREE.InstancedMesh(geom, mats.masonry, bays.length);
  mesh.name = "isfahan:arcade";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  const dummy = new THREE.Object3D();
  for (let i = 0; i < bays.length; i++) {
    const bay = bays[i]!;
    dummy.position.set(bay.x, 0, bay.z);
    dummy.rotation.set(0, bay.yaw, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
}

function arcadeHoles(): ArchHole[] {
  const halfW = ISFAHAN.archWidth * 0.5;
  const springer = ISFAHAN.archClearance;
  const ground: ArchHole = {
    y0: 0,
    halfW,
    springerY: springer,
    apexY: springer + halfW * 0.92,
  };
  const upperHalf = 1.15;
  const sill = 7.15;
  const upperSpringer = sill + 0.85;
  const upper: ArchHole = {
    y0: sill,
    halfW: upperHalf,
    springerY: upperSpringer,
    apexY: upperSpringer + upperHalf * 0.9,
  };
  return [ground, upper];
}

function makeBayGeometry(
  width: number,
  height: number,
  depth: number,
  holes: ArchHole[],
): THREE.BufferGeometry {
  const hw = width * 0.5;
  const shape = new THREE.Shape();
  shape.moveTo(-hw, 0);
  shape.lineTo(hw, 0);
  shape.lineTo(hw, height);
  shape.lineTo(-hw, height);
  shape.closePath();
  for (const hole of holes) shape.holes.push(pointedArchHole(0, hole));

  const geom = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    curveSegments: 10,
  });
  geom.translate(0, 0, -depth * 0.5);
  geom.computeVertexNormals();
  return geom;
}

function pointedArchHole(cx: number, hole: ArchHole): THREE.Path {
  const path = new THREE.Path();
  const left = cx - hole.halfW;
  const right = cx + hole.halfW;
  const inset = hole.halfW * 0.18;
  // Clockwise so the hole winds opposite the CCW outer shape.
  path.moveTo(left, hole.y0);
  path.lineTo(left, hole.springerY);
  path.bezierCurveTo(
    left,
    hole.apexY,
    cx - inset,
    hole.apexY,
    cx,
    hole.apexY,
  );
  path.bezierCurveTo(
    cx + inset,
    hole.apexY,
    right,
    hole.apexY,
    right,
    hole.springerY,
  );
  path.lineTo(right, hole.y0);
  path.closePath();
  return path;
}

function addArcadeColliders(
  group: THREE.Group,
  colliders: THREE.Mesh[],
  mats: Mats,
  bays: Bay[],
  arcade: number,
): void {
  const walls: Record<"east" | "west" | "north" | "south", THREE.BufferGeometry[]> =
    {
      east: [],
      west: [],
      north: [],
      south: [],
    };

  for (const bay of bays) {
    const key = wallKey(bay);
    walls[key].push(...pierLintelGeoms(bay, arcade));
  }

  for (const [name, geoms] of Object.entries(walls)) {
    if (geoms.length === 0) continue;
    const merged = mergeGeoms(geoms);
    const mesh = part(merged, mats.masonryDeep, 0, 0, 0);
    mesh.name = `isfahan:arcade-collider:${name}`;
    mesh.visible = false;
    mesh.castShadow = false;
    group.add(mesh);
    colliders.push(mesh);
  }
}

function wallKey(bay: Bay): "east" | "west" | "north" | "south" {
  if (bay.yaw === 0) return bay.z < 0 ? "north" : "south";
  return bay.x < 0 ? "west" : "east";
}

function pierLintelGeoms(bay: Bay, arcade: number): THREE.BufferGeometry[] {
  const { module, pierWidth, archClearance, bayHeight } = ISFAHAN;
  const lintelH = bayHeight - archClearance;
  const pierX = (module - pierWidth) * 0.5;
  const pose = new THREE.Matrix4()
    .makeRotationY(bay.yaw)
    .setPosition(bay.x, 0, bay.z);

  const placed = (sx: number, sy: number, sz: number, lx: number, ly: number, lz: number) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(lx, ly, lz);
    g.applyMatrix4(pose);
    return g;
  };

  return [
    placed(pierWidth, bayHeight, arcade, -pierX, bayHeight * 0.5, 0),
    placed(pierWidth, bayHeight, arcade, pierX, bayHeight * 0.5, 0),
    placed(module, lintelH, arcade, 0, archClearance + lintelH * 0.5, 0),
  ];
}

function addShahMosque(
  group: THREE.Group,
  colliders: THREE.Mesh[],
  mats: Mats,
  halfL: number,
  arcade: number,
): void {
  const z = halfL + arcade + ISFAHAN.mosqueDepth * 0.5;
  const body = solid(
    group,
    colliders,
    new THREE.BoxGeometry(64, 22, 48),
    mats.masonry,
    0,
    11,
    z,
  );
  body.castShadow = true;

  addArchedPortal(
    group,
    colliders,
    mats,
    0,
    z - 28,
    0,
    28,
    30,
    12,
    9,
    8,
  );
  group.add(part(new THREE.BoxGeometry(18, 2, 1.2), mats.tile, 0, 26, z - 34));

  const dome = part(
    new THREE.SphereGeometry(16, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    mats.domeShah,
    0,
    24,
    z + 4,
  );
  dome.castShadow = true;
  group.add(dome);
  group.add(
    part(new THREE.CylinderGeometry(2.2, 2.8, 6, 12), mats.tile, 0, 42, z + 4),
  );

  addMinaret(group, mats, -24, z - 18);
  addMinaret(group, mats, 24, z - 18);
}

function addMinaret(
  group: THREE.Group,
  mats: Mats,
  x: number,
  z: number,
): void {
  const shaft = part(
    new THREE.CylinderGeometry(2.1, 2.6, 46, 12),
    mats.masonryDeep,
    x,
    23,
    z,
  );
  shaft.castShadow = true;
  group.add(shaft);
  group.add(
    part(new THREE.CylinderGeometry(2.4, 2.4, 3.2, 12), mats.tile, x, 47, z),
  );
  group.add(part(new THREE.ConeGeometry(2.6, 5, 12), mats.tile, x, 51, z));
}

function addLotfollah(
  group: THREE.Group,
  colliders: THREE.Mesh[],
  mats: Mats,
  halfW: number,
  arcade: number,
): void {
  const x = halfW + arcade + 22;
  solid(
    group,
    colliders,
    new THREE.BoxGeometry(36, 16, 36),
    mats.cream,
    x,
    8,
    0,
  );
  addArchedPortal(
    group,
    colliders,
    mats,
    x - 20,
    0,
    Math.PI / 2,
    16,
    16,
    8,
    5.5,
    6,
  );
  const dome = part(
    new THREE.SphereGeometry(12, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    mats.domeLotf,
    x,
    18,
    0,
  );
  dome.castShadow = true;
  group.add(dome);
}

function addAliQapu(
  group: THREE.Group,
  colliders: THREE.Mesh[],
  mats: Mats,
  halfW: number,
  arcade: number,
): void {
  const x = -(halfW + arcade + 16);
  solid(
    group,
    colliders,
    new THREE.BoxGeometry(18, 28, 22),
    mats.masonry,
    x,
    14,
    0,
  );
  const porch = solid(
    group,
    colliders,
    new THREE.BoxGeometry(14, 7, 18),
    mats.stone,
    x + 12,
    24,
    0,
  );
  porch.castShadow = true;
  for (const z of [-6, -2, 2, 6]) {
    const col = part(
      new THREE.CylinderGeometry(0.45, 0.5, 7, 8),
      mats.wood,
      x + 16,
      24,
      z,
    );
    col.castShadow = true;
    group.add(col);
  }
}

function addQeysarieh(
  group: THREE.Group,
  colliders: THREE.Mesh[],
  mats: Mats,
  halfL: number,
  arcade: number,
): void {
  const z = -(halfL + arcade + 8);
  solid(
    group,
    colliders,
    new THREE.BoxGeometry(28, 20, 12),
    mats.masonry,
    0,
    10,
    z,
  );
  addArchedPortal(
    group,
    colliders,
    mats,
    0,
    z + 7,
    Math.PI,
    16,
    16,
    6,
    5,
    6.5,
  );
  group.add(part(new THREE.BoxGeometry(18, 1.6, 1.1), mats.tile, 0, 14.5, z + 10));
  const stub = solid(
    group,
    colliders,
    new THREE.BoxGeometry(16, 10, ISFAHAN.bazaarDepth),
    mats.masonryDeep,
    0,
    5,
    z - ISFAHAN.bazaarDepth * 0.5,
  );
  stub.castShadow = true;
}

/**
 * U-shaped collider (piers + lintel + back wall) plus a beige pointed-arch facade.
 * `yaw` 0 faces −Z (plaza, looking north from the mosque).
 */
function addArchedPortal(
  group: THREE.Group,
  colliders: THREE.Mesh[],
  mats: Mats,
  x: number,
  z: number,
  yaw: number,
  width: number,
  height: number,
  depth: number,
  archHalfW: number,
  springerY: number,
): void {
  const pose = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, 0, z);
  const pierW = Math.max(1.6, (width - archHalfW * 2) * 0.5);
  const lintelH = height - springerY;
  const pierX = (width - pierW) * 0.5;
  const backZ = depth * 0.5 - 0.9;

  const placeBox = (
    sx: number,
    sy: number,
    sz: number,
    lx: number,
    ly: number,
    lz: number,
    mat: THREE.Material,
    collide: boolean,
  ): void => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(lx, ly, lz);
    g.applyMatrix4(pose);
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (collide) colliders.push(mesh);
  };

  placeBox(pierW, height, depth, -pierX, height * 0.5, 0, mats.masonry, true);
  placeBox(pierW, height, depth, pierX, height * 0.5, 0, mats.masonry, true);
  placeBox(width, lintelH, depth, 0, springerY + lintelH * 0.5, 0, mats.masonry, true);
  placeBox(width - 0.4, height, 1.8, 0, height * 0.5, backZ, mats.masonryDeep, true);

  const facade = makeBayGeometry(width, height, 1.3, [
    {
      y0: 0,
      halfW: archHalfW,
      springerY,
      apexY: springerY + archHalfW * 0.85,
    },
  ]);
  facade.applyMatrix4(
    new THREE.Matrix4().makeRotationY(yaw).setPosition(x, 0, z),
  );
  // Nudge the facade toward the plaza (−local Z).
  const forward = new THREE.Vector3(0, 0, -depth * 0.5 + 0.15).applyAxisAngle(
    new THREE.Vector3(0, 1, 0),
    yaw,
  );
  facade.translate(forward.x, 0, forward.z);
  const face = new THREE.Mesh(facade, mats.cream);
  face.castShadow = true;
  face.receiveShadow = true;
  group.add(face);

  const tile = new THREE.BoxGeometry(archHalfW * 2 + 1.2, 0.55, 0.5);
  tile.translate(0, springerY + archHalfW * 0.85 + 0.4, -depth * 0.5 + 0.2);
  tile.applyMatrix4(pose);
  group.add(new THREE.Mesh(tile, mats.tile));
}

/**
 * Safavid fanous posts along the inner arcade and around the pool. Visual only — lighting is a
 * pooled set of PointLights owned by LandmarkSystem, keyed off these flame positions.
 */
function addLamps(
  group: THREE.Group,
  mats: Mats,
  bays: Bay[],
  arcade: number,
  halfW: number,
  halfL: number,
): THREE.Vector3[] {
  const spots = lampSpots(bays, arcade, halfW, halfL);
  if (spots.length === 0) return [];

  const bodies = new THREE.InstancedMesh(
    makeLampBodyGeometry(),
    mats.brass,
    spots.length,
  );
  const plinths = new THREE.InstancedMesh(
    makeLampPlinthGeometry(),
    mats.masonryDeep,
    spots.length,
  );
  const glasses = new THREE.InstancedMesh(
    makeLampGlassGeometry(),
    mats.lampGlass,
    spots.length,
  );
  bodies.name = "isfahan:lamps";
  plinths.name = "isfahan:lamp-plinths";
  glasses.name = "isfahan:lamp-glass";
  bodies.castShadow = true;
  plinths.castShadow = true;
  glasses.castShadow = false;
  bodies.frustumCulled = false;
  plinths.frustumCulled = false;
  glasses.frustumCulled = false;

  const dummy = new THREE.Object3D();
  const flames: THREE.Vector3[] = [];
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i]!;
    dummy.position.set(s.x, 0, s.z);
    dummy.rotation.set(0, i * 0.37, 0);
    dummy.updateMatrix();
    bodies.setMatrixAt(i, dummy.matrix);
    plinths.setMatrixAt(i, dummy.matrix);
    glasses.setMatrixAt(i, dummy.matrix);
    flames.push(new THREE.Vector3(s.x, ISFAHAN.lampFlameY, s.z));
  }
  bodies.instanceMatrix.needsUpdate = true;
  plinths.instanceMatrix.needsUpdate = true;
  glasses.instanceMatrix.needsUpdate = true;
  group.add(plinths);
  group.add(bodies);
  group.add(glasses);
  return flames;
}

function lampSpots(
  bays: Bay[],
  _arcade: number,
  _halfW: number,
  halfL: number,
): Array<{ x: number; z: number }> {
  const inset = ISFAHAN.lampInset;
  const step = Math.max(1, ISFAHAN.lampEveryBays);
  const module = ISFAHAN.module;
  const spots: Array<{ x: number; z: number }> = [];
  const seen = new Set<string>();
  const push = (x: number, z: number): void => {
    const key = `${Math.round(x * 2)}_${Math.round(z * 2)}`;
    if (seen.has(key)) return;
    seen.add(key);
    spots.push({ x, z });
  };

  for (const bay of bays) {
    const along = bay.yaw === 0 ? bay.x : bay.z;
    if (Math.round(along / module) % step !== 0) continue;
    if (bay.yaw === 0) push(bay.x, bay.z - Math.sign(bay.z || 1) * inset);
    else push(bay.x - Math.sign(bay.x || 1) * inset, bay.z);
  }

  const poolZ = 36;
  const poolW = 11;
  const poolD = 40;
  push(poolW, poolZ - poolD);
  push(-poolW, poolZ - poolD);
  push(poolW, poolZ + poolD);
  push(-poolW, poolZ + poolD);

  for (const z of [-140, -90, -48, 100, 148, 178]) {
    if (Math.abs(z) > halfL - 16) continue;
    push(0, z);
  }
  return spots;
}

function makeLampBodyGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, y: number): void => {
    g.translate(0, y, 0);
    parts.push(g);
  };
  add(new THREE.CylinderGeometry(0.055, 0.065, 2.05, 8), 1.55);
  add(new THREE.CylinderGeometry(0.13, 0.13, 0.1, 8), 2.62);
  add(new THREE.CylinderGeometry(0.24, 0.24, 0.1, 8), 2.7);
  add(new THREE.CylinderGeometry(0.24, 0.22, 0.08, 8), 3.32);
  add(new THREE.ConeGeometry(0.28, 0.38, 8), 3.54);
  add(new THREE.SphereGeometry(0.045, 8, 6), 3.76);
  return mergeGeoms(parts);
}

function makeLampPlinthGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.2, 0.24, 0.52, 8);
  g.translate(0, 0.26, 0);
  return g;
}

function makeLampGlassGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.2, 0.2, 0.52, 8);
  g.translate(0, 3.01, 0);
  return g;
}

function addParterres(
  group: THREE.Group,
  colliders: THREE.Mesh[],
  mats: Mats,
  halfL: number,
): void {
  // Sketch is top = Qeysarieh (−Z), bottom = mosque (+Z). Everything is mirrored in X
  // so a path runs down the middle. Metres; origin is the plaza centre.
  const plot = 22;
  const x = 28;
  const tallD = 50;
  const barD = 14;
  const thinW = 9;
  const poolW = 20;
  const poolD = 78;

  // Two rows of squares just inside the north gate.
  pairBed(group, colliders, mats, plot, plot, x, -halfL + 24);
  pairBed(group, colliders, mats, plot, plot, x, -halfL + 24 + plot + 10);

  // Taller beds on the way to the pool.
  pairBed(group, colliders, mats, plot, tallD, x, -52);

  // Frame around the reflecting pool: bar, flanks, bar.
  const poolZ = 36;
  pairBed(
    group,
    colliders,
    mats,
    plot,
    barD,
    x,
    poolZ - poolD * 0.5 - 6 - barD * 0.5,
  );
  pairBed(
    group,
    colliders,
    mats,
    thinW,
    poolD,
    poolW * 0.5 + 6 + thinW * 0.5,
    poolZ,
  );
  addPool(group, colliders, mats, poolW, poolD, poolZ);
  pairBed(
    group,
    colliders,
    mats,
    plot,
    barD,
    x,
    poolZ + poolD * 0.5 + 6 + barD * 0.5,
  );

  // Last pair of squares in front of the mosque.
  pairBed(group, colliders, mats, plot, plot, x, halfL - 24);
}

function pairBed(
  group: THREE.Group,
  colliders: THREE.Mesh[],
  mats: Mats,
  w: number,
  d: number,
  x: number,
  z: number,
): void {
  bed(group, colliders, mats, w, d, -x, z);
  bed(group, colliders, mats, w, d, x, z);
}

function bed(
  group: THREE.Group,
  colliders: THREE.Mesh[],
  mats: Mats,
  w: number,
  d: number,
  x: number,
  z: number,
): void {
  const curbH = 0.45;
  solid(
    group,
    colliders,
    new THREE.BoxGeometry(w + 0.7, curbH, d + 0.7),
    mats.stone,
    x,
    curbH * 0.5,
    z,
  );
  const grass = part(
    new THREE.BoxGeometry(w, 0.22, d),
    mats.garden,
    x,
    curbH + 0.05,
    z,
  );
  grass.receiveShadow = true;
  grass.castShadow = false;
  group.add(grass);
}

function addPool(
  group: THREE.Group,
  colliders: THREE.Mesh[],
  mats: Mats,
  w: number,
  d: number,
  z: number,
): void {
  const curbH = 0.55;
  const curbT = 0.7;
  const waterH = 0.32;

  // Floor of the basin — stone, not the water.
  group.add(part(new THREE.BoxGeometry(w, 0.06, d), mats.stone, 0, 0.03, z));

  // Filled volume, inset from the rim so the curb reads around it.
  const water = part(
    new THREE.BoxGeometry(w - 0.5, waterH, d - 0.5),
    mats.water,
    0,
    0.08 + waterH * 0.5,
    z,
  );
  water.receiveShadow = true;
  water.castShadow = false;
  group.add(water);

  // Invisible plug so the player cannot walk into the basin.
  const plug = part(
    new THREE.BoxGeometry(w, curbH, d),
    mats.stone,
    0,
    curbH * 0.5,
    z,
  );
  plug.visible = false;
  group.add(plug);
  colliders.push(plug);

  const y = curbH * 0.5;
  solid(
    group,
    colliders,
    new THREE.BoxGeometry(w + curbT * 2, curbH, curbT),
    mats.stone,
    0,
    y,
    z + d * 0.5 + curbT * 0.5,
  );
  solid(
    group,
    colliders,
    new THREE.BoxGeometry(w + curbT * 2, curbH, curbT),
    mats.stone,
    0,
    y,
    z - d * 0.5 - curbT * 0.5,
  );
  solid(
    group,
    colliders,
    new THREE.BoxGeometry(curbT, curbH, d),
    mats.stone,
    w * 0.5 + curbT * 0.5,
    y,
    z,
  );
  solid(
    group,
    colliders,
    new THREE.BoxGeometry(curbT, curbH, d),
    mats.stone,
    -(w * 0.5 + curbT * 0.5),
    y,
    z,
  );
}

function mergeGeoms(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let offset = 0;
  for (const g of geoms) {
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    const nrm = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (nrm) normals.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      else normals.push(0, 1, 0);
    }
    const idx = g.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + offset);
    } else {
      for (let i = 0; i < pos.count; i++) indices.push(offset + i);
    }
    offset += pos.count;
    g.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  merged.setIndex(indices);
  return merged;
}

function solid(
  group: THREE.Group,
  colliders: THREE.Mesh[],
  geom: THREE.BufferGeometry,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = part(geom, mat, x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  colliders.push(mesh);
  return mesh;
}

function part(
  geom: THREE.BufferGeometry,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  return mesh;
}
