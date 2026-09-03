/**
 * src/ui/Compass.ts
 *
 * Contents: the `Compass` widget — a horizontal heading strip with cardinal/inter-cardinal ticks and
 * diamond markers for cairns, plus the small numeric heading readout beneath it.
 *
 * Purpose: on a 2 km island with no map, direction is the player's only navigation aid, and the
 * cairn markers are what turn "walking" into "walking towards something".
 *
 * Implementation note (this is the whole trick): the tick ring is built three times — at -360, 0 and
 * +360 degrees — inside a single absolutely-positioned track. Because the visible window is only
 * `SPAN_DEG` wide, those three copies always cover it, so rotating the compass is ONE `transform`
 * write per frame on one element, which stays on the compositor and never touches layout. Markers
 * live in the same track and pick whichever of the three copies is nearest the current heading; that
 * choice only changes when a marker is directly behind the player (i.e. off-screen), so it is safe
 * to refresh them at a few hertz instead of every frame.
 *
 * Ownership: WS7.
 */

import { HUD } from '../config/world.config';
import { RAD2DEG, wrap } from '../utils/math';
import { el, setProp, setText } from './dom';

/** Degrees of heading visible across the full width of the strip. */
const SPAN_DEG = HUD.compassSpanDeg;
/** One minor tick every this many degrees. */
const TICK_STEP = 15;
/** Copies of the tick ring, so the strip never runs out of ticks as the heading wraps. */
const RING_COPIES = [-360, 0, 360] as const;
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
/** Beyond this distance a marker is drawn at its faintest. */
const MARKER_FADE_M = 700;

export type MarkerKind = 'cairn' | 'ghost';

interface Marker {
  x: number;
  z: number;
  kind: MarkerKind;
  /** Scratch: squared distance to the player, refreshed on every `updateMarkers`. */
  d2: number;
}

/** Compass bearing in degrees, 0 = north (-Z), 90 = east (+X). */
export function bearingDeg(dx: number, dz: number): number {
  return wrap(Math.atan2(dx, -dz) * RAD2DEG, 360);
}

/**
 * `left` value for something sitting `deg` degrees around the ring. Written as an explicit
 * `+`/`-` because `calc(50% + -4%)` is legal but poorly supported in older engines.
 */
function ringLeft(deg: number): string {
  const pct = (deg / SPAN_DEG) * 100;
  return pct < 0 ? `calc(50% - ${(-pct).toFixed(3)}%)` : `calc(50% + ${pct.toFixed(3)}%)`;
}

/** Nearest 8-point cardinal name for a bearing. */
export function cardinalName(deg: number): string {
  return CARDINALS[Math.round(wrap(deg, 360) / 45) % 8]!;
}

export class Compass {
  readonly root: HTMLDivElement;

  private readonly track: HTMLDivElement;
  private readonly headingLabel: HTMLDivElement;
  private readonly slots: HTMLDivElement[] = [];
  private readonly markers: Marker[] = [];
  /** Reused index buffer so the 4 Hz marker refresh allocates nothing. */
  private readonly order: number[] = [];
  private heading = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud__compass', parent);
    this.root.setAttribute('aria-hidden', 'true'); // decorative; the readout carries the numbers

    const strip = el('div', 'compass__strip', this.root);
    this.track = el('div', 'compass__track', strip);
    el('div', 'compass__needle', strip);
    this.headingLabel = el('div', 'compass__heading mono', this.root);

