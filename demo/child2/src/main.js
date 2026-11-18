import { render } from './hello.js';

const el = document.getElementById('app');
if (el) render(el);
/** hello.js itself has no accept handler; without this boundary its update bubbles up to the
 * entry and turns into a full page reload inside the wujie sandbox — which kills the sandbox. */
if (import.meta.hot) {
  import.meta.hot.accept('./hello.js', (mod) => {
    if (el) mod.render(el);
  });
  import.meta.hot.accept();
}
