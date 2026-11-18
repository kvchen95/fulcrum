#!/usr/bin/env node
/**
 * Local debugging orchestrator.
 *
 * Usage:
 *   fulcrum dev                 # start the base only (cross-repo mode: sub-apps run `pnpm dev` in their own repos)
 *   fulcrum dev child           # also spawn A; the other apps keep relying on discovery/fallback
 *   fulcrum dev --all           # spawn everything (demo / single-repo debugging)
 *
 * Key semantics: **apps that weren't picked are not blank**. If a dev server is running
 * on this machine, proxy to it; otherwise read the local artifact; failing that, use the
 * `remote` from the manifest (the test env).
 *
 * It does exactly three things: read the manifest → start the selected remote dev servers → start the base.
 * No port-probe retries — on a port conflict, strictPort fails loudly, which is far easier
 * to debug than silently switching ports.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadManifest,
  setRoot,
  buildProxy,
  resolveArtifact,
  artifactAgeHours,
  describeAge,
} from '@fulcrum/entry-vite/internal';
import type { AppEntry, ResolvedArtifact } from '@fulcrum/entry-vite/internal';

const ROOT = resolve(process.cwd());
setRoot(ROOT);

// Silence is not allowed at any stage: when things hang, the last step log line must show exactly where
const t0 = Date.now();
const step = (n: string, msg: string): void => console.log(`[dev] ${n} ${msg}  (+${Date.now() - t0}ms)`);
step('1/6', 'read manifest');

const args = process.argv.slice(2);
const all = args.includes('--all');
const picked = args.filter((a) => !a.startsWith('--'));

const manifest = loadManifest();
const { host, remotes } = manifest;

/**
 * Default (no arguments): start only the base, spawn zero sub-apps — cross-repo mode.
 *   Each sub-app is started by you with `pnpm dev` in its own repo; the base discovers
 *   them by scanning ports / receiving announce.
 * With names or `--all`: spawn in-repo, for demo / single-repo debugging.
 */
const wanted = new Set<string>(all ? remotes.map((r) => r.name) : picked);

const unknown = [...wanted].filter((n) => !remotes.some((r) => r.name === n));
if (unknown.length) {
  console.error(`\n[dev] unknown app(s): ${unknown.join(', ')}`);
  console.error(`[dev] available: ${remotes.map((r) => r.name).join(', ')}\n`);
  process.exit(1);
}

// Port health check
//
// Two kinds of "base port occupied" need different treatment:
//  a) the occupier is **this template's base, already running** → reuse it; this run only
//     starts the sub-apps you named. The base picks its targets by runtime probing, so
//     once a sub-app is up it switches over automatically — no base restart, no browser
//     restart needed (the page polls /__mf/status every 2s).
//  b) the occupier is some other program → exit with an error; don't make anyone debug
//     against an unrecognized port.
step('2/6', `port health check (base ${String(host.port)}${wanted.size ? ` + ${wanted.size} sub-app(s)` : ', spawning no sub-apps'})`);
let reuseHost = false;
if (!process.argv.includes('--no-port-check')) {
  const busy: string[] = [];
  const hostBusy = typeof host.port === 'number' ? await portInUse(host.port) : false;
  if (hostBusy) {
    reuseHost = typeof host.port === 'number' ? await isMfBase(host.port) : false;
    if (!reuseHost) busy.push(`base ${String(host.port)}`);
  }
  for (const name of wanted) {
    const app = remotes.find((r) => r.name === name);
    if (app?.port && (await portInUse(app.port))) busy.push(`${app.name} ${app.port}`);
  }
  if (busy.length) {
    console.error(`\n[dev] port(s) already in use: ${busy.join(', ')}`);
    console.error('[dev] most likely the last round did not exit cleanly. Run first:  fulcrum stop');
    console.error('[dev] if something else owns the port, change "port" in apps.manifest.json or shut it down\n');
    process.exit(1);
  }
  if (reuseHost) {
    console.log(`[dev] base ${String(host.port)} is already running (this template's base), reusing it; this run only starts: ${[...wanted].join(', ') || '(none)'}`);
  }
}

