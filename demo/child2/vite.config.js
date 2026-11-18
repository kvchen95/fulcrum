import { defineConfig } from 'vite';
import { announce, artifactManifest } from '@fulcrum/sub-vite';

export default defineConfig({
  // base must match this app's entry in apps.manifest.json, or asset paths 404 / fetch someone else's HTML
  base: '/child2/',
  server: { port: 7002, strictPort: true, host: '127.0.0.1', watch: { usePolling: true, interval: 300 } },
  // Announce the port to the host when the dev server starts; write the artifact manifest after build (silently skip when the host is unreachable)
  plugins: [announce(), artifactManifest()],
});
