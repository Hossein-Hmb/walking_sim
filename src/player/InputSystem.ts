/**
 * src/player/InputSystem.ts
 *
 * Contents: `InputSystem` — the one place raw browser input (keyboard, pointer, gamepad) is turned
 * into the engine-facing `InputState` snapshot declared in `core/types.ts`.
 *
 * Purpose: WS3 owns "how the game is controlled". Every other system reads `ctx.input.state` and
 * never touches a DOM event, so rebinding, adding a gamepad or swapping to touch controls is a
 * change confined to this file.
 *
 * Bindings (PLAN.md WS3):
 *   Arrow keys / WASD  move (camera-relative — the camera basis is applied by PlayerSystem)
 *   Space              jump (edge-triggered)
 *   Shift              sprint (held)
 *   Left-drag          orbit the camera; double-click the canvas for pointer-lock orbit
 *   Q / E / C / P      scan / interact / cairn / photo
 *   F1                 debug overlay
 *   Esc                pause
 *   Gamepad            left stick move, right stick look, A jump, X interact, RB/RT sprint (optional, hot-plug)
 *
 * Frame contract (WS0): the Engine calls `beginFrame()` before the fixed-step loop and `endFrame()`
 * after rendering. Edge-triggered flags (`jump`, `actions`) are therefore true for exactly one whole
 * frame *including every fixed step inside it* — which is why presses are latched here rather than
 * read directly off the DOM event.
 *
 * History: this started life as `StubInput` in `core/stubs.ts` (WS0 shipped it "real, it's cheap").
 * WS3 moved it here as PLAN.md instructs and added pointer lock, gamepad support and auto-repeat
 * hardening. The semantics of the original are preserved exactly.
 */

import * as THREE from 'three';
import { INPUT } from '../config/world.config';
import type { ActionId, IInput, InputState } from '../core/types';

/** Single-press keys that map straight onto an `ActionId`. */
const KEY_ACTIONS: Readonly<Record<string, ActionId>> = {
  KeyQ: 'scan',
  KeyE: 'interact',
  KeyC: 'cairn',
  KeyP: 'photo',
  F1: 'debug',
  Escape: 'pause',
};

/** Keys we swallow so the page never scrolls (or opens help) under the game. */
const SWALLOWED = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'F1', 'Tab']);

/** Standard-mapping gamepad button indices. */
const PAD_BUTTON = { a: 0, x: 2, rightBumper: 5, rightTrigger: 7 } as const;
/** Standard-mapping gamepad axis indices. */
const PAD_AXIS = { leftX: 0, leftY: 1, rightX: 2, rightY: 3 } as const;

export class InputSystem implements IInput {
  readonly state: InputState = {
    move: new THREE.Vector2(),
    look: new THREE.Vector2(),
    jump: false,
    sprint: false,
    actions: new Set<ActionId>(),
  };

  private readonly held = new Set<string>();
  private readonly queuedActions = new Set<ActionId>();
  private jumpQueued = false;
  private readonly lookAccum = new THREE.Vector2();
  private dragging = false;
  private target: HTMLElement | null = null;
  private lastFrameMs = 0;

  // Gamepad state is polled, not evented, so it lives outside `held`.
  private padJumpWasDown = false;
  private padInteractWasDown = false;
  private readonly padMove = new THREE.Vector2();
  private readonly padLook = new THREE.Vector2();
  private padSprint = false;

  /** Attach DOM listeners. `target` is the canvas — pointer capture and lock are scoped to it. */
  attach(target: HTMLElement): void {
    this.target = target;
    this.lastFrameMs = performance.now();
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    target.addEventListener('pointerdown', this.onPointerDown);
    target.addEventListener('dblclick', this.onDoubleClick);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.target?.removeEventListener('pointerdown', this.onPointerDown);
    this.target?.removeEventListener('dblclick', this.onDoubleClick);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    this.target = null;
  }

  /** True while the pointer is locked to the canvas (free-look without holding a button). */
  get pointerLocked(): boolean {
    return this.target != null && document.pointerLockElement === this.target;
  }

  /** Ask for pointer lock. Must be called from a user gesture; failure is silent by design. */
  requestPointerLock(): void {
    void this.target?.requestPointerLock?.();
  }

