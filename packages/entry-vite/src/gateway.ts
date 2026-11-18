/**
 * Generate proxy rules from the manifest / resolve targets per request.
 *
 * Core mechanism: **fallback happens at the proxy layer, not inside the base.**
 *  - a local dev server is running → forward to it, HMR works
 *  - not running locally → read the local artifact; without one, forward to the app's `remote` (built artifact in the test env)
 * The base always requests same-origin paths like `/child2/`, so no CORS is needed and components contain no environment checks.
 *
 * Target choice is **decided at runtime**, not fixed at startup:
 * After the base starts, sub-app ports are probed every few hundred ms; once a port comes alive it switches to local.
 * So "start the base first, then start child2 in another terminal" takes effect immediately, no base restart.
 *
 * Four field-tested constraints (design doc §3.1), enforced in code rather than docs:
 *  1. every remote must have a proxy rule with ws true — otherwise HMR silently breaks
 *  2. keys must be '^/<prefix>/' — writing '/child' would let /child2/ be matched first by the prefix
 *  3. base must equal the proxy prefix — guaranteed by manifest.validate
 *  4. port probing must have a timeout — otherwise the socket neither connects nor errors and the request hangs
 */
import net from 'node:net';
import { resolve } from 'node:path';
import { projectRoot } from './root.js';
import { ManifestError } from './manifest.js';
import { resolveArtifact } from './artifact.js';
import type { AppEntry, Manifest, Mode, PortSource, TargetChoice } from './types.js';

/**
 * Default artifact dir (output of fulcrum build).
 * Must be a function, not a constant: the plugin may be imported with any cwd; only after setRoot is it computed accurately.
 */
export function defaultArtifactRoot(): string {
  return resolve(projectRoot(), 'dist/site');
}

/** base '/child/' -> proxy key '^/child/' */
export function proxyKeyFor(base: string): string {
  if (!base.startsWith('/') || !base.endsWith('/')) {
    throw new ManifestError(`base must look like '/child/', got "${base}"`);
  }
  if (base === '/') {
    throw new ManifestError('base cannot be "/"; a remote must have its own prefix');
  }
  return `^${base}`;
}

/**
 * Local dev server URL.
 * `port` can be passed explicitly: in cross-repo mode the port is discovered by scanning, not in the manifest.
 */
export function localTargetFor(app: AppEntry, port: number | null | undefined = app.port): string {
  if (!port) {
    throw new ManifestError(`${app.name}: port unknown (no dev server discovered and no port in the manifest)`);
  }
  return `http://127.0.0.1:${port}`;
}

/**
 * A given app's artifact dir.
 *
 * Resolution order (see artifact.ts):
 *   manifest.artifact → <dir>/dist → each repo under $MF_APPS_DIR → dist/site/<name>
 * In other words: if artifact is written, use it; otherwise auto-find via fulcrum-artifact.json.
 */
export function artifactDirFor(app: AppEntry, artifactRoot: string = defaultArtifactRoot()): string | null {
  const hit = resolveArtifact(app, { artifactRoot });
  return hit?.dir ?? null;
}

/** Whether the artifact is usable (index.html required; half a bundle is worse than falling back) */
export function hasArtifact(app: AppEntry, artifactRoot: string = defaultArtifactRoot()): boolean {
  return artifactDirFor(app, artifactRoot) != null;
}

/** Remote (test env) URL: origin only; the path is decided by base */
export function remoteTargetFor(app: AppEntry): string | null {
  if (!app.remote) return null;
  try {
    const u = new URL(app.remote);
    return `${u.protocol}//${u.host}`;
  } catch {
    throw new ManifestError(`${app.name}: remote is not a valid URL — "${app.remote}"`);
  }
}

export interface ResolveTargetOptions {
  preferArtifact?: boolean;
  artifactRoot?: string;
}

/**
 * Static decision at startup (sets the initial value + used by check).
 */
