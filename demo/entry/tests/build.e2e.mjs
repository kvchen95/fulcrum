/**
 * Build artifact acceptance: run after npm run build to check that dist/site really works as a site.
 *
 *   npm run build && npm run test:build
 *
 * Difference from tests/e2e.mjs: that one tests the **dev state** (local dev server + test-environment
 * fallback mixed); this one tests the **production state** (one site, everything from built artifacts).
 * They are kept separate because the production state should never show @vite/client, an HMR ws,
 * a "test environment" label or anything of the sort.
 *
 * Prerequisite: npm run build (artifacts in dist/site) + any static server pointed at it.
 * Uses the built-in `npm run preview` (8000) by default; set MF_HOST to test elsewhere.
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.MF_HOST ?? 'http://127.0.0.1:8000/';
const SITE = resolve(ROOT, 'dist/site');

if (!existsSync(resolve(SITE, 'index.html'))) {
  console.error('[build-e2e] 没有 dist/site —— 先 npm run build');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(resolve(ROOT, 'apps.manifest.json'), 'utf8'));
const REMOTES = manifest.apps.filter((a) => a.role === 'remote');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ✔ ${label}`);
  else {
    failures++;
    console.error(`  ✘ ${label} ${extra}`);
  }
};

/** Recursively list all files under a directory (paths relative to base) */
function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(p.slice(base.length + 1));
  }
  return out;
}

console.log('\n[1/4] 产物结构');
{
  const files = walk(SITE);
  check('底座 index.html 存在', files.includes('index.html'));
  check(
    '底座资源带 hash（可长缓存）',
    files.some((f) => /^assets\/.+-[A-Za-z0-9_-]{8}\.js$/.test(f)),
    files.filter((f) => f.startsWith('assets/')).slice(0, 3).join(' '),
  );
  for (const app of REMOTES) {
    // The default build produces all remotes (enabled only decides which ones dev starts by default)
    check(`${app.name}: 产物在 dist/site/${app.name}/`, files.includes(`${app.name}/index.html`));
    check(
      `${app.name}: 资源带 hash`,
      files.some((f) => f.startsWith(`${app.name}/assets/`) && /-[A-Za-z0-9_-]{8}\.js$/.test(f)),
    );
  }
  const mf = resolve(ROOT, 'dist/fulcrum-manifest.json');
  check('dist/fulcrum-manifest.json 存在', existsSync(mf));
  if (existsSync(mf)) {
    const m = JSON.parse(readFileSync(mf, 'utf8'));
    check('清单里列出全部子应用', m.apps.filter((a) => a.dir).length === REMOTES.length, JSON.stringify(m.apps.map((a) => a.dir)));
  }
}

console.log('\n[2/4] 页面渲染');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await (await browser.newContext({ viewport: { width: 960, height: 480 } })).newPage();
const errors = [];
const sockets = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 140)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 140)}`);
});
page.on('websocket', (s) => sockets.push(s.url()));

// Don't use networkidle: it may never fire
await page.goto(HOST, { waitUntil: 'domcontentloaded', timeout: 30000 });
await sleep(4000);

const state = await page.evaluate(() =>
  [...document.querySelectorAll('.slot')].map((s) => {
    const app = s.querySelector('wujie-app');
    const sr = app?.shadowRoot;
    return {
      id: app?.getAttribute('data-wujie-id') ?? null,
      label: s.querySelector('.label')?.textContent ?? null,
      h3: sr?.querySelector('h3')?.textContent ?? null,
      mounted: !!sr && sr.childElementCount > 0,
      failure: s.querySelector('.not-started')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? null,
    };
  }),
);

check('应用数量与 manifest 一致', state.length === REMOTES.length, `${state.length} vs ${REMOTES.length}`);
check('全部无失败面板', state.every((x) => !x.failure), JSON.stringify(state.filter((x) => x.failure)));
check('全部挂载出内容', state.every((x) => x.mounted && x.h3), JSON.stringify(state));
check('没有 JS 报错', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
check('标签是生产文案（不带"本地/测试环境"）', state.every((x) => x.label && !/本地|测试环境/.test(x.label)), JSON.stringify(state.map((x) => x.label)));

console.log('\n[3/4] 生产态不该有开发工具');
check('没有 HMR websocket', sockets.length === 0, sockets.join(' '));
{
  const created = await page.evaluate(() => ({
    hasOverride: typeof window.__mfOverride === 'function',
    hasStatus: typeof window.__mfStatus === 'function',
    togglesHidden: (() => {
      const b = document.getElementById('toggles');
      return !b || b.offsetParent === null;
    })(),
  }));
  check('地址覆盖面板已隐藏', created.togglesHidden && !created.hasOverride);
}

console.log('\n[4/4] SPA 深链回退（刷新任意子路由都不能 404）');
for (const app of REMOTES) {
  const deep = new URL(`${app.name}/deep/route/xyz`, HOST).toString();
  const res = await page.request.get(deep).catch(() => null);
  const html = res ? await res.text() : '';
  check(
    `${app.name}: ${app.base}deep/route/xyz 回退到自己的 index.html`,
    res?.status() === 200 && html.includes('<div id="app"'),
    `status=${res?.status()}`,
  );
}
{
  const res = await page.request.get(new URL('deep/route/xyz', HOST).toString()).catch(() => null);
  const html = res ? await res.text() : '';
  check('底座深链回退到 /index.html', res?.status() === 200 && html.includes('id="stage"'), `status=${res?.status()}`);
}

console.log('');
if (failures) {
  console.error(`[build-e2e] 失败 ${failures} 项`);
  await browser.close();
  process.exit(1);
}
console.log('[build-e2e] 全部通过');
await browser.close();
