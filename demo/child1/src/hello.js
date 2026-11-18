// Edit the text here to verify HMR: the host should show the change without a page reload
export const LABEL = 'child-A v1';

export function render(el) {
  el.innerHTML = '';
  const h = document.createElement('h3');
  h.textContent = LABEL;
  const p = document.createElement('p');
  p.textContent = '（改 src/hello.js 的 LABEL 验证热更）';
  el.append(h, p);
}
