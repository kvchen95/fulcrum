#!/usr/bin/env node
/**
 * Serve dist/site statically — local acceptance of the built artifacts, with the same
 * addressing scheme as production (same-origin sub-paths).
 *
 *   fulcrum preview            # http://127.0.0.1:8000/
 *   fulcrum preview 9000       # different port
 *
 * Why not `vite preview`: vite preview serves a **single** app, while we need to serve
 * three artifact trees at once — base + /child/ + /child2/ — each with its own SPA
 * fallback. The logic maps 1:1 to try_files in nginx.conf, so "passes locally = should
 * pass in production".
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, extname, join, normalize } from 'node:path';
import { loadManifest, setRoot } from 'fulcrum-entry-vite/internal';

const ROOT = resolve(process.cwd());
setRoot(ROOT);
const SITE = resolve(ROOT, 'dist/site');
const manifest = loadManifest();
const portArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const port = Number(portArg ?? manifest.gateway.port ?? 8000);
const host = manifest.gateway.host ?? '127.0.0.1';

if (!existsSync(resolve(SITE, 'index.html'))) {
  console.error('\n[preview] no dist/site/index.html — build first: fulcrum build\n');
  process.exit(1);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Find the file; return null when missing (hand off to the SPA fallback) */
function fileFor(urlPath: string): string | null {
  const safe = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const p = join(SITE, safe);
  if (!p.startsWith(SITE)) return null; // guard against path traversal
  if (!existsSync(p)) return null;
  const st = statSync(p);
  if (st.isDirectory()) {
    const idx = join(p, 'index.html');
    return existsSync(idx) ? idx : null;
  }
  return p;
}

/** SPA fallback: base falls back to /index.html, sub-apps to /<base>/index.html */
function fallbackFor(urlPath: string): string | null {
  const app = manifest.remotes.filter((a) => urlPath.startsWith(a.base)).sort((a, b) => b.base.length - a.base.length)[0];
  const target = app ? join(SITE, app.name, 'index.html') : resolve(SITE, 'index.html');
  return existsSync(target) ? target : null;
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
  const file = fileFor(urlPath) ?? fallbackFor(urlPath);
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404 ${urlPath}`);
    return;
  }
  const ext = extname(file);
  const headers: Record<string, string> = { 'content-type': MIME[ext] ?? 'application/octet-stream' };
  // Same as nginx.conf: long-cache hashed artifacts, never cache HTML
  headers['cache-control'] =
    ext === '.html' ? 'no-store' : ext === '.js' || ext === '.css' ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
});

server.listen(port, host, () => {
  console.log(`\n[preview] http://${host}:${port}/   (root: ${SITE})`);
  console.log(`[preview] base /, sub-apps: ${manifest.remotes.map((a) => a.base).join(' ')}\n`);
});
