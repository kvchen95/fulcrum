import { render } from './hello.js';

const el = document.getElementById('app');
if (el) render(el);
if (import.meta.hot) import.meta.hot.accept();