export function resolveTarget(
  app: AppEntry,
  localNames: Set<string> | string[] | null | undefined,
  opts: ResolveTargetOptions = {},
): TargetChoice {
  const ln = localNames instanceof Set ? localNames : new Set(localNames ?? []);
  if (ln.has(app.name)) return { target: localTargetFor(app), mode: 'local' };

  // Not started locally: use the last build first, then fall back to the test env.
  // This line is the premise that makes "change one, start only one" work — the other apps need neither servers nor network.
  if (opts.preferArtifact !== false && hasArtifact(app, opts.artifactRoot)) {
    return { target: artifactDirFor(app, opts.artifactRoot) as string, mode: 'artifact' };
  }

  const remote = remoteTargetFor(app);
  if (!remote) {
    throw new ManifestError(
      `${app.name}: none of the three — not started locally, no local artifact (dist/site/${app.name}/), and no remote configured.\n` +
        `  Fix 1: fulcrum dev -- ${app.name} (start its dev server)\n` +
        `  Fix 2: fulcrum build -- ${app.name} (use the last build)\n` +
        `  Fix 3: add "remote": "https://<test-env-host>" in apps.manifest.json`,
    );
  }
  return { target: remote, mode: 'remote' };
}

/** TCP probe: is anyone listening on the port. Must have a timeout (see header constraint 4). */
export function portUp(port: number, timeoutMs = 500, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((done) => {
    let finished = false;
    const sock = net.connect({ host, port });
    const fin = (v: boolean): void => {
      if (finished) return;
      finished = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      done(v);
    };
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
    setTimeout(() => fin(false), timeoutMs).unref?.();
  });
}

/** Minimal structural contract of discovery (avoids a gateway ↔ discover dependency cycle) */
export interface DiscoveryLike {
  isLocal(name: string): boolean;
  get?(name: string): { port?: number | null; source?: PortSource } | null | undefined;
}

export interface LocalWatcher {
  start(): LocalWatcher;
  stop(): void;
  isLocal(name: string): boolean;
  /** Discovered port. Return null when not discovered — never fake it with the manifest's stale value (it would show as "running") */
  portOf(name: string): number | null;
  /** Where the port came from: announce / proc / http / manifest (spawn mode) */
  sourceOf(name: string): PortSource | 'manifest' | null;
 localNames(): string[];
  artifactNames(artifactRoot?: string): string[];
  refresh: () => Promise<void>;
}

export interface LocalWatcherOptions {
  initial?: Set<string>;
  intervalMs?: number;
  discovery?: DiscoveryLike | null;
}

/**
 * Local liveness table.
 *
 * Two data sources:
 *  - with `discovery` (recommended cross-repo): who is running is decided by port scanning; no port needed in the manifest
 *  - without: fall back to probing the manifest's port (in-repo demo / unit tests)
 *
 * `initial` is the value before the first scan finishes; real results take over afterwards.
 * `"pin": "remote"` in the manifest forces an app to always use the test env.
 */
