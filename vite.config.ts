/**
 * vite.config.ts
 *
 * Contents: the Vite dev-server and production-build configuration for the game.
 *
 * Purpose: keep the toolchain deliberately boring. There is no asset pipeline (everything in the
 * game is procedural) and `@dimforge/rapier3d-compat` inlines its WASM as base64, so no WASM plugin
 * or `assetsInclude` entry is required. The only non-default choices are an ES2022 build target
 * (top-level await + modern syntax, matching tsconfig) and vendor chunk splitting so three.js and
 * Rapier can be cached independently of game code.
 */

import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: true,
    open: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // three + rapier are ~1 MB raw between them; splitting keeps game-code rebuilds cheap to fetch.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('@dimforge/rapier3d-compat')) return 'rapier';
          return null;
        },
      },
    },
    chunkSizeWarningLimit: 1600,
  },
  worker: {
    // WS1 generates terrain in a Web Worker; ESM workers keep the import syntax identical.
    format: 'es',
  },
});