step('3/6', 'generate proxy (a broken manifest explodes right here)');
// Build the proxy once up front: a broken manifest (or an app with none of its three fallbacks) must explode here
try {
  buildProxy(manifest, { localNames: wanted });
} catch (e) {
  console.error(`\n[dev] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}

// Tell the base vite "which apps are running on this machine": **env vars are the main
// channel**, the file is just a record. Previously it relied only on the file, and a stale
// file left behind by a root-owned run caused an immediate EACCES exit — runtime state
// must never be able to block startup, so a failed file write only warns.
const LOCAL_FILE = resolve(ROOT, '.mf-dev-local.json');
const LOCAL_ENV = [...wanted].join(',');
// A second terminal (reusing the existing base) must not overwrite the local apps recorded
// by the first terminal: the file is only a fallback record for "manually starting vite",
// so merge-write it — don't lose apps started by other terminals.
let fileLocal: string[] = [...wanted];
try {
  if (existsSync(LOCAL_FILE)) {
    const prev = (JSON.parse(readFileSync(LOCAL_FILE, 'utf8')) as { localNames?: unknown }).localNames;
    if (Array.isArray(prev)) fileLocal = [...new Set([...prev.map(String), ...wanted])];
  }
} catch {
  /* on a corrupt file, just write this run's data */
}
try {
  writeFileSync(LOCAL_FILE, JSON.stringify({ localNames: fileLocal }, null, 2));
} catch (e) {
  const why = e instanceof Error ? ((e as NodeJS.ErrnoException).code ?? e.message) : String(e);
  console.warn(`[dev] note: cannot write ${LOCAL_FILE} (${String(why)}); falling back to env vars, startup is not affected`);
  console.warn(`[dev] to clean up the stale file: rm -f ${LOCAL_FILE} (or sudo rm if you do not own it)`);
}

const children: ChildProcess[] = [];

/** Kill every child process (whole groups) and exit; shared by failure paths and normal exit. */
function killAllAndExit(code = 0): never {
  for (const c of children) {
    try {
      if (process.platform !== 'win32' && c.pid) process.kill(-c.pid, 'SIGTERM');
      else c.kill('SIGTERM');
    } catch {
      /* already exited */
    }
  }
  for (const f of [resolve(ROOT, '.dev-pids.json'), resolve(ROOT, '.mf-dev-local.json')]) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
}

/**
 * Find a usable vite entry for the directory (prefer the JS entry inside local node_modules).
 *
 * Why not `npx vite`:
 *  - when "not installed locally", npx downloads and **asks interactively**; in a script it
 *    manifests as hanging forever with no output
 *  - npx wraps everything in another `sh -c`; after killing the parent, the real vite becomes
 *    an orphan still holding the port
 * Calling `node <vite.js>` directly has neither problem.
 */
function resolveViteBin(dir: string): string | null {
  // Look for vite upward from the target directory (in monorepo / pnpm workspaces deps often install one level up)
  const candidates: string[] = [];
  let cur = dir;
  for (let i = 0; i < 4; i += 1) {
    candidates.push(resolve(cur, 'node_modules/vite/bin/vite.js'));
    const parent = resolve(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function viteCmd(dir: string, extraArgs: string[]): { cmd: string; args: string[] } {
  const bin = resolveViteBin(dir);
  if (!bin) {
    console.error(`\n[dev] no vite under ${dir}. Install dependencies first: pnpm install\n`);
    process.exit(1);
  }
  return { cmd: process.execPath, args: [bin, ...extraArgs] };
}

/**
 * Port health check before starting servers.
 *
 * A real scenario that bit us: the previous dev round didn't shut down cleanly (or another
 * terminal is open) and the base is still running. Starting again: the new base fails to
 * bind the same port, but the sub-apps come up as usual; the browser is actually talking to
 * the **old base**, whose targets still point at the test env → stuck on the loading state.
 * Symptom: "B is clearly started, yet the base keeps spinning" — with only one unremarkable
 * error line in the terminal.
 */
function portInUse(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((done) => {
    let finished = false;
    const sock = net.connect({ host: '127.0.0.1', port });
    const finish = (v: boolean): void => {
      if (finished) return;
      finished = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      done(v);
    };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    // Safety net: in some environments the socket neither connects nor errors (firewall / port
    // forwarding); without this timeout it hangs forever — exactly why "dev stalls at this line".
    setTimeout(() => finish(false), timeoutMs).unref?.();
  });
}

/**
 * Is the thing running on this port "this template's base"?
 * Recognized by its own /__mf/status.
 * If it can't be recognized, treat it as someone else's program and fall back to the original
 * error behavior — no guessing.
 */
async function isMfBase(port: number): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`http://127.0.0.1:${port}/__mf/status`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; apps?: unknown };
    return body?.ok === true && Array.isArray(body.apps);
  } catch {
    return false;
  }
}

