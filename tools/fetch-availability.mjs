#!/usr/bin/env node
/**
 * Fetches availability from every PARC Calendly calendar, merges it, collapses
 * duplicate start times, and writes data/availability.json.
 *
 *   node tools/fetch-availability.mjs [--days 21]
 *
 * WHY A BUILD-TIME SNAPSHOT
 * Calendly's availability endpoint sends no CORS header, so page JavaScript
 * cannot call it. Two ways around that: a Cloudflare Worker proxy (live, needs
 * an account) or this — fetch from Node, commit the result, serve it
 * same-origin. The page prefers the Worker when one is configured and falls
 * back to this file, so both paths produce the same UI and the same JSON shape.
 *
 * The snapshot goes stale. It is a FINDER, not a booking system: every slot
 * links out to Calendly, which is always authoritative about what is still free.
 * Re-run this whenever you want it fresh (a cron job or GitHub Action can do it).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PROFILE = 'parctesting';

/* Matched on NAME, not slug.
 * ⚠️  In Calendly the event NAMED "Exam Sessions C" carries the slug
 * exam-sessions-d, and D carries exam-sessions-c. Matching by name is what
 * keeps the labels honest. Do not "fix" the apparent mismatch. */
const SESSIONS = [
  { letter: 'A', match: /Exam Sessions A\b/i,  label: 'Session A' },
  { letter: 'B', match: /Exam Sessions B\b/i,  label: 'Session B' },
  { letter: 'C', match: /Exam Sessions C\b/i,  label: 'Session C' },
  { letter: 'D', match: /Exam Sessions D\b/i,  label: 'Session D' },
  { letter: 'E', match: /Exam Sessions E\b/i,  label: 'Session E' },
  { letter: 'F', match: /Exam Sessions F\b/i,  label: 'Session F' },
  { letter: 'S', match: /Exam Sessions S\b/i,  label: 'Session S' },
  { letter: 'Y', match: /YOUTH ONLY/i,         label: 'Youth', youth: true },
];

const days = Number((process.argv.find((a) => a.startsWith('--days=')) || '').split('=')[1]) || 21;
const TZ = 'America/Chicago';   // canonical; the page re-renders in the viewer's zone

async function json(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

const list = await json(`https://calendly.com/api/booking/profiles/${PROFILE}/event_types`);
const types = SESSIONS
  .map((s) => {
    const hit = list.find((e) => s.match.test(e.name || ''));
    return hit && { ...s, uuid: hit.uuid, slug: hit.slug, name: hit.name };
  })
  .filter(Boolean);

const today = new Date();
const start = today.toISOString().slice(0, 10);
const end = new Date(today.getTime() + days * 86400000).toISOString().slice(0, 10);

const results = await Promise.allSettled(types.map(async (t) => ({
  t,
  d: await json(`https://calendly.com/api/booking/event_types/${t.uuid}/calendar/range`
    + `?timezone=${encodeURIComponent(TZ)}&diagnostics=false&range_start=${start}&range_end=${end}`),
})));

const bucket = new Map();
let raw = 0, okCount = 0;
for (const r of results) {
  if (r.status !== 'fulfilled') { console.warn('  ! failed:', r.reason?.message); continue; }
  okCount++;
  for (const day of r.value.d.days || []) {
    if (day.status !== 'available') continue;
    for (const spot of day.spots || []) {
      if (spot.status !== 'available') continue;
      raw++;
      const key = new Date(spot.start_time).toISOString();
      if (!bucket.has(key)) bucket.set(key, { start: spot.start_time, sessions: [], remaining: 0 });
      const row = bucket.get(key);
      const seats = Number(spot.invitees_remaining) || 0;
      row.sessions.push({ letter: r.value.t.letter, slug: r.value.t.slug, remaining: seats });
      row.remaining += seats;
    }
  }
}

/* Youth sessions are stripped from the committed snapshot. This file is served
   at data/availability.json and anyone can read it, so leaving them in
   advertised the youth calendar to every visitor — which is what the age gate
   exists to avoid. The live Worker only returns them when the page asks with
   include=youth, and it only asks once the date of birth says so. A youth
   candidate falling back to this snapshot sees general sessions, which they can
   book; the leak in the other direction is the one that matters. */
const publicTypes = types.filter((t) => !t.youth);
const slots = [...bucket.values()]
  .map((s) => ({ ...s, sessions: s.sessions.filter((x) => x.letter !== 'Y') }))
  .filter((s) => s.sessions.length)
  .sort((a, b) => new Date(a.start) - new Date(b.start));

for (const s of slots) {
  s.remaining = s.sessions.reduce((n, x) => n + (x.remaining || 0), 0);
}

const out = {
  generated: new Date().toISOString(),
  timezone: TZ,
  days,
  partial: okCount < types.length,
  sources: publicTypes.map((t) => ({ letter: t.letter, label: t.label, slug: t.slug, youth: false })),
  slots,
};

mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(join(ROOT, 'data', 'availability.json'), JSON.stringify(out));
console.log(`calendars merged : ${okCount}/${types.length}`);
console.log(`raw slots        : ${raw}`);
console.log(`after dedupe     : ${slots.length}  (${raw - slots.length} duplicates collapsed)`);
console.log(`window           : ${days} days`);
console.log(`wrote data/availability.json (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);
