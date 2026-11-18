#!/usr/bin/env node
/**
 * Last-resort stop.
 *
 * Why it exists: when dev is SIGKILLed (terminal closed / kill -9), the SIGINT handler
 * never runs, the child vite processes become orphans still holding 8000/7001/7002,
 * and the next `fulcrum dev` fails immediately with port-in-use.
 *
 * Cleanup order:
 *   1. processes recorded in .dev-pids.json (left by the normal exit path)
 *   2. reverse-lookup PIDs by port — ss / lsof / netstat, whichever exists; if none,
 *      read /proc directly (Linux)
 *   3. after killing, re-check the ports via TCP connections (no external commands
 *      involved, never falsely reports "released")
 */
import { readFileSync, existsSync, rmSync, readdirSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { loadManifest, setRoot } from '@fulcrum/entry-vite/internal';

const ROOT = resolve(process.cwd());
setRoot(ROOT);
const PID_FILE = resolve(ROOT, '.dev-pids.json');
const LOCAL_FILE = resolve(ROOT, '.mf-dev-local.json');
const isWin = process.platform === 'win32';

const targets = new Set<number>();
const notes: string[] = [];

function tryExec(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** Fallback on Linux without ss/lsof: get the inode from /proc/net/tcp, then scan each process's fds to find the holder */
function pidsViaProc(port: number): number[] {
  const wantPort = port.toString(16).toUpperCase().padStart(4, '0');
  const inodes = new Set<string>();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      const local = cols[1] ?? '';
      const state = cols[3];
      if (!local.endsWith(`:${wantPort}`)) continue;
      if (state !== '0A') continue; // 0A = LISTEN
      const inode = cols[9];
      if (inode && inode !== '0') inodes.add(inode);
    }
  }
  if (!inodes.size) return [];
  const pids: number[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let fds: string[] = [];
    try {
      fds = readdirSync(`/proc/${d}/fd`);
    } catch {
      continue; // another user's process; skip what we cannot scan
    }
    for (const fd of fds) {
      let t = '';
      try {
        t = readlinkSync(`/proc/${d}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(t);
      if (m && inodes.has(m[1] as string)) {
        pids.push(Number(d));
        break;
      }
    }
  }
  return pids;
}

/** port → [pid] */
function pidsOnPort(port: number): number[] {
  const out: number[] = [];
  if (isWin) {
    const txt = tryExec('netstat', ['-ano', '-p', 'TCP']);
    for (const line of txt.split('\n')) {
      if (line.includes(`:${port} `) && /LISTENING/i.test(line)) {
        const pid = Number(line.trim().split(/\s+/).pop());
        if (pid) out.push(pid);
      }
    }
  } else {
    for (const m of tryExec('ss', ['-ltnpH', `sport = :${port}`]).matchAll(/pid=(\d+)/g)) {
      out.push(Number(m[1]));
    }
    if (!out.length) {
      for (const l of tryExec('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).split('\n')) {
        if (l.trim()) out.push(Number(l.trim()));
      }
    }
    if (!out.length) out.push(...pidsViaProc(port));
  }
  return [...new Set(out.filter(Boolean))];
}

function killPid(pid: number, sig: NodeJS.Signals = 'SIGTERM'): boolean {
  let done = false;
  // Kill the process group first (dev spawns children detached, so the child is the group leader), then the single pid
  for (const t of [-pid, pid]) {
    try {
      process.kill(t, sig);
      done = true;
    } catch {
      /* does not exist / not a group leader / no permission */
    }
  }
  return done;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Pure TCP probe: is anyone still listening on the port */
function portBusy(port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((done) => {
    let finished = false;
    const sock = net.connect({ host: '127.0.0.1', port });
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

// 1) pid file
if (existsSync(PID_FILE)) {
  let pids: number[] = [];
  try {
    pids = JSON.parse(readFileSync(PID_FILE, 'utf8')) as number[];
  } catch {
    pids = [];
  }
  for (const pid of pids) if (killPid(pid)) targets.add(pid);
  rmSync(PID_FILE, { force: true });
}

// 2) reverse-lookup by port
const manifest = loadManifest();
const ports = [manifest.host.port, ...manifest.remotes.map((r) => r.port)].filter(
  (p): p is number => typeof p === 'number',
);
for (const port of ports) {
  for (const pid of pidsOnPort(port)) if (killPid(pid)) targets.add(pid);
}

// 3) hard kill + re-check
await new Promise((r) => setTimeout(r, 900));
for (const pid of targets) {
  if (!alive(pid)) continue;
  try {
    if (!isWin) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* not a group leader */
      }
    }
    process.kill(pid, 'SIGKILL');
    notes.push(`force-killed pid ${pid}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') {
      notes.push(`pid ${pid} was started by another user; sudo is required to kill it`);
    }
  }
}

await new Promise((r) => setTimeout(r, 300));
const stillBusy: number[] = [];
for (const port of ports) if (await portBusy(port)) stillBusy.push(port);

if (targets.size) console.log(`\n[stop] stopped ${targets.size} process(es)`);
else console.log('\n[stop] nothing to stop');
for (const n of notes) console.log(`[stop] ${n}`);

if (stillBusy.length) {
  const detail = stillBusy.map((p) => `${p} (pid ${pidsOnPort(p).join(',') || 'unknown'})`).join(', ');
  console.log(`[stop] ports still busy: ${detail}`);
  console.log('[stop] if they belong to another user (e.g. started with sudo earlier): sudo kill -9 <pid>');
  process.exitCode = 1;
} else {
  console.log(`[stop] ports released: ${ports.join(', ')}\n`);
}
rmSync(LOCAL_FILE, { force: true });
