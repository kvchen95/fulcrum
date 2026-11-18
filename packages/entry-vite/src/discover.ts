/**
 * Sub-app discovery: who is running, on which port, as which app.
 *
 * The base no longer spawns sub-apps, nor requires ports in the manifest — you run
 * `pnpm dev` in any directory yourself; a scan every 2s claims results onto the names in the manifest.
 *
 * Three gates to claim (all must pass):
 *   1. something LISTENs on the port              (listeningPorts)
 *   2. the appName matches                        (proc reads package.json, or HTTP reads {base}package.json)
 *   3. that port really serves {base}             (verifyServesBase, ruling out same-named processes that aren't dev servers)
 *
 * Why gate 3 cannot be skipped: package.json only says "a process of this repo is running",
 * not that it is a dev server, let alone that its base matches. Skipping it would treat
 * same-named processes like `node scripts/seed.js` as sub-apps.
 */
import { listeningPorts, identifyByProc, identifyByHttp, verifyServesBase, type PackageIdentity } from './ports.js';
import type { AppEntry, Manifest, PortSource } from './types.js';

export interface DiscoveryOptions {
  intervalMs?: number;
  timeoutMs?: number;
  /** Ports to skip scanning (the base itself, the manifest gateway port) */
  skipPorts?: number[];
}

export interface ClaimedPort {
  port: number;
  source: PortSource;
  pid?: number | null;
  cwd?: string | null;
}

export interface Verdict {
  ok: boolean;
  app?: string;
  source?: PortSource;
  why?: string;
}

export interface AnnounceInput {
  appName: string;
  port: number;
  base?: string | null;
}

export interface Discovery {
  start(): Discovery;
  touch(): void;
  stop(): void;
  get(name: string): ClaimedPort | undefined;
  claimFromAnnounce(input: AnnounceInput): Promise<{ ok: boolean; why?: string; changed?: boolean; port?: number }>;
  releaseFromAnnounce(input: { appName: string; port: number }): boolean;
  isLocal(name: string): boolean;
  claimedNames(): string[];
  verdicts(): Array<{ port: number } & Verdict>;
  refresh: () => Promise<void>;
}

