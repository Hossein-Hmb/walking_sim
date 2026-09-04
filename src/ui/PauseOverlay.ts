/**
 * src/ui/PauseOverlay.ts
 *
 * Contents: `PauseOverlay` — the Esc panel. Full control reference, a quality-preset selector, a
 * short summary of the journey so far, and a resume button.
 *
 * Purpose: this is both the pause screen and the only help the game ever gives. There is no tutorial
 * and no menu system, so everything a player might need to look up has to be one key away.
 *
 * Quality presets: WS7 owns the *control*; WS8 owns what the levels actually do. Choosing one
 * persists it to `localStorage` and emits `quality:changed`, so when WS8 lands its renderer/grass/
 * shadow switches it only has to subscribe — the UI, the persistence and the restore-on-load are
 * already here.
 *
 * Accessibility: `role="dialog"` + `aria-modal`, focus is moved into the panel on open and returned
 * to the canvas on close, Tab is trapped inside the panel, and the whole thing is dismissible from
 * the keyboard alone. While closed it is `pointer-events: none`, so it can never eat game input.
 *
 * Ownership: WS7.
 */

import type { EventName } from '../core/EventBus';
import type { QualityLevel } from '../core/types';
import { CONTROLS } from './controls';
import { el, setClass, setText } from './dom';

const QUALITY_STORAGE_KEY = 'strandfall.quality';
const QUALITY_LEVELS: readonly QualityLevel[] = ['low', 'medium', 'high'];
const DEFAULT_QUALITY: QualityLevel = 'medium';

export interface PauseOverlayOptions {
  /** Called whenever the panel opens or closes, including via the backdrop or the resume button. */
  onToggle(open: boolean): void;
  /** Called when the player picks a preset — and once at construction with the restored value. */
  onQuality(level: QualityLevel): void;
}

/** The numbers shown in the "journey" block, refreshed each time the panel opens. */
export interface JourneySummary {
  /** Metres walked, horizontal distance only. */
  distanceM: number;
  altitudeM: number;
  /** In-world clock, "HH:MM". */
  clock: string;
  seed: number;
}

export class PauseOverlay {
  private readonly root: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly resumeBtn: HTMLButtonElement;
  private readonly debugHint: HTMLParagraphElement;
  private readonly journeyValues: Map<keyof JourneySummary, HTMLDivElement>;
  private readonly qualityButtons = new Map<QualityLevel, HTMLButtonElement>();
  /** Rows that stay dimmed until their owning workstream proves it exists. */
  private readonly pendingRows = new Map<EventName, HTMLDivElement[]>();

  private readonly opts: PauseOverlayOptions;
  private quality: QualityLevel;
  private open = false;
  private lastFocused: HTMLElement | null = null;

  constructor(parent: HTMLElement, opts: PauseOverlayOptions) {
    this.opts = opts;
    this.quality = readStoredQuality();

    this.root = el('div', 'pause', parent);
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', 'Paused');
    this.root.setAttribute('aria-hidden', 'true');

    this.panel = el('div', 'pause__panel', this.root);
    const title = el('h2', 'pause__title', this.panel);
    title.textContent = 'Iranzamin';
    const sub = el('p', 'pause__sub', this.panel);
    sub.textContent = 'paused — the island waits';

    this.buildControls();
    this.journeyValues = this.buildJourney();
    this.buildQuality();

    const foot = el('div', 'pause__foot', this.panel);
    this.debugHint = el('p', 'pause__hint', foot);
    this.setDebugState(false);
    this.resumeBtn = el('button', 'pause__resume', foot);
    this.resumeBtn.type = 'button';
    this.resumeBtn.textContent = 'resume';
    this.resumeBtn.addEventListener('click', () => this.setOpen(false));

    this.root.addEventListener('pointerdown', this.onBackdropPointerDown);
    this.root.addEventListener('keydown', this.onKeyDown);

    // Republish the restored preset so WS8 can apply it on the very first frame.
    opts.onQuality(this.quality);
  }

  get isOpen(): boolean {
    return this.open;
  }

  get qualityLevel(): QualityLevel {
    return this.quality;
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    setClass(this.root, 'is-open', open);
    this.root.setAttribute('aria-hidden', open ? 'false' : 'true');

    if (open) {
      this.lastFocused = document.activeElement as HTMLElement | null;
      this.resumeBtn.focus({ preventScroll: true });
    } else {
      // Hand focus back to the canvas so movement keys keep reaching the game.
      const canvas = document.querySelector<HTMLElement>('#game');
      (canvas ?? this.lastFocused)?.focus({ preventScroll: true });
      this.lastFocused = null;
    }

    this.opts.onToggle(open);
  }

  /** Refresh the journey block. Cheap, but only worth doing while the panel is visible. */
  setJourney(summary: JourneySummary): void {
    setText(this.journeyValues.get('distanceM')!, formatDistance(summary.distanceM));
    setText(this.journeyValues.get('altitudeM')!, `${Math.round(summary.altitudeM)} m`);
    setText(this.journeyValues.get('clock')!, summary.clock);
    setText(this.journeyValues.get('seed')!, String(summary.seed));
  }

