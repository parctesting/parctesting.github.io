#!/usr/bin/env node
/**
 * List and remove team profiles, and hand out edit codes.
 *
 *   REVIEWS_URL=... REVIEWS_ADMIN_KEY=... node tools/moderate-team.mjs
 *
 *   ... list              who is on the team page (default)
 *   ... delete <id>       remove one, photo and all
 *   ... reset-code <id>   give one profile a new edit code; its old code stops working
 *   ... issue-codes       give a code to every profile that has none
 *
 * Profiles publish as soon as they are sent, so this is how one comes off, not
 * how one goes up. Deletion is immediate and permanent — the page reads live, so
 * there is nothing to rebuild and nothing to undo it with.
 *
 * An edit code lets a volunteer change their own profile from the VE page. New
 * profiles get one when they are sent. Profiles sent before codes existed, and
 * anyone who has lost theirs, get one from here. Pass it on privately: whoever
 * holds a code can change that profile.
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
  const code = m.hasEditCode === undefined ? '' : `   edit code: ${m.hasEditCode ? 'yes' : 'none'}`;
  console.log(`  ${m.id}${note || ''}`);
  console.log(`    ${m.name}${m.callsign ? '  ' + m.callsign : ''}${m.role ? '  — ' + m.role : ''}`);
  console.log(`    photo: ${m.hasPhoto ? 'yes' : 'none'}${code}   sent: ${(m.at || '').slice(0, 10)}`);
  console.log(`    ${m.bio}\n`);
}

async function list() {
  const res = await fetch(`${URL_BASE}/team/list?key=${encodeURIComponent(KEY)}`);
  if (res.status === 401) { console.error('Rejected — check REVIEWS_ADMIN_KEY.'); process.exit(1); }
  if (!res.ok) { console.error(`HTTP ${res.status}`); process.exit(1); }
  return res.json();
}

async function moderate(profileId, action) {
  const res = await fetch(`${URL_BASE}/team/moderate?key=${encodeURIComponent(KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: profileId, action }),
  });
  let d = {};
  try { d = await res.json(); } catch { /* reported below */ }
  return { ok: res.ok, status: res.status, d };
}

/* The Worker in Cloudflare predates edit codes until the new one is pasted in. */
function needsNewWorker(r) {
  if (r.status === 400 && /action must be delete or show/.test(r.d.error || '')) {
    console.error('The Worker in Cloudflare does not know about edit codes yet.');
    console.error('Paste the current worker/parc-reviews.js into it first (see DEPLOY.md).');
    process.exit(1);
  }
}

if (cmd === 'list') {
  const d = await list();
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
  if (d.members.some((m) => m.hasEditCode === false)) {
    console.log('To give everyone without an edit code one:  node tools/moderate-team.mjs issue-codes');
  }
  process.exit(0);
}

if (cmd === 'issue-codes') {
  const d = await list();
  if (d.members.length && d.members.every((m) => m.hasEditCode === undefined)) {
    needsNewWorker({ status: 400, d: { error: 'action must be delete or show' } });
  }
  const missing = d.members.filter((m) => m.hasEditCode === false);
  if (!missing.length) { console.log('Every profile already has an edit code.'); process.exit(0); }

  console.log(`Edit codes for ${missing.length} profile(s). Send each person their own code, privately.\n`);
  let failed = 0;
  for (const m of missing) {
    const r = await moderate(m.id, 'reset-code');
    needsNewWorker(r);
    const who = `${m.name}${m.callsign ? ' ' + m.callsign : ''}`;
    if (r.ok) console.log(`  ${r.d.editCode}   ${who}   (${m.id})`);
    else { failed++; console.log(`  failed for ${who}: ${r.d.error || 'HTTP ' + r.status}`); }
  }
  console.log('\nThey change their profile on the VE page "Add yourself to the team page":');
  console.log('choose "Update my profile" and enter the code.');
  process.exit(failed ? 1 : 0);
}

if (!['delete', 'show', 'reset-code'].includes(cmd) || !id) {
  console.error('usage: moderate-team.mjs [list | delete <id> | reset-code <id> | issue-codes | show <id>]');
  process.exit(2);
}

const r = await moderate(id, cmd);
needsNewWorker(r);
if (!r.ok) { console.log(`failed: ${r.d.error || 'HTTP ' + r.status}`); process.exit(1); }
if (cmd === 'reset-code') {
  console.log(`New edit code for ${id}:\n\n  ${r.d.editCode}\n`);
  console.log('Any earlier code for this profile no longer works. Send this one privately:');
  console.log('whoever holds it can change the profile, on the VE page under "Update my profile".');
} else {
  console.log(`${r.d.action}: ${r.d.id}`);
}
process.exit(0);
