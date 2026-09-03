/**
 * src/landmarks/isfahanFacts.ts
 *
 * Contents: authored lore for Naqsh-e Jahan — five press-to-read plaques at the monuments and
 * pool, plus two NPCs (a bazaar merchant and a traveling scholar) who cycle spoken facts.
 *
 * Purpose: keep copy and local placements out of `LoreSystem`. Coordinates are landmark-local
 * metres from the plaza centre (+X east, +Z south / mosque, −Z north / bazaar).
 */

import type { LandmarkSite } from "../core/types";

export interface LoreLine {
  title: string;
  body: string;
}

export interface PlaqueDef {
  id: string;
  localX: number;
  localZ: number;
  title: string;
  body: string;
}

export interface NpcDef {
  id: string;
  localX: number;
  localZ: number;
  /** Landmark-local facing; 0 looks toward +Z (the mosque). */
  yaw: number;
  /** indigo traveler vs warm merchant cloak. */
  palette: "merchant" | "scholar";
  lines: readonly LoreLine[];
}

export interface IsfahanLore {
  plaques: PlaqueDef[];
  npcs: NpcDef[];
}

/**
 * @complexity Time: O(1) | Space: O(1) — a handful of authored records.
 */
export function isfahanLore(site: LandmarkSite): IsfahanLore {
  const hw = site.halfWidth;
  const hl = site.halfLength;

  return {
    plaques: [
      {
        id: "pool",
        localX: 14,
        localZ: 36,
        title: "The maidan",
        body: "This long basin sits on a square that was once a polo field. Naqsh-e Jahan was laid out so vast that polo matches and army reviews were held between the palaces. The water and parterres came later, when the maidan became a garden.",
      },
      {
        id: "shah",
        localX: 0,
        localZ: hl - 18,
        title: "Masjid-e Shah",
        body: "The Shah Mosque — now the Imam Mosque — was begun by Shah Abbas I in 1611. Its plan turns toward Mecca without breaking the square's north–south line. The dome's seven-colour tiles were a Safavid craft: one firing, seven glazes, a colour that shifts with the sun.",
      },
      {
        id: "lotfollah",
        localX: hw - 10,
        localZ: 0,
        title: "Sheikh Lotfollah",
        body: "The mosque on the east side was a private chapel for the court, named for Shah Abbas's father-in-law. It has no minarets and no courtyard. The cream dome is famous for changing colour from dawn to dusk — a trick of the glaze, not the light alone.",
      },
      {
        id: "ali-qapu",
        localX: -(hw - 10),
        localZ: 0,
        title: "Ali Qapu",
        body: "Ali Qapu, the High Gate, was the entrance to the royal precinct on the west side. From the music hall on the upper porch the shah watched polo and ceremonies in the square below. The wooden columns are a later memory of that talar.",
      },
      {
        id: "qeysarieh",
        localX: 0,
        localZ: -(hl - 16),
        title: "Qeysarieh",
        body: "The Qeysarieh portal is the door into the Grand Bazaar. From here the covered markets of Isfahan ran north — silk, spices, porcelain — so the square was a market as much as a palace courtyard. The name Ispahan is the older European spelling of the same city.",
      },
    ],
    npcs: [
      {
        id: "merchant",
        localX: 16,
        localZ: -(hl - 28),
        yaw: 0,
        palette: "merchant",
        lines: [
          {
            title: "A merchant of the Qeysarieh",
            body: "Ispahan — Isfahan — was called nisf-e jahan, half the world. See this square once, they said, and you have seen half of it. The other half is whatever you still owe the road.",
          },
          {
            title: "A merchant of the Qeysarieh",
            body: "Silk, porcelain, and spices moved through this bazaar. Shah Abbas wanted the capital's heart to be a market as well as a mosque, so a trader and a king would share the same paving.",
          },
          {
            title: "A merchant of the Qeysarieh",
            body: "The capital moved here in 1598. Before that the old square was smaller, closer to the Friday mosque. Abbas built this maidan so the city would have a new heart — and so the guns of the old quarters could not dictate the new one.",
          },
        ],
      },
      {
        id: "scholar",
        localX: -18,
        localZ: 20,
        yaw: Math.PI * 0.5,
        palette: "scholar",
        lines: [
          {
            title: "A traveler by the pool",
            body: "Naqsh-e Jahan means image of the world. Four buildings for four powers: the mosque, the school, the palace, and the bazaar. Walk the circuit and you have read the city in plan.",
          },
          {
            title: "A traveler by the pool",
            body: "Stone goal posts for polo once stood at either end of the maidan. The pool and the garden beds are later. What you walk now is a garden laid over a parade ground.",
          },
          {
            title: "A traveler by the pool",
            body: "The real square is a little longer than this island can hold — we walk a faithful fragment. UNESCO listed it as a World Heritage site; the name on the old maps is still Ispahan.",
          },
        ],
      },
    ],
  };
}