/** Wait until a host:port accepts a TCP connection (at most timeoutMs). */
function waitPort(port: number, timeoutMs = 15000, hostName = '127.0.0.1'): Promise<boolean> {
  return new Promise((done) => {
    const deadline = Date.now() + timeoutMs;
    const tryOnce = (): void => {
      let settled = false;
      const sock = net.connect({ host: hostName, port });
      const next = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        try {
          sock.destroy();
        } catch {
          /* ignore */
        }
        if (ok) done(true);
        else if (Date.now() > deadline) done(false);
        else setTimeout(tryOnce, 150);
      };
      sock.once('connect', () => next(true));
      sock.once('error', () => next(false));
      setTimeout(() => next(false), 700).unref?.();
    };
    tryOnce();
  });
}

function run(label: string, cwd: string, cmd: string, cmdArgs: string[]): ChildProcess {
  if (!existsSync(cwd)) {
    console.error(`\n[dev] directory of ${label} does not exist: ${cwd}`);
    console.error('[dev] "dir" in the manifest is relative to the repo root; adjust it as needed\n');
    process.exit(1);
  }
  // detached: true puts each child in its own process group so shutdown can kill whole groups —
  // otherwise the outer process forks another layer, and after killing the parent the real vite
  // becomes an orphan still holding the port
  const child = spawn(cmd, cmdArgs, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, MF_LOCAL_APPS: LOCAL_ENV },
    // No shell needed anymore: call node <vite.js> directly, consistent across platforms
    shell: false,
    detached: process.platform !== 'win32',
  });
  child.on('error', (e) => console.error(`\n[dev] ${label} failed to start: ${e.message}\n`));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\n[dev] ${label} exited with code=${code}`);
      if (!ABORT_HINTED) {
        ABORT_HINTED = true;
        console.error('[dev] two most common reasons a sub-app fails to start:');
        console.error('[dev]   1) dependencies not installed → pnpm install');
        console.error('[dev]   2) pnpm blocked the esbuild build script → pnpm approve-builds');
        console.error('');
      }
    }
  });
  children.push(child);
  return child;
}
let ABORT_HINTED = false;

step('4/6', wanted.size ? `start ${wanted.size} sub-app dev server(s) (spawned in-repo)` : 'skip: no sub-apps to spawn');
const started: AppEntry[] = [];
for (const name of wanted) {
  const app = remotes.find((r) => r.name === name);
  if (!app) continue;
  if (!app.dir || !app.port) {
    console.warn(`[dev] ${app.name} has no dir or port, cannot spawn it (in cross-repo mode run pnpm dev in its own repo)`);
    continue;
  }
  started.push(app);
  const dir = resolve(ROOT, app.dir);
  const { cmd, args: viteArgs } = viteCmd(dir, ['--port', String(app.port), '--strictPort', '--base', app.base]);
  run(app.name, dir, cmd, viteArgs);
}

const notStarted = remotes.filter((r) => !wanted.has(r.name));

// Critical: wait until every local sub-app's port is actually connectable before starting the base.
// Otherwise the base comes up first and the page immediately hits ports that aren't listening
// yet → 500 → the loader stays on the loading state (it doesn't reject). One of the causes of
// "B is clearly started, yet the base keeps spinning".
step('5/6', wanted.size ? 'wait for sub-app ports' : 'skip: no sub-apps spawned');
const readyChecks = await Promise.all(
  started.map(async (app) => ({ app, ok: await waitPort(app.port as number) })),
);
const notReady = readyChecks.filter((x) => !x.ok);
if (notReady.length) {
  console.error(`\n[dev] these apps' ports did not come up: ${notReady.map((x) => `${x.app.name}:${String(x.app.port)}`).join(', ')}`);
  const dead = children.filter((c) => c.exitCode !== null && c.exitCode !== 0);
  if (dead.length) {
    console.error(`[dev] ${dead.length} of them already exited (code=${dead.map((c) => String(c.exitCode)).join(',')}); starting the base anyway is pointless`);
    console.error('[dev] check the errors of each sub-app above; for dependency issues reinstall: pnpm install\n');
    killAllAndExit(1);
  } else {
    console.error('[dev] processes alive but ports not listening — most likely still compiling, or the port is taken by another program\n');
  }
}

