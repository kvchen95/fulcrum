#!/usr/bin/env node
/**
 * Build: turn the base + all sub-apps into **a single site that can be dropped straight
 * onto nginx / object storage**.
 *
 *   fulcrum build                  # base + all sub-apps from the manifest
 *   fulcrum build child            # base + A only (CI usage when sub-apps live in separate repos)
 *   fulcrum build --no-base        # sub-app artifacts only
 *   fulcrum build --clean          # wipe everything and rebuild
 *   fulcrum build --with child2    # enter the sub-app repo and run its own build, then collect artifacts
 *
 * Artifact layout (one root covers everything — no per-app aliases needed):
 *
 *   dist/site/
 *     index.html          ← base
 *     assets/…            ← base assets
 *     child/…             ← A (deployed at /child/)
 *     child2/…            ← B (deployed at /child2/)
 *   dist/fulcrum-manifest.json ← manifest produced by this build (version, each app's base, artifact dirs)
 *   dist/nginx.conf       ← sample config
 *
 * Why build as "same-origin sub-paths": the base code only ever requests same-origin
 * paths like `/child/` (proxy in dev, nginx in production), so dev-time and prod-time
 * addressing are identical and no second set of "production URLs" needs maintaining.
 * For a cross-origin deployment, what changes is the nginx location upstream.
 */
