#!/usr/bin/env node
/**
 * Points the reviews page at a deployed reviews Worker, then proves it works.
 *
 *   node tools/set-reviews-url.mjs https://parc-reviews.<you>.workers.dev
 *   node tools/set-reviews-url.mjs --clear
 *
 * The same Worker serves the Our Team page, so this wires up all three places
 * that talk to it: the reviews page, the public team page, and the locked
 * team-submit page in _ve-source. Missing an endpoint is a silent failure, so
 * they are set together rather than one command each.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const TARGETS = [
  [join(ROOT, 'pages', 'reviews.html'),        'data-reviews-endpoint'],
  [join(ROOT, 'pages', 'team.html'),           'data-team-endpoint'],
  [join(ROOT, '_ve-source', 'team-submit.html'), 'data-team-endpoint'],
];
const arg = process.argv[2];

if (!arg) {
  console.error('usage: node tools/set-reviews-url.mjs <worker-url> | --clear');
  process.exit(2);
}

const url = arg === '--clear' ? '' : arg.replace(/\/+$/, '');
/* http is allowed only against loopback, so a local Worker can be tested; a
   real deployment over plain http would put what people write on the wire. */
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/i;
if (url && !/^https:\/\/[a-z0-9.-]+$/i.test(url) && !LOOPBACK.test(url)) {
  console.error(`Refusing: "${url}" does not look like a Worker URL.`);
  process.exit(1);
}

/* A typo'd subdomain would leave the page quietly broken, so check before
   wiring it in. An empty list is the correct response on a fresh deploy. */
if (url) {
  console.log(`Checking ${url} …`);
  const res = await fetch(url, { headers: { Origin: 'https://radiotests.org' } })
    .catch((e) => { console.error(`  unreachable: ${e.message}`); process.exit(1); });

  if (!res.ok) { console.error(`  HTTP ${res.status}`); process.exit(1); }

  const cors = res.headers.get('access-control-allow-origin');
  if (!cors) {
    console.error('  no Access-Control-Allow-Origin — the browser will block this.');
    console.error('  Check ALLOWED_DOMAINS in worker/parc-reviews.js.');
    process.exit(1);
  }

  const data = await res.json().catch(() => null);
  if (!data || !Array.isArray(data.reviews)) {
    console.error('  did not return a review list; is this the reviews Worker?');
    process.exit(1);
  }
  console.log(`  ok — ${data.count} approved review(s), CORS allows ${cors}`);
}

for (const [file, attr] of TARGETS) {
  if (!existsSync(file)) { console.log(`  skipped (not present): ${file}`); continue; }
  const before = readFileSync(file, 'utf8');
  const after = before.replace(new RegExp(`(${attr}=")[^"]*(")`), `$1${url}$2`);
  if (after === before && url) {
    console.error(`Could not find ${attr} in ${file}.`);
    process.exit(1);
  }
  writeFileSync(file, after);
  console.log(`  ${attr} -> ${file.split('/').slice(-2).join('/')}`);
}

console.log(url ? `\nWired in. Rebuild and deploy:` : `\nCleared. Rebuild and deploy:`);
console.log('  node tools/deploy.mjs --push');
