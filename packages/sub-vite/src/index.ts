/**
 * @fulcrum/sub-vite —— the single integration point on the sub-app side.
 *
 * Two plugins, each handling one thing:
 *
 *   announce()           when the dev server starts, POST to the host's /__mf/announce,
 *                          and to /__mf/unannounce when it shuts down. The host instantly
 *                          knows "who is on which port", with no need to wait for its
 *                          2s port scan (so there is no 2s lag either).
 *
 *   artifactManifest()   after build, write fulcrum-artifact.json into the output dir;
 *                          from it the host knows "which app this package belongs to,
 *                          when it was built, and whether base is correct".
 *
 * Design constraint: **must silently skip when the host is unreachable**. A sub-app
 * running `pnpm dev` alone (host not started) or building in CI (no host at all) must
 * still finish normally — never fail just because "the notification couldn't be sent".
 *
 * appName is read from package.json; without appName, use name (and log a hint).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8000';

interface Pkg {
  name?: string;
  appName?: string;
  [key: string]: unknown;
}

function readPkg(root: string): Pkg {
  const file = resolve(root, 'package.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Pkg;
  } catch {
    return {};
  }
}

export interface AppNameResult {
  appName: string | null;
  from: 'appName' | 'name' | null;
}

/** App name: appName wins (the micro-frontend-side id); fall back to the package name only if absent */
export function resolveAppName(root: string): AppNameResult {
  const pkg = readPkg(root);
  if (pkg.appName) return { appName: pkg.appName, from: 'appName' };
  if (pkg.name) return { appName: pkg.name, from: 'name' };
  return { appName: null, from: null };
}

function announceBaseUrl(opt: AnnounceOptions): string {
  return (opt.baseUrl ?? process.env.MF_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
}

async function post(url: string, body: unknown, timeoutMs = 800): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface AnnounceOptions {
  appName?: string;
  baseUrl?: string;
  quiet?: boolean;
}

interface Announced {
  appName: string;
  port: number;
  base: string;
}

/** Announce to the host when the dev server starts */
export function announce(opts: AnnounceOptions = {}): Plugin {
  let appName: string | null = opts.appName ?? null;
  let base = '/';
  let announced: Announced | null = null;
  const quiet = opts.quiet ?? false;

  return {
    name: 'fulcrum-sub',
    apply: 'serve',

    configResolved(config: ResolvedConfig) {
      base = config.base || '/';
      if (!appName) {
        const r = resolveAppName(config.root);
        appName = r.appName;
        if (!quiet && appName) {
          const hint = r.from === 'appName' ? '' : ' (no appName, falling back to package name; add appName to package.json)';
          // Only log once, on the first resolution
          if (!SAID) {
            SAID = true;
            console.log(`[fulcrum-sub] app name: ${appName}${hint}`);
          }
        }
      }
    },

    async configureServer(server) {
      // The real port is only available once the httpServer is listening
      const onListening = async (): Promise<void> => {
        const addr = server.httpServer?.address();
        const port =
          typeof addr === 'object' && addr ? addr.port : (server.config.server?.port ?? null);
        if (!appName || !port) return;
        announced = { appName, port, base };
        const ok = await post(`${announceBaseUrl(opts)}/__mf/announce`, announced);
        if (!quiet) {
          console.log(
            ok
              ? `[fulcrum-sub] announced to host: ${appName} on :${port}${base}`
              : `[fulcrum-sub] host not reachable (${announceBaseUrl(opts)}), skipping — the host will pick this up on its next port scan`,
          );
        }
      };

      if (server.httpServer?.listening) await onListening();
      else server.httpServer?.once('listening', onListening);

      server.httpServer?.once('close', () => {
        if (!announced) return;
        // Notify on close: use a short timeout instead of relying on keepalive — the process is about to exit
        void post(`${announceBaseUrl(opts)}/__mf/unannounce`, announced, 300);
      });
    },
  };
}

/** Log the app name only once, on the first resolution (process-level, not per plugin instance) */
let SAID = false;

export interface ArtifactOptions {
  appName?: string;
  quiet?: boolean;
}

interface ArtifactFile {
  appName: string | null;
  base: string;
  builtAt: string;
  commit: string | null;
  name: string | null;
}

/**
 * After build, write the artifact manifest so the host can find this package without any config.
 *
 * Every field is something the host actually uses — no "just in case" abstraction:
 *   appName   reconciliation (compared against the manifest's name)
 *   base      mismatch guard (a vite base vs manifest base mismatch shows a blank page)
 *   builtAt   staleness check (older than the source mtime → warn)
 *   commit    pin down the exact build in CI
 */
export function artifactManifest(opts: ArtifactOptions = {}): Plugin {
  let root = process.cwd();
  let base = '/';
  let appName: string | null = opts.appName ?? null;
  let outDir = 'dist';

  return {
    name: 'fulcrum-sub-artifact',

    configResolved(config: ResolvedConfig) {
      root = config.root;
      base = config.base || '/';
      outDir = config.build?.outDir ?? 'dist';
      if (!appName) appName = resolveAppName(root).appName;
    },

    // closeBundle runs after the artifacts are written, so outDir definitely exists by then
    closeBundle() {
      const dir = resolve(root, outDir);
      if (!existsSync(dir)) return;
      const manifest: ArtifactFile = {
        appName,
        base,
        builtAt: new Date().toISOString(),
        commit: process.env.GIT_COMMIT ?? process.env.CI_COMMIT_SHA ?? null,
        name: (() => {
          try {
            return readPkg(root).name ?? null;
          } catch {
            return null;
          }
        })(),
      };
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, 'fulcrum-artifact.json'), JSON.stringify(manifest, null, 2) + '\n');
        if (!opts.quiet) console.log(`[fulcrum-sub] ${appName ?? '(unnamed)'} -> ${dir}/fulcrum-artifact.json`);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        console.warn(`[fulcrum-sub] failed to write artifact manifest (build unaffected): ${why}`);
      }
    },
  };
}

/** Attach both plugins at once */
export default function allPlugins(opts: AnnounceOptions & ArtifactOptions = {}): Plugin[] {
  return [announce(opts), artifactManifest(opts)];
}