export function createLocalWatcher(
  manifest: Manifest,
  { initial = new Set<string>(), intervalMs = 800, discovery = null }: LocalWatcherOptions = {},
): LocalWatcher {
  const state = new Map<string, boolean>();
  for (const app of manifest.remotes) {
    const pinnedRemote = app.pin === 'remote';
    state.set(app.name, !pinnedRemote && initial.has(app.name));
  }
  let timer: ReturnType<typeof setInterval> | null = null;

  /** With discovery, defer to it entirely; otherwise probe the manifest's port */
  const isLocal = (name: string): boolean => {
    const app = manifest.remotes.find((a) => a.name === name);
    if (app?.pin === 'remote') return false;
    if (discovery) return discovery.isLocal(name);
    return state.get(name) === true;
  };

  const tick = async (): Promise<void> => {
    if (discovery) {
      for (const app of manifest.remotes) state.set(app.name, isLocal(app.name));
      return;
    }
    await Promise.all(
      manifest.remotes.map(async (app) => {
        if (app.pin === 'remote' || !app.port) {
          state.set(app.name, false);
          return;
        }
        state.set(app.name, await portUp(app.port));
      }),
    );
  };

  const watcher: LocalWatcher = {
    start() {
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
      return watcher;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    isLocal(name: string) {
      return isLocal(name);
    },
    portOf(name: string) {
      const hit = discovery?.get?.(name);
      if (hit?.port) return hit.port;
      if (discovery) return null;
      return manifest.remotes.find((a) => a.name === name)?.port ?? null;
    },
    sourceOf(name: string) {
      if (discovery) {
        const s = discovery.get?.(name)?.source;
        return s ?? null;
      }
      return manifest.remotes.find((a) => a.name === name)?.port ? 'manifest' : null;
    },
    /** Current local names (for /__mf/status) */
    localNames() {
      return manifest.remotes.filter((a) => state.get(a.name) === true).map((a) => a.name);
    },
    /** Names currently served from artifacts (not running, but a last build exists locally) */
    artifactNames(artifactRoot?: string) {
      return manifest.remotes
        .filter((a) => state.get(a.name) !== true && hasArtifact(a, artifactRoot))
        .map((a) => a.name);
    },
    /** Force one refresh (for tests) */
    refresh: tick,
  };
  return watcher;
}

/**
 * One proxy rule. We don't use vite's ProxyOptions type here:
 * our rules carry `router` and `__*` private fields that vite's type lacks;
 * forcing them in means as everywhere. Define it separately and convert once, in index.ts, with a single as.
 */
export interface ProxyRule {
  target: string;
  changeOrigin: boolean;
  ws: boolean;
  timeout: number;
  proxyTimeout: number;
  router: () => string;
  configure: (proxyServer: ProxyEvents) => void;
  __auto: boolean;
  __initialMode: Mode;
  __local: string | null;
  __remote: string | null;
  __artifact: string | null;
}

export type ProxyMap = Record<string, ProxyRule>;

/** http-proxy's error event signature (only these fields are used) */
export interface ProxyEvents {
  on(event: 'error', cb: (err: { code?: string; message?: string }, req: unknown, res: ProxyResponse) => void): void;
}

export interface ProxyResponse {
  headersSent?: boolean;
  writeHead?: (status: number, headers: Record<string, string>) => void;
  end?: (body: string) => void;
  destroy?: () => void;
}

/** The watcher may only implement isLocal (fake watcher in tests); when the port is unreadable, use the manifest's */
function portFromWatcher(watcher: LocalWatcher, name: string): number | null {
  const fn = (watcher as Partial<LocalWatcher>).portOf;
  return typeof fn === 'function' ? fn.call(watcher, name) : null;
}

export interface BuildProxyOptions extends ResolveTargetOptions {
  localNames?: Set<string> | string[];
  watcher?: LocalWatcher;
}

/** Build the proxy rule table from the manifest */
export function buildProxy(manifest: Manifest, opts: BuildProxyOptions = {}): ProxyMap {
  const localNames = opts.localNames instanceof Set ? opts.localNames : new Set(opts.localNames ?? []);
  const watcher = opts.watcher ?? createLocalWatcher(manifest, { initial: localNames });
  const proxy: ProxyMap = {};

  for (const app of manifest.remotes) {
    const { target: initialTarget, mode: initialMode } = resolveTarget(app, localNames, opts);
    const remote = remoteTargetFor(app);
    // The port may be discovered by scanning, so fetch it per request instead of fixing it at startup
    const localNow = (): string => localTargetFor(app, portFromWatcher(watcher, app.name) ?? app.port);
    const artifact = hasArtifact(app, opts.artifactRoot) ? artifactDirFor(app, opts.artifactRoot) : null;

    proxy[proxyKeyFor(app.base)] = {
      // Fallback target: router always supplies a value; this just gives the proxy a legal default
      target: initialTarget,
      changeOrigin: true,
      // HMR's websocket must be proxied too (field-tested); remote mode has no ws, leaving it on is harmless
      ws: true,
      // With an unreachable target the default waits for the system TCP timeout (tens of seconds to two minutes); in dev this looks like "stuck".
      timeout: app.proxyTimeout ?? 5000,
      proxyTimeout: app.proxyTimeout ?? 5000,

      /**
       * Compute the target per request: local when the port is alive, otherwise fall back to artifact / remote.
       * Called synchronously, so it only reads in-memory tables — no IO inside a request.
       */
      router: () => (watcher.isLocal(app.name) ? localNow() : (artifact ?? remote ?? localNow())),

      // The default proxy error writes one line to the terminal while the page shows blank. Replace it with a readable 502.
      configure: (proxyServer) => {
        proxyServer.on('error', (err, req, res) => {
          void req;
          const isLocalNow = watcher.isLocal(app.name);
          const target = isLocalNow ? localNow() : remote;
          const code = err.code ?? err.message ?? 'unknown';
          const hint = isLocalNow
            ? `${app.name}'s local dev server ${target} is unreachable (${code}).\n  Start it in your own repo: pnpm dev (the host discovers the port)`
            : `${app.name} fell back to the test env ${String(remote)} but it is unreachable (${code}).\n  Either start its dev server, give it a local artifact (fulcrum build -- ${app.name}), or fix remote`;
          console.error(`\n[fulcrum] ${hint}\n`);
          if (res && !res.headersSent) {
            res.writeHead?.(502, { 'content-type': 'text/html; charset=utf-8' });
            res.end?.(
              `<pre style="font:13px/1.6 ui-monospace,monospace;padding:12px;color:#b00">` +
                `${app.name} failed to load\ntarget: ${target} (${isLocalNow ? 'local' : 'test env'})\n${hint}</pre>`,
            );
          } else if (res && typeof res.destroy === 'function') {
            res.destroy();
          }
        });
      },

      // For check / panel display; vite ignores unknown fields
      __auto: true,
      __initialMode: initialMode,
      __local: null,
      __remote: remote,
      __artifact: artifact,
    };
  }

  assertProxyCoversRemotes(manifest, proxy, localNames);
  return proxy;
}

/**
 * Self-check: every remote has a rule, all ws true, auto rules have both a local and a remote target, no extra keys.
 * Exported so CI and tests can run it against any proxy object.
 */
export function assertProxyCoversRemotes(
  manifest: Manifest,
  proxy: ProxyMap,
  localNames: Set<string> | string[] = new Set<string>(),
): true {
  const ln = localNames instanceof Set ? localNames : new Set(localNames);
  const problems: string[] = [];
  for (const app of manifest.remotes) {
    const key = proxyKeyFor(app.base);
    const rule = proxy[key];
    if (!rule) {
      problems.push(`${app.name}: missing proxy rule "${key}"`);
      continue;
    }
    if (rule.ws !== true) {
      problems.push(`${app.name}: proxy rule "${key}" has ws !== true — HMR would silently break`);
    }
    if (rule.__auto) {
      // In cross-repo mode __local is null (the port is only known at runtime); just require at least one known target
      if (!rule.__remote && !rule.__artifact) {
        problems.push(`${app.name}: neither remote nor local artifact, and the port is unknown — guaranteed failure`);
      }
      continue;
    }
    let expected: string;
    try {
      expected = resolveTarget(app, ln).target;
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
      continue;
    }
    if (rule.target !== expected) {
      problems.push(`${app.name}: target ${rule.target} does not match the expected value ${expected}`);
    }
  }
  const expectedKeys = new Set(manifest.remotes.map((a) => proxyKeyFor(a.base)));
  for (const key of Object.keys(proxy)) {
    if (!expectedKeys.has(key)) problems.push(`proxy rule "${key}" has no matching remote in the manifest`);
  }
  if (problems.length) {
    throw new ManifestError(`proxy does not match the manifest:\n  - ${problems.join('\n  - ')}`);
  }
  return true;
}
