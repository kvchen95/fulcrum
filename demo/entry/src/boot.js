/**
 * Host bootstrap logic (template version).
 *
 * Key design: **the host does not distinguish "local vs test environment".**
 * It always calls `startApp({ url: app.base })` (a same-origin path), and the vite proxy
 * decides whether that request is forwarded to a local dev server (what you are editing)
 * or to a built artifact in the test environment (what you are not editing).
 * The benefits:
 *   - no port/domain/environment branches anywhere in the host code; switching environments
 *     later never requires frontend changes
 *   - no CORS needed (the browser only ever sees one origin)
 *   - all five apps (abcde) stay usable; only the ones you pick get HMR
 *
 * The other three features each map to one field-tested conclusion:
 *   - sandbox health check + one-click refreshApp (the §7.3 pitfall everyone hits)
 *   - URL overrides (temporarily point at another port/machine locally, without polluting others)
 *   - a load failure only affects its own slot (§7.6)
 */
import * as W from 'wujie';
import { resolveAppUrl, listOverridden, writeOverride, clearOverrides, OVERRIDE_KEY } from './runtime/resolve.js';
import { watchSandbox, checkAll, recover } from './runtime/health.js';
import { ManifestError } from './runtime/manifest-error.js';

/* global __MF_MANIFEST__, __MF_LOCAL__, __MF_PROD__ */
// Note: these injected values must be read as **bare identifiers**, not globalThis.__MF_MANIFEST__.
// vite's define only replaces identifiers; globalThis.X is a property access, so it is not
// replaced at build time, leaving an undefined property read in the production bundle
// (it throws "Cannot read properties of undefined").
const manifest = __MF_MANIFEST__;
/**
 * The production build (npm run build) has neither a "local dev server" nor a "test-environment
 * fallback": every sub-app is served by the same site under its base. Only this addressing
 * differs — the resolution logic itself doesn't need to change a line.
 */
const IS_PROD = __MF_PROD__ === true;
// Initial value comes from launch args; refreshed live from /__mf/status after the page opens (terminals started later get picked up too)
const localNames = new Set(IS_PROD ? [] : (__MF_LOCAL__ ?? []));
const liveLocal = new Set(localNames);
// Three modes: local (dev server, HMR) / artifact (last build, read-only) / remote (test environment)
const liveMode = new Map();
const labels = new Map();
const remotes = manifest.apps.filter((a) => a.role === 'remote');

const stage = document.getElementById('stage');
const envEl = document.getElementById('env');
const healthEl = document.getElementById('health');
const recoverBtn = document.getElementById('recover');
const togglesBtn = document.getElementById('toggles');
envEl.textContent = IS_PROD
  ? `env=${manifest.env} · 生产构建 · ${remotes.length} 个子应用`
  : `env=${manifest.env} · 本地 ${localNames.size}/${remotes.length}`;

/** Mode → label text and color */
const MODE_UI = {
  local: { text: '本地', color: '#0a7' },
  artifact: { text: '上次打的包', color: '#b45309' },
  remote: { text: '测试环境', color: '#999' },
};
function modeOf(app) {
  return liveMode.get(app.name) ?? (liveLocal.has(app.name) ? 'local' : 'remote');
}

const started = [];

/**
 * Pre-check: fetch the HTML ourselves once before startApp.
 *
 * Why this step must exist — hit in practice:
 * when the proxy returns 500 (the sub-app dev server is not up), wujie's startApp **does not
 * reject**; it only logs `[wujie error]: html请求出现错误` to the console and stays in the
 * loading state forever. The try/catch therefore never runs and the user just sees a spinning
 * blank slot — the exact cause of "sub-app B is clearly running, yet the host still shows loading".
 */
