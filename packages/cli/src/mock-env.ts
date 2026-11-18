#!/usr/bin/env node
/**
 * A "test env" stand-in, for demo/testing only.
 *
 * In a real environment it is a built artifact (/child2/ on a CDN or nginx); here we
 * emulate it with a static file server:
 *  - no dev server, no HMR — same as production
 *  - used to verify the mechanism "sub-apps not started locally automatically fall
 *    back to the test env"
 *
 *   fulcrum mock-env 7999 ./fixtures/testenv
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, normalize } from 'node:path';

const port = Number(process.argv[2] ?? 7999);
const baseDir = resolve(process.cwd(), process.argv[3] ?? 'dist/site');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

createServer((req: IncomingMessage, res: ServerResponse) => {
  const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  let filePath = normalize(join(baseDir, urlPath));
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (urlPath.endsWith('/') || !extname(filePath)) filePath = join(filePath, 'index.html');
  void readFile(filePath)
    .then((buf) => {
      res.writeHead(200, {
        'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
        // test env artifacts: never cache HTML, long-cache everything else
        'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
        'access-control-allow-origin': '*',
      });
      res.end(buf);
    })
    .catch(() => {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found: ' + urlPath);
    });
}).listen(port, '127.0.0.1', () => {
  console.log(`[mock-env] http://127.0.0.1:${port}/   (root: ${baseDir})`);
});
