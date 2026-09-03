/**
 * src/world/terrain.worker.ts
 *
 * Contents: the Web Worker wrapper around `generateTerrain`. Receives a `TerrainWorkerRequest`,
 * streams `progress` messages while it works, and posts a single `done` message whose typed arrays
 * are **transferred** (zero-copy) back to the main thread.
 *
 * Purpose: PLAN.md WS1 requires terrain generation to happen off the main thread so the loading
 * screen keeps animating and the first frame is not blocked for ~400 ms. This file deliberately
 * contains no logic of its own — everything lives in `TerrainGenerator.ts` so the exact same code
 * path can run synchronously on the main thread as a fallback when workers are unavailable.
 *
 * ⚠ The worker bundle must stay free of three.js. Its whole import graph is `TerrainGenerator` →
 * `RiverNetwork` / `noise` → `utils/math` + `simplex-noise`, none of which touch the renderer.
 */

import { generateTerrain, type TerrainWorkerRequest, type TerrainWorkerResponse } from './TerrainGenerator';

/**
 * The project's tsconfig ships the DOM lib rather than WebWorker (it is shared with the app), so
 * `self` is typed as a Window. Narrow it to just the two members a worker actually needs — this
 * keeps `postMessage`'s transfer-list overload correctly typed.
 */
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<TerrainWorkerRequest>) => void) | null;
  postMessage(message: TerrainWorkerResponse, transfer?: Transferable[]): void;
};

ctx.onmessage = (event: MessageEvent<TerrainWorkerRequest>): void => {
  const request = event.data;
  if (!request || request.type !== 'generate') return;

  try {
    const result = generateTerrain(request.params, (progress, label) => {
      ctx.postMessage({ type: 'progress', progress, label });
    });

    // Every buffer leaving here is transferred, not cloned: 6 MB of typed arrays would otherwise be
    // copied twice (structured clone + GC pressure) on a thread that is about to render.
    const transfer: Transferable[] = [
      result.heights.buffer,
      result.biomes.buffer,
      result.riverMask.buffer,
    ];
    for (const river of result.rivers) transfer.push(river.points.buffer);

    ctx.postMessage(
      {
        type: 'done',
        heights: result.heights,
        biomes: result.biomes,
        riverMask: result.riverMask,
        rivers: result.rivers,
        stats: result.stats,
      },
      transfer,
    );
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