async function probe(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      const proxyLike = res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504;
      return { ok: false, status: res.status, hint: proxyLike ? `proxy 拿不到页面（HTTP ${res.status}）` : `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, hint: `请求失败：${e.message}` };
  }
}

function failurePanel(app, holder, { mode, url, reason }) {
  const m = mode ?? (liveLocal.has(app.name) ? 'local' : 'remote');
  const where = IS_PROD
    ? `站点内 ${app.base}`
    : m === 'local'
      ? `本地 dev server（:${app.port}）`
      : m === 'artifact'
        ? `本地构建产物 dist/site/${app.name}/`
        : `测试环境 ${app.remote ?? '(未配置)'}`;
  holder.innerHTML = `
    <div class="not-started" style="text-align:left;padding:12px;line-height:1.7">
      <b style="color:#c00">${app.title ?? app.name} 加载失败</b><br>
      目标：${where} <code>${url}</code><br>
      原因：${reason}<br>
      ${IS_PROD
        ? `修法：<code>npm run build</code> 时带上这个应用；产物应位于 <code>dist/site${app.base}</code>`
        : m === 'local'
          ? `修法：确认它的 dev server 起来了 —— <code>npm run dev -- ${app.name}</code>；端口被占用 <code>lsof -i :${app.port}</code> 查`
          : m === 'artifact'
            ? `修法：<code>npm run build -- ${app.name}</code> 重新打这个包`
            : `修法三选一：<br>① 起服务改它：<code>npm run dev -- ${app.name}</code><br>② 用上次打的包：<code>npm run build -- ${app.name}</code><br>③ 修 <code>apps.manifest.json</code> 里的 <code>remote</code>`}
    </div>`;
}

// First-frame mode: apps named in the launch args are local, the rest inferred by "has an artifact or not" (consistent with /__mf/status)
for (const app of remotes) {
  liveMode.set(app.name, liveLocal.has(app.name) ? 'local' : 'remote');
}

function slot(app) {
  const div = document.createElement('div');
  div.className = 'slot';
  const label = document.createElement('span');
  label.className = 'label';
  // See at a glance which one is a local service (has HMR) and which is a test-environment artifact
  const ui = MODE_UI[modeOf(app)];
  label.textContent = IS_PROD ? (app.title ?? app.name) : `${app.title ?? app.name} · ${ui.text}`;
  label.style.color = IS_PROD ? '#999' : ui.color;
  labels.set(app.name, label);
  div.appendChild(label);
  const holder = document.createElement('div');
  holder.style.height = '100%';
  div.appendChild(holder);
  stage.appendChild(div);
  return holder;
}

for (const app of remotes) {
  const holder = slot(app);
  let resolved;
  try {
    resolved = resolveAppUrl(manifest, app.name);
  } catch (e) {
    if (e instanceof ManifestError) {
      holder.innerHTML = `<div class="not-started">${app.name}：${e.message}</div>`;
      continue;
    }
    throw e;
  }
  const mode = modeOf(app);

  // 1) Pre-check: if the HTML can't be fetched, don't hand it to wujie (it never rejects, it just spins forever)
  const pre = await probe(resolved.url);
  if (!pre.ok) {
    failurePanel(app, holder, { mode, url: resolved.url, reason: pre.hint });
    continue;
  }

  // 2) Hand it to wujie; loadError covers script/style load failures, and the timeout backstop covers "stuck without ever calling back"
  try {
    let settled = false;
    const timeout = new Promise((_, reject) =>
      setTimeout(() => {
        if (!settled) reject(new Error('startApp 超时（10s 未完成挂载）'));
      }, 10_000),
    );
    await Promise.race([
      W.startApp({
        name: app.name,
        url: resolved.url,
        el: holder,
        sync: false,
        loadError: (u, e) => {
          settled = true;
          failurePanel(app, holder, { mode, url: resolved.url, reason: `资源加载失败 ${u}：${e?.message ?? ''}` });
        },
      }).then(() => {
        settled = true;
      }),
      timeout,
    ]);
    if (holder.querySelector('.not-started')) continue; // loadError already rendered the failure panel
    started.push({ name: app.name, url: resolved.url, el: holder });
  } catch (e) {
    // A load failure only affects this slot: the host and the other sub-apps keep working (observed, §7.6)
    failurePanel(app, holder, { mode, url: resolved.url, reason: String(e.message).slice(0, 140) });
  }
}

// ---- local/remote state polling ----
//
// Why poll: target selection happens at the proxy layer and is decided at runtime, so after you
// run `npm run dev -- child2` in another terminal, the host needs no restart — but the page must
// learn "it has become local" so it can update the label and swap out the already-mounted old
// instance (the old one is running the test-environment artifact).
// On change, refreshApp automatically: it is the least effort in dev — don't make people refresh manually.
const mountedMode = new Map(
  started.map((t) => {
    const app = remotes.find((r) => r.name === t.name);
    return [t.name, app ? modeOf(app) : 'remote'];
  }),
);

async function pollStatus() {
  let body;
  try {
    const res = await fetch('/__mf/status', { cache: 'no-store' });
    if (!res.ok) return;
    body = await res.json();
  } catch {
    return; // the host doesn't provide it (vite started by hand) — just skip
  }
  if (!body?.apps) return;

  for (const info of body.apps) {
    const prev = liveMode.get(info.name);
    liveMode.set(info.name, info.mode);
    if (info.local) liveLocal.add(info.name);
    else liveLocal.delete(info.name);

    const label = labels.get(info.name);
    if (label && prev !== info.mode) {
      const ui = MODE_UI[info.mode] ?? MODE_UI.remote;
      label.textContent = `${info.title ?? info.name} · ${ui.text}`;
      label.style.color = ui.color;
    }
  }
  const localCount = body.apps.filter((a) => a.mode === 'local').length;
  const artCount = body.apps.filter((a) => a.mode === 'artifact').length;
  envEl.textContent = `env=${manifest.env} · 本地 ${localCount} · 产包 ${artCount}/${remotes.length}`;

  // Target changed → remount this app (to pick up the new target's content)
  for (const t of started) {
    const app = remotes.find((r) => r.name === t.name);
    const now = app ? modeOf(app) : 'remote';
    const was = mountedMode.get(t.name);
    if (was === now) continue;
    mountedMode.set(t.name, now);
    console.info(`[fulcrum] ${t.name} 目标变为${MODE_UI[now]?.text ?? now}，重新挂载`);
    try {
      await W.refreshApp(t);
    } catch (e) {
      console.warn(`[fulcrum] ${t.name} 重挂失败：${e.message}`);
    }
  }
}

if (!IS_PROD) {
  // Poll only in dev: a production build has no such thing as "target switching"
  const statusTimer = globalThis.setInterval(pollStatus, 2000);
  globalThis.addEventListener('beforeunload', () => globalThis.clearInterval(statusTimer));
  pollStatus();
}

// ---- sandbox health ----
const names = started.map((t) => t.name);
watchSandbox(names, (bad) => {
  healthEl.className = 'on';
  healthEl.textContent = `沙箱失效：${bad.map((b) => b.name).join('、')}`;
  recoverBtn.style.display = '';
});

recoverBtn.addEventListener('click', async () => {
  await recover(W, started);
  healthEl.className = '';
  recoverBtn.style.display = 'none';
});

// ---- URL override panel ----
if (IS_PROD) {
  // Don't expose the URL override panel in production (overriding can only break yourself)
  togglesBtn.style.display = 'none';
}
togglesBtn.addEventListener('click', () => {
  const cur = listOverridden(manifest);
  const lines = [
    `本地服务：${[...localNames].join(', ') || '(无)'}`,
    `当前覆盖（localStorage["${OVERRIDE_KEY}"]）：`,
    '',
    ...remotes.map((a) => {
      const hit = cur.find((c) => c.name === a.name);
      const where = hit ? hit.url : localNames.has(a.name) ? `本地 :${a.port}` : `${a.remote ?? '(无 remote)'}${a.base}`;
      return `${a.name.padEnd(12)} ${where}`;
    }),
    '',
    // Don't hardcode a full URL in this example, or the §4 "single source of truth" gate would flag it as hardcoded
    '改写：window.__mfOverride(<name>, <绝对地址>)',
    '清空：window.__mfClearOverride()',
  ];
  // eslint-disable-next-line no-alert
  alert(lines.join('\n'));
});

// Expose the debug hooks only in dev; keeping them in production amounts to leaving a "point any sub-app at any URL" switch on the live site
if (!IS_PROD) {
  globalThis.__mfOverride = (name, url) => {
    writeOverride(name, url);
    return '已写入，刷新页面生效';
  };
  globalThis.__mfClearOverride = () => {
    clearOverrides();
    return '已清空，刷新页面生效';
  };
  globalThis.__mfStatus = () => fetch('/__mf/status', { cache: 'no-store' }).then((r) => r.json());
  globalThis.__mfLocal = () => [...liveLocal];
  console.info(
    '[fulcrum] 本地服务:',
    [...liveLocal].join(',') || '(无)',
    '| 其余走测试环境:',
    remotes.filter((r) => !liveLocal.has(r.name)).map((r) => r.name).join(',') || '(无)',
  );
}
// The sandbox health diagnostics are harmless; keep them in both environments
globalThis.__mfHealth = () => checkAll(names);
