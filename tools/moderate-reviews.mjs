#!/usr/bin/env node
/**
 * List and delete reviews.
 *
 *   REVIEWS_URL=https://parc-reviews.<you>.workers.dev \
 *   REVIEWS_ADMIN_KEY=... node tools/moderate-reviews.mjs
 *
 *   ... list             show what is on the page (default)
 *   ... delete <id>      take one down, immediately
 *
 * Reviews publish as soon as they are submitted, so this is how a bad one comes
 * off rather than how a good one goes up. Deletion is immediate and permanent —
 * the page reads live, so there is nothing to rebuild, and nothing to undo with.
 */
const URL_BASE = (process.env.REVIEWS_URL || '').replace(/\/+$/, '');
const KEY = process.env.REVIEWS_ADMIN_KEY || '';
const [cmd = 'list', id] = process.argv.slice(2);

if (!URL_BASE || !KEY) {
  console.error('Set REVIEWS_URL and REVIEWS_ADMIN_KEY first. For example:\n');
  console.error('  export REVIEWS_URL=https://parc-reviews.<you>.workers.dev');
  console.error('  export REVIEWS_ADMIN_KEY=<the secret you set in Cloudflare>');
  process.exit(1);
}

function show(r, marker) {
  console.log(`  ${r.id}${marker || ''}`);
  console.log(`    ${'*'.repeat(r.rating)}${'.'.repeat(5 - r.rating)}  ${r.name}  ${(r.at || '').slice(0, 10)}`);
  console.log(`    ${r.text}\n`);
}

if (cmd === 'list') {
  const res = await fetch(`${URL_BASE}/list?key=${encodeURIComponent(KEY)}`);
  if (res.status === 401) { console.error('Rejected — check REVIEWS_ADMIN_KEY.'); process.exit(1); }
  if (!res.ok) { console.error(`HTTP ${res.status}`); process.exit(1); }
  const d = await res.json();

  if (!d.count) console.log('No reviews on the page yet.\n');
  else {
    console.log(`${d.count} on the page:\n`);
    for (const r of d.reviews) show(r);
  }

  /* Anything left by the older hold-for-approval version. It is not on the page
     and never will be, so the only thing to do with it is clear it. */
  if (d.leftoverPending && d.leftoverPending.length) {
    console.log(`${d.leftoverPending.length} left over from before reviews published`);
    console.log('automatically. These are NOT on the page — delete them:\n');
    for (const r of d.leftoverPending) show(r, '   [not published]');
  }

  if (d.count || (d.leftoverPending || []).length) {
    console.log('To take one down:  node tools/moderate-reviews.mjs delete <id>');
  }
  process.exit(0);
}

if (cmd !== 'delete' || !id) {
  console.error('usage: moderate-reviews.mjs [list | delete <id>]');
  process.exit(2);
}

const res = await fetch(`${URL_BASE}/moderate?key=${encodeURIComponent(KEY)}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id, action: 'delete' }),
});
const d = await res.json();
console.log(res.ok ? `deleted: ${d.id}` : `failed: ${d.error}`);
process.exit(res.ok ? 0 : 1);
