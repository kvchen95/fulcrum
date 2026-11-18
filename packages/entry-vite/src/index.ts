/**
 * fulcrum-entry-vite — the base project's single integration point.
 *
 * Everything scattered across vite.config.js (manifest injection, three-level-fallback forwarding, port
 * discovery, the status endpoint, sub-app announce endpoints) is gathered into one vite plugin. A base project only needs:
 *
 *   import { fulcrum } from 'fulcrum-entry-vite';
 *   export default defineConfig({ plugins: [fulcrum()] });
 *
 * It does four things:
 *   1. define      bakes manifest / local names / prod flag into the base frontend
 *   2. proxy       HTTP + ws forwarding, target computed per request (local → artifact → test env)
 *   3. discovery   port scanning + sub-app announce reports
 *   4. endpoints   /__mf/status (page polling), /__mf/announce, /__mf/unannounce
 *
 * All three usage forms come from this one code base, avoiding "plugin and CLI behave differently":
 *   - vite plugin (dev server / build)
 *   - CLI reuses pure functions via fulcrum-entry-vite/internal
 *   - unit tests import pure functions directly
 */
import { resolve as resolvePath } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer, PreviewServer } from 'vite';
import { setRoot, projectRoot, needsPolling, pollingWatch } from './root.js';
import { loadManifest } from './manifest.js';
import { createLocalWatcher, defaultArtifactRoot, type LocalWatcher } from './gateway.js';
import { createMfProxy, type MfProxy } from './proxy.js';
import { createDiscovery, type Discovery } from './discover.js';
import { resolveArtifact, artifactAgeHours, describeAge } from './artifact.js';
import type { Manifest } from './types.js';

export { setRoot, projectRoot } from './root.js';
export { loadManifest, validate, ManifestError, appByName } from './manifest.js';
export type { AppEntry, ArtifactManifest, GatewayConfig, Manifest, Mode, PortSource, ResolvedArtifact, Role, TargetChoice } from './types.js';
export {
  buildProxy,
  assertProxyCoversRemotes,
  createLocalWatcher,
  resolveTarget,
  proxyKeyFor,
  localTargetFor,
  remoteTargetFor,
  portUp,
  artifactDirFor,
  hasArtifact,
  defaultArtifactRoot,
} from './gateway.js';
export type { LocalWatcher, ProxyMap, ProxyRule } from './gateway.js';
export { createMfProxy, matchApp, targetFor } from './proxy.js';
export { createDiscovery } from './discover.js';
export type { Discovery } from './discover.js';
export { listeningPorts, identifyByProc, identifyByHttp, verifyServesBase, packageIdentityOfPid } from './ports.js';
export { readArtifactManifest, checkBaseMatch, artifactAgeHours, describeAge } from './artifact.js';

export interface FulcrumOptions {
  /** manifest path (defaults to searching upward from project root for apps.manifest.json) */
  manifest?: string;
  /** Which apps count as "local" by default (usually unnecessary; scanning/announce decides) */
  localNames?: string[];
  /** Artifact root dir (default <root>/dist/site) */
  artifactRoot?: string;
  /** Scan interval cap (2s while someone is looking, 10s when idle) */
  scanIntervalMs?: number;
  /** Print discovery/announce logs */
  log?: boolean;
}

interface PluginState {
  root: string | null;
  manifest: Manifest | null;
  discovery: Discovery | null;
  watcher: LocalWatcher | null;
  proxy: MfProxy | null;
}

