/**
 * Port discovery: turn "which dev servers are running locally, and which sub-app each is" into data.
 *
 * Two channels; a hit on either one counts as a claim:
 *   1. proc  /proc/net/tcp → inode → pid → cwd/package.json → appName
 *            fastest, no network needed; requires same-user processes and cwd at the repo root
 *   2. http  GET {base}package.json → requires JSON content-type and a matching appName
 *            fallback: monorepo subdirectory starts, cross-user, /proc unreadable on Windows
 *
 * Three field-tested constraints (see the design doc):
 *  1. **vite answers 200 HTML for any non-existent path** (SPA fallback), so the test must be
 *     content-type + appName in the JSON — never the status code alone
 *  2. with a misconfigured base vite answers 404 and hints the correct base — a free second check
 *  3. port probing must have a timeout, otherwise the socket neither connects nor errors and a round hangs
 */
import { readFileSync, existsSync, readdirSync, readlinkSync, type Dirent } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const isWin = process.platform === 'win32';
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'] as const;

/** Port → set (socket inodes on Linux, pids on Windows) */
export type PortIndex = Map<number, Set<string | number>>;

export interface PackageIdentity {
  pid: number;
  cwd: string | null;
  appName: string | null;
  name: string | null;
}

export interface IdentityResult {
  appName: string | null;
  name: string | null;
  why?: string;
}

export interface VerifyResult {
  ok: boolean;
  why?: string;
}

/** All local LISTEN ports → inode sets (Linux reads /proc directly; other platforms fall back to netstat) */
export function listeningPorts(): PortIndex {
  if (!isWin) {
    const out: PortIndex = new Map();
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
      if (!existsSync(f)) continue;
      let text = '';
      try {
        text = readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n').slice(1)) {
        const c = line.trim().split(/\s+/);
        if (c.length < 10) continue;
        if (c[3] !== '0A') continue; // 0A = LISTEN
        const local = c[1] ?? '';
        const portPart = local.split(':')[1] ?? '';
        const port = parseInt(portPart, 16);
        const inode = c[9] ?? '';
        if (!port || inode === '0') continue;
        if (!out.has(port)) out.set(port, new Set());
        out.get(port)!.add(inode);
      }
    }
    return out;
  }
  // Windows: netstat -ano yields (port, pid); no inode concept, use pid as the key
  const res: PortIndex = new Map();
  const txt = tryExec('netstat', ['-ano', '-p', 'TCP']);
  for (const line of txt.split('\n')) {
    if (!/LISTENING/i.test(line)) continue;
    const c = line.trim().split(/\s+/);
    const local = c[1] ?? '';
    const pid = Number(c[c.length - 1]);
    const port = Number(local.split(':').pop());
    if (!port || !pid) continue;
    if (!res.has(port)) res.set(port, new Set());
    res.get(port)!.add(pid);
  }
  return res;
}

