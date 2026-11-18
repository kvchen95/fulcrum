/**
 * Shared types: manifest, artifact manifest, proxy rules.
 *
 * Only "shapes shared across modules" go here. Each module keeps its own internal types
 * in its own file — don't pile them up here, or types.ts becomes a dumping ground.
 */

export type Role = 'host' | 'remote';

/** Three-level fallback: local dev server → local artifact → test env */
export type Mode = 'local' | 'artifact' | 'remote';

/** How the port was learned */
export type PortSource = 'announce' | 'proc' | 'http' | 'manifest';

/**
 * One app in the manifest.
 *
 * Besides the optional fields, unknown fields are allowed (`[key: string]: unknown`):
 * teams often stuff `owner`, `jira` and the like in there; validation must not fail over one extra field.
 */
export interface AppEntry {
  name: string;
  role: Role;
  base: string;
  title?: string;
  /** Repo path, relative to project root. Not needed in cross-repo mode */
  dir?: string;
  /** Port. Discovered by scanning in cross-repo mode, so it can be omitted here */
  port?: number;
  /** Test environment URL */
  remote?: string;
  /** Artifact dir, relative to project root. If omitted, auto-found via fulcrum-artifact.json */
  artifact?: string;
  /** Whether dev spawns it by default (only affects `--all`, not releases) */
  enabled?: boolean;
  /** 'remote' = always use the test env; even if it runs locally, don't switch to local */
  pin?: string;
  /** Per-app proxy timeout override */
  proxyTimeout?: number;
  mode?: string;
  [key: string]: unknown;
}

export interface GatewayConfig {
  host?: string;
  port?: number;
  [key: string]: unknown;
}

/** Validated manifest. host and remotes are already split out; callers don't need to filter */
export interface Manifest {
  env: string;
  gateway: GatewayConfig;
  apps: AppEntry[];
  host: AppEntry;
  remotes: AppEntry[];
}

/** fulcrum-artifact.json inside an artifact dir */
export interface ArtifactManifest {
  appName?: string;
  base?: string;
  builtAt?: string;
  commit?: string | null;
  [key: string]: unknown;
}

/** Where the artifact was found */
export interface ResolvedArtifact {
  dir: string;
  manifest: ArtifactManifest | null;
  source: 'manifest' | 'dir' | 'appsDir' | 'site';
}

/** Return of resolveTarget: target may be an http:// URL or an absolute path to an artifact dir */
export interface TargetChoice {
  target: string;
  mode: Mode;
}
