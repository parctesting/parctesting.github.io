#!/usr/bin/env node
/**
 * Points the schedule page at a deployed availability Worker, then proves it works.
 *
 *   node tools/set-worker-url.mjs https://parc-availability.<you>.workers.dev
 *   node tools/set-worker-url.mjs --clear      # back to the committed snapshot
 *
 * Sets data-availability-endpoint on <div id="schedule">. With it set, the page
 * fetches live availability on every load and the "times last checked" line
 * hides itself. Without it, the page reads data/availability.json, which only
 * changes when someone runs tools/fetch-availability.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PAGE = join(ROOT, 'pages', 'calendar.html');
const arg = process.argv[2];

if (!arg) {
  console.error('usage: node tools/set-worker-url.mjs <worker-url> | --clear');
  process.exit(2);
}

const url = arg === '--clear' ? '' : arg.replace(/\/+$/, '');
if (url && !/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/i.test(url)
        && !/^https:\/\/[a-z0-9.-]+$/i.test(url)) {
  console.error(`Refusing: "${url}" does not look like a Worker URL.`);
  process.exit(1);
}

/* Prove it actually serves merged availability before wiring it in — a typo'd
   subdomain would otherwise fail silently and just fall back to the snapshot. */
if (url) {
  console.log(`Checking ${url} …`);
  const res = await fetch(`${url}?tz=America%2FChicago&days=7`, {
    headers: { Origin: 'https://parcradio.net' },
  }).catch((e) => { console.error(`  unreachable: ${e.message}`); process.exit(1); });

  if (!res.ok) {
    console.error(`  HTTP ${res.status} — is the Worker deployed?`);
    process.exit(1);
  }
  const acao = res.headers.get('access-control-allow-origin');
  if (!acao) {
    console.error('  no Access-Control-Allow-Origin header — browsers would block this.');
    process.exit(1);
  }
  const data = await res.json();
  if (!data.slots || !data.slots.length) {
    console.error(`  responded, but returned no slots: ${JSON.stringify(data).slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`  ok — ${data.slots.length} merged slots, ${data.sources.length} calendars`);
  console.log(`  CORS allows: ${acao}`);
  if (data.partial) console.log('  note: some calendars could not be reached (partial: true)');
}

const html = readFileSync(PAGE, 'utf8');
const next = html.replace(/data-availability-endpoint="[^"]*"/,
                          `data-availability-endpoint="${url}"`);
if (next === html) {
  console.error('Could not find data-availability-endpoint on pages/calendar.html');
  process.exit(1);
}
writeFileSync(PAGE, next);
console.log(url ? `\nWired in. The schedule page now fetches live data on every load.`
                : `\nCleared. The schedule page falls back to data/availability.json.`);
console.log('Next:  node tools/deploy.mjs --check');
