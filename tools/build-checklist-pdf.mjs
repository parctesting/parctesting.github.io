#!/usr/bin/env node
/**
 * Build Documents/Checklist.pdf from tools/checklist/checklist.html.
 *
 *   node tools/build-checklist-pdf.mjs
 *
 * The PDF used to be exported from a Word file and drifted from the site: it
 * still allowed a separate calculator app, told candidates to pay the exam fee
 * through PayPal (PayPal is only for donations), and referred to three photos it
 * did not contain. The source is now HTML beside this script, using the site's
 * own figures, so a wording change or a new figure is one rebuild.
 *
 * Needs headless Chromium. Nothing is fetched from the network.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SRC = join(ROOT, 'tools', 'checklist', 'checklist.html');
const OUT = join(ROOT, 'Documents', 'Checklist.pdf');
const profile = mkdtempSync(join(tmpdir(), 'parc-pdf-'));

const r = spawnSync('chromium', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files',
  `--user-data-dir=${profile}`, '--no-pdf-header-footer',
  `--print-to-pdf=${OUT}`, `file://${SRC}`,
], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000 });
rmSync(profile, { recursive: true, force: true });

if (r.status !== 0) {
  console.error(String(r.stderr || '').slice(-2000));
  process.exit(1);
}
console.log(`Documents/Checklist.pdf: ${(statSync(OUT).size / 1024).toFixed(0)} KB`);
