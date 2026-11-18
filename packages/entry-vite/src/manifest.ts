/**
 * manifest: the single source of truth for addresses needed for local debugging.
 *
 * Design constraints (violations throw, no fallback):
 *  - name is globally unique (also the loader instance id: wujie name / qiankun container id / iframe name)
 *  - exactly one entry with role === 'host'
 *  - every remote's base must look like '/<name>/' and must not be a prefix of another remote
 *  - every remote needs at least one of remote (test env) or artifact (local artifact),
 *    otherwise loading necessarily fails when it "is not started locally"
 *  - port / dir are both optional (in cross-repo mode the port is found by scanning; the repo path is unrelated to the base)
 *  - unfilled fields always error out, no "|| defaults"
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectRoot } from './root.js';
import type { AppEntry, GatewayConfig, Manifest } from './types.js';

export class ManifestError extends Error {
  override name = 'ManifestError';
}

/** Narrow the JSON.parse result to an object once before using it, avoiding as any everywhere */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Find the manifest.
 *
 * Priority: explicit argument > MF_MANIFEST > search upward from the project root, up to 3 levels, for apps.manifest.json.
 * Why search upward: the base's vite root is often a subdirectory like `base/` (base code in its own folder),
 * while the manifest belongs to the whole workspace. Hardcoding `<root>/apps.manifest.json` makes such layouts fail to start outright.
 */
function findManifestPath(): string {
  const tried: string[] = [];
  let cur = projectRoot();
  for (let i = 0; i < 4; i += 1) {
    const candidate = resolve(cur, 'apps.manifest.json');
    tried.push(candidate);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  throw new ManifestError(`apps.manifest.json not found; looked in:\n  ${tried.join('\n  ')}`);
}

export function loadManifest(file?: string | null): Manifest {
  // MF_MANIFEST env var takes priority: CI / temporary env switches need no file edits
  const path = resolve(file ?? process.env.MF_MANIFEST ?? findManifestPath());
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new ManifestError(`cannot read manifest: ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new ManifestError(`manifest is not valid JSON: ${path}\n${why}`);
  }
  return validate(json, path);
}

export function validate(json: unknown, source = '<inline>'): Manifest {
  const errors: string[] = [];
  const root = asRecord(json);
  const appsRaw = root?.apps;
  if (!Array.isArray(appsRaw) || appsRaw.length === 0) {
    throw new ManifestError(`${source}: apps must be a non-empty array`);
  }

  // --- Per-field ---
  // During validation fields are read with a "loose shape"; only after validation passes are they narrowed into AppEntry (see end of file)
  const names = new Set<string>();
  for (const [i, rawApp] of appsRaw.entries()) {
    const a = asRecord(rawApp);
    const label = `apps[${i}]${typeof a?.name === 'string' ? `(${a.name})` : ''}`;

    const name = typeof a?.name === 'string' ? a.name : null;
    if (!name) errors.push(`${label}: missing name`);
    else if (names.has(name)) errors.push(`${label}: duplicate name — the name is also the loader instance id and must be unique`);
    if (name) names.add(name);

    const role = a?.role;
    if (role !== 'host' && role !== 'remote') errors.push(`${label}: role must be host | remote`);

    if (typeof a?.base !== 'string' || !a.base) errors.push(`${label}: missing base`);
    const base = typeof a?.base === 'string' ? a.base : '';
    if (!base.startsWith('/')) errors.push(`${label}: base must start with / (got "${String(a?.base)}")`);

    if (role === 'remote') {
      if (!base.endsWith('/')) {
        errors.push(`${label}: remote base must end with / or relative asset paths will break (got "${base}")`);
      }
      // port / dir are both optional:
      //   cross-repo mode — the port is decided by scanning; the repo path is unrelated to the base
      //   demo mode — both are only needed when you want `fulcrum dev -- <name>` to spawn it
      if (a?.port != null) {
        const port = a.port;
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
          errors.push(`${label}: port must be either omitted or an integer in 1-65535 (got ${String(port)})`);
        }
      }
      if (a?.dir != null && (typeof a.dir !== 'string' || !a.dir)) {
        errors.push(`${label}: dir must be either omitted or a non-empty string`);
      }
      // At least one of the three fallbacks must exist, otherwise this app can never load
      if (!a?.remote && !a?.artifact) {
        errors.push(`${label}: must set at least one of remote (test environment) or artifact (local artifact directory)`);
      }
    }
  }

  // Everything below reads AppEntry; first narrow the validated data into AppEntry[]
  const apps = appsRaw.map((rawApp) => rawApp as AppEntry);

  // --- Structural ---
  const hosts = apps.filter((a) => a.role === 'host');
  if (hosts.length !== 1) errors.push(`exactly one role=host is required, got ${hosts.length}`);

  const remotes = apps.filter((a) => a.role === 'remote');

  // base prefix conflict: /child/ and /child/aa/ would fight over routes
  for (const a of remotes) {
    for (const b of remotes) {
      if (a === b) continue;
      if (b.base.startsWith(a.base)) {
        errors.push(`base prefix conflict: ${a.name}="${a.base}" is a prefix of ${b.name}="${b.base}" — the proxy rules would steal each other's routes`);
      }
    }
  }

  // Duplicate ports: only meaningful when port is explicitly written (cross-repo mode has no port)
  const ports = new Map<number, string>();
  for (const a of remotes) {
    if (a.port == null) continue;
    const taken = ports.get(a.port);
    if (taken) errors.push(`duplicate port: ${a.name} and ${taken} both use ${a.port}`);
    ports.set(a.port, a.name);
  }

  if (errors.length) {
    throw new ManifestError(`manifest validation failed (${source}):\n  - ${errors.join('\n  - ')}`);
  }

  const gateway = asRecord(root?.gateway) as GatewayConfig | null;
  const env = typeof root?.env === 'string' && root.env ? root.env : 'dev';
  const host = hosts[0] as AppEntry;

  return { env, gateway: gateway ?? {}, apps, host, remotes };
}

/** Get an app by name; also returns when the remote is not enabled — the caller decides the semantics. */
export function appByName(manifest: Manifest, name: string): AppEntry {
  const a = manifest.apps.find((x) => x.name === name);
  if (!a) {
    const known = manifest.apps.map((x) => x.name).join(', ');
    throw new ManifestError(`no app "${name}" in the manifest (known: ${known})`);
  }
  return a;
}
