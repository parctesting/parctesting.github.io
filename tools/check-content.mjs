#!/usr/bin/env node
/**
 * Content-integrity guard for the PARC site rewrite.
 *
 * The exam scripts are operational documents read aloud during a live FCC exam
 * session. The facelift rewrites every page's head/nav/header/footer, and this
 * tool exists to prove it changed nothing else. A dropped sentence in a script
 * is a real-world problem, not a cosmetic one.
 *
 *   node tools/check-content.mjs snapshot .baseline
 *   node tools/check-content.mjs verify   .baseline
 *
 * To compare against the site as it was BEFORE this work, use the tag:
 *   git show pre-facelift-2026-08-22:pages/script.html
 * Comparing against HEAD is meaningless for VE pages — those hold ciphertext
 * now; their plaintext lives in the gitignored _ve-source/.
 *
 * "Content zone" = everything from <div class="container"> up to the <footer>.
 * That is the region the retheme pass must never touch.
 */
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

function htmlFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name === '.baseline') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) htmlFiles(full, acc);
    else if (name.endsWith('.html')) acc.push(full);
  }
  return acc;
}

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&copy;': '(c)', '&mdash;': '-', '&ndash;': '-',
  '&rsquo;': "'", '&lsquo;': "'", '&ldquo;': '"', '&rdquo;': '"', '&hellip;': '...',
};

/** Visible text of an HTML fragment, whitespace-normalised for stable diffing. */
function textOf(html) {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  // Keep link targets: a lost href is a content change even if the text survives.
  s = s.replace(/<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>/gi, (_m, href) => ` [->${href}] `);
  s = s.replace(/<img\b[^>]*?src\s*=\s*["']([^"']*)["'][^>]*>/gi, (_m, src) => ` [img:${src}] `);
  s = s.replace(/<[^>]+>/g, ' ');
  for (const [ent, ch] of Object.entries(ENTITIES)) s = s.split(ent).join(ch);
  s = s.replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(+d));
  return s.replace(/\s+/g, ' ').trim();
}

/** The region the retheme pass is forbidden to modify. */
function contentZone(html) {
  const start = html.search(/<div\s+class=["']container["']/i);
  const end = html.search(/<footer\b/i);
  if (start === -1 || end === -1 || end <= start) {
    const b = html.search(/<body\b/i);
    return b === -1 ? html : html.slice(b);
  }
  return html.slice(start, end);
}

const [, , cmd, dirArg] = process.argv;
const OUT = join(ROOT, dirArg || '.baseline');

if (cmd === 'snapshot') {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true });
  let n = 0;
  for (const f of htmlFiles(ROOT).sort()) {
    const rel = relative(ROOT, f);
    const dest = join(OUT, rel + '.txt');
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, textOf(contentZone(readFileSync(f, 'utf8'))) + '\n');
    n++;
  }
  console.log(`snapshot: ${n} pages -> ${relative(ROOT, OUT)}/`);
} else if (cmd === 'verify') {
  if (!existsSync(OUT)) { console.error(`no baseline at ${OUT}; run snapshot first`); process.exit(2); }
  const changed = [], missing = [], added = [];
  const seen = new Set();
  for (const f of htmlFiles(ROOT).sort()) {
    const rel = relative(ROOT, f);
    seen.add(rel);
    const base = join(OUT, rel + '.txt');
    if (!existsSync(base)) { added.push(rel); continue; }
    const before = readFileSync(base, 'utf8').trim();
    const after = textOf(contentZone(readFileSync(f, 'utf8')));
    if (before !== after) changed.push({ rel, before, after });
  }
  const walkBase = (d, acc = []) => {
    if (!existsSync(d)) return acc;
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walkBase(full, acc);
      else acc.push(relative(OUT, full).replace(/\.txt$/, ''));
    }
    return acc;
  };
  for (const rel of walkBase(OUT)) if (!seen.has(rel)) missing.push(rel);

  for (const { rel, before, after } of changed) {
    console.log(`\n=== BODY CHANGED: ${rel}`);
    // Show the first divergence with a little context on each side.
    let i = 0; while (i < before.length && i < after.length && before[i] === after[i]) i++;
    console.log(`  at char ${i} (len ${before.length} -> ${after.length})`);
    console.log(`  before: ...${before.slice(Math.max(0, i - 60), i + 120)}`);
    console.log(`  after : ...${after.slice(Math.max(0, i - 60), i + 120)}`);
  }
  if (missing.length) console.log(`\nPAGES REMOVED (${missing.length}):\n  ` + missing.join('\n  '));
  if (added.length) console.log(`\nPAGES ADDED (${added.length}):\n  ` + added.join('\n  '));

  const failOnBody = process.argv.includes('--fail-on-body-change');
  if (changed.length === 0) console.log(`\nOK: content zone identical across ${seen.size} pages.`);
  else console.log(`\n${changed.length} page(s) changed inside the content zone.`);
  if (failOnBody && changed.length) process.exit(1);
} else {
  console.error('usage: check-content.mjs <snapshot|verify> [dir] [--fail-on-body-change]');
  process.exit(2);
}