export function fulcrum(options: FulcrumOptions = {}): Plugin {
  const log = options.log !== false;
  /** Plugin instance internal state, initialized in configResolved */
  const state: PluginState = {
    root: null,
    manifest: null,
    discovery: null,
    watcher: null,
    proxy: null,
  };

  return {
    name: 'fulcrum',
    // The base handles /child/ forwarding itself, so it must run before vite's middleware
    enforce: 'pre',

    config(config, env) {
      // During build vite's root hasn't gone through configResolved yet, but config() can already get the final root
      setRoot(config.root ? resolveRoot(config.root) : projectRoot());
      const manifest = loadManifest(options.manifest ? resolvePath(options.manifest) : undefined);
      state.manifest = manifest;
      state.root = projectRoot();

      const isProd = env.command === 'build';
      const localNames = options.localNames ?? readLocalHint();

      const host = manifest.host;
      const gw = manifest.gateway;

      return {
        // The base's port/bind host also comes from the manifest — upholds the "no port in config" rule
        // which only holds once the plugin takes over
        server: {
          host: gw.host ?? '127.0.0.1',
          port: host.port,
          strictPort: true,
        },
        define: {
          __MF_MANIFEST__: JSON.stringify(manifest),
          __MF_LOCAL__: JSON.stringify(isProd ? [] : [...localNames]),
          __MF_PROD__: isProd ? 'true' : 'false',
        } as Record<string, string>,
      };
    },

    configResolved(config) {
      setRoot(config.root);
      state.root = config.root;
    },

    configureServer(server: ViteDevServer) {
      const manifest = state.manifest;
      if (!manifest) throw new Error('[fulcrum] manifest not initialized: did config() run?');
      const host = manifest.host;

      // Discovery: who is running, on which port. skipPorts excludes the base itself
      const discovery = createDiscovery(manifest, {
        intervalMs: options.scanIntervalMs ?? 2000,
        skipPorts: [host.port].filter((p): p is number => typeof p === 'number'),
      });
      const watcher = createLocalWatcher(manifest, {
        initial: options.localNames ? new Set(options.localNames) : readLocalHint(),
        discovery,
      });
      const proxy = createMfProxy(manifest, watcher, {
        artifactRoot: options.artifactRoot ?? defaultArtifactRoot(),
      });
      state.discovery = discovery;
      state.watcher = watcher;
      state.proxy = proxy;

      watcher.start();
      discovery.start();
      server.httpServer?.once('close', () => {
        watcher.stop();
        discovery.stop();
      });

      // Sub-app forwarding: HTTP and WebSocket upgrades both go through our own implementation
      server.middlewares.use(proxy.middleware);
      server.httpServer?.on('upgrade', (req, socket, head) => {
        proxy.handleUpgrade(req, socket, head);
      });

      installEndpoints(server, manifest, discovery, watcher, log);
    },

    configurePreviewServer(server: PreviewServer) {
      // preview also mounts the status endpoint: during artifact acceptance, sub-app reports should not flood the log with errors
      const manifest = state.manifest ?? loadManifest();
      server.middlewares.use('/__mf/status', (_req: IncomingMessage, res: ServerResponse) => {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true, host: manifest.host.name, env: manifest.env, apps: [], local: [], artifact: [] }));
      });
    },
  };
}

function resolveRoot(maybeRelative: string): string {
  return maybeRelative ? resolvePath(maybeRelative) : projectRoot();
}

/** The orchestrator tells the base via env var "which apps this terminal spawned" */
function readLocalHint(): Set<string> {
  const raw = process.env.MF_LOCAL_APPS;
  if (raw === undefined) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

interface AnnouncePayload {
  appName: string;
  port: number;
  base?: string | null;
}

/** /__mf/status, /__mf/announce, /__mf/unannounce */
function installEndpoints(
  server: ViteDevServer,
  manifest: Manifest,
  discovery: Discovery,
  watcher: LocalWatcher,
  log: boolean,
): void {
  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage, res: ServerResponse, next: (body: string) => void): void => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString();
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => next(body));
  };

  server.middlewares.use('/__mf/status', (_req, res) => {
    // Every pull counts as "someone is looking": scanning returns to fast cadence
    discovery.touch();
    const apps = manifest.remotes.map((a) => {
      const local = watcher.isLocal(a.name);
      const artifact = local ? null : resolveArtifact(a, { artifactRoot: defaultArtifactRoot() });
      const mode = local ? 'local' : artifact ? 'artifact' : 'remote';
      return {
        name: a.name,
        title: a.title,
        base: a.base,
        port: watcher.portOf(a.name),
        source: watcher.sourceOf(a.name),
        remote: a.remote ?? null,
        local,
        mode,
        artifactSource: artifact?.source ?? null,
        artifactAge: artifact ? describeAge(artifactAgeHours(artifact.dir)) : null,
      };
    });
    json(res, 200, {
      ok: true,
      host: manifest.host.name,
      env: manifest.env,
      apps,
      local: apps.filter((a) => a.local).map((a) => a.name),
      artifact: apps.filter((a) => a.mode === 'artifact').map((a) => a.name),
    });
  });

  server.middlewares.use('/__mf/announce', (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false });
    readBody(req, res, (body) => {
      let payload: AnnouncePayload;
      try {
        payload = JSON.parse(body) as AnnouncePayload;
      } catch {
        return json(res, 400, { ok: false, why: 'body is not JSON' });
      }
      void discovery.claimFromAnnounce(payload).then((r) => {
        if (log) {
          if (r.ok) console.log(`[fulcrum-sub] ${payload.appName} → :${payload.port}${payload.base ?? ''}`);
          else console.warn(`[fulcrum-sub] rejected ${payload.appName}:${payload.port} — ${String(r.why)}`);
        }
        json(res, r.ok ? 200 : 409, r);
      });
    });
  });

  server.middlewares.use('/__mf/unannounce', (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false });
    readBody(req, res, (body) => {
      let payload: Partial<AnnouncePayload> = {};
      try {
        payload = JSON.parse(body) as Partial<AnnouncePayload>;
      } catch {
        /* ignore */
      }
      const released =
        payload.appName && typeof payload.port === 'number'
          ? discovery.releaseFromAnnounce({ appName: payload.appName, port: payload.port })
          : false;
      if (log) {
        console.log(
          `[fulcrum-sub] ${String(payload.appName)} exited (:${String(payload.port)})${released ? '' : ' (port mismatch, ignored)'}`,
        );
      }
      json(res, 200, { ok: true, released });
    });
  });
}

export default fulcrum;
