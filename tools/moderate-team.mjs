#!/usr/bin/env node
/**
 * List and remove team profiles.
 *
 *   REVIEWS_URL=... REVIEWS_ADMIN_KEY=... node tools/moderate-team.mjs
 *
 *   ... list            who is on the team page (default)
 *   ... delete <id>     remove one, photo and all
 *
 * Profiles publish as soon as they are sent, so this is how one comes off, not
 * how one goes up. Deletion is immediate and permanent — the page reads live, so
 * there is nothing to rebuild and nothing to undo it with.
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

function show(m, note) {
  console.log(`  ${m.id}${note || ''}`);
  console.log(`    ${m.name}${m.callsign ? '  ' + m.callsign : ''}${m.role ? '  — ' + m.role : ''}`);
  console.log(`    photo: ${m.hasPhoto ? 'yes' : 'none'}   sent: ${(m.at || '').slice(0, 10)}`);
  console.log(`    ${m.bio}\n`);
}

if (cmd === 'list') {
  const res = await fetch(`${URL_BASE}/team/list?key=${encodeURIComponent(KEY)}`);
  if (res.status === 401) { console.error('Rejected — check REVIEWS_ADMIN_KEY.'); process.exit(1); }
  if (!res.ok) { console.error(`HTTP ${res.status}`); process.exit(1); }
  const d = await res.json();

  if (!d.count) { console.log('Nobody on the team page yet.'); process.exit(0); }

  const live = d.members.filter((m) => m.approved);
  console.log(`${live.length} on the team page:\n`);
  for (const m of live) show(m);

  if (d.notShown && d.notShown.length) {
    console.log(`${d.notShown.length} left over from before profiles published`);
    console.log('automatically. These are NOT on the page:\n');
    for (const m of d.notShown) show(m, '   [not shown]');
    console.log('Publish one with:  node tools/moderate-team.mjs show <id>\n');
  }

  console.log('To take one down:  node tools/moderate-team.mjs delete <id>');
  process.exit(0);
}

if (!['delete', 'show'].includes(cmd) || !id) {
  console.error('usage: moderate-team.mjs [list | delete <id> | show <id>]');
  process.exit(2);
}

const res = await fetch(`${URL_BASE}/team/moderate?key=${encodeURIComponent(KEY)}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id, action: cmd }),
});
const d = await res.json();
console.log(res.ok ? `${d.action}: ${d.id}` : `failed: ${d.error}`);
process.exit(res.ok ? 0 : 1);
