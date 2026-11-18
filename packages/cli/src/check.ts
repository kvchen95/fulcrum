#!/usr/bin/env node
/**
 * Checks used by CI / pre-commit; a non-zero exit code blocks the pipeline.
 *
 * Six gates:
 *  1. manifest schema and structure (unique names, a single host, non-conflicting base prefixes, no duplicate ports)
 *  2. **every remote has a fallback path** — otherwise "not started locally" means a blank page
 *  3. proxy is correct in all three states: all-local / all-fallback / mixed
 *  4. the base source contains no sub-app URL literals (the single source of truth hasn't been bypassed)
 *  5. in the build artifacts, build-time injections have been replaced with literals
 *  6. no machine-local override values were committed
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import {
  loadManifest,
  setRoot,
  buildProxy,
  proxyKeyFor,
  localTargetFor,
  remoteTargetFor,
  hasArtifact,
  artifactDirFor,
} from '@fulcrum/entry-vite/internal';

const ROOT = resolve(process.cwd());
setRoot(ROOT);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

let failed = 0;
const ok = (msg: string): void => console.log(`  ✔ ${msg}`);
const bad = (msg: string): void => {
  failed += 1;
  console.error(`  ✘ ${msg}`);
};

console.log('\n[check] 1/6 manifest');
const manifest = (() => {
  try {
    const m = loadManifest(resolve(ROOT, 'apps.manifest.json'));
    ok(`structure valid: 1 host + ${m.remotes.length} remotes`);
    return m;
  } catch (e) {
    bad(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
})();

console.log('\n[check] 2/6 every remote has a fallback (artifact or test env)');
{
  // When not started locally there must still be a way through: local artifacts / a test env URL.
  // With neither, the failure panel is inevitable.
  const missing = manifest.remotes.filter((a) => !a.remote && !hasArtifact(a));
  if (missing.length) {
    bad(`no remote and no local artifact: ${missing.map((a) => a.name).join(', ')}`);
    console.error('     fix: configure "remote" (test env), or run fulcrum build -- <name> first');
  } else {
    for (const a of manifest.remotes) {
      const via = a.remote
        ? remoteTargetFor(a)
        : `local artifact ${hasArtifact(a) ? `dist/site/${a.name}/` : '(?)'}`;
      ok(`${a.name.padEnd(10)} → ${String(via)}${a.remote ? a.base : ''}`);
    }
  }
}

console.log('\n[check] 3/6 proxy correct in all three states');
try {
  const allLocal = buildProxy(manifest, { localNames: manifest.remotes.map((r) => r.name) });
  for (const app of manifest.remotes) {
    const rule = allLocal[proxyKeyFor(app.base)];
    if (!rule) throw new Error(`${app.name}: missing proxy rule`);
    if (rule.target !== localTargetFor(app)) throw new Error(`${app.name}: wrong target in the all-local state`);
    if (rule.ws !== true) throw new Error(`${app.name}: ws must be true`);
  }
  ok(`all-local: ${manifest.remotes.length} rules point at dev servers, ws on`);

  // In "all-fallback" the artifact beats the test env — that's the everyday "start only one app" shape
  const noneLocal = buildProxy(manifest, { localNames: [] });
  for (const app of manifest.remotes) {
    const rule = noneLocal[proxyKeyFor(app.base)];
    if (!rule) throw new Error(`${app.name}: missing proxy rule`);
    const expected = hasArtifact(app) ? artifactDirFor(app) : remoteTargetFor(app);
    const expectedMode = hasArtifact(app) ? 'artifact' : 'remote';
    if (rule.target !== expected) throw new Error(`${app.name}: wrong target in the all-fallback state (expected ${expectedMode})`);
    if (rule.__initialMode !== expectedMode) throw new Error(`${app.name}: wrong mode in the all-fallback state (expected ${expectedMode})`);
  }
  ok(`all-fallback: ${manifest.remotes.length} rules have a fallback target (artifact or test env)`);

  // The mixed state is the everyday usage; verify it separately
  const first = manifest.remotes[0];
  if (!first) throw new Error('no remote in the manifest');
  const mixed = buildProxy(manifest, { localNames: [first.name] });
  ok(`mixed: ${first.name} → local, the remaining ${manifest.remotes.length - 1} → fallback`);
  // The rule is decided at runtime (__auto); __initialMode records the decision at startup time
  if (mixed[proxyKeyFor(first.base)]?.__initialMode !== 'local') throw new Error('wrong mode marker in the mixed state');
} catch (e) {
  bad(e instanceof Error ? e.message : String(e));
}

console.log('\n[check] 4/6 no sub-app URL literals in base source');
{
  // Scan all source under the base directory (skipping node_modules / dist / tests) for two kinds of hardcoding:
  //   sub-app base paths, and any http URL pointing at localhost
  // Don't hardcode a file list — otherwise this gate silently stops working the moment
  // the directory layout changes
  const hostDir = resolve(ROOT, manifest.host.dir ?? '.');
  const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage', 'tests', '__tests__', 'test', 'e2e', 'mocks']);
  const isTestFile = (name: string): boolean => /\.(test|spec)\.[^.]+$/.test(name);
  const EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.vue', '.html']);
  const offenders: string[] = [];

  const checkFile = (file: string): void => {
    // Strip comments before scanning: "don't hardcode http://localhost:7001" written in a
    // comment is documentation, not hardcoding
    const src = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const rel = relative(ROOT, file);
    for (const app of manifest.remotes) {
      // A base path appearing in base source = someone bypassed the manifest
      if (src.includes(`'${app.base}'`) || src.includes(`"${app.base}"`) || src.includes(`\`${app.base}\``)) {
        offenders.push(`${rel}: sub-app base "${app.base}" appears in base source`);
      }
    }
    for (const m of src.matchAll(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/g)) {
      offenders.push(`${rel}: local address ${m[0]} appears in base source`);
    }
  };

  const scan = (dir: string): void => {
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = resolve(dir, e.name);
      if (e.isDirectory()) scan(full);
      else if (EXTS.has(extname(e.name)) && !isTestFile(e.name)) checkFile(full);
    }
  };

  scan(hostDir);
  if (offenders.length) {
    for (const o of offenders) bad(o);
    console.error('     addresses must live only in the manifest (single source of truth)');
  } else {
    ok(`no hardcoded addresses (scanned all sources under ${relative(ROOT, hostDir) || '.'}/)`);
  }
}

console.log('\n[check] 5/6 build artifacts: build-time injections must be replaced with literals');
{
  // A pit hit before: when boot references globalThis.__MF_MANIFEST__, vite's define doesn't
  // apply (define only replaces bare identifiers), so the production bundle keeps an undefined
  // property read — symptom: blank page on load + "Cannot read properties of undefined (reading 'apps')".
  const site = resolve(ROOT, 'dist/site');
  if (!existsSync(site)) {
    console.log('  · no dist/site (not built yet), skipping');
  } else {
    const bads: string[] = [];
    for (const f of walk(resolve(site, 'assets'))) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/globalThis\.(__MF_(?:MANIFEST|LOCAL|PROD)__)/g)) {
        bads.push(`${f.split('/').pop() ?? f}: ${m[1]}`);
      }
    }
    if (bads.length) {
      bad('`globalThis.__MF_*__` not replaced (define only replaces bare identifiers — reference __MF_MANIFEST__ directly instead):');
      for (const b of bads) console.error(`     ${b}`);
    } else {
      ok('no leftover globalThis.__MF_*__ reads in the artifacts');
    }
  }
}

console.log('\n[check] 6/6 machine-local overrides not committed');
{
  const raw = readFileSync(resolve(ROOT, 'apps.manifest.json'), 'utf8');
  const count = (raw.match(/localhost/g) ?? []).length;
  if (count > 0) bad(`localhost ×${count} in apps.manifest.json (override values must not enter the manifest)`);
  else ok('no localhost in the manifest');
}

console.log('');
if (failed) {
  console.error(`[check] ${failed} gate(s) failed\n`);
  process.exit(1);
}
console.log('[check] all gates passed\n');
