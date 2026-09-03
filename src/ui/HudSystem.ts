/**
 * src/ui/HudSystem.ts
 *
 * Contents: `HudSystem`, the System that owns every piece of in-game UI — the compass strip, the
 * stamina ring, the altitude/journey readout, the first-run control hints, the toast queue, the
 * interact prompt, the lore card, the tumble vignette, and the pause/help overlay.
 *
 * Purpose: give the player the four things a walking simulator actually needs — which way am I
 * facing, how much effort is left, how high am I, and what do the keys do — without ever drawing a
 * polygon. Everything here is DOM, so the HUD costs zero draw calls and zero triangles against the
 * `PERF` budget and stays crisp at any device pixel ratio.
 *
 * Cost discipline (the acceptance criterion is < 0.3 ms/frame):
 *   - Per frame: one `transform` write to rotate the compass, plus a distance accumulation. That's
 *     it. The transform stays on the compositor and never invalidates layout.
 *   - Everything textual runs on a `HUD.readoutHz` throttle, and every write goes through the
 *     compare-first helpers in `dom.ts`, so an unchanged value costs a string comparison.
 *   - The frame's own cost is reported as `perf.mark('hud', ms)` and shows up in the F1 overlay.
 *
 * Event coupling: the HUD subscribes to everything and requires nothing. Systems that have not
 * landed yet simply never emit, and their rows render as placeholders — `player:tumbled`,
 * `weather:changed`, `cairn:placed`, `scan:pulse` and `photo:toggle` all light up the moment their
 * owning workstream starts emitting, with no edit here.
 *
 * Pause: the overlay emits `hud:pause`; whoever owns the loop decides what that means (in `main.ts`
 * it stops and restarts the Engine's RAF). Because a stopped Engine never calls `update`, the pause
 * key is handled by a direct DOM listener rather than through `InputState.actions` — otherwise the
 * game could be paused but not un-paused.
 *
 * Ownership: WS7. This file, `LoadingScreen.ts`, `Compass.ts`, `PauseOverlay.ts`, `controls.ts`,
 * `dom.ts` and `hud.css` are the whole of it.
 */

import "./hud.css";
import * as THREE from "three";
import { HUD } from "../config/world.config";
import type { EventName, Unsubscribe } from "../core/EventBus";
import type {
  BiomeName,
  BiomeWeights,
  GameContext,
  System,
} from "../core/types";
import { clamp01, RAD2DEG, wrap } from "../utils/math";
import { perf } from "../utils/Perf";
import { Compass } from "./Compass";
import { CONTROLS } from "./controls";
import { el, setClass, setText } from "./dom";
import { PauseOverlay } from "./PauseOverlay";

/** Stamina/balance arc geometry, in the SVG's 100x100 user space. */
const RING_RADIUS = 44;
const BALANCE_RADIUS = 37;
/** The arc spans 270 degrees, leaving a 90 degree gap at the bottom. */
const ARC_FRACTION = 0.75;
const RING_CIRCUM = 2 * Math.PI * RING_RADIUS;
const BALANCE_CIRCUM = 2 * Math.PI * BALANCE_RADIUS;

/** A single frame moving the player further than this is a teleport, not a walk. */
const MAX_STEP_M = 4;

const BIOME_LABELS: Readonly<Record<BiomeName, string>> = {
  grass: "grassland",
  rock: "scree",
  snow: "snowfield",
  sand: "strand",
  water: "shallows",
};

const BIOME_ORDER: readonly BiomeName[] = ["grass", "rock", "snow", "sand"];

interface ReadoutRow {
  row: HTMLDivElement;
  value: HTMLDivElement;
}

export class HudSystem implements System {
  readonly name = "hud";

  private ctx!: GameContext;
  private root!: HTMLDivElement;
  private compass!: Compass;
  private pause!: PauseOverlay;

