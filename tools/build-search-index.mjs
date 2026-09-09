#!/usr/bin/env node
/**
 * Builds data/search-index.json for the site search.
 *
 *   node tools/build-search-index.mjs
 *
 * WHAT GOES IN — and what must never
 * Only pages listed in PAGES that are indexable. VE_PAGES are excluded
 * explicitly, and so is anything carrying noindex. That matters more than it
 * looks: the search index is a plain JSON file served to every visitor, so
 * anything that reaches it is public regardless of how the page itself is
 * protected. The VE pages hold only ciphertext, but their plaintext sources sit
 * in _ve-source/ and must never be read by this tool.
 *
 * The index is built from the BUILT pages, never from _ve-source/.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PAGES, VE_PAGES, SITE } from './site-data.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const VE = new Set(VE_PAGES);

const ENT = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&copy;': '(c)', '&mdash;': '—', '&ndash;': '–',
  '&rsquo;': '’', '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”', '&hellip;': '…' };

function decode(s) {
  for (const [k, v] of Object.entries(ENT)) s = s.split(k).join(v);
  return s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}

/** Visible text of the page body, with chrome stripped. */
function bodyText(html) {
  const a = html.search(/<div\s+class=["']container["']/i);
  const b = html.search(/<footer\b/i);
  let s = a === -1 || b === -1 || b <= a ? html : html.slice(a, b);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
       .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
       .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
       .replace(/<[^>]+>/g, ' ');
  s = decode(s).replace(/\s+/g, ' ').trim();
  // "Main Content" is an invisible heading left by the old template; it is not
  // page content and turned up inside search snippets.
  return s.replace(/^Main Content\s*/i, '').replace(/\s*Main Content\s*/gi, ' ').trim();
}

function headings(html) {
  const a = html.search(/<div\s+class=["']container["']/i);
  const b = html.search(/<footer\b/i);
  const body = a === -1 || b === -1 || b <= a ? html : html.slice(a, b);
  const out = [];
  for (const m of body.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const t = decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (t && t.length < 120 && !/^main content$/i.test(t)) out.push(t);
  }
  return [...new Set(out)].slice(0, 12);
}

const docs = [];
let skippedVe = 0, skippedNoindex = 0;

for (const [rel, meta] of Object.entries(PAGES)) {
  if (VE.has(rel)) { skippedVe++; continue; }          // belt
  if (meta.noindex) { skippedNoindex++; continue; }     // and braces
  const file = join(ROOT, rel);
  if (!existsSync(file)) continue;
  const html = readFileSync(file, 'utf8');
  if (html.includes('ve-payload')) { skippedVe++; continue; }  // and a third check
  const text = bodyText(html);
  if (!text) continue;
  docs.push({
    u: '/' + rel.replace(/\\/g, '/'),
    t: meta.title,
    d: meta.desc || '',
    h: headings(html),
    b: text,
  });
}

// A last guard: no document may contain exam-script phrasing.
const LEAK = /All bracketed text is VE instruction|DO NOT READ|force quit which is/i;
const leaked = docs.filter((d) => LEAK.test(d.b));
if (leaked.length) {
  console.error('REFUSING to write: VE script text found in ' + leaked.map((d) => d.u).join(', '));
  process.exit(1);
}

mkdirSync(join(ROOT, 'data'), { recursive: true });
const payload = { built: new Date().toISOString(), docs };
writeFileSync(join(ROOT, 'data', 'search-index.json'), JSON.stringify(payload));

const bytes = JSON.stringify(payload).length;
console.log(`search index: ${docs.length} pages, ${(bytes / 1024).toFixed(0)} KB`);
console.log(`  excluded: ${skippedVe} VE page(s), ${skippedNoindex} noindex page(s)`);
