#!/usr/bin/env node
/**
 * Repairs mismatched heading close tags: <h3>…</h7>, <h5>…</h4>, and friends.
 *
 * The old pages were built by copy-paste and 75 headings across 18 public pages
 * open as <h3> and close as </h7>. Browsers paper over it (a heading implicitly
 * closes the one before), so nothing looked broken — but the document outline is
 * garbage, which breaks screen-reader navigation, and any tool that walks
 * headings by matching tags reads wildly wrong spans. It made an earlier attempt
 * at repairing heading LEVELS produce nonsense.
 *
 * Only the close tag's number changes. No text, no attributes, no nesting.
 *
 *   node tools/fix-heading-tags.mjs [--dry]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DRY = process.argv.includes('--dry');

const files = [];
for (const dir of [join(ROOT, 'pages'), join(ROOT, '_ve-source'), ROOT]) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
  for (const e of entries) if (e.isFile() && e.name.endsWith('.html')) files.push(join(dir, e.name));
}

let totalFixed = 0;
const report = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  let fixed = 0;

  // Pair each heading opener with the first heading closer that follows it,
  // provided no other heading opens in between. If the numbers disagree, the
  // closer is the typo — rewrite it to match the opener.
  const out = src.replace(
    /<h([1-8])\b([^>]*)>((?:(?!<h[1-8]\b)[\s\S])*?)<\/h([1-8])>/g,
    (m, open, attrs, inner, close) => {
      if (open === close) return m;
      fixed++;
      return `<h${open}${attrs}>${inner}</h${open}>`;
    });

  if (fixed) {
    totalFixed += fixed;
    report.push(`${f.replace(ROOT + '/', '')}: ${fixed}`);
    if (!DRY) writeFileSync(f, out);
  }
}
console.log(`${totalFixed} mismatched heading close tag(s) repaired across ${report.length} file(s)` +
            (DRY ? ' (dry run)' : ''));
report.forEach((r) => console.log('  ' + r));