  private staminaBox!: HTMLDivElement;
  private staminaArc!: SVGCircleElement;
  private balanceArc!: SVGCircleElement;
  private staminaLabel!: HTMLDivElement;
  private hints!: HTMLDivElement;
  private prompt!: HTMLDivElement;
  private promptLabel!: HTMLSpanElement;
  private lore!: HTMLDivElement;
  private loreTitle!: HTMLHeadingElement;
  private loreBody!: HTMLParagraphElement;
  private toastBox!: HTMLDivElement;
  private vignette!: HTMLDivElement;
  private readonly rows = new Map<string, ReadoutRow>();

  private readonly unsubscribes: Unsubscribe[] = [];
  private readonly timers = new Set<number>();
  private readonly toasts: HTMLDivElement[] = [];

  private readonly camDir = new THREE.Vector3();
  private readonly lastPos = new THREE.Vector3();
  private hasLastPos = false;
  private distanceM = 0;

  private throttle = 0;
  private markerPhase = 0;
  private hintsStart = -1;
  private hintsFaded = false;
  /** True once `loading:done` has fired. Until then there is nothing to pause. */
  private live = false;
  private photoActive = false;
  private weather = { rain: 0, snow: 0, wind: 0 };
  private weatherSeen = false;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.root = el("div", "hud", document.body);

    this.compass = new Compass(this.root);
    this.buildToasts();
    this.buildPrompt();
    this.buildLore();
    this.buildStamina();
    this.buildReadout();
    this.buildHints();
    this.vignette = el("div", "hud__vignette", this.root);

    this.pause = new PauseOverlay(document.body, {
      onToggle: (open) => {
        if (open) this.refreshJourney();
        ctx.events.emit("hud:pause", { paused: open });
      },
      onQuality: (level) => {
        perf.note("quality", level);
        ctx.events.emit("quality:changed", { level });
      },
    });

    this.subscribe(ctx);
    window.addEventListener("keydown", this.onKeyDown);

    this.lastPos.copy(ctx.player.position);
    this.hasLastPos = true;

