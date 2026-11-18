/** The three-level resolution of resolveAppUrl / overrides and the "no fallback" contract */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAppUrl, readOverrides, OVERRIDE_KEY } from '../src/runtime/resolve.js';
import { ManifestError } from '../src/runtime/manifest-error.js';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
};

const manifest = {
  apps: [
    { name: 'base', role: 'host', base: '/' },
    { name: 'child1', role: 'remote', base: '/child1/' },
  ],
};

test('未覆盖时走 manifest 的 base', () => {
  const r = resolveAppUrl(manifest, 'child1');
  assert.deepEqual(r, { url: '/child1/', source: 'manifest' });
});

test('localStorage 覆盖优先', () => {
  store.set(OVERRIDE_KEY, JSON.stringify({ child1: 'http://127.0.0.1:7101/child1/' }));
  const r = resolveAppUrl(manifest, 'child1');
  assert.deepEqual(r, { url: 'http://127.0.0.1:7101/child1/', source: 'override' });
  store.clear();
});

test('window.__MF_OVERRIDE__ 优先于 localStorage', () => {
  store.set(OVERRIDE_KEY, JSON.stringify({ child1: 'http://127.0.0.1:7101/child1/' }));
  globalThis.__MF_OVERRIDE__ = { child1: 'http://127.0.0.1:7201/child1/' };
  const r = resolveAppUrl(manifest, 'child1');
  assert.equal(r.url, 'http://127.0.0.1:7201/child1/');
  delete globalThis.__MF_OVERRIDE__;
  store.clear();
});

test('负例：未知应用必须抛错，不许静默兜底', () => {
  assert.throws(() => resolveAppUrl(manifest, 'nope'), (e) => {
    assert.ok(e instanceof ManifestError);
    assert.match(e.message, /未知应用/);
    return true;
  });
});

test('负例：把底座自身当子应用加载', () => {
  assert.throws(() => resolveAppUrl(manifest, 'base'), /是底座自身/);
});

test('负例：覆盖值不是绝对地址', () => {
  store.set(OVERRIDE_KEY, JSON.stringify({ child1: '127.0.0.1:7101' }));
  assert.throws(() => resolveAppUrl(manifest, 'child1'), /必须是绝对地址/);
  store.clear();
});

test('localStorage 里是坏 JSON 时当作没有覆盖，不阻断', () => {
  store.set(OVERRIDE_KEY, '{not json');
  assert.deepEqual(readOverrides(), {});
  assert.equal(resolveAppUrl(manifest, 'child1').source, 'manifest');
  store.clear();
});

test('负例：无 base 又无覆盖 —— 必须报错而不是拼一个默认值', () => {
  const m = { apps: [{ name: 'x', role: 'remote' }] };
  assert.throws(() => resolveAppUrl(m, 'x'), /没有 base，也没有本机覆盖/);
});
