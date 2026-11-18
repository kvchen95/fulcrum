/**
 * The single "sub-app URL outlet" in the host.
 *
 * Three-level resolution, return on the first hit; if nothing hits, it must throw —
 * never '|| http://localhost:7001'. A default value turns "forgot to configure" into
 * "silently connecting to someone else's service", an order of magnitude harder to
 * debug than an error.
 *
 * Priority (later overrides earlier):
 *   1. manifest (committed to the repo, so the team shares the same set of placeholder addresses)
 *   2. localStorage overrides (temporarily point at another port/machine locally; written by the UI panel)
 *   3. window.__MF_OVERRIDE__ (for script injection / e2e)
 */
import { ManifestError } from './manifest-error.js';

export const OVERRIDE_KEY = 'mf:overrides';

/** Read local overrides: {'child1': 'http://127.0.0.1:7101/child1/'} */
export function readOverrides() {
  const fromInjection = globalThis.__MF_OVERRIDE__;
  let fromStorage = {};
  try {
    const raw = globalThis.localStorage?.getItem(OVERRIDE_KEY);
    if (raw) fromStorage = JSON.parse(raw);
  } catch {
    fromStorage = {}; // private mode / broken JSON: treat as no overrides, don't block
  }
  return { ...fromStorage, ...(fromInjection ?? {}) };
}

export function writeOverride(name, url) {
  const current = readOverrides();
  const next = { ...current, [name]: url };
  globalThis.localStorage?.setItem(OVERRIDE_KEY, JSON.stringify(next));
  return next;
}

export function clearOverrides() {
  globalThis.localStorage?.removeItem(OVERRIDE_KEY);
}

/**
 * @param {object} manifest  validated manifest (the output of validate in dev/manifest.js, or build-time injected)
 * @param {string} name      sub-app name
 * @returns {{url: string, source: 'override'|'manifest'}}
 */
export function resolveAppUrl(manifest, name) {
  const app = manifest.apps.find((a) => a.name === name);
  if (!app) {
    const known = manifest.apps.map((a) => a.name).join(', ');
    throw new ManifestError(`未知应用 "${name}"（manifest 里只有: ${known}）`);
  }
  if (app.role === 'host') {
    throw new ManifestError(`"${name}" 是底座自身，不能当子应用加载`);
  }

  const overrides = readOverrides();
  const hit = overrides[name];
  if (hit) {
    if (!/^https?:\/\//.test(hit)) {
      throw new ManifestError(`覆盖值必须是绝对地址，实际得到 "${hit}"`);
    }
    return { url: hit, source: 'override' };
  }

  // dev URL from the manifest: a path under the same origin, forwarded by the host dev server's proxy
  if (!app.base) {
    throw new ManifestError(`"${name}" 在 manifest 里没有 base，也没有本机覆盖 —— 无法解析地址`);
  }
  return { url: app.base, source: 'manifest' };
}

/** For the panel/badge: return all overridden entries */
export function listOverridden(manifest) {
  const overrides = readOverrides();
  return manifest.apps
    .filter((a) => a.role === 'remote' && overrides[a.name])
    .map((a) => ({ name: a.name, title: a.title, url: overrides[a.name] }));
}
