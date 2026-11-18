/**
 * Reverse-proxy middleware for the base (HTTP + WebSocket upgrade). Dev server only.
 *
 * Three kinds of target, chosen by priority (computed per request — targets switch without restarting the base):
 *   1. local     the local dev server port is alive → forward, HMR works
 *   2. artifact  a local build artifact exists (dist/site/<name>/) → **read straight from disk**, i.e. "use the last build"
 *   3. remote    none of the above → forward to the manifest's remote (test env)
 *
 * Why kind 2 exists: five sub-apps ABCDE; you only want to start the one you are changing.
 * The ones not started shouldn't force you to run servers, nor require the test env to be reachable —
 * the last build's artifact is enough; the one or two being changed go through the dev server for HMR.
 *
 * Why not vite's `server.proxy`:
 * vite bundles a **trimmed** http-proxy without a `router` option; the target is fixed at startup —
 * but here the target must switch per request, and static files must be served directly too.
 *
 * Three hard constraints:
 *  1. ws must pass through — otherwise HMR silently breaks (page loads, code does not update, no error)
 *  2. there must be a timeout — with an unreachable target the default waits for the system TCP timeout, shown as "spinning"
 *  3. paths pass through as-is — sub-apps carry a base prefix (/child/xxx); it must not be rewritten away
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { normalize, extname, join } from 'node:path';
import { artifactDirFor, hasArtifact, defaultArtifactRoot, type LocalWatcher } from './gateway.js';
import type { AppEntry, Manifest, Mode } from './types.js';

type MimeMap = Record<string, string>;

const MIME: MimeMap = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Find which sub-app a request path belongs to (prefix match, longest prefix wins) */
export function matchApp(manifest: Manifest, url: string): AppEntry | null {
  const path = url.split('?')[0] ?? '/';
  const hits = manifest.remotes.filter((a) => path.startsWith(a.base)).sort((a, b) => b.base.length - a.base.length);
  return hits[0] ?? null;
}

export interface TargetInfo {
  mode: Mode;
  target: string | null;
  url: URL | null;
  port?: number | null;
  dir?: string | null;
}

/** Decide where this request goes. */
export function targetFor(
  app: AppEntry,
  watcher: LocalWatcher,
  artifactRoot: string = defaultArtifactRoot(),
): TargetInfo {
  if (watcher.isLocal(app.name)) {
    // The port may have been discovered by scanning (cross-repo mode); prefer the discovered port
    const port = watcher.portOf(app.name) ?? app.port;
    const origin = `http://127.0.0.1:${port}`;
    return { mode: 'local', target: origin, url: new URL(origin), port };
  }
  if (hasArtifact(app, artifactRoot)) {
    const dir = artifactDirFor(app, artifactRoot);
    return { mode: 'artifact', target: dir, url: null, dir };
  }
  if (app.remote) {
    return { mode: 'remote', target: app.remote, url: new URL(app.remote) };
  }
  return { mode: 'remote', target: null, url: null };
}

const MODE_LABEL: Record<Mode, string> = { local: 'local dev server', artifact: 'local build artifact', remote: 'test environment' };

