#!/usr/bin/env node
/**
 * Gives every page exactly one <h1>, without changing how any page looks.
 *
 * The old template used <h1> as a "big red centred heading" style, so pages
 * ended up with four or five of them while others had none at all. That breaks
 * screen-reader navigation (the H-key jumps between section headings) and
 * wastes the strongest on-page signal a search engine reads.
 *
 * Two moves, both visually identical to what is there now:
 *   - content <h1> becomes <h2 class="page-section">, styled to match the old h1
 *   - tools/retheme.mjs injects a visually-hidden <h1> from site-data metadata
 *
 * Pages that already have exactly one <h1> (the ones written by hand: home,
 * schedule, FAQ, donations, 404) are left completely alone.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAGES } from './site-data.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const zone = (h) => {
  const a = h.search(/<div\s+class=["']container["']/i);
  const b = h.search(/<footer\b/i);
  return a === -1 || b === -1 || b <= a ? null : [a, b];
};

let demoted = 0, touched = 0, skipped = [];
for (const rel of Object.keys(PAGES)) {
  const file = join(ROOT, rel);
  let html;
  try { html = readFileSync(file, 'utf8'); } catch { continue; }
  const z = zone(html);
  if (!z) continue;
  const body = html.slice(z[0], z[1]);
  const count = (body.match(/<h1\b/gi) || []).length;

  if (count === 1) { skipped.push(rel); continue; }   // already correct
  if (count === 0) { touched++; continue; }           // retheme adds the hidden h1

  const fixed = body
    .replace(/<h1\b([^>]*)>/gi, (m, attrs) =>
      /class=/i.test(attrs)
        ? `<h2${attrs.replace(/class="([^"]*)"/i, 'class="$1 page-section"')}>`
        : `<h2 class="page-section"${attrs}>`)
    .replace(/<\/h1>/gi, '</h2>');
  demoted += count;
  touched++;
  writeFileSync(file, html.slice(0, z[0]) + fixed + html.slice(z[1]));
}
console.log(`demoted ${demoted} content <h1> to <h2 class="page-section">`);
console.log(`${touched} page(s) will receive a hidden <h1> from metadata`);
console.log(`${skipped.length} page(s) already had exactly one <h1>, left alone`);