// Apps not spawned by this terminal fall into three buckets:
//   1) you started its dev server in your own repo → the base will find it (invisible here,
//      left to its own discovery)
//   2) it has a local artifact                     → reuse the last build, no network needed
//   3) neither                                     → only the test env remains; only then check remote reachability
const resolved = new Map<string, ResolvedArtifact | null>(notStarted.map((app) => [app.name, resolveArtifact(app)]));
const artifactApps = notStarted.filter((app) => resolved.get(app.name));
const remoteOnly = notStarted.filter((app) => !resolved.get(app.name));

const remoteChecks = await Promise.all(
  remoteOnly.map(async (app) => {
    const target = app.remote ? new URL(app.remote) : null;
    if (!target) return { app, ok: false, why: 'no remote configured' };
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    const ok = await waitPort(port, 2000, target.hostname).catch(() => false);
    return { app, ok, why: `${target.protocol}//${target.host}` };
  }),
);
const deadRemotes = remoteChecks.filter((x) => !x.ok);

console.log('');
console.log('─'.repeat(72));
console.log(
  reuseHost
    ? ` base        http://${String(manifest.gateway.host)}:${String(host.port)}/   (already running, reused)`
    : ` base        http://${String(manifest.gateway.host)}:${String(host.port)}/`,
);
for (const app of started) {
  console.log(` local dev   ${app.name.padEnd(10)} → http://127.0.0.1:${String(app.port)}${app.base}   (HMR available)`);
}
for (const app of artifactApps) {
  const hit = resolved.get(app.name);
  if (!hit) continue;
  const age = describeAge(artifactAgeHours(hit.dir));
  console.log(` artifact    ${app.name.padEnd(10)} → ${hit.dir.replace(ROOT + '/', '')}/   (${age} build, read-only)`);
}
for (const app of remoteOnly) {
  const remote = app.remote ?? '(no remote configured → will fail)';
  console.log(` test env    ${app.name.padEnd(10)} → ${remote}${app.base}`);
}
console.log('─'.repeat(72));
if (!wanted.size) {
  console.log('');
  console.log('[dev] no sub-apps spawned this run — run pnpm dev in the repo of each sub-app; the base picks up the port within 2s.');
  console.log('[dev] sub-apps with @fulcrum/sub-vite announce themselves immediately, no scan wait needed.');
}
if (artifactApps.length && !process.argv.includes('--quiet')) {
  console.log(`[dev] ${artifactApps.length} app(s) fall back to the last build's artifacts (no test env needed, no server started).`);
  console.log('[dev] to refresh a stale artifact: fulcrum build <name>');
}
if (deadRemotes.length) {
  console.warn('');
  console.warn(`[dev] warning: these apps have neither local artifacts nor a reachable test env — ${deadRemotes.map((x) => `${x.app.name}(${x.why})`).join(', ')}`);
  console.warn('[dev] they will show the failure panel in the browser. Pick one:');
  for (const x of deadRemotes) {
    console.warn(`[dev]   fulcrum dev ${x.app.name}     (start a dev server to change it)`);
    console.warn(`[dev]   fulcrum build ${x.app.name}   (serve the last built bundle)`);
  }
}
console.log('');

if (reuseHost) {
  step('6/6', 'base already running, skipping startup');
  console.log('[dev] once sub-apps are up, the base switches to local automatically (probing ports every 0.8s),');
  console.log('[dev] just refresh the browser; tabs on the base page refresh every 2s.');
  console.log('[dev] this terminal only manages the sub-apps it started; Ctrl-C stops only them, never the base.\n');
} else {
  step('6/6', 'start base');
  // The base code and the manifest may not live at the same level: vite's root decides where
  // index.html is, while the manifest belongs to the whole workspace — hence host.dir comes
  // from the manifest.
  const hostDir = resolve(ROOT, host.dir ?? '.');
  const { cmd, args: viteArgs } = viteCmd(hostDir, []);
  run('host', hostDir, cmd, viteArgs);
}

// Persist the pids: interactive Ctrl-C goes through shutdown, but if the parent process is
// SIGKILLed (or the editor/terminal is closed outright), the SIGINT/SIGTERM handlers never run
// and the child vite processes become orphans still holding ports. `fulcrum stop` relies on
// this pid table as the safety net.
const PID_FILE = resolve(ROOT, '.dev-pids.json');
try {
  writeFileSync(PID_FILE, JSON.stringify(children.map((c) => c.pid).filter(Boolean), null, 2));
} catch {
  /* failing to write doesn't block development */
}

const shutdown = (): void => killAllAndExit(0);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
