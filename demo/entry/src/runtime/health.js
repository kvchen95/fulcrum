/**
 * Sandbox health check — the toolized backstop for the one "guaranteed" pitfall from the spike.
 *
 * Observed facts (see plan §7.3):
 *   editing a sub-app entry (any change that triggers a vite full-reload) makes wujie's iframe
 *   do a full page reload, and the wujie runtime inside the sandbox is lost with it. At that point:
 *     - the page still shows the DOM from the last render (looks unbroken — the easiest thing to misjudge)
 *     - iframe.contentWindow.__WUJIE becomes undefined
 *     - from then on HMR messages, bus.emit and route sync all stop working
 *     - only refreshApp can recover
 *
 * So this is not a "nice-to-have hint": it turns this class of **silent failure** into something observable.
 */

/**
 * @typedef {object} Health
 * @property {string} name
 * @property {'alive'|'missing'|'unreachable'|'not-mounted'} state
 * @property {string|null} detail
 */

/**
 * Check one sub-app's sandbox state.
 *
 * @param {string} name  wujie instance name, which is also the iframe's name attribute
 * @returns {Health}
 */
export function checkSandbox(name, doc = globalThis.document) {
  const iframe = doc?.querySelector?.(`iframe[name="${name}"]`);
  if (!iframe) {
    return { name, state: 'not-mounted', detail: '还没挂载（未启动或已 unmount）' };
  }
  let win;
  try {
    win = iframe.contentWindow;
  } catch (e) {
    return { name, state: 'unreachable', detail: `跨域，读不到 contentWindow: ${e.message}` };
  }
  if (!win) {
    return { name, state: 'unreachable', detail: 'contentWindow 为 null' };
  }
  if (!win.__WUJIE) {
    return {
      name,
      state: 'missing',
      detail: 'sandbox 丢失：iframe 被整页 reload 过（多半是子应用改入口触发 full-reload）',
    };
  }
  return { name, state: 'alive', detail: null };
}

/** Batch check; only needs the list of remote names. */
export function checkAll(names, doc = globalThis.document) {
  return names.map((n) => checkSandbox(n, doc));
}

/** Unhealthy as soon as any one of them is not alive (and is mounted). */
export function isHealthy(healths) {
  return healths.every((h) => h.state === 'alive' || h.state === 'not-mounted');
}

/**
 * Poll health; call back when missing is found (used to pop up the "click to recover" badge).
 * Returns stop().
 *
 * Why polling instead of listening for events: a full-reload happens inside the sandbox and no
 * event is observable from the main app; polling is the only approach that does not depend on
 * wujie internals, and its cost is negligible (reading one property).
 *
 * @param {string[]} names
 * @param {(bad: Health[]) => void} onUnhealthy
 * @param {{intervalMs?: number, doc?: Document}} opts
 */
export function watchSandbox(names, onUnhealthy, opts = {}) {
  const interval = opts.intervalMs ?? 1000;
  const doc = opts.doc ?? globalThis.document;
  let stopped = false;
  let lastSignature = '';

  const tick = () => {
    if (stopped) return;
    const healths = checkAll(names, doc);
    const bad = healths.filter((h) => h.state === 'missing' || h.state === 'unreachable');
    // Dedupe: don't fire the callback every second for the same bad state
    const sig = bad.map((b) => `${b.name}:${b.state}`).join('|');
    if (sig !== lastSignature) {
      lastSignature = sig;
      if (bad.length) onUnhealthy(bad, healths);
    }
  };

  const timer = globalThis.setInterval(tick, interval);
  tick();
  return () => {
    stopped = true;
    globalThis.clearInterval(timer);
  };
}

/**
 * Recover: refreshApp destroys the iframe and shadowRoot and rebuilds them (documented; the
 * screen may flash blank briefly). That is why a badge lets **a human** decide when to recover
 * instead of auto-rebuilding (auto-rebuild interrupts whatever is being viewed).
 *
 * @param {{refreshApp: Function}} wujie  the wujie module object (import * as W from 'wujie')
 * @param {Array<{name: string, url: string, el: string|HTMLElement}>} targets
 */
export async function recover(wujie, targets) {
  if (typeof wujie?.refreshApp !== 'function') {
    throw new Error('wujie.refreshApp 不可用：wujie 必须 >= 2.0.0');
  }
  return Promise.all(targets.map((t) => wujie.refreshApp(t)));
}