    for (const site of ctx.world.data.landmarks ?? []) {
      this.compass.addMarker(site.x, site.z, "cairn");
    }
  }

  /**
   * @complexity Time: O(1) per frame; O(markers log markers) on the 2 Hz marker tick, with
   *             markers capped at `HUD.maxMarkers`. Space: O(1) — no per-frame allocation.
   */
  update(dt: number, ctx: GameContext): void {
    const t0 = performance.now();

    this.accumulateDistance(ctx);

    // The only unconditional DOM write in the frame.
    ctx.camera.getWorldDirection(this.camDir);
    this.compass.setHeading(
      wrap(Math.atan2(this.camDir.x, -this.camDir.z) * RAD2DEG, 360),
    );

    this.throttle += dt;
    const interval = 1 / HUD.readoutHz;
    if (this.throttle >= interval) {
      this.throttle = 0;
      this.compass.refreshLabel();
      this.updateStamina(ctx);
      this.updateReadout(ctx);
      this.updateHints(ctx);

      // Markers move only when the player does, so they run at half the readout rate.
      this.markerPhase ^= 1;
      if (this.markerPhase === 0 && this.compass.markerCount > 0) {
        const nearest = this.compass.updateMarkers(
          ctx.player.position.x,
          ctx.player.position.z,
        );
        this.setRow("cairn", nearest >= 0, `${Math.round(nearest)} m`);
      }
    }

    perf.mark("hud", performance.now() - t0);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    this.pause.dispose();
    this.root.remove();
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private buildToasts(): void {
    this.toastBox = el("div", "hud__toasts", this.root);
    this.toastBox.setAttribute("role", "status");
    this.toastBox.setAttribute("aria-live", "polite");
  }

  private buildPrompt(): void {
    this.prompt = el("div", "hud__prompt", this.root);
    this.prompt.setAttribute("aria-hidden", "true");
    const key = el("span", "key", this.prompt);
    key.textContent = "E";
    this.promptLabel = el("span", "hud__prompt-label", this.prompt);
    this.promptLabel.textContent = "read";
  }

  private buildLore(): void {
    this.lore = el("div", "hud__lore", this.root);
    this.lore.setAttribute("role", "dialog");
    this.lore.setAttribute("aria-hidden", "true");
    el("div", "lore__rule", this.lore);
    this.loreTitle = el("h2", "lore__title", this.lore);
    this.loreBody = el("p", "lore__body", this.lore);
    const hint = el("p", "lore__hint", this.lore);
    const key = el("span", "key", hint);
    key.textContent = "E";
    const rest = el("span", undefined, hint);
    rest.textContent = "close";
  }

  private buildStamina(): void {
    this.staminaBox = el("div", "hud__stamina", this.root);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "stamina__svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("aria-hidden", "true");
    this.staminaBox.appendChild(svg);

    const track = arcCircle(RING_RADIUS, "stamina__track");
    track.setAttribute("stroke-dasharray", dashArray(RING_CIRCUM, 1));
    svg.appendChild(track);

    this.staminaArc = arcCircle(RING_RADIUS, "stamina__value");
    this.staminaArc.setAttribute("stroke-dasharray", dashArray(RING_CIRCUM, 1));
    svg.appendChild(this.staminaArc);

    this.balanceArc = arcCircle(BALANCE_RADIUS, "stamina__balance");
    this.balanceArc.setAttribute(
      "stroke-dasharray",
      dashArray(BALANCE_CIRCUM, 1),
    );
    svg.appendChild(this.balanceArc);

    this.staminaLabel = el("div", "stamina__label", this.staminaBox);
    this.staminaLabel.textContent = "steady";
  }

  private buildReadout(): void {
    const box = el("div", "hud__readout", this.root);
    for (const [key, label] of [
      ["alt", "alt"],
      ["ground", "ground"],
      ["walked", "walked"],
      ["clock", "time"],
      ["weather", "sky"],
      ["cairn", "cairn"],
    ] as const) {
      const row = el("div", "readout__row", box);
      const caption = el("div", "readout__label", row);
      caption.textContent = label;
      const value = el("div", "readout__value mono", row);
      value.textContent = "—";
      this.rows.set(key, { row, value });
    }
    // Conditional rows start hidden and appear when their system reports something.
    this.rows.get("weather")!.row.classList.add("is-hidden");
    this.rows.get("cairn")!.row.classList.add("is-hidden");
  }

  private buildHints(): void {
    this.hints = el("div", "hud__hints", this.root);
    for (const binding of CONTROLS) {
      if (!binding.hint) continue;
      const hint = el("div", "hint", this.hints);
      for (const key of binding.keys) {
        const chip = el("span", "key", hint);
        chip.textContent = key;
      }
      const action = el("span", undefined, hint);
      action.textContent = binding.action;
    }
  }

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------

  private subscribe(ctx: GameContext): void {
    const on = ctx.events;
    this.unsubscribes.push(
      on.on("loading:done", () => {
        this.live = true;
        this.root.classList.add("is-live");
        this.hintsStart = ctx.time.elapsed;
      }),

      on.on("hud:toast", ({ text, ms }) => this.toast(text, ms)),

      on.on("hud:prompt", ({ label }) => this.setPrompt(label)),

      on.on("hud:lore", (payload) => this.setLore(payload)),

      // WS3 already emits its own `hud:toast` for this, so only the vignette belongs here.
      on.on("player:tumbled", () => this.flash()),

      on.on("player:enterBiome", ({ biome }) =>
        this.toast(`the ${BIOME_LABELS[biome]}`),
      ),

      on.on("cairn:placed", ({ position, isGhost }) => {
        this.compass.addMarker(
          position.x,
          position.z,
          isGhost ? "ghost" : "cairn",
        );
        if (!isGhost) this.toast("a cairn stands here");
        this.markLive("cairn:placed");
      }),

      on.on("landmark:placed", ({ position, name }) => {
        this.compass.addMarker(position.x, position.z, "cairn");
        this.toast(name, 2800);
      }),

      on.on("weather:changed", ({ rain, snow, wind }) => {
        this.weather.rain = rain;
        this.weather.snow = snow;
        this.weather.wind = wind.length();
        this.weatherSeen = true;
      }),

      on.on("scan:pulse", () => this.markLive("scan:pulse")),

      on.on("photo:toggle", ({ active }) => {
        this.photoActive = active;
        setClass(this.root, "is-hidden", active);
        if (active) this.pause.setOpen(false);
        this.markLive("photo:toggle");
      }),

      on.on("debug:toggle", ({ active }) => this.pause.setDebugState(active)),
    );
  }

  /** Promote a control row from "soon" to live now that its system has proven it exists. */
  private markLive(event: EventName): void {
    this.pause.markControlLive(event);
  }

  /**
   * Esc / H toggle the pause overlay. This is a direct DOM listener rather than an `InputState`
   * action because a paused Engine stops calling `update`, and a pause you cannot leave is a
   * hang. `keydown` still fires while the loop is stopped.
   */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    const isEscape = e.code === "Escape";
    const isHelp = e.code === "KeyH" && !this.pause.isOpen;
    if (!isEscape && !isHelp) return;
    if (!this.live || this.photoActive) return; // nothing to pause yet / P owns the frame
    e.preventDefault();
    this.pause.toggle();
  };

  // -------------------------------------------------------------------------
  // Per-tick updates
  // -------------------------------------------------------------------------

  private accumulateDistance(ctx: GameContext): void {
    const p = ctx.player.position;
    if (this.hasLastPos) {
      const dx = p.x - this.lastPos.x;
      const dz = p.z - this.lastPos.z;
      const step = Math.sqrt(dx * dx + dz * dz);
      // Spawns and tumble-recoveries teleport; those metres were not walked.
      if (step < MAX_STEP_M) this.distanceM += step;
    }
    this.lastPos.copy(p);
    this.hasLastPos = true;
  }

  private updateStamina(ctx: GameContext): void {
    const { stamina, balance, isTumbling } = ctx.player;
    const s = clamp01(stamina);
    const b = clamp01(balance);

    this.staminaArc.setAttribute("stroke-dasharray", dashArray(RING_CIRCUM, s));
    this.balanceArc.setAttribute(
      "stroke-dasharray",
      dashArray(BALANCE_CIRCUM, b),
    );

    const unsteady = b < 0.98 || isTumbling;
    setClass(this.staminaBox, "is-active", s < 0.995 || unsteady);
    setClass(this.staminaBox, "is-low", s < 0.35);
    setClass(this.staminaBox, "is-spent", s < 0.1);
    setClass(this.staminaBox, "is-unsteady", unsteady);

    setText(this.staminaLabel, staminaWord(s, b, isTumbling));
  }

  private updateReadout(ctx: GameContext): void {
    const player = ctx.player;
    this.setRow("alt", true, `${Math.round(player.altitude)} m`);
    this.setRow(
      "ground",
      true,
      groundLabel(player.biome, player.altitude, ctx.world.data.seaLevel),
    );
    this.setRow("walked", true, formatDistance(this.distanceM));
    this.setRow("clock", true, formatClock(ctx.time.timeOfDay));

    if (this.weatherSeen) {
      const { rain, snow, wind } = this.weather;
      const sky = snow > 0.05 ? "blizzard" : rain > 0.05 ? "timefall" : "clear";
      this.setRow("weather", true, `${sky} · ${wind.toFixed(0)} m/s`);
    }
  }

  private updateHints(ctx: GameContext): void {
    if (this.hintsFaded || this.hintsStart < 0) return;
    if (ctx.time.elapsed - this.hintsStart < HUD.hintsFadeAfterSeconds) return;
    this.hintsFaded = true;
    this.hints.classList.add("is-faded");
  }

  private refreshJourney(): void {
    this.pause.setJourney({
      distanceM: this.distanceM,
      altitudeM: this.ctx.player.altitude,
      clock: formatClock(this.ctx.time.timeOfDay),
      seed: this.ctx.world.data.seed,
    });
  }

  private setRow(key: string, visible: boolean, value: string): void {
    const row = this.rows.get(key);
    if (!row) return;
    setClass(row.row, "is-hidden", !visible);
    if (visible) setText(row.value, value);
  }

  // -------------------------------------------------------------------------
  // Toasts & feedback
  // -------------------------------------------------------------------------

  private setPrompt(label: string | null): void {
    const on = label !== null;
    setClass(this.prompt, "is-on", on);
    this.prompt.setAttribute("aria-hidden", on ? "false" : "true");
    if (label) setText(this.promptLabel, label);
  }

  private setLore(payload: { title: string; body: string } | null): void {
    const on = payload !== null;
    setClass(this.lore, "is-open", on);
    this.lore.setAttribute("aria-hidden", on ? "false" : "true");
    if (payload) {
      setText(this.loreTitle, payload.title);
      setText(this.loreBody, payload.body);
      this.markLive("hud:lore");
    }
  }

  /**
   * Queue a transient message. Oldest toasts are evicted immediately once `HUD.maxToasts` is
   * reached, so a burst of events can never grow the DOM or push the HUD off screen.
   */
  private toast(text: string, ms: number = HUD.toastDefaultMs): void {
    while (this.toasts.length >= HUD.maxToasts)
      this.removeToast(this.toasts[0]!);

    const node = el("div", "toast", this.toastBox);
    node.textContent = text;
    this.toasts.push(node);
    // One frame at the initial opacity so the transition actually runs.
    requestAnimationFrame(() => node.classList.add("is-in"));
    this.after(Math.max(ms, 400), () => this.removeToast(node));
  }

  private removeToast(node: HTMLDivElement): void {
    const i = this.toasts.indexOf(node);
    if (i < 0) return;
    this.toasts.splice(i, 1);
    node.classList.remove("is-in");
    this.after(400, () => node.remove());
  }

  /** A wash of colour across the screen — used when the player goes down. */
  private flash(): void {
    this.vignette.classList.remove("is-flash");
    // Force a reflow so re-adding the class restarts the animation.
    void this.vignette.offsetWidth;
    this.vignette.classList.add("is-flash");
  }

  /** `setTimeout` that is guaranteed to be cancelled on dispose. */
  private after(ms: number, fn: () => void): void {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** One arc of the stamina ring. The 135 deg rotation that opens the gap lives in the stylesheet. */
function arcCircle(radius: number, className: string): SVGCircleElement {
  const circle = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "circle",
  );
  circle.setAttribute("class", className);
  circle.setAttribute("cx", "50");
  circle.setAttribute("cy", "50");
  circle.setAttribute("r", String(radius));
  return circle;
}

