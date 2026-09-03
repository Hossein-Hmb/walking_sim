/**
 * src/ui/controls.ts
 *
 * Contents: `CONTROLS`, the single canonical list of key bindings shown to the player, plus the
 * `ControlBinding` shape.
 *
 * Purpose: the first-run hint strip and the pause/help overlay must never disagree about what a key
 * does, so both read this table. The bindings themselves are owned by the input implementation
 * (WS0's `StubInput`, later WS3's `InputSystem`); this file is only their description.
 *
 * `provenBy` is how the UI copes with workstreams that have not landed yet: a control whose feature
 * system does not exist is rendered dimmed and tagged "soon", and is promoted to normal the first
 * time the HUD observes the named event. Nothing has to be edited when WS6 arrives — placing a
 * cairn once is enough to light the row up. WS8 may drop the flags entirely.
 *
 * Ownership: WS7.
 */

import type { EventName } from '../core/EventBus';

export interface ControlBinding {
  /** Key caps, rendered as separate chips. */
  keys: readonly string[];
  /** Lower-case verb phrase — the HUD never shouts. */
  action: string;
  /** Shown in the compact first-run hint strip, not just the pause overlay. */
  hint?: boolean;
  /**
   * Event that proves the owning system exists. While unseen the row renders as "soon".
   * Omit for controls handled by WS0/WS7, which are always live.
   */
  provenBy?: EventName;
}

export const CONTROLS: readonly ControlBinding[] = [
  { keys: ['↑', '↓', '←', '→'], action: 'walk', hint: true },
  { keys: ['W', 'A', 'S', 'D'], action: 'walk' },
  { keys: ['Shift'], action: 'press on — costs stamina', hint: true },
  { keys: ['Space'], action: 'jump' },
  { keys: ['drag'], action: 'look around', hint: true },
  { keys: ['Q'], action: 'read the land', provenBy: 'scan:pulse' },
  { keys: ['C'], action: 'leave a cairn', provenBy: 'cairn:placed' },
  { keys: ['P'], action: 'photo mode', provenBy: 'photo:toggle' },
  { keys: ['E'], action: 'read a nearby fact', provenBy: 'hud:lore' },
  { keys: ['F1'], action: 'performance overlay' },
  { keys: ['Esc', 'H'], action: 'pause & help', hint: true },
];
