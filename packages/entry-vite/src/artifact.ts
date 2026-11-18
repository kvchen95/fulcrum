/**
 * Artifact manifest: reads fulcrum-artifact.json to judge "can this bundle be used".
 *
 * Three uses:
 *   1. Zero-config artifact lookup — no hand-written artifact absolute path in the manifest
 *   2. Staleness check  — builtAt older than the source mtime hints "this bundle may be stale"
 *   3. Mis-match guard  — a base in the manifest differing from the manifest errors out directly (otherwise a blank page that is hard to debug)
 *
 * Search order (stop at first hit):
 *   a. the manifest's artifact (explicit, most controllable)
 *   b. <dir>/dist/fulcrum-artifact.json (same-repo sub-app)
 *   c. $MF_APPS_DIR/<any dir>/dist/fulcrum-artifact.json (cross-repo scan)
 *   d. dist/site/<name> (the copy the base itself built)
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { projectRoot } from './root.js';
import type { AppEntry, ArtifactManifest, ResolvedArtifact } from './types.js';

export interface ResolveArtifactOptions {
  appsDir?: string | null;
  artifactRoot?: string;
}

/** Read one manifest; treat a broken file as absent */
export function readArtifactManifest(dir: string): ArtifactManifest | null {
  const file = resolve(dir, 'fulcrum-artifact.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ArtifactManifest;
  } catch {
    return null;
  }
}

/** Scan each repo's dist under MF_APPS_DIR, matching by appName */
function findByAppsDir(appName: string, appsDir: string | null): { dir: string; manifest: ArtifactManifest | null } | null {
  if (!appsDir || !existsSync(appsDir)) return null;
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = readdirSync(appsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(appsDir, e.name, 'dist');
    const manifest = readArtifactManifest(dir);
    if (manifest?.appName === appName) return { dir, manifest };
  }
  return null;
}

/** Resolve an app's artifact; returns null when not found */
export function resolveArtifact(app: AppEntry, opts: ResolveArtifactOptions = {}): ResolvedArtifact | null {
  const appsDir = opts.appsDir ?? process.env.MF_APPS_DIR ?? null;
  const siteRoot = opts.artifactRoot ?? resolve(projectRoot(), 'dist/site');

  // a. explicit in the manifest
  if (app.artifact) {
    const dir = resolve(projectRoot(), app.artifact);
    const manifest = readArtifactManifest(dir);
    if (hasIndex(dir)) return { dir, manifest, source: 'manifest' };
  }

  // b. same-repo sub-app's dist
  if (app.dir) {
    const dir = resolve(projectRoot(), app.dir, 'dist');
    const manifest = readArtifactManifest(dir);
    if (hasIndex(dir)) return { dir, manifest, source: 'dir' };
  }

  // c. cross-repo: scan MF_APPS_DIR
  const hit = findByAppsDir(app.name, appsDir);
  if (hit && hasIndex(hit.dir)) return { dir: hit.dir, manifest: hit.manifest, source: 'appsDir' };

  // d. the copy inside the site the base itself built (where fulcrum build puts full builds)
  const siteDir = join(siteRoot, app.name);
  if (hasIndex(siteDir)) return { dir: siteDir, manifest: readArtifactManifest(siteDir), source: 'site' };

  return null;
}

function hasIndex(dir: string | null | undefined): boolean {
  return Boolean(dir) && existsSync(join(dir as string, 'index.html'));
}

/** Artifact age in hours; returns null when builtAt is unavailable */
export function artifactAgeHours(dir: string): number | null {
  const m = readArtifactManifest(dir);
  if (!m?.builtAt) {
    // No manifest: fall back to index.html's mtime
    try {
      return (Date.now() - statSync(join(dir, 'index.html')).mtimeMs) / 3600000;
    } catch {
      return null;
    }
  }
  const t = Date.parse(m.builtAt);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 3600000;
}

export type BaseCheck = { ok: true } | { ok: false; why: string };

/**
 * Check: whether the base in the artifact manifest matches the manifest's base.
 * A mismatch must error — otherwise every resource path is wrong: a blank page with no visible cause.
 */
export function checkBaseMatch(app: AppEntry, resolved: ResolvedArtifact | null | undefined): BaseCheck {
  const m = resolved?.manifest;
  if (!m?.base) return { ok: true };
  const norm = (s: string): string => (s.endsWith('/') ? s : `${s}/`);
  if (norm(m.base) !== norm(app.base)) {
    return {
      ok: false,
      why: `artifact declares base "${m.base}" but the manifest wants "${app.base}" — this would render a blank page`,
    };
  }
  return { ok: true };
}

/** Human-readable description of an artifact's freshness */
export function describeAge(hours: number | null | undefined): string {
  if (hours == null) return 'time unknown';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes ago`;
  if (hours < 48) return `${Math.round(hours)} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}