/** `stroke-dasharray` that draws `fraction` of a 270 deg arc on a circle of circumference `c`. */
function dashArray(c: number, fraction: number): string {
  return `${(c * ARC_FRACTION * fraction).toFixed(2)} ${c.toFixed(2)}`;
}

function staminaWord(
  stamina: number,
  balance: number,
  tumbling: boolean,
): string {
  if (tumbling) return "falling";
  if (balance < 0.6) return "unsteady";
  if (stamina < 0.1) return "spent";
  if (stamina < 0.35) return "winded";
  if (stamina < 0.8) return "working";
  return "steady";
}

/**
 * Dominant biome, overridden by water once the player is actually wading. The threshold sits just
 * *below* sea level rather than at it, so standing on a beach at 0 m still reads as land.
 *
 * @complexity Time: O(1) — four weights, unrolled by the loop bound.
 */
function groundLabel(
  weights: BiomeWeights,
  altitude: number,
  seaLevel: number,
): string {
  if (altitude < seaLevel - 0.1) return BIOME_LABELS.water;
  let best = 0;
  for (let i = 1; i < 4; i++) {
    if (weights[i]! > weights[best]!) best = i;
  }
  return BIOME_LABELS[BIOME_ORDER[best]!];
}

function formatDistance(metres: number): string {
  return metres < 1000
    ? `${Math.round(metres)} m`
    : `${(metres / 1000).toFixed(2)} km`;
}

/** `TimeState.timeOfDay` (0..1, 0 = midnight) as a 24 h clock. */
function formatClock(timeOfDay: number): string {
  const total = wrap(timeOfDay, 1) * 24;
  const hours = Math.floor(total);
  const minutes = Math.floor((total - hours) * 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