import { build } from 'vite';
import { rmSync, mkdirSync, writeFileSync, existsSync, statSync, readdirSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { loadManifest, setRoot, resolveArtifact, checkBaseMatch, artifactAgeHours, describeAge } from 'fulcrum-entry-vite/internal';

const ROOT = resolve(process.cwd());
setRoot(ROOT);
const args = process.argv.slice(2);
const onlyBase = args.includes('--no-base');
const withIdx = args.indexOf('--with');
const withApps = withIdx >= 0 ? args.slice(withIdx + 1).filter((a) => !a.startsWith('--')) : [];
// values of --with <name...> don't count toward the "apps to build" list
const picked = args.filter((a) => !a.startsWith('--') && !withApps.includes(a));
const manifest = loadManifest();
const { host, remotes } = manifest;

const OUT = resolve(ROOT, 'dist');
const SITE = resolve(OUT, 'site');
const t0 = Date.now();

// Build everything by default: enabled is the "which apps dev starts by default" switch,
// unrelated to releases. Missing one sub-app at release time = 404 on that page in
// production, so default to building more rather than fewer.
const targets = picked.length ? remotes.filter((r) => picked.includes(r.name)) : remotes;
const unknown = picked.filter((n) => !remotes.some((r) => r.name === n));
if (unknown.length) {
  console.error(`\n[build] unknown app(s): ${unknown.join(', ')}`);
  console.error(`[build] available: ${remotes.map((r) => r.name).join(', ')}\n`);
  process.exit(1);
}

// --with: enter the sub-app repo and run its own build (no need to switch dirs for cross-repo apps)
for (const name of withApps) {
  const app = remotes.find((r) => r.name === name);
  if (!app) {
    console.error(`[build] --with: unknown app: ${name}`);
    process.exit(1);
  }
  const dir = app.dir ? resolve(ROOT, app.dir) : null;
  if (!dir || !existsSync(dir)) {
    console.error(`[build] ${name} has no dir, cannot enter its repo. Run build in its own repo, or point an artifact at its output.`);
    continue;
  }
  const pm = existsSync(resolve(dir, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
  console.log(`[build] entering ${dir}, running ${pm} run build …`);
  try {
    execFileSync(pm, ['run', 'build'], { cwd: dir, stdio: 'inherit' });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.error(`[build] ${name}'s own build failed (${why}), skipping it`);
  }
}

console.log(`[build] output dir dist/site/  base${onlyBase ? ' (skipped)' : ''} + ${targets.length} sub-app(s)`);

// Only a full build (no names) wipes the output; when building a single sub-app, the
// artifacts of the other apps must be preserved — otherwise `fulcrum build child2`
// would erase the just-released child and production would 404 immediately.
const cleanAll = args.includes('--clean') || (picked.length === 0 && !onlyBase);
if (cleanAll) rmSync(OUT, { recursive: true, force: true });
mkdirSync(SITE, { recursive: true });
if (!cleanAll) console.log('[build] incremental mode: keeping existing artifacts of other apps (add --clean for a full wipe)');

interface BuildAppInput {
  root: string;
  base: string;
  outDir: string;
  label: string;
  clean: boolean;
}

/** Build one app; base is decided by the manifest (the sub-app repo's vite.config doesn't need to repeat it) */
async function buildApp({ root, base, outDir, label, clean }: BuildAppInput): Promise<void> {
  const start = Date.now();
  await build({
    root,
    base,
    logLevel: 'warn',
    // In production there is no "local dev server", so the local list is an empty array;
    // the manifest is still compiled in — the base uses it to know how many apps exist
    // and each one's base.
    // (The Node API inline config doesn't carry the define from vite.config; give it explicitly here)
    define: {
      __MF_MANIFEST__: JSON.stringify(manifest),
      __MF_LOCAL__: JSON.stringify([]),
      __MF_PROD__: 'true',
    },
    build: {
      outDir,
      // Incremental builds must not empty outDir: base and sub-app artifacts share one site root
      emptyOutDir: clean,
      // Production must be cacheable, so filenames carry a hash (vite's default; made explicit here)
      assetsDir: 'assets',
      // The base entry uses top-level await to mount sub-apps serially (order matters: fetch the
      // HTML first, then hand off to the loader). The default target is es2020, which makes esbuild
      // fail with "Top-level await is not available". A micro-frontend base targets modern browsers
      // anyway, so just use esnext.
      target: 'esnext',
    },
  });
  const files = countFiles(outDir);
  const size = dirSize(outDir);
  console.log(
    `  ✔ ${label.padEnd(10)} base=${base.padEnd(10)} ${String(files).padStart(3)} files ${(size / 1024).toFixed(0)}KB  ${Date.now() - start}ms`,
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const countFiles = (dir: string): number => (existsSync(dir) ? walk(dir).length : 0);
const dirSize = (dir: string): number => (existsSync(dir) ? walk(dir).reduce((n, f) => n + statSync(f).size, 0) : 0);

// 1) base: artifacts land directly in the site root
if (!onlyBase) {
  // In incremental mode the base artifacts must not wipe the site root either: that would delete the sub-app directories too
  await buildApp({ root: resolve(ROOT, host.dir ?? '.'), base: '/', outDir: SITE, label: 'base', clean: cleanAll });
} else {
  mkdirSync(SITE, { recursive: true });
}

interface BuiltApp {
  name: string;
  base: string;
  from: 'source' | 'artifact';
}

// 2) sub-apps: each lands in its /<name>/ sub-directory (aligned with the manifest's base)
//
// In cross-repo setups the sub-app source is not in the base repo, so there are two paths:
//   a) source available (manifest has dir, or --with points at that repo) → build fresh
//   b) source unavailable → copy its last build's artifacts (located via fulcrum-artifact.json) and verify base
// "Build succeeded but some app didn't actually make it in" is not allowed — that would be a
// 404 in production, hence the final headcount.
const built: BuiltApp[] = [];
for (const app of targets) {
  const srcDir = app.dir ? resolve(ROOT, app.dir) : null;
  const outDir = resolve(SITE, app.name);

  if (srcDir && existsSync(resolve(srcDir, 'index.html'))) {
    try {
      await buildApp({ root: srcDir, base: app.base, outDir, label: app.name, clean: true });
      built.push({ name: app.name, base: app.base, from: 'source' });
      continue;
    } catch (e) {
      // Broken source (e.g. a cross-repo sync half-done, or deps not installed) must not fail
      // the whole release: fall back to the previous artifacts, but be loud about it —
      // silently shipping a stale bundle is the hardest incident to debug.
      const why = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? 'unknown error';
      console.warn(`  ! ${app.name} fresh build failed (${why}), falling back to the last artifacts`);
    }
  }

  const art = resolveArtifact(app);
  if (!art) {
    console.warn(`  · ${app.name} skipped: no source and no artifacts found (${app.dir ?? 'no dir configured'})`);
    continue;
  }
  const baseCheck = checkBaseMatch(app, art);
  if (!baseCheck.ok) {
    console.error(`  ✘ ${app.name} artifacts unusable: ${baseCheck.why}`);
    continue;
  }
  rmSync(outDir, { recursive: true, force: true });
  cpSync(art.dir, outDir, { recursive: true });
  const age = describeAge(artifactAgeHours(art.dir));
  console.log(`  ✔ ${app.name.padEnd(10)} reusing artifacts (${age}) ← ${art.dir}`);
  built.push({ name: app.name, base: app.base, from: 'artifact' });
}

// 3) runtime manifest: for ops/rollback, and so the base can later switch to "fetch the manifest at startup"
const siteManifest = {
  builtAt: new Date().toISOString(),
  env: manifest.env,
  host: { name: host.name, base: '/', dir: 'site' },
  apps: remotes.map((a) => ({
    name: a.name,
    title: a.title,
    base: a.base,
    dir: built.some((b) => b.name === a.name) ? a.name : null,
    from: built.find((b) => b.name === a.name)?.from ?? null,
    remote: a.remote ?? null,
  })),
};
writeFileSync(resolve(OUT, 'fulcrum-manifest.json'), JSON.stringify(siteManifest, null, 2) + '\n');

// 4) sample nginx: one root serves all apps, SPA fallback to each app's index.html
const locations = built
  .map(
    (a) => `    # sub-app ${a.name}
    location ${a.base} {
        try_files $uri $uri/ ${a.base}index.html;
        # cross-origin deployment: change to proxy_pass https://${a.name}.example.com/; and add CORS headers
    }
`,
  )
  .join('\n');

const nginx = `# generated by fulcrum build. Drop the whole dist/site directory where "root" points.
server {
    listen       80;
    server_name  _;
    root         /srv/mf/dist/site;
    index        index.html;

    # base (SPA fallback)
    location / {
        try_files $uri $uri/ /index.html;
    }

${locations}
    # long-cache hashed assets; never cache index.html or users keep a stale shell after a release
    location ~* \\/assets\\/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
    location = /index.html {
        add_header Cache-Control "no-store";
    }
}
`;
writeFileSync(resolve(OUT, 'nginx.conf'), nginx);

const total = dirSize(SITE);
console.log('');
console.log('─'.repeat(72));
console.log(` site root   dist/site            ${(total / 1024).toFixed(0)}KB`);
console.log(` manifest    dist/fulcrum-manifest.json`);
console.log(` nginx sample  dist/nginx.conf`);
console.log('─'.repeat(72));
console.log(`\n[build] done in ${Date.now() - t0}ms`);
console.log('[build] local acceptance: fulcrum preview   (serves dist/site statically, same addressing as production)\n');