    this.buildTicks();
    this.buildMarkerSlots();
  }

  /**
   * Rotate the strip. Call every frame — it is a single compositor-friendly write.
   *
   * @param deg - camera heading in degrees, 0 = north
   * @complexity Time: O(1) | Space: O(1)
   */
  setHeading(deg: number): void {
    this.heading = wrap(deg, 360);
    const pct = (this.heading / SPAN_DEG) * 100;
    setProp(this.track, 'transform', `translateX(${(-pct).toFixed(3)}%)`);
  }

  /** Update the "312° NW" text. Throttled by the caller — it costs a text write. */
  refreshLabel(): void {
    const deg = Math.round(this.heading) % 360;
    setText(this.headingLabel, `${String(deg).padStart(3, '0')}°  ${cardinalName(deg)}`);
  }

  /**
   * Register a point of interest. Silently drops the oldest once `HUD.maxMarkers` is reached, so a
   * player who spams cairns cannot grow the DOM or the per-tick cost without bound.
   */
  addMarker(x: number, z: number, kind: MarkerKind): void {
    this.markers.push({ x, z, kind, d2: 0 });
    if (this.markers.length > HUD.maxMarkers) this.markers.shift();
  }

  get markerCount(): number {
    return this.markers.length;
  }

  /**
   * Point the marker diamonds at the nearest cairns.
   *
   * @param px - player world x
   * @param pz - player world z
   * @returns distance in metres to the nearest marker, or -1 when there are none
   *
   * @complexity Time: O(n log n) on marker count (n <= HUD.maxMarkers = 32), at HUD.readoutHz/2.
   *             Space: O(1) — the index buffer is reused.
   */
  updateMarkers(px: number, pz: number): number {
    const markers = this.markers;
    const order = this.order;
    order.length = 0;

    for (let i = 0; i < markers.length; i++) {
      const m = markers[i]!;
      const dx = m.x - px;
      const dz = m.z - pz;
      m.d2 = dx * dx + dz * dz;
      order.push(i);
    }
    order.sort((a, b) => markers[a]!.d2 - markers[b]!.d2);

    const shown = Math.min(order.length, this.slots.length);
    for (let s = 0; s < this.slots.length; s++) {
      const slot = this.slots[s]!;
      if (s >= shown) {
        setProp(slot, 'opacity', '0');
        continue;
      }
      const m = markers[order[s]!]!;
      const dist = Math.sqrt(m.d2);
      const bearing = bearingDeg(m.x - px, m.z - pz);

      // Choose the ring copy that sits nearest the current heading, so the marker is on the same
      // side of the strip as the thing it points at.
      const delta = ((((bearing - this.heading) % 360) + 540) % 360) - 180;
      const absolute = this.heading + delta;

      setProp(slot, 'left', ringLeft(absolute));
      setProp(slot, 'opacity', (dist > MARKER_FADE_M ? 0.22 : 0.9 - 0.5 * (dist / MARKER_FADE_M)).toFixed(2));
      if (slot.classList.contains('is-ghost') !== (m.kind === 'ghost')) {
        slot.classList.toggle('is-ghost', m.kind === 'ghost');
      }
    }

    return shown > 0 ? Math.sqrt(markers[order[0]!]!.d2) : -1;
  }

  /**
   * ~96 static nodes. Built into a fragment and attached in one go, so the browser does a single
   * style/layout pass instead of one per tick.
   *
   * @complexity Time: O(360 / TICK_STEP * RING_COPIES) = O(1) with the constants above.
   */
  private buildTicks(): void {
    const fragment = document.createDocumentFragment();
    for (const offset of RING_COPIES) {
      for (let a = 0; a < 360; a += TICK_STEP) {
        const left = ringLeft(a + offset);
        const cardinal = a % 45 === 0;

        const tick = el('div', cardinal ? 'compass__tick is-cardinal' : 'compass__tick', fragment);
        tick.style.left = left;

        if (cardinal) {
          const label = el(
            'div',
            a % 90 === 0 ? 'compass__label' : 'compass__label is-minor',
            fragment,
          );
          label.style.left = left;
          label.textContent = cardinalName(a);
        }
      }
    }
    this.track.appendChild(fragment);
  }

  private buildMarkerSlots(): void {
    for (let i = 0; i < HUD.markerSlots; i++) {
      const slot = el('div', 'compass__marker', this.track);
      slot.style.opacity = '0';
      this.slots.push(slot);
    }
  }
}
