#!/usr/bin/env node
/**
 * Repairs skipped heading levels (h2 straight to h5, h1 straight to h6, …).
 *
 *   node tools/fix-headings-deep.mjs --preview   # writes __preview/ copies only
 *   node tools/fix-headings-deep.mjs             # applies in place
 *
 * WHY IT MATTERS
 * Screen-reader users navigate by heading level; a jump from h2 to h5 reads as
 * three missing sections. Search engines use the same outline to work out how a
 * page is organised.
 *
 * TWO CHANGES, NEITHER VISIBLE
 *
 * 1. Delete `<h2 class="noDisplay">Main Content</h2>`. It is invisible template
 *    cruft from the old Dreamweaver page, it says nothing, and on three pages it
 *    sits ABOVE the real <h1>, which is why those outlines start at h2.
 *
 * 2. Promote any heading that jumps more than one level to exactly one level
 *    below its parent — carrying a class that reproduces its old appearance, so
 *    an <h5> that becomes an <h3> still renders in the same red at the same size.
 *    The old template used heading levels as font styles rather than structure,
 *    so this separates the two without redesigning anything.
 *
 * Heading TEXT is never touched.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { PAGES } from './site-data.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PREVIEW = process.argv.includes('--preview');
const OUT = join(ROOT, '__preview');

const zone = (h) => {
  const a = h.search(/<div\s+class=["']container["']/i);
  const b = h.search(/<footer\b/i);
  return a === -1 || b === -1 || b <= a ? null : [a, b];
};

function repair(body) {
  // 1. drop the meaningless hidden heading
  let out = body.replace(/\s*<h2\s+class=["']noDisplay["']\s*>\s*Main Content\s*<\/h2>/gi, '');

  // 2. walk the outline and pull orphaned levels up
  const parts = [];
  const re = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;
  let last = 0, m, prev = 0, changes = 0;
  while ((m = re.exec(out)) !== null) {
    const [full, lvlStr, attrs, inner] = m;
    const lvl = Number(lvlStr);
    let target = lvl;
    if (prev && lvl > prev + 1) target = prev + 1;   // close the gap
    parts.push(out.slice(last, m.index));
    if (target !== lvl) {
      // Keep the old look: hx-N reproduces what h<N> used to render as.
      const cls = `hx-${lvl}`;
      const newAttrs = /class="([^"]*)"/i.test(attrs)
        ? attrs.replace(/class="([^"]*)"/i, `class="$1 ${cls}"`)
        : `${attrs} class="${cls}"`;
      parts.push(`<h${target}${newAttrs}>${inner}</h${target}>`);
      changes++;
    } else {
      parts.push(full);
    }
    last = m.index + full.length;
    prev = target;
  }
  parts.push(out.slice(last));
  return { html: parts.join(''), changes };
}

if (PREVIEW && existsSync(OUT)) rmSync(OUT, { recursive: true });

let touched = 0, totalChanges = 0;
const report = [];
for (const rel of Object.keys(PAGES)) {
  const file = join(ROOT, rel);
  let html;
  try { html = readFileSync(file, 'utf8'); } catch { continue; }
  const z = zone(html);
  if (!z) continue;
  const { html: fixed, changes } = repair(html.slice(z[0], z[1]));
  const merged = html.slice(0, z[0]) + fixed + html.slice(z[1]);
  if (merged === html) continue;

  touched++; totalChanges += changes;
  report.push(`${rel}: ${changes} heading level(s) corrected`);
  const dest = PREVIEW ? join(OUT, rel) : file;
  if (PREVIEW) mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, merged);
}
console.log(`${touched} page(s) changed, ${totalChanges} heading level(s) corrected` +
            (PREVIEW ? ` -> __preview/` : ' (applied in place)'));
report.forEach((r) => console.log('  ' + r));
