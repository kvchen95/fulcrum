/**
 * Host vite config — nothing but one line of plugins.
 *
 * All logic lives in @fulcrum/entry-vite:
 *   manifest injection, three-level fallback forwarding (local dev server → local artifact →
 *   test environment), sub-app port discovery/reporting, /__mf/status and other endpoints.
 *
 * This file must **never contain any sub-app name, port or environment check**:
 * apps.manifest.json is the single source of truth for addresses; hardcoding is caught by `npm run check`.
 */
import { defineConfig } from 'vite';
import { fulcrum } from '@fulcrum/entry-vite';

export default defineConfig({
  plugins: [fulcrum()],
});