function panel(
  res: http.ServerResponse,
  app: AppEntry,
  { target, mode, err }: { target: string | null; mode: Mode; err: unknown },
): void {
  const hints: Record<Mode, string> = {
    local: `${app.name}'s local dev server ${String(target)} is unreachable (${String(err)}).\n  Start it in your own repo: pnpm dev (the host discovers the port)`,
    artifact: `${app.name}'s local build artifact is unreadable (${String(err)}).\n  Artifact dir: ${String(target)}\n  Rebuild: fulcrum build -- ${app.name}`,
    remote: `${app.name} is not started locally and has no local artifact; fell back to the test environment ${target ?? '(no remote configured)'} but it is unreachable (${String(err)}).\n  Pick one:\n    1. start its dev server: fulcrum dev -- ${app.name}\n    2. use the last build: fulcrum build -- ${app.name}\n    3. fix the remote in apps.manifest.json`,
  };
  const hint = hints[mode] ?? hints.remote;
  console.error(`\n[fulcrum] ${hint}\n`);
  if (!res.headersSent) {
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<pre style="font:13px/1.6 ui-monospace,monospace;padding:12px;color:#b00">` +
        `${app.name} failed to load\ntarget: ${target ?? '(none)'} (${MODE_LABEL[mode] ?? mode})\n${hint}</pre>`,
    );
  } else if (typeof res.destroy === 'function') {
    res.destroy();
  }
}

/** Map a URL path to a file inside the artifact; fall back to index.html when not found (sub-apps are SPAs too) */
function artifactFileFor(dir: string, app: AppEntry, urlPath: string): string | null {
  const rel = urlPath.startsWith(app.base) ? urlPath.slice(app.base.length) : urlPath.replace(/^\//, '');
  const safe = normalize(decodeURIComponent(rel)).replace(/^(\.\.[/\\])+/, '');
  const p = join(dir, safe);
  if (p.startsWith(dir) && existsSync(p)) {
    const st = statSync(p);
    if (st.isDirectory()) {
      const idx = join(p, 'index.html');
      return existsSync(idx) ? idx : null;
    }
    return p;
  }
  // Sub-app is a SPA: /child2/some/route must also return its own index.html
  const idx = join(dir, 'index.html');
  return existsSync(idx) ? idx : null;
}

async function serveArtifact(req: http.IncomingMessage, res: http.ServerResponse, app: AppEntry, dir: string | null | undefined): Promise<void> {
  if (!dir) return panel(res, app, { target: null, mode: 'artifact', err: 'no artifact dir' });
  const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
  const file = artifactFileFor(dir, app, urlPath);
  if (!file) return panel(res, app, { target: dir, mode: 'artifact', err: 'no index.html' });

  const ext = extname(file);
  const headers: Record<string, string | number> = { 'content-type': MIME[ext] ?? 'application/octet-stream' };
  // Same as dist/nginx.conf: long-cache hashed artifacts, don't cache HTML (otherwise a release serves a stale shell)
  headers['cache-control'] =
    ext === '.html' ? 'no-store' : ext === '.js' || ext === '.css' ? 'public, max-age=31536000, immutable' : 'no-cache';
  // Let sub-apps/debug tooling know this response comes from an artifact
  headers['x-mf-mode'] = 'artifact';

  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  const stream = createReadStream(file);
  stream.on('error', (e: NodeJS.ErrnoException) =>
    panel(res, app, { target: dir, mode: 'artifact', err: e.code ?? e.message }),
  );
  stream.pipe(res);
}

export interface MfProxyOptions {
  artifactRoot?: string;
}

export interface MfProxy {
  middleware: (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void;
  handleUpgrade: (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => boolean;
}

/** Create the proxy middleware; index.ts attaches middleware and handleUpgrade to vite's server */
export function createMfProxy(manifest: Manifest, watcher: LocalWatcher, opts: MfProxyOptions = {}): MfProxy {
  const artifactRoot = opts.artifactRoot ?? defaultArtifactRoot();

  /** HTTP */
  function middleware(req: http.IncomingMessage, res: http.ServerResponse, next: () => void): void {
    const app = matchApp(manifest, req.url ?? '');
    if (!app) return next();

    const { mode, target, url, dir } = targetFor(app, watcher, artifactRoot);

    // 2) local artifact: read from disk directly — faster than the network, and the test env needn't be reachable
    if (mode === 'artifact') {
      void serveArtifact(req, res, app, dir);
      return;
    }

    if (!url) return panel(res, app, { target, mode, err: 'no usable target' });

    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const timeout = app.proxyTimeout ?? 5000;

    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: url.host };
    // Let upstream know the original host (so absolute URLs generated inside sub-apps do not point wrong)
    headers['x-forwarded-host'] = req.headers.host ?? '';
    headers['x-forwarded-proto'] = 'http';

    const upstream = mod.request(
      {
        host: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        method: req.method,
        // Path passes through as-is: sub-apps carry the base prefix
        path: req.url,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        upstreamRes.on('error', () => res.destroy());
      },
    );

    upstream.setTimeout(timeout, () => {
      upstream.destroy(Object.assign(new Error(`ETIMEDOUT ${timeout}ms`), { code: 'ETIMEDOUT' }));
    });
    upstream.on('error', (e: NodeJS.ErrnoException) => panel(res, app, { target, mode, err: e.code ?? e.message }));
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }

  /** WebSocket upgrade: only needed by dev servers (artifacts are static files, no HMR) */
  function handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): boolean {
    const app = matchApp(manifest, req.url ?? '');
    if (!app) return false; // Not a sub-app path (e.g. the base's own HMR), hand back to vite

    const { mode, target, url } = targetFor(app, watcher, artifactRoot);
    if (mode !== 'local' || !url) {
      // Artifact / remote have no usable ws endpoint; just close it (the page will not expect one)
      socket.destroy();
      return true;
    }
    const isTls = url.protocol === 'https:';
    const port = Number(url.port || (isTls ? 443 : 80));

    const upstream = net.connect(port, url.hostname, () => {
      // Rebuild the original request line + all headers (forwarded verbatim, avoiding subtle mistakes like sec-websocket-key)
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i] ?? '';
        const v = req.rawHeaders[i + 1] ?? '';
        if (k.toLowerCase() === 'host') lines.push(`${k}: ${url.host}`);
        else lines.push(`${k}: ${v}`);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });

    upstream.setTimeout(app.proxyTimeout ?? 5000, () => upstream.destroy());
    upstream.on('error', (e: NodeJS.ErrnoException) => {
      console.error(`[fulcrum] ws ${app.name} → ${String(target)} failed: ${e.code ?? e.message}`);
      socket.destroy();
    });
    socket.on('error', () => upstream.destroy());
    return true;
  }

  return { middleware, handleUpgrade };
}
