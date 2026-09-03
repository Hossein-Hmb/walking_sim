/**
 * src/player/TouchControls.ts
 *
 * Contents: the on-screen left stick and the three right-hand buttons (jump, run, read) used on
 * phones and tablets. Pointer events only — no keyboard, no gamepad.
 *
 * Purpose: keep mobile input inside WS3. `InputSystem` reads `move` / `sprint` and the jump/interact
 * queues each frame; this file only owns the DOM overlay and the finger math. The rest of the
 * screen still belongs to look-drag on the canvas.
 */

import "./touch.css";
import * as THREE from "three";
import { TOUCH } from "../config/world.config";

export function preferTouchControls(): boolean {
  return window.matchMedia("(hover: none), (pointer: coarse)").matches;
}

/**
 * @complexity Time: O(1) per pointer event | Space: O(1)
 */
export class TouchControls {
  readonly root: HTMLDivElement;
  readonly move = new THREE.Vector2();
  sprint = false;

  onJump: (() => void) | null = null;
  onInteract: (() => void) | null = null;

  private readonly knob: HTMLDivElement;
  private readonly base: HTMLDivElement;
  private stickId: number | null = null;
  private originX = 0;
  private originY = 0;
  private travel = 48;
  private visible = false;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "touch";
    this.root.setAttribute("aria-hidden", "true");

    const zone = document.createElement("div");
    zone.className = "touch__stick-zone";
    this.base = document.createElement("div");
    this.base.className = "touch__stick-base";
    this.knob = document.createElement("div");
    this.knob.className = "touch__stick-knob";
    this.base.appendChild(this.knob);
    zone.appendChild(this.base);
    this.root.appendChild(zone);

    const actions = document.createElement("div");
    actions.className = "touch__actions";
    actions.appendChild(this.makeButton("read", "interact"));
    actions.appendChild(this.makeButton("jump", "jump"));
    actions.appendChild(this.makeButton("run", "sprint"));
    this.root.appendChild(actions);

    this.root.addEventListener("contextmenu", (e) => e.preventDefault());
    zone.addEventListener("pointerdown", this.onStickDown);
    window.addEventListener("pointermove", this.onStickMove);
    window.addEventListener("pointerup", this.onStickUp);
    window.addEventListener("pointercancel", this.onStickUp);

    if (preferTouchControls()) this.show();
    window.addEventListener("touchstart", this.reveal, { passive: true });
  }

  /** True once the overlay is on screen — canvas look should then skip pointer-lock. */
  get active(): boolean {
    return this.visible;
  }

  attach(parent: HTMLElement): void {
    parent.appendChild(this.root);
  }

  reset(): void {
    this.stickId = null;
    this.move.set(0, 0);
    this.sprint = false;
    this.knob.style.transform = "";
    this.root.querySelector(".touch__btn--run")?.classList.remove("is-held");
  }

  dispose(): void {
    window.removeEventListener("pointermove", this.onStickMove);
    window.removeEventListener("pointerup", this.onStickUp);
    window.removeEventListener("pointercancel", this.onStickUp);
    window.removeEventListener("touchstart", this.reveal);
    this.reset();
    this.root.remove();
  }

  private readonly reveal = (): void => {
    this.show();
  };

  private show(): void {
    if (this.visible) return;
    this.visible = true;
    this.root.classList.add("is-on");
    document.body.classList.add("is-touch");
  }

  private makeButton(label: string, action: "jump" | "sprint" | "interact"): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `touch__btn touch__btn--${action === "sprint" ? "run" : action}`;
    btn.textContent = label;
    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType !== "touch") return;
      e.preventDefault();
      e.stopPropagation();
      btn.setPointerCapture(e.pointerId);
      if (action === "jump") this.onJump?.();
      else if (action === "interact") this.onInteract?.();
      else {
        this.sprint = true;
        btn.classList.add("is-held");
      }
    });
    if (action === "sprint") {
      const release = (): void => {
        this.sprint = false;
        btn.classList.remove("is-held");
      };
      btn.addEventListener("pointerup", release);
      btn.addEventListener("pointercancel", release);
      btn.addEventListener("lostpointercapture", release);
    }
    return btn;
  }

  private readonly onStickDown = (e: PointerEvent): void => {
    if (this.stickId !== null) return;
    if (e.button !== 0 && e.pointerType !== "touch") return;
    e.preventDefault();
    e.stopPropagation();
    this.stickId = e.pointerId;
    const rect = this.base.getBoundingClientRect();
    this.originX = rect.left + rect.width * 0.5;
    this.originY = rect.top + rect.height * 0.5;
    this.travel = rect.width * 0.5 * TOUCH.stickTravel;
    this.base.setPointerCapture(e.pointerId);
    this.applyStick(e.clientX, e.clientY);
  };

  private readonly onStickMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.stickId) return;
    this.applyStick(e.clientX, e.clientY);
  };

  private readonly onStickUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.stickId) return;
    this.stickId = null;
    this.move.set(0, 0);
    this.knob.style.transform = "";
  };

  private applyStick(clientX: number, clientY: number): void {
    const dx = clientX - this.originX;
    const dy = clientY - this.originY;
    const len = Math.hypot(dx, dy);
    const max = Math.max(this.travel, 1);
    const scale = len > max ? max / len : 1;
    const nx = (dx * scale) / max;
    const ny = -(dy * scale) / max;
    const mag = Math.hypot(nx, ny);
    if (mag <= TOUCH.stickDeadzone) {
      this.move.set(0, 0);
    } else {
      const live = (mag - TOUCH.stickDeadzone) / (1 - TOUCH.stickDeadzone);
      this.move.set((nx / mag) * live, (ny / mag) * live);
    }
    this.knob.style.transform = `translate(${(dx * scale).toFixed(1)}px, ${(dy * scale).toFixed(1)}px)`;
  }
}