function tryExec(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

const LIKELY_DEV = /vite|webpack|next|nuxt|umi|rsbuild|rspack|node|bun|deno/i;

/** Narrow candidate processes by cmdline first (saves an order of magnitude of scanning on busy machines); fall back to a full scan when unreadable */
function candidatePids(): { likely: number[]; all: number[] } {
  const likely: number[] = [];
  const all: number[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync('/proc');
  } catch {
    return { likely, all };
  }
  for (const d of dirs) {
    if (!/^\d+$/.test(d)) continue;
    all.push(Number(d));
    try {
      const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8');
      if (LIKELY_DEV.test(cmd)) likely.push(Number(d));
    } catch {
      /* unreadable: assume it is not one */
    }
  }
  return { likely, all };
}

/** inode → pid (Linux); scan /proc/*\/fd for socket:[inode] */
function pidsForInodes(inodes: Set<string | number> | null | undefined): Set<number> {
  const pids = new Set<number>();
  if (!inodes?.size) return pids;

  const { likely, all } = candidatePids();
  // First scan processes that "look like a dev server"; fall back to a full scan if nothing is found (guards against misses)
  for (const pass of [likely, all]) {
    if (pids.size) break;
    for (const pid of pass) scanPidFds(pid, inodes, pids);
  }
  return pids;
}

function scanPidFds(pid: number, inodes: Set<string | number>, pids: Set<number>): void {
  let fds: string[] = [];
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return; // other users' processes are unreadable, skip (the HTTP channel covers them)
  }
  for (const fd of fds) {
    let t = '';
    try {
      t = readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch {
      continue;
    }
    const m = /^socket:\[(\d+)\]$/.exec(t);
    if (m && inodes.has(m[1] as string)) {
      pids.add(pid);
      return;
    }
  }
}

/** Read package.json under a process's cwd, take appName (fall back to name when absent) */
export function packageIdentityOfPid(pid: number): PackageIdentity | null {
  let cwd = '';
  try {
    cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
  const pkgFile = join(cwd, 'package.json');
  if (!existsSync(pkgFile)) return { pid, cwd, appName: null, name: null };
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { appName?: string; name?: string };
    return { pid, cwd, appName: pkg.appName ?? null, name: pkg.name ?? null };
  } catch {
    return { pid, cwd, appName: null, name: null };
  }
}

/** proc channel: port → identity. Windows can't get cwd, so only the HTTP channel works there */
export function identifyByProc(port: number, inodes: Set<string | number> | null | undefined): PackageIdentity[] {
  void port;
  if (isWin) {
    const out: PackageIdentity[] = [];
    for (const pid of inodes ?? []) {
      out.push({ pid: Number(pid), cwd: null, appName: null, name: null });
    }
    return out;
  }
  const ids = [...pidsForInodes(inodes)]
    .map((pid) => packageIdentityOfPid(pid))
    .filter((x): x is PackageIdentity => x != null);
  return ids;
}

/** fetch with a timeout; returning null means failure */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * HTTP channel: GET {base}package.json, requiring JSON + a matching appName.
 *
 * Why package.json and not {base}/:
 *  - {base}/ answers 200 HTML for any app (SPA fallback), which cannot identify it
 *  - package.json's content-type is application/json, naturally distinguishable
 */
export async function identifyByHttp(
  base: string,
  port: number,
  { timeoutMs = 400 }: { timeoutMs?: number } = {},
): Promise<IdentityResult> {
  const path = `${base.replace(/\/$/, '')}/package.json`;
  let lastWhy = 'unreachable';
  for (const host of LOOPBACK) {
    const res = await fetchWithTimeout(`http://${host}:${port}${path}`, timeoutMs);
    if (!res) {
      lastWhy = 'connection failed';
      continue;
    }
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('json')) {
      // vite's SPA fallback: 200 text/html. Means this base does not belong to this port
      lastWhy = `content-type=${ct || '(empty)'} (likely SPA fallback, base mismatch)`;
      continue;
    }
    try {
      const pkg = (await res.json()) as { appName?: string; name?: string };
      return { appName: pkg.appName ?? null, name: pkg.name ?? null };
    } catch {
      lastWhy = 'package.json is not valid JSON';
    }
  }
  return { appName: null, name: null, why: lastWhy };
}

/**
 * Third gate: confirm this port really serves base (rules out "same-named process but not a dev server").
 * Test: {base} returns HTML containing resource paths starting with {base} (vite injects the base prefix).
 */
export async function verifyServesBase(
  base: string,
  port: number,
  { timeoutMs = 400 }: { timeoutMs?: number } = {},
): Promise<VerifyResult> {
  for (const host of LOOPBACK) {
    const res = await fetchWithTimeout(`http://${host}:${port}${base}`, timeoutMs);
    if (!res || !res.ok) continue;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('html')) continue;
    const html = await res.text().catch(() => '');
    // vite dev: src="/child2/@vite/client", src="/child2/src/main.js"
    // built artifact: src="/child2/assets/index-xxx.js"
    if (html.includes(`${base}@vite/client`) || html.includes(`${base}assets/`) || html.includes(`src="${base}`)) {
      return { ok: true };
    }
    return { ok: false, why: `HTML does not contain resources prefixed with ${base}` };
  }
  return { ok: false, why: 'could not fetch HTML' };
}

/** Re-export the Dirent type for callers (avoids each one importing node:fs) */
export type { Dirent };
