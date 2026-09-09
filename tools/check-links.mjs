#!/usr/bin/env node
/** Resolves every internal href/src across the published site and reports misses. */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const walk = (d, a = []) => {
  for (const n of readdirSync(d)) {
    if (['.git', '.baseline', 'node_modules', 'design', '_ve-source', '__preview'].includes(n)) continue;
    const f = join(d, n);
    statSync(f).isDirectory() ? walk(f, a) : n.endsWith('.html') && a.push(f);
  }
  return a;
};

const bad = [];
let checked = 0;
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  const html = readFileSync(file, 'utf8');
  for (const m of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
    let url = m[1].trim();
    if (/^(https?:|mailto:|tel:|data:|blob:|javascript:|#)/i.test(url) || !url) continue;
    const clean = decodeURIComponent(url.split('#')[0].split('?')[0]);
    if (!clean) continue;
    checked++;
    const target = clean.startsWith('/')
      ? join(ROOT, clean)
      : resolve(dirname(file), clean);
    if (!existsSync(target)) bad.push(`${rel}  ->  ${url}`);
  }
}
console.log(`checked ${checked} internal links across the published site`);
if (bad.length) { console.log(`\nBROKEN (${bad.length}):`); bad.forEach((b) => console.log('  ' + b)); process.exit(1); }
else console.log('no broken internal links');
