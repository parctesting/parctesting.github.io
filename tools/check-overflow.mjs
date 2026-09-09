#!/usr/bin/env node
/**
 * Catches horizontal page overflow at phone width across every page.
 *
 * The workflow buttons on the Online_* pages sat inside layout <table>s, which
 * cannot wrap — so on a phone the row ran off the right edge and the page
 * scrolled sideways. Eyeballing screenshots missed it; measuring does not.
 *
 * Needs the preview server running:  python3 -m http.server 8088
 *   node tools/check-overflow.mjs [width]
 *
 * Works by serving a throwaway probe page that loads each page in a
 * viewport-width iframe and compares scrollWidth to clientWidth. Same origin,
 * so the probe can read the inner document.
 */
import { readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const WIDTH = Number(process.argv[2]) || 390;
const BASE = `http://127.0.0.1:8088`;
const PROBE = join(ROOT, '__overflow-probe.html');

const walk = (d, a = []) => {
  for (const n of readdirSync(d)) {
    if (['.git', '.baseline', 'node_modules', 'design', '_ve-source', 'tools', 'worker', 'data'].includes(n)) continue;
    const f = join(d, n);
    statSync(f).isDirectory() ? walk(f, a) : (n.endsWith('.html') && !n.startsWith('__')) && a.push(relative(ROOT, f));
  }
  return a;
};

const pages = walk(ROOT).sort();
writeFileSync(PROBE, `<!doctype html><meta charset="utf-8">
<body><div id="out">pending</div><script>
var pages = ${JSON.stringify(pages)};
var W = ${WIDTH};
var results = [];
// Write after every page, so a virtual-time timeout still yields partial data
// instead of an empty result.
function flush() { document.getElementById('out').textContent = JSON.stringify(results); }
function next(i) {
  if (i >= pages.length) { flush(); return; }
  var f = document.createElement('iframe');
  f.style.cssText = 'width:' + W + 'px;height:800px;border:0;position:absolute;left:-9999px';
  f.src = '/' + pages[i];
  f.onload = function () {
    try {
      var d = f.contentDocument.documentElement;
      results.push([pages[i], d.scrollWidth, d.clientWidth]);
    } catch (e) { results.push([pages[i], -1, -1]); }
    flush();
    f.remove();
    next(i + 1);
  };
  f.onerror = function () { results.push([pages[i], -1, -1]); flush(); f.remove(); next(i + 1); };
  document.body.appendChild(f);
}
next(0);
</script></body>`);

let dom = '';
try {
  dom = execFileSync('chromium', [
    '--headless=old', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--disable-extensions',
    `--window-size=${WIDTH + 40},900`, '--virtual-time-budget=240000',
    '--dump-dom', `${BASE}/__overflow-probe.html`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 5e7 });
} finally {
  rmSync(PROBE, { force: true });
}

const m = dom.match(/<div id="out">(\[.*?\])<\/div>/s);
if (!m) { console.error('probe produced no result (is the server on :8088?)'); process.exit(2); }
const rows = JSON.parse(m[1]);
const bad = rows.filter(([, sw, cw]) => sw > 0 && sw > cw + 1);
const failed = rows.filter(([, sw]) => sw === -1);

console.log(`measured ${rows.length} of ${pages.length} pages at ${WIDTH}px viewport`);
if (failed.length) console.log(`  (${failed.length} could not be measured)`);
if (bad.length) {
  console.log(`\nHORIZONTAL OVERFLOW (${bad.length}):`);
  bad.sort((a, b) => (b[1] - b[2]) - (a[1] - a[2]))
     .forEach(([p, sw, cw]) => console.log(`  ${p}  content ${sw}px in ${cw}px viewport  (+${sw - cw})`));
  process.exit(1);
}
console.log('no horizontal overflow');
