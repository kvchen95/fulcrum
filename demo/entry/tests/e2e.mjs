/**
 * End-to-end acceptance (ships with the template, re-runnable).
 *
 * Expectations are derived from the host's `/__mf/status` (the real runtime state), so all of
 * these launch modes are testable:
 *   npm run dev                    → only the enabled ones are local
 *   npm run dev -- child           → A local, B on the test environment
 *   npm run dev -- child child2    → both local
 *   two terminals: npm run dev / then npm run dev -- child2 → the host picks up B as local too
 *
 * Don't use `.mf-dev-local.json`: it only records "what this terminal started";
 * with multiple terminals it is a union, not fully equivalent to the host's actual routing.
 *
 * Prerequisites:
 *   1. Build the "test environment" artifacts and start the stand-in (a CDN/nginx in real life):
 *        node -e "import('vite').then(({build})=>build({root:'../child2',base:'/child2/',build:{outDir:'../../tmp/testenv/child2',emptyOutDir:true}}))"
 *        node dev/fake-test-env.js 7999 tmp/testenv
 *   2. Start the host (any of the ways above)
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.MF_HOST ?? 'http://127.0.0.1:8000/';
const HELLO = resolve(ROOT, '../child1/src/hello.js');
const MARKER_OLD = 'child-A v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const manifest = JSON.parse(readFileSync(resolve(ROOT, 'apps.manifest.json'), 'utf8'));
const REMOTES = manifest.apps.filter((a) => a.role === 'remote').map((a) => a.name);

// The runtime truth comes from the host's own /__mf/status, not from the file written at startup
let status;
try {
  const res = await fetch(new URL('__mf/status', HOST));
  status = await res.json();
} catch (e) {
  console.error(`[e2e] 拿不到 ${HOST}__mf/status —— 底座没起？ ${e.message}`);
  process.exit(1);
}
if (!status?.ok) {
  console.error('[e2e] /__mf/status 返回异常');
  process.exit(1);
}
const LOCAL = new Set(status.local ?? []);
// Test environments on placeholder domains (test.example.com) are unreachable by design — such apps
// cannot have their mounting verified, so skip them explicitly with an explanation instead of failing the whole e2e run.
const byName = new Map(status.apps.map((a) => [a.name, a]));
const SKIP = new Set(
  status.apps
    .filter((a) => a.mode === 'remote' && /example\.com$/.test(new URL(a.remote ?? 'http://x').hostname ?? ''))
    .map((a) => a.name),
);
const ACTIVE = REMOTES.filter((n) => !SKIP.has(n));
if (SKIP.size) {
  console.log(`[e2e] 跳过 ${[...SKIP].join(', ')}：走占位测试环境，无法验证。要测它先 npm run build -- <name> 或起它的 dev server`);
}

let failures = 0;
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ✔ ${label}`);
  else {
    failures++;
    console.error(`  ✘ ${label} ${extra}`);
  }
};

console.log(`\n本地: ${[...LOCAL].join(',') || '(无)'} ｜ 测试环境: ${REMOTES.filter((n) => !LOCAL.has(n)).join(',') || '(无)'}`);

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await (await browser.newContext({ viewport: { width: 960, height: 480 } })).newPage();
const sockets = [];
page.on('websocket', (s) => sockets.push(s.url()));

const state = () =>
  page.evaluate(() => {
    return [...document.querySelectorAll('.slot')].map((s) => {
      const app = s.querySelector('wujie-app');
      const id = app?.getAttribute('data-wujie-id') ?? null;
      const sr = app?.shadowRoot;
      const fail = s.querySelector('.not-started');
      return {
        id,
        label: s.querySelector('.label')?.textContent ?? null,
        h3: sr?.querySelector('h3')?.textContent ?? null,
        mounted: !!sr && sr.childElementCount > 0,
        failure: fail ? fail.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) : null,
      };
    });
  });

console.log('\n[1/5] 每个应用都渲染出来（不是空白、不是转圈）');
// Don't use networkidle: the test-environment path keeps a long-lived connection, so networkidle may never fire
await page.goto(HOST, { waitUntil: 'domcontentloaded', timeout: 30000 });
await sleep(4500);
let s = await state();
check('应用数量与 manifest 一致', s.length === REMOTES.length, `${s.length} vs ${REMOTES.length}`);
const activeSlots = s.filter((_, i) => !SKIP.has(REMOTES[i]));
check('全部无失败面板', activeSlots.every((x) => !x.failure), JSON.stringify(activeSlots.filter((x) => x.failure)));
check('全部挂载出内容', activeSlots.every((x) => x.mounted && x.h3), JSON.stringify(activeSlots));

console.log('\n[2/5] 本地应用走 dev server，测试环境应用走构建产物');
for (const name of ACTIVE) {
  const html = await page.evaluate(async (n) => (await fetch(`/${n}/`)).text().catch(() => ''), name);
  const isLocal = LOCAL.has(name);
  if (isLocal) {
    check(`${name}: 是本地（含 @vite/client）`, html.includes('@vite/client'), html.slice(0, 80));
    check(`${name}: 有 ws（HMR 可用）`, sockets.some((u) => u.includes(`/${name}/`)), sockets.join(' '));
  } else {
    check(`${name}: 是构建产物（hash 资源、无 @vite/client）`, /assets\/index-[A-Za-z0-9_-]+\.js/.test(html) && !html.includes('@vite/client'), html.slice(0, 80));
    check(`${name}: 无 ws（不热更）`, !sockets.some((u) => u.includes(`/${name}/`)), sockets.join(' '));
  }
}

console.log('\n[3/5] 改本地应用源码 → 只有它变');
if (LOCAL.has('child1')) {
  const orig = readFileSync(HELLO, 'utf8');
  const marker = `HMR-${Date.now().toString(36)}`;
  writeFileSync(HELLO, orig.replace(MARKER_OLD, marker));
  await sleep(6000);
  s = await state();
  // Use startsWith instead of ===: historical code may leave a tail like v1.2; what matters is that HMR happened
  check(`child1 hot-reloaded to ${marker}`, s.some((x) => x.id === 'child1' && x.h3?.startsWith(marker)), JSON.stringify(s));
  const others = s.filter((_, i) => REMOTES[i] !== 'child1' && !SKIP.has(REMOTES[i]));
  check('其他应用未被牵连', others.every((x) => x.h3 && x.h3 !== marker), JSON.stringify(others));
  writeFileSync(HELLO, orig);
  // 3b) Entry-level change: vite sends a full page reload inside the sandbox, which kills it.
  // The host must auto-recover (refreshApp) so the developer never has to refresh the host page.
  const MAIN = resolve(ROOT, '../child1/src/main.js');
  const mainOrig = readFileSync(MAIN, 'utf8');
  writeFileSync(MAIN, `${mainOrig}\nconsole.log('[e2e] entry change');`);
  await sleep(7000); // full reload -> sandbox dies (1s poll) -> auto refreshApp
  const health = await page.evaluate(() => (window.__mfHealth ? window.__mfHealth() : []));
  const h1 = health.find((h) => h.name === 'child1');
  check('entry change: sandbox auto-recovered without host refresh', h1?.state === 'alive', JSON.stringify(health));
  s = await state();
  check('recovered sandbox serves the current code', s.some((x) => x.id === 'child1' && !!x.h3), JSON.stringify(s));
  writeFileSync(MAIN, mainOrig);
  await sleep(2500);
} else {
  console.log('  （child 不在本地，跳过）');
}

console.log('\n[4/5] 底座知道谁在本地');
{
  const local = await page.evaluate(() => (window.__mfLocal ? window.__mfLocal() : null));
  check(
    '__mfLocal() 与 /__mf/status 一致',
    Array.isArray(local) && local.length === LOCAL.size && local.every((n) => LOCAL.has(n)),
    `page=${JSON.stringify(local)} status=${JSON.stringify([...LOCAL])}`,
  );
}

console.log('\n[5/5] 沙箱健康');
{
  const health = await page.evaluate(() => (window.__mfHealth ? window.__mfHealth() : null));
  check('__mfHealth() 覆盖可验证的应用', Array.isArray(health) && health.length === ACTIVE.length, `${JSON.stringify(health)} 期望 ${ACTIVE.length}`);
  check('没有 missing 状态', Array.isArray(health) && health.every((h) => h.state === 'alive'), JSON.stringify(health));
}

console.log('');
if (failures) {
  console.error(`[e2e] 失败 ${failures} 项`);
  await browser.close();
  process.exit(1);
}
console.log('[e2e] 全部通过');
await browser.close();
