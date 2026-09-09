#!/usr/bin/env node
/**
 * Rewrites site-absolute paths in _ve-source/*.html to relative ones.
 *
 * These files are decrypted and swapped into the document wholesale by
 * js/ve-lock.js, so their links and assets must resolve the same way the rest
 * of the site does. They always render at pages/<name>.html, one level below
 * the site root, so the prefix is always "../".
 *
 * Without this a decrypted script page loads "/css/site.css", which is correct
 * at parcradio.net but wrong wherever the site is served from a subpath —
 * exactly the case a fork's GitHub Pages preview creates.
 *
 *   node tools/relativize-ve-source.mjs [--dry]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SRC = join(ROOT, '_ve-source');
const DRY = process.argv.includes('--dry');

let files = [];
try { files = readdirSync(SRC).filter((n) => n.endsWith('.html')); } catch {}

let total = 0, touched = 0;
for (const name of files) {
  const f = join(SRC, name);
  const src = readFileSync(f, 'utf8');
  let n = 0;
  // Leading "//" is protocol-relative and must be left alone.
  const out = src.replace(/(href|src)="\/([^\/"][^"]*)"/g, (m, attr, path) => {
    n++;
    return `${attr}="../${path}"`;
  });
  if (n) {
    total += n; touched++;
    if (!DRY) writeFileSync(f, out);
  }
}
console.log(`${total} path(s) made relative across ${touched} file(s)${DRY ? ' (dry run)' : ''}`);
