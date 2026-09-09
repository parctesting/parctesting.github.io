#!/usr/bin/env node
/**
 * Repairs malformed markup in the VE exam scripts.
 *
 *   node tools/fix-ve-markup.mjs [--dry]
 *
 * THREE DEFECTS, ALL PRE-EXISTING EXCEPT THE FIRST
 *
 * 1. Duplicated </main>. Introduced by re-running tools/retheme.mjs over
 *    already-rethemed pages; harmless to browsers, invalid HTML.
 *
 * 2. A stray <h8> typed INSIDE the <strong> that labels the force-quit steps:
 *      <li><strong><h8>For a Mac computer:</strong>
 *    It is never closed. The parent <strong>/<li> ends up bounding it, so the
 *    damage does not run down the page — but the LABEL ITSELF renders in the red
 *    that these scripts reserve for "VE instruction, do not read aloud". The
 *    examiner is supposed to say "For a Mac computer:" out loud; it is the line
 *    that tells the candidate which branch applies to them. script.html (the
 *    correct version) has no <h8> there at all, so the fix is to delete it.
 *
 * 3. Stray closing tags (</h5>, </h4>) with no matching opener, left over from
 *    hand-editing. Removing them changes nothing visually.
 *
 * Heading and body TEXT are never touched — verified by tools/check-content.mjs.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SRC = join(ROOT, '_ve-source');
const DRY = process.argv.includes('--dry');

/** Remove closing heading tags that have no opener still on the stack. */
function dropStrayClosers(html) {
  const stack = [];
  const drop = [];
  const re = /<\/?h([1-8])\b[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const lvl = m[1];
    if (m[0][1] !== '/') { stack.push(lvl); continue; }
    const i = stack.lastIndexOf(lvl);
    if (i === -1) drop.push([m.index, m[0].length]);
    else stack.splice(i, 1);
  }
  let out = html;
  for (const [pos, len] of drop.reverse()) out = out.slice(0, pos) + out.slice(pos + len);
  return { html: out, removed: drop.length };
}

let files = [];
try { files = readdirSync(SRC).filter((n) => n.endsWith('.html')).map((n) => join(SRC, n)); } catch {}

let tMain = 0, tH8 = 0, tStray = 0;
const report = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  let out = src;
  let nMain = 0, nH8 = 0;

  // 1. collapse duplicated </main>
  out = out.replace(/(<\/main>\s*)+(<\/main>)/gi, (m, _a, last) => {
    nMain += (m.match(/<\/main>/gi) || []).length - 1;
    return last;
  });

  // 2. delete the stray <h8> inside the <strong> label
  out = out.replace(/(<strong>)\s*<h8\b[^>]*>(\s*(?:For a Mac computer|If using a PC))/gi,
    (m, strong, label) => { nH8++; return strong + label; });

  // 3. drop closers with no opener
  const { html: cleaned, removed } = dropStrayClosers(out);
  out = cleaned;

  if (out !== src) {
    tMain += nMain; tH8 += nH8; tStray += removed;
    report.push(`${f.replace(ROOT + '/', '')}: ${nMain} </main>, ${nH8} stray <h8>, ${removed} stray closer(s)`);
    if (!DRY) writeFileSync(f, out);
  }
}
console.log(`${report.length} file(s) repaired${DRY ? ' (dry run)' : ''}: ` +
            `${tMain} duplicate </main>, ${tH8} stray <h8>, ${tStray} stray closing tag(s)`);
report.forEach((r) => console.log('  ' + r));
