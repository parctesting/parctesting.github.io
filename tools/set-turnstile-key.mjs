#!/usr/bin/env node
/**
 * Puts the Cloudflare Turnstile site key into the reviews page.
 *
 *   node tools/set-turnstile-key.mjs 0x4AAAAAAA...
 *   node tools/set-turnstile-key.mjs --clear
 *
 * The SITE key is public and belongs in the markup — it is the half Cloudflare
 * expects the browser to send. The SECRET key is the other half and goes into
 * the Worker as TURNSTILE_SECRET; it must never be committed.
 *
 * With no key set the page never loads Turnstile at all, and the Worker accepts
 * submissions without a token, so the form keeps working while it is being set
 * up. Configure both halves to actually enforce the check.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PAGES = [
  join(ROOT, 'pages', 'reviews.html'),
  join(ROOT, '_ve-source', 'team-submit.html'),
];
const arg = process.argv[2];

if (!arg) {
  console.error('usage: node tools/set-turnstile-key.mjs <site-key> | --clear');
  process.exit(2);
}

const key = arg === '--clear' ? '' : arg.trim();

/* Live site keys look like 0x4AAAAAAA…; Cloudflare's documented test keys start
   1x, 2x or 3x. Refuse anything else rather than commit a typo. */
if (key && !/^[0-3]x[A-Za-z0-9_-]{10,40}$/.test(key)) {
  console.error(`Refusing: "${key}" does not look like a Turnstile site key.`);
  console.error('Expected something like 0x4AAAAAAABBBBBBBBCCCCCC (Dashboard → Turnstile → your widget).');
  process.exit(1);
}

/* Both halves start 0x4AAAAAAA and the only easy tell is length — the secret is
   noticeably longer. Committing it would publish it, so stop rather than guess. */
if (key.length > 30) {
  console.error(`Refusing: "${key}" is ${key.length} characters, which is secret-key length.`);
  console.error('The SITE key is the shorter one. The secret goes in the Worker, never here.');
  process.exit(1);
}

for (const file of PAGES) {
  if (!existsSync(file)) continue;
  const before = readFileSync(file, 'utf8');
  /* Absent is an error; already-correct is not. Comparing before and after
     conflated the two, so re-running with the same key looked like a missing
     attribute and stopped the run before it reached the other pages. */
  if (!/data-turnstile-sitekey="/.test(before)) {
    console.error(`Could not find data-turnstile-sitekey in ${file}.`);
    process.exit(1);
  }
  writeFileSync(file, before.replace(/(data-turnstile-sitekey=")[^"]*(")/, `$1${key}$2`));
  console.log(`  set in ${file.split('/').slice(-2).join('/')}`);
}

console.log(key ? `Site key set: ${key}` : 'Site key cleared.');
console.log('\nThe other half goes in the Worker, not here:');
console.log('  Workers & Pages → parc-reviews → Settings → Variables and Secrets');
console.log('  Add a secret named TURNSTILE_SECRET\n');
console.log('Then rebuild and deploy:  node tools/deploy.mjs --push');