  /**
   * Promote every control row waiting on `event` from "soon" to live. Called by the HUD the first
   * time it sees the event, so the help text tells the truth about which systems have landed.
   */
  markControlLive(event: EventName): void {
    const rows = this.pendingRows.get(event);
    if (!rows) return;
    for (const row of rows) {
      row.classList.remove('is-pending');
      row.querySelector('.control__soon')?.remove();
    }
    this.pendingRows.delete(event);
  }

  setDebugState(active: boolean): void {
    setText(
      this.debugHint,
      `esc to resume · f1 ${active ? 'hides' : 'shows'} the performance overlay`,
    );
  }

  dispose(): void {
    this.root.removeEventListener('pointerdown', this.onBackdropPointerDown);
    this.root.removeEventListener('keydown', this.onKeyDown);
    this.root.remove();
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private buildControls(): void {
    const section = el('section', 'pause__section', this.panel);
    const legend = el('h3', 'pause__legend', section);
    legend.textContent = 'controls';
    const grid = el('div', 'pause__controls', section);

    for (const binding of CONTROLS) {
      const pending = binding.provenBy !== undefined;
      const row = el('div', pending ? 'control is-pending' : 'control', grid);
      const keys = el('div', 'control__keys', row);
      for (const key of binding.keys) {
        const chip = el('span', 'key', keys);
        chip.textContent = key;
      }
      const action = el('span', 'control__action', row);
      action.textContent = binding.action;
      if (binding.provenBy) {
        const soon = el('span', 'control__soon', row);
        soon.textContent = 'soon';
        const list = this.pendingRows.get(binding.provenBy) ?? [];
        list.push(row);
        this.pendingRows.set(binding.provenBy, list);
      }
    }
  }

  private buildJourney(): Map<keyof JourneySummary, HTMLDivElement> {
    const section = el('section', 'pause__section', this.panel);
    const legend = el('h3', 'pause__legend', section);
    legend.textContent = 'journey';
    const grid = el('div', 'pause__journey', section);

    const cells: Array<[keyof JourneySummary, string]> = [
      ['distanceM', 'walked'],
      ['altitudeM', 'altitude'],
      ['clock', 'local time'],
      ['seed', 'island seed'],
    ];
    const map = new Map<keyof JourneySummary, HTMLDivElement>();
    for (const [key, label] of cells) {
      const cell = el('div', 'journey__cell', grid);
      const caption = el('div', 'journey__label', cell);
      caption.textContent = label;
      const value = el('div', 'journey__value mono', cell);
      value.textContent = '—';
      map.set(key, value);
    }
    return map;
  }

  private buildQuality(): void {
    const section = el('section', 'pause__section', this.panel);
    const legend = el('h3', 'pause__legend', section);
    legend.textContent = 'quality';
    const group = el('div', 'quality', section);
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Quality preset');

    for (const level of QUALITY_LEVELS) {
      const btn = el('button', 'quality__btn', group);
      btn.type = 'button';
      btn.textContent = level;
      btn.setAttribute('aria-pressed', String(level === this.quality));
      btn.addEventListener('click', () => this.selectQuality(level));
      this.qualityButtons.set(level, btn);
    }

    const note = el('p', 'quality__note', section);
    note.textContent =
      'affects resolution scale, grass density, shadows and view distance. saved for next time.';
  }

  private selectQuality(level: QualityLevel): void {
    if (this.quality === level) return;
    this.quality = level;
    for (const [key, btn] of this.qualityButtons) {
      btn.setAttribute('aria-pressed', String(key === level));
    }
    writeStoredQuality(level);
    this.opts.onQuality(level);
  }

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  /** Clicking the dimmed backdrop (but not the panel) resumes. */
  private readonly onBackdropPointerDown = (e: PointerEvent): void => {
    if (e.target === this.root) this.setOpen(false);
  };

  /** Keep Tab inside the panel while it is modal. */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab' || !this.open) return;
    const focusable = this.panel.querySelectorAll<HTMLElement>('button:not([disabled])');
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;

    if (e.shiftKey && (active === first || !this.panel.contains(active))) {
      e.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus({ preventScroll: true });
    }
  };
}

/** Metres under a kilometre, kilometres above it — nobody counts 1,412 m. */
function formatDistance(metres: number): string {
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(2)} km`;
}

/** `localStorage` throws in Safari private browsing; a missing preference is not worth a crash. */
function readStoredQuality(): QualityLevel {
  try {
    const stored = window.localStorage.getItem(QUALITY_STORAGE_KEY);
    if (stored && (QUALITY_LEVELS as readonly string[]).includes(stored)) {
      return stored as QualityLevel;
    }
  } catch {
    /* storage unavailable — fall through to the default */
  }
  return DEFAULT_QUALITY;
}

function writeStoredQuality(level: QualityLevel): void {
  try {
    window.localStorage.setItem(QUALITY_STORAGE_KEY, level);
  } catch {
    /* storage unavailable — the choice simply will not persist */
  }
}
