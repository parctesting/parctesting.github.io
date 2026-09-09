#!/usr/bin/env node
/**
 * Rewrites the chrome (head, header, nav, footer) of every page from
 * tools/site-data.mjs, leaving page content untouched.
 *
 * THE CONTRACT: everything between <div class="container"> and <footer> is
 * copied through byte-for-byte. The exam scripts are read aloud during live FCC
 * sessions; this tool must never edit a word of them. tools/check-content.mjs
 * verifies that contract held.
 *
 *   node tools/retheme.mjs          # rewrite all pages
 *   node tools/retheme.mjs --dry    # report only
 *   node tools/retheme.mjs index.html pages/faq.html
 */
import { readFileSync, writeFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { PAGES, VE_PAGES, DELETE_PAGES } from './site-data.mjs';
import { organizationSchema, faqSchema } from './schema.mjs';
import { buildHead, buildHeader, buildFooter, link } from './chrome.mjs';

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const VE = new Set(VE_PAGES);

/* ---------- content zone -------------------------------------------------- */
/** Everything the retheme pass must copy through untouched. */
function extractContent(html) {
  const start = html.search(/<div\s+class=["']container["']/i);
  const end = html.search(/<footer\b/i);
  if (start === -1 || end === -1 || end <= start) return null;

  let zone = html.slice(start, end);

  // 21 script pages embed an identical 35-line <style> block re-declaring
  // .dropbtn/.dropdown rules that css/site.css already owns (and carrying a
  // "background-color: #black" typo). Stripping it changes no text, so the
  // content-integrity check still passes.
  zone = zone.replace(/[ \t]*<style\b[^>]*>[\s\S]*?<\/style>\s*/gi, '');

  // Make extraction IDEMPOTENT.
  //
  // On an already-rethemed page the span from <div class="container"> to
  // <footer> ends with the </main> this tool emitted last time. Absorbing it
  // into "content" and then emitting another </main> in the footer left every
  // page with 2-4 stray closers after a few runs. Strip any chrome tags that
  // belong to us before treating the rest as page content.
  zone = zone.replace(/<\/?main\b[^>]*>/gi, '');
  zone = zone.replace(/<h1\s+class=["']sr-only["'][^>]*>[\s\S]*?<\/h1>/i, '');

  // Drop the trailing wrapper the old template opened just before <footer>.
  zone = zone.replace(/<div\s+class=["']row["']\s*>\s*$/i, '');
  zone = zone.replace(/(?:\s|<br\s*\/?>)+$/i, '');

  // The old markup closed .container AFTER the footer. Rebalance so the
  // container closes inside <main>, where it belongs.
  const opens = (zone.match(/<div[\s>]/gi) || []).length;   // <div1> must not match
  const closes = (zone.match(/<\/div>/gi) || []).length;
  if (opens > closes) zone += '\n' + '</div>'.repeat(opens - closes);

  return zone.trimEnd() + '\n';
}

/* ---------- driver -------------------------------------------------------- */
function metaFor(rel) {
  // VE pages are OUTPUT of tools/parc-lock.mjs, not source. Regenerating one
  // here would overwrite its ciphertext payload with an empty unlock form —
  // the page would then never unlock and the encrypted content would be gone
  // from pages/. Always rebuild them with parc-lock.mjs instead.
  if (VE.has(rel)) return null;
  const meta = PAGES[rel];
  if (!meta) return null;
  if (meta.schema === 'organization') meta.schemaJson = organizationSchema();
  if (meta.schema === 'faq') meta.schemaJson = faqSchema(join(ROOT, rel));
  return meta;
}

function retheme(rel, dry) {
  const abs = join(ROOT, rel);
  const html = readFileSync(abs, 'utf8');
  const meta = metaFor(rel);
  if (VE.has(rel)) return { rel, status: 'skipped (encrypted — rebuild with parc-lock.mjs)' };
  if (!meta) return { rel, status: 'skipped (no metadata)' };

  let content = extractContent(html);
  // Page bodies also carry a few site-absolute links; make them relative so the
  // build works at a subpath too. Protocol-relative and external URLs untouched.
  if (content) {
    content = content.replace(/(href|src)="(\/[^\/"][^"]*)"/g,
      (m, attr, path) => `${attr}="${link(rel, path)}"`);
  }
  if (!content) return { rel, status: 'SKIPPED — no <div class="container"> / <footer> markers' };

  // Exactly one <h1> per page, carrying the page's real subject. Rendered
  // visually hidden where the page body already shows its own title, so this
  // changes semantics and search signal without changing the design.
  const hasH1 = /<h1\b/i.test(content);
  const pageH1 = hasH1 ? '' :
    `<h1 class="sr-only">${esc(meta.h1 || meta.title)}</h1>\n`;

  const out = `<!doctype html>
<html lang="en">
<head>
${buildHead(rel, meta)}
</head>
<body>

${buildHeader(rel)}
${pageH1}
${content}
${buildFooter(rel)}

<script src="${link(rel, '/js/site.js')}" defer></script>
<script src="${link(rel, '/js/search.js')}" defer></script>
${(meta.scripts || []).map((s) => `<script src="${link(rel, s)}" defer></script>`).join('\n')}
</body>
</html>
`;
  if (!dry) writeFileSync(abs, out);
  return { rel, status: 'ok', before: html.length, after: out.length };
}

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const explicit = args.filter((a) => !a.startsWith('--'));

const walk = (d, a = []) => {
  for (const n of readdirSync(d)) {
    if (n === '.git' || n === '.baseline' || n === 'node_modules' || n === '_ve-source') continue;
    const f = join(d, n);
    statSync(f).isDirectory() ? walk(f, a) : n.endsWith('.html') && a.push(relative(ROOT, f));
  }
  return a;
};

if (!dry && !explicit.length) {
  for (const rel of DELETE_PAGES) {
    const abs = join(ROOT, rel);
    if (existsSync(abs)) { rmSync(abs); console.log(`deleted  ${rel}`); }
  }
  for (const d of ['pages/GOV SHUTDOWN', 'pages/Update']) {
    const abs = join(ROOT, d);
    if (existsSync(abs) && readdirSync(abs).length === 0) { rmSync(abs, { recursive: true }); console.log(`deleted  ${d}/`); }
  }
}

const targets = explicit.length ? explicit : walk(ROOT).sort();
let ok = 0, skipped = [];
for (const rel of targets) {
  if (DELETE_PAGES.includes(rel)) continue;
  const r = retheme(rel, dry);
  if (r.status === 'ok') ok++; else skipped.push(`${r.rel}: ${r.status}`);
}
console.log(`\nrethemed: ${ok} page(s)${dry ? ' (dry run)' : ''}`);
if (skipped.length) console.log('skipped:\n  ' + skipped.join('\n  '));
