/**
 * Gates must come with negative cases: deliberately inject violations and confirm the
 * error names the specific field. A validator with no negative cases — you only find out
 * it stopped nothing once the business grows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, ManifestError } from '../dist/manifest.js';
import {
  buildProxy,
  proxyKeyFor,
  assertProxyCoversRemotes,
  resolveTarget,
  localTargetFor,
  remoteTargetFor,
} from '../dist/gateway.js';
import { needsPolling } from '../dist/root.js';

const HOST = { name: 'base', role: 'host', base: '/', port: 8000 };
const REMOTE = (over = {}) => ({
  name: 'child',
  role: 'remote',
  base: '/child/',
  dir: '../child',
  port: 7001,
  remote: 'https://test.example.com',
  ...over,
});

const run = (apps) => validate({ env: 'dev', gateway: {}, apps });

// Unit tests must not depend on a real dist on disk — these cases only exercise the
// "local/remote" branches. Point artifactRoot at a non-existent directory so the
// "artifact" branch is permanently unavailable.
// The artifact branch has its own positive case (the "none of the three" one below).
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
const NO_ARTIFACT = { artifactRoot: mkdtempSync(pathJoin(tmpdir(), 'mf-no-artifact-')) };

test('valid manifest passes', () => {
  const r = run([HOST, REMOTE(), REMOTE({ name: 'child2', base: '/child2/', port: 7002 })]);
  assert.equal(r.remotes.length, 2);
  assert.equal(r.host.name, 'base');
});

test('negative: duplicate name (the name is also the loader instance id)', () => {
  assert.throws(
    () => run([HOST, REMOTE(), REMOTE({ base: '/other/', port: 7003 })]),
    (e) => {
      assert.ok(e instanceof ManifestError);
      assert.match(e.message, /duplicate name/);
      return true;
    },
  );
});

test('negative: no host', () => {
  assert.throws(() => run([REMOTE()]), /exactly one role=host/);
});

test('negative: two hosts', () => {
  assert.throws(() => run([HOST, { ...HOST, name: 'base2' }, REMOTE()]), /exactly one role=host/);
});

// port / dir are optional now: in cross-repo mode the port is decided by scanning, and the repo path is independent of the base
test('remote without port / dir is valid (cross-repo mode)', () => {
  const m = run([HOST, REMOTE({ port: undefined, dir: undefined })]);
  assert.equal(m.remotes.length, 1);
  assert.equal(m.remotes[0].port, undefined);
});

test('negative: port present but invalid', () => {
  assert.throws(() => run([HOST, REMOTE({ port: 99999 })]), /port must be either omitted/);
});

test('negative: neither remote nor artifact — the guaranteed-failure panel', () => {
  assert.throws(
    () => run([HOST, REMOTE({ remote: undefined })]),
    /must set at least one of remote \(test environment\) or artifact/,
  );
});

test('negative: base does not end with / (relative asset paths would break)', () => {
  assert.throws(() => run([HOST, REMOTE({ base: '/child' })]), /must end with \//);
});

test('negative: base prefix conflict (/child/ is a prefix of /child/aa/)', () => {
  assert.throws(
    () => run([HOST, REMOTE(), REMOTE({ name: 'childA', base: '/child/aa/', port: 7003 })]),
    /base prefix conflict/,
  );
});

test('negative: two remotes claim the same port', () => {
  assert.throws(
    () => run([HOST, REMOTE(), REMOTE({ name: 'child2', base: '/child2/', port: 7001 })]),
    /duplicate port/,
  );
});

test('proxyKeyFor: anchored key with trailing slash', () => {
  assert.equal(proxyKeyFor('/child/'), '^/child/');
  assert.throws(() => proxyKeyFor('/'), ManifestError);
  assert.throws(() => proxyKeyFor('/child'), ManifestError);
});

// ---------- local / test-env routing decision (the core of this round of fixes) ----------

test('started locally → forward to the local dev server', () => {
  const r = resolveTarget(REMOTE(), new Set(['child']));
  assert.deepEqual(r, { target: localTargetFor(REMOTE()), mode: 'local' });
});

test('not started locally + local artifact → read dist directly, no network', () => {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'mf-artifact-'));
  mkdirSync(pathJoin(dir, 'child'), { recursive: true });
  writeFileSync(pathJoin(dir, 'child', 'index.html'), '<html></html>');
  const r = resolveTarget(REMOTE(), new Set(), { artifactRoot: dir });
  assert.equal(r.mode, 'artifact');
  assert.equal(r.target, pathJoin(dir, 'child'));
});

test('not started locally + remote configured → fall back to the test env (not a blank page)', () => {
  const r = resolveTarget(REMOTE(), new Set(), NO_ARTIFACT);
  assert.deepEqual(r, { target: 'https://test.example.com', mode: 'remote' });
});

test('remoteTargetFor takes the origin only; the path is decided by base', () => {
  assert.equal(remoteTargetFor({ name: 'x', remote: 'https://t.example.com/sub/child/' }), 'https://t.example.com');
  assert.equal(remoteTargetFor({ name: 'x' }), null);
  assert.throws(() => remoteTargetFor({ name: 'x', remote: 'not-a-url' }), ManifestError);
});

test('negative: no local server, no remote, no artifact — must throw with three fixes', () => {
  const app = REMOTE({ remote: undefined });
  assert.throws(() => resolveTarget(app, new Set(), NO_ARTIFACT), (e) => {
    assert.match(e.message, /none of the three/);
    assert.match(e.message, /fulcrum dev -- child/);
    assert.match(e.message, /fulcrum build -- child/);
    assert.match(e.message, /"remote"/);
    return true;
  });
});

test('mixed state: A local, B test env — both rules correct', () => {
  const a = REMOTE();
  const b = REMOTE({ name: 'child2', base: '/child2/', port: 7002, remote: 'https://test.example.com' });
  const m = run([HOST, a, b]);
  const proxy = buildProxy(m, { localNames: ['child'], ...NO_ARTIFACT });
  assert.equal(proxy['^/child/'].target, 'http://127.0.0.1:7001');
  assert.equal(proxy['^/child/'].__initialMode, 'local');
  assert.equal(proxy['^/child2/'].target, 'https://test.example.com');
  assert.equal(proxy['^/child2/'].__initialMode, 'remote');
  // Both cases must enable ws: local for HMR, remote enabled is harmless
  assert.equal(proxy['^/child/'].ws, true);
  assert.equal(proxy['^/child2/'].ws, true);
});

test('runtime switching: port comes alive → go local; dies → fall back to the test env', () => {
  const a = REMOTE();
  const b = REMOTE({ name: 'child2', base: '/child2/', port: 7002, remote: 'https://test.example.com' });
  const m = run([HOST, a, b]);
  // Fake watcher: simulates "the base is already running, then another terminal starts child2"
  const alive = new Map([['child', false], ['child2', false]]);
  const watcher = { isLocal: (n) => alive.get(n) === true };
  const proxy = buildProxy(m, { localNames: ['child'], watcher, ...NO_ARTIFACT });

  // Before child2 starts: both go through the test env
  assert.equal(proxy['^/child/'].router(), 'https://test.example.com');
  assert.equal(proxy['^/child2/'].router(), 'https://test.example.com');

  // Another terminal starts child2 (port comes alive) → no base restart, routing switches over by itself
  alive.set('child2', true);
  assert.equal(proxy['^/child2/'].router(), 'http://127.0.0.1:7002');
  // child not started → still falls back
  assert.equal(proxy['^/child/'].router(), 'https://test.example.com');
});

test('negative: a proxy rule has ws !== true (HMR would silently break)', () => {
  const m = run([HOST, REMOTE()]);
  const broken = { '^/child/': { target: 'http://127.0.0.1:7001', changeOrigin: true, ws: false } };
  assert.throws(() => assertProxyCoversRemotes(m, broken, ['child']), /ws !== true/);
});

test('negative: proxy missing a rule', () => {
  const m = run([HOST, REMOTE()]);
  assert.throws(() => assertProxyCoversRemotes(m, {}, ['child']), /missing proxy rule/);
});

test('negative: proxy has keys not in the manifest (drift)', () => {
  const m = run([HOST, REMOTE()]);
  const extra = {
    '^/child/': { target: 'http://127.0.0.1:7001', changeOrigin: true, ws: true },
    '^/ghost/': { target: 'http://127.0.0.1:7999', changeOrigin: true, ws: true },
  };
  assert.throws(() => assertProxyCoversRemotes(m, extra, ['child']), /no matching remote/);
});

test('negative: target disagrees with the local/test-env decision', () => {
  const m = run([HOST, REMOTE()]);
  // Declares child is local, but target points at the test env
  const wrong = { '^/child/': { target: 'https://test.example.com', changeOrigin: true, ws: true } };
  assert.throws(() => assertProxyCoversRemotes(m, wrong, ['child']), /does not match/);
});

test('generated proxy passes the self-check with all ws true', () => {
  const m = run([HOST, REMOTE()]);
  const proxy = buildProxy(m, { localNames: ['child'] });
  assert.equal(Object.keys(proxy).length, 1);
  assert.equal(proxy['^/child/'].ws, true);
  assert.equal(proxy['^/child/'].target, 'http://127.0.0.1:7001');
});


test('WSL + /mnt/*（Windows 盘）必须自动改用轮询监听', () => {
  const prev = process.env.WSL_DISTRO_NAME;
  process.env.WSL_DISTRO_NAME = 'Ubuntu';
  assert.equal(needsPolling('/mnt/d/code/fulcrum'), true);
  assert.equal(needsPolling('/home/kovi/work/fulcrum'), false);
  delete process.env.WSL_DISTRO_NAME;
  // 没有 WSL 环境变量 = 原生 Windows/Linux，不需要轮询
  assert.equal(needsPolling('/mnt/d/code/fulcrum'), false);
  process.env.WSL_DISTRO_NAME = prev;
});
