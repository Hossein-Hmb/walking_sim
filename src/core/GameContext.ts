/**
 * src/core/GameContext.ts
 *
 * Contents: factories that build the shared service container (`createGameContext`) and its mutable
 * sub-objects (`createTimeState`, `createPlayerState`, `createSharedUniforms`).
 *
 * Purpose: `GameContext` is the only thing every system is allowed to depend on. Building it in one
 * place keeps the wiring in `main.ts` short and makes the swap from stub → real implementation a
 * one-line change per service.
 *
 * ⚠ IDENTITY MATTERS. Systems capture `ctx.player`, `ctx.uniforms.*` and `ctx.time` by reference
 * during `init()`. Mutate those objects in place; never reassign them. Services that are whole
 * objects (`ctx.world`, `ctx.physics`) may only be swapped *before* `engine.init()` runs — which is
 * exactly what WS8 will do when it deletes the stubs.
 */

import * as THREE from 'three';
import { TIME } from '../config/world.config';
import { EventBus } from './EventBus';
import type { Engine } from './Engine';
import type {
  GameContext,
  IInput,
  IPhysics,
  IPlayerState,
  IWorld,
  SharedUniforms,
  TimeState,
} from './types';

export interface GameContextDeps {
  physics: IPhysics;
  world: IWorld;
  input: IInput;
  events?: EventBus;
  player?: IPlayerState;
  uniforms?: SharedUniforms;
}

export function createTimeState(): TimeState {
  return { elapsed: 0, dt: 0, timeOfDay: TIME.startTimeOfDay };
}

/** The single mutable player-state object. WS3's PlayerSystem writes into it every fixed step. */
export function createPlayerState(): IPlayerState {
  return {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    grounded: false,
    stamina: 1,
    balance: 1,
    isTumbling: false,
    biome: [1, 0, 0, 0],
    altitude: 0,
  };
}

/** Created once, shared by reference between WS4's materials and WS6's feature systems. */
export function createSharedUniforms(): SharedUniforms {
  return {
    uTime: { value: 0 },
    uWetness: { value: 0 },
    uScanOrigin: { value: new THREE.Vector3() },
    uScanRadius: { value: -1 },
    uWind: { value: new THREE.Vector2(1, 0) },
  };
}

export function createGameContext(engine: Engine, deps: GameContextDeps): GameContext {
  return {
    scene: engine.scene,
    camera: engine.camera,
    renderer: engine.renderer,
    events: deps.events ?? new EventBus(),
    physics: deps.physics,
    world: deps.world,
    input: deps.input,
    player: deps.player ?? createPlayerState(),
    time: createTimeState(),
    uniforms: deps.uniforms ?? createSharedUniforms(),
  };
}
