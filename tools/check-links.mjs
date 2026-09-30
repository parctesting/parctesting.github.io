#!/usr/bin/env node
/** Resolves every internal href/src across the published site and reports misses. */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { PAGES, VE_PAGES } from './site-data.mjs';

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

/* The VE scripts are published encrypted, so the loop above cannot see what they
   show. On 2026-09-07 a cleanup deleted images/PAUSE_BANNER.png as unreferenced
   while twelve scripts still displayed it, and it stayed broken for three weeks.
   Where the plaintext is on disk (_ve-source/, never committed), check the scripts'
   own references too, resolved from the address each script is published at. */
const veMissing = new Set();
let veChecked = 0;
const VE_SOURCE = join(ROOT, '_ve-source');
if (existsSync(VE_SOURCE)) {
  for (const rel of VE_PAGES) {
    const src = join(VE_SOURCE, rel.split('/').pop());
    if (!existsSync(src)) continue;
    for (const m of readFileSync(src, 'utf8').matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
      const url = m[1].trim();
      if (!url || /^(https?:|mailto:|tel:|data:|blob:|javascript:|#)/i.test(url)) continue;
      const clean = decodeURIComponent(url.split('#')[0].split('?')[0]);
      if (!clean) continue;
      veChecked++;
      const target = clean.startsWith('/') ? join(ROOT, clean) : resolve(dirname(join(ROOT, rel)), clean);
      if (!existsSync(target)) veMissing.add(`${rel} (VE script)  ->  ${url}`);
    }
  }
  console.log(`checked ${veChecked} links inside the VE scripts`);
} else {
  console.log('_ve-source/ not present: links inside the encrypted VE scripts not checked');
}

/* A link that opens a new tab must say so. Without it a screen reader user lands
   in a tab with no Back history and no idea how they got there. The visible arrow
   comes from css/site.css; this is the spoken half. Public pages only: the locked
   VE shells are rebuilt by parc-lock, which needs the passcode. */
const unannounced = [];
for (const rel of Object.keys(PAGES)) {
  if (rel === 'pages/ve-file.html' || !existsSync(join(ROOT, rel))) continue;
  const html = readFileSync(join(ROOT, rel), 'utf8');
  for (const m of html.matchAll(/<a\b[^>]*target=["']_blank["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (!/opens (Calendly )?in a new tab/.test(m[1])) {
      unannounced.push(`${rel}  ->  ${m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '(image link)'}`);
    }
  }
}

for (const v of veMissing) bad.push(v);
if (bad.length) { console.log(`\nBROKEN (${bad.length}):`); bad.forEach((b) => console.log('  ' + b)); }
else console.log('no broken internal links');
if (unannounced.length) {
  console.log(`\nNEW-TAB LINKS WITHOUT "(opens in a new tab)" (${unannounced.length}):`);
  unannounced.forEach((u) => console.log('  ' + u));
} else console.log('every new-tab link on the public pages is announced');
if (bad.length || unannounced.length) process.exit(1);
