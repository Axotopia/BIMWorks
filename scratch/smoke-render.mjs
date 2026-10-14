import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const html = fs.readFileSync('dist/index.html', 'utf8');
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  resources: undefined,          // don't fetch subresources
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:5173/',
  beforeParse(window) {
    // The bundle fetches /api/*, WebGL, ResizeObserver, and fonts.
    window.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
    window.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    window.cancelAnimationFrame = () => {};
    window.matchMedia = () => ({ matches:false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    window.HTMLCanvasElement.prototype.getContext = () => null; // no WebGL in jsdom
    window.addEventListener('error', (e) => {
      console.log('WINDOW ERROR:', e.error?.stack || e.message);
    });
    window.addEventListener('unhandledrejection', (e) => {
      console.log('UNHANDLED REJECTION:', e.reason?.stack || e.reason);
    });
  },
});

// Inject the built bundle as a classic script so we can catch syntax/runtime errors.
const js = fs.readFileSync('dist/assets/index-D63BsnbW.js', 'utf8');
try {
  dom.window.eval(js);
  console.log('BUNDLE EVALUATED without throwing');
} catch (e) {
  console.log('BUNDLE THREW:', e.stack || e);
}
// Give React a tick to render.
await new Promise((r) => setTimeout(r, 1500));
const root = dom.window.document.getElementById('root');
console.log('root children:', root ? root.children.length : 'no #root');
console.log('body text length:', dom.window.document.body.textContent.trim().length);
console.log('first 200 chars:', JSON.stringify(dom.window.document.body.textContent.trim().slice(0, 200)));