export function createDiscovery(manifest: Manifest, opts: DiscoveryOptions = {}): Discovery {
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 400;
  const skip = new Set(opts.skipPorts ?? []);

  /** name → claim result */
  const claimed = new Map<string, ClaimedPort>();
  /** port → verdict (including negatives, so the same port is not retried every round) */
  const verdict = new Map<number, Verdict>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastPortSet = '';
  let lastAccess = Date.now();
  let running = false;
  let lastTickAt = 0;
  let lastTouchScan = 0;

  /** Page visits switch back to fast cadence; when nobody is looking, slow down (saves CPU, quiets the logs) */
  const FAST_MS = 2000;
  const SLOW_MS = 10000;
  const IDLE_AFTER_MS = 30_000;

  /** Find the app in the manifest by appName; fall back to name when there is no appName */
  function appFor(identity: Pick<PackageIdentity, 'appName' | 'name'>): AppEntry | null {
    const { appName, name } = identity;
    if (appName) {
      const hit = manifest.remotes.find((a) => a.name === appName);
      if (hit) return hit;
    }
    if (name) {
      const hit = manifest.remotes.find((a) => a.name === name);
      if (hit) return hit;
    }
    return null;
  }

  /** Claim a port; when one app has several ports, take the smaller one (multi-worktree case) */
  function claim(app: AppEntry, port: number, source: PortSource, extra: Partial<ClaimedPort> = {}): boolean {
    const prev = claimed.get(app.name);
    if (prev && prev.port <= port) return false;
    claimed.set(app.name, { port, source, ...extra });
    return true;
  }

  async function scanPort(port: number, inodes: Set<string | number> | undefined): Promise<void> {
    // 1) proc channel: no request needed, fastest
    for (const id of identifyByProc(port, inodes)) {
      const app = appFor(id);
      if (!app) continue;
      const ok = await verifyServesBase(app.base, port, { timeoutMs });
      if (!ok.ok) {
        verdict.set(port, { ok: false, why: `appName matched ${app.name} but ${ok.why}` });
        continue;
      }
      verdict.set(port, { ok: true, app: app.name, source: 'proc' });
      claim(app, port, 'proc', { pid: id.pid, cwd: id.cwd });
      return;
    }

    // 2) HTTP channel: try {base}package.json once for each app not yet claimed
    const pending = manifest.remotes.filter((a) => !claimed.has(a.name));
    for (const app of pending) {
      const id = await identifyByHttp(app.base, port, { timeoutMs });
      if (!id.appName && !id.name) continue;
      if (id.appName !== app.name && id.name !== app.name) continue;
      const ok = await verifyServesBase(app.base, port, { timeoutMs });
      if (!ok.ok) {
        verdict.set(port, { ok: false, why: `${app.name}'s package.json responded but ${ok.why}` });
        continue;
      }
      verdict.set(port, { ok: true, app: app.name, source: 'http' });
      claim(app, port, 'http');
      return;
    }

    verdict.set(port, { ok: false, why: "no app's appName matched" });
  }

  /** For the adaptive loop: skip if the last scan was too recent (touch may have just scanned) */
  async function tickIfDue(minGapMs = 700): Promise<void> {
    if (Date.now() - lastTickAt < minGapMs) return;
    await tick();
  }

  async function tick(): Promise<void> {
    lastTickAt = Date.now();
    const ports = listeningPorts();
    // If the port set is unchanged, do not rescan (claims are still valid)
    const signature = [...ports.keys()].sort((a, b) => a - b).join(',');
    if (signature === lastPortSet) return;
    lastPortSet = signature;

    // If a claimed port disappears, revoke the claim (terminal closed → fall back to artifact/remote)
    for (const [name, info] of [...claimed]) {
      if (!ports.has(info.port)) claimed.delete(name);
    }
    // Verdicts become stale when the port set changes
    for (const port of [...verdict.keys()]) if (!ports.has(port)) verdict.delete(port);

    const todo = [...ports.keys()].filter((p) => !skip.has(p) && !verdict.has(p) && p >= 1024);
    await Promise.all(todo.map((p) => scanPort(p, ports.get(p))));
  }

  const discovery: Discovery = {
    start() {
      void tick();
      // Adaptive interval: 2s while the page polls, drops to 10s after 30s idle
      const loop = (): void => {
        if (!running) return;
        const idle = Date.now() - lastAccess > IDLE_AFTER_MS;
        timer = setTimeout(() => {
          void tickIfDue().then(loop);
        }, idle ? SLOW_MS : intervalMs || FAST_MS);
        timer.unref?.();
      };
      running = true;
      loop();
      return discovery;
    },
    /** Called every time the page pulls /__mf/status: back to fast cadence immediately, plus a throttled scan (800ms) */
    touch() {
      lastAccess = Date.now();
      const now = Date.now();
      if (now - lastTouchScan > 800) {
        lastTouchScan = now;
        void tick();
      }
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    get(name: string) {
      return claimed.get(name);
    },
    /**
     * Sub-app proactively reports (announce plugin).
     * The report itself is not trusted — still run verifyServesBase to guard against "reported but not serving this base".
     */
    async claimFromAnnounce({ appName, port, base }) {
      const app = manifest.remotes.find((a) => a.name === appName);
      if (!app) return { ok: false, why: `no ${appName} in the manifest` };
      if (!Number.isInteger(port)) return { ok: false, why: `invalid port: ${String(port)}` };
      if (base && base !== app.base) {
        return { ok: false, why: `reported base "${base}" does not match the manifest's "${app.base}"` };
      }
      const ok = await verifyServesBase(app.base, port, { timeoutMs });
      if (!ok.ok) return { ok: false, why: ok.why };
      const changed = claim(app, port, 'announce');
      // The reported port takes priority: remove it from the "to scan" set
      verdict.set(port, { ok: true, app: app.name, source: 'announce' });
      return { ok: true, changed, port };
    },
    /** Sub-app reports exit */
    releaseFromAnnounce({ appName, port }) {
      const cur = claimed.get(appName);
      if (cur && cur.port === port) {
        claimed.delete(appName);
        verdict.delete(port);
        return true;
      }
      return false;
    },
    isLocal(name: string) {
      return claimed.has(name);
    },
    /** Names of currently running apps (for /__mf/status and logs) */
    claimedNames() {
      return [...claimed.keys()];
    },
    /** port → verdict details (for debugging: why some port was not claimed) */
    verdicts() {
      return [...verdict.entries()].map(([port, v]) => ({ port, ...v }));
    },
    refresh: tick,
  };

  return discovery;
}
