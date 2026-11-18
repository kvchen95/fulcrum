/**
 * Unit tests for cross-repo discovery: identity resolution, artifact manifest, base mismatch.
 *
 * No real dev server is started (that's covered by e2e); pure logic only:
 *   - appName takes precedence over name
 *   - the manifest's name must equal appName to be claimed
 *   - an artifact manifest whose base disagrees with the manifest must be rejected (otherwise a blank page in production)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveArtifact, checkBaseMatch, artifactAgeHours, describeAge } from '../dist/artifact.js';

const APP = (over = {}) => ({ name: 'child2', role: 'remote', base: '/child2/', remote: 'https://t.example.com', ...over });

function fakeRepo({ appName = 'child2', base = '/child2/', builtAt = new Date().toISOString() } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mf-art-'));
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<html></html>');
  writeFileSync(join(dist, 'fulcrum-artifact.json'), JSON.stringify({ appName, base, builtAt }));
  return { root, dist };
}

test('fulcrum-artifact.json alone locates the artifact with zero config', () => {
  const { root, dist } = fakeRepo();
  const hit = resolveArtifact(APP({ artifact: dist }));
  assert.equal(hit?.dir, dist);
  assert.equal(hit?.source, 'manifest');
  assert.equal(hit?.manifest.appName, 'child2');
  assert.ok(root);
});

test('without artifact, resolve via dir/dist (same-repo sub-app)', () => {
  const { root } = fakeRepo();
  // dir is a path relative to the base; an absolute path resolves fine too
  const hit = resolveArtifact(APP({ dir: root }));
  assert.equal(hit?.source, 'dir');
});

test('negative: artifact base disagrees with the manifest — must refuse (blank page)', () => {
  const { dist } = fakeRepo({ base: '/wrong/' });
  const hit = resolveArtifact(APP({ artifact: dist }));
  const r = checkBaseMatch(APP(), hit);
  assert.equal(r.ok, false);
  assert.match(r.why, /\/wrong\//);
});

test('base spelling difference (missing trailing slash) is not a mismatch', () => {
  const { dist } = fakeRepo({ base: '/child2' });
  const hit = resolveArtifact(APP({ artifact: dist }));
  assert.equal(checkBaseMatch(APP(), hit).ok, true);
});

test('a bundle without index.html is not an artifact', () => {
  const root = mkdtempSync(join(tmpdir(), 'mf-empty-'));
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'fulcrum-artifact.json'), JSON.stringify({ appName: 'child2', base: '/child2/' }));
  // Use a non-existent app name to avoid falling back to real artifacts in dist/site
  assert.equal(resolveArtifact(APP({ name: 'no-such-app', artifact: dist })), null);
});

test('artifact age: builtAt is used when parseable; describeAge is human-readable', () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const { dist } = fakeRepo({ builtAt: twoHoursAgo });
  const h = artifactAgeHours(dist);
  assert.ok(h > 1.5 && h < 2.5, `expected ~2 hours, got ${h}`);
  assert.match(describeAge(h), /hours ago/);
});