  /** Publishes this frame's snapshot. Edge-triggered flags stay true for the whole frame. */
  beginFrame(): void {
    const now = performance.now();
    // Clamped so a tab-switch stall cannot produce one enormous gamepad look delta.
    const dt = Math.min((now - this.lastFrameMs) / 1000, 0.1);
    this.lastFrameMs = now;

    this.pollGamepad(dt);

    const s = this.state;
    const forward =
      (this.held.has('ArrowUp') || this.held.has('KeyW') ? 1 : 0) -
      (this.held.has('ArrowDown') || this.held.has('KeyS') ? 1 : 0);
    const strafe =
      (this.held.has('ArrowRight') || this.held.has('KeyD') ? 1 : 0) -
      (this.held.has('ArrowLeft') || this.held.has('KeyA') ? 1 : 0);

    s.move.set(strafe + this.padMove.x, forward + this.padMove.y);
    if (s.move.lengthSq() > 1) s.move.normalize();

    s.sprint = this.held.has('ShiftLeft') || this.held.has('ShiftRight') || this.padSprint;
    s.jump = this.jumpQueued;
    this.jumpQueued = false;

    s.look.copy(this.lookAccum).add(this.padLook);
    this.lookAccum.set(0, 0);

    s.actions.clear();
    for (const a of this.queuedActions) s.actions.add(a);
    this.queuedActions.clear();
  }

  /** Clears edge-triggered flags once every system has had a chance to read them. */
  endFrame(): void {
    this.state.jump = false;
    this.state.actions.clear();
    this.state.look.set(0, 0);
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (SWALLOWED.has(e.code)) e.preventDefault();
    // Auto-repeat must not re-trigger an edge, but the key is already in `held`.
    if (e.repeat) return;
    this.held.add(e.code);
    if (e.code === 'Space') this.jumpQueued = true;
    const action = KEY_ACTIONS[e.code];
    if (action) this.queuedActions.add(action);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  /** Alt-tabbing away must not leave a key stuck down. */
  private readonly onBlur = (): void => {
    this.held.clear();
    this.jumpQueued = false;
    this.dragging = false;
    this.lookAccum.set(0, 0);
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.onBlur();
    // The clock restarts on return so the first frame back does not integrate the hidden interval.
    this.lastFrameMs = performance.now();
  };

  // -------------------------------------------------------------------------
  // Pointer
  // -------------------------------------------------------------------------

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.dragging = true;
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging && !this.pointerLocked) return;
    this.lookAccum.x += e.movementX;
    this.lookAccum.y += e.movementY;
  };

  private readonly onPointerUp = (): void => {
    this.dragging = false;
  };

  private readonly onDoubleClick = (): void => {
    if (!this.pointerLocked) this.requestPointerLock();
  };

  // -------------------------------------------------------------------------
  // Gamepad (optional — costs one array read per frame when nothing is connected)
  // -------------------------------------------------------------------------

  private pollGamepad(dt: number): void {
    this.padMove.set(0, 0);
    this.padLook.set(0, 0);
    this.padSprint = false;
    if (!INPUT.gamepadEnabled || typeof navigator.getGamepads !== 'function') return;

    const pad = navigator.getGamepads().find((p): p is Gamepad => p != null && p.connected);
    if (!pad) {
      this.padJumpWasDown = false;
      this.padInteractWasDown = false;
      return;
    }

    const dz = INPUT.gamepadDeadzone;
    // Forward is -Y on a standard gamepad, matching `InputState.move.y` = forward.
    this.padMove.set(
      deadzone(pad.axes[PAD_AXIS.leftX] ?? 0, dz),
      -deadzone(pad.axes[PAD_AXIS.leftY] ?? 0, dz),
    );

    const lookScale = INPUT.gamepadLookPixelsPerSecond * dt;
    this.padLook.set(
      deadzone(pad.axes[PAD_AXIS.rightX] ?? 0, dz) * lookScale,
      deadzone(pad.axes[PAD_AXIS.rightY] ?? 0, dz) * lookScale,
    );

    this.padSprint =
      isPressed(pad, PAD_BUTTON.rightBumper) || isPressed(pad, PAD_BUTTON.rightTrigger);

    const jumpDown = isPressed(pad, PAD_BUTTON.a);
    if (jumpDown && !this.padJumpWasDown) this.jumpQueued = true;
    this.padJumpWasDown = jumpDown;

    const interactDown = isPressed(pad, PAD_BUTTON.x);
    if (interactDown && !this.padInteractWasDown) this.queuedActions.add('interact');
    this.padInteractWasDown = interactDown;
  }
}

/** Rescales the live part of the stick range so movement starts smoothly at the deadzone edge. */
function deadzone(v: number, dz: number): number {
  const m = Math.abs(v);
  if (m <= dz) return 0;
  return Math.sign(v) * ((m - dz) / (1 - dz));
}

function isPressed(pad: Gamepad, index: number): boolean {
  const b = pad.buttons[index];
  return b != null && (b.pressed || b.value > 0.5);
}
