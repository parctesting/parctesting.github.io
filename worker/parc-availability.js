/**
 * PARC availability merger — Cloudflare Worker.
 *
 * WHAT IT SOLVES
 * The schedule page offers seven separate Calendly event types (different time
 * windows with different capacity caps). Candidates had to open each one and
 * compare by eye. Calendly can only pool availability across HOSTS inside ONE
 * event type, and only on the Teams plan, so there is no way to merge these
 * seven at the source without restructuring the account.
 *
 * This fetches all of them, merges the slots, collapses duplicate start times
 * into one row, and returns the result as JSON.
 *
 * WHY A WORKER AT ALL
 * The endpoint Calendly's own widget uses is unauthenticated and returns real
 * availability — but it sends no Access-Control-Allow-Origin, so page
 * JavaScript on parcradio.net cannot call it. The Worker's only real job is to
 * add that header. No API key is involved.
 *
 * ⚠️  THIS DEPENDS ON AN UNDOCUMENTED CALENDLY ENDPOINT.
 * Calendly can change or block it without notice. js/schedule.js therefore
 * treats this as pure enhancement: the seven tabbed embeds are always rendered
 * and always book normally, and the merged panel hides itself on any failure.
 * Do not make the booking flow depend on this Worker.
 *
 * WHAT IT ANSWERS
 *   ?month=2026-11        every open time in that month, plus a day either side
 *   ?days=21              the next N days from today (what older pages ask for)
 *   &tz=America/Chicago   &include=youth
 * A reply to month= echoes the month back. That echo is how the page tells this
 * build from an older one that only understood days= — the page asks for both,
 * so an older Worker still returns what it can.
 *
 * DEPLOY
 *   ./deploy-worker.sh    (needs your own Cloudflare credentials; see that file)
 */

const PROFILE = 'parctesting';

/* Site label -> the event NAME as it appears in Calendly.
 *
 * ⚠️  The event named "Exam Sessions C" carries the SLUG exam-sessions-d, and D
 * carries exam-sessions-c. They are genuinely swapped in the Calendly account.
 * Matching on NAME here (not slug) is what keeps this correct — and the site's
 * tabs compensate the same way. Do not "fix" the apparent mismatch.
 */
const SESSIONS = [
  { letter: 'A', match: /Exam Sessions A\b/i },
  { letter: 'B', match: /Exam Sessions B\b/i },
  { letter: 'C', match: /Exam Sessions C\b/i },
  { letter: 'D', match: /Exam Sessions D\b/i },
  { letter: 'E', match: /Exam Sessions E\b/i },
  { letter: 'F', match: /Exam Sessions F\b/i },
  { letter: 'S', match: /Exam Sessions S\b/i },
];
// 'Y' must match data/availability.json and js/schedule.js. Emitting
// 'YOUTH' here silently broke youth badges and youth-first booking.
const YOUTH = { letter: 'Y', match: /YOUTH ONLY/i, youth: true };

/* Which sites may call this Worker.
 *
 * A missing entry does not error visibly: the browser blocks the response, the
 * page silently falls back to its committed snapshot, and the calendar quietly
 * shows yesterday. That is what happened when radiotests.org went up.
 *
 * So rather than an exact list that needs a redeploy every time a host is
 * added, any subdomain of the domains below is accepted as well — beta.,
 * staging., www. and so on all work without touching this file.
 *
 * Not wide open: this Worker has a free-tier request budget, and an unrestricted
 * allowlist would let any site on the internet spend it. It only proxies public
 * Calendly availability, so there is nothing confidential here — the limit is
 * about the quota, not secrecy. */
const ALLOWED_DOMAINS = [
  'parcradio.net',
  'parcradio.org',
  'radiotests.org',
  'github.io',
];

const ALLOWED_EXACT = [
  'http://127.0.0.1:8088',
  'http://localhost:8088',
  'http://127.0.0.1:8090',
  'http://localhost:8090',
];

const DEFAULT_ORIGIN = 'https://parcradio.net';

function originAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED_EXACT.includes(origin)) return true;
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  // Exact domain, or a subdomain of it. The leading dot stops "notparcradio.net"
  // matching "parcradio.net".
  return ALLOWED_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
}

const DAY_MS = 86400000;

/* Calendly's range endpoint refuses long spans. Measured 2026-09-13: 35 days
   answers, 45 fails with every calendar erroring. The cap here used to be 60, so
   any request for 36-60 days came back as a 502 instead of data. A month with a
   day of margin each side is at most 33 days, inside the limit. */
const MAX_SPAN_DAYS = 35;

/* How far ahead a month may be asked for. Sessions are open months out; the
   bound just stops something walking the calendar from spending the request
   budget on years that will never have a session. */
const MAX_MONTHS_AHEAD = 12;

/* Calendly is always asked in one zone. The page places every time in the
   candidate's own zone itself, and a month's day of margin covers every US zone,
   so asking in each viewer's zone only multiplied the distinct URLs — and with
   them the calls Calendly counts against this Worker. */
const QUERY_TZ = 'America/Chicago';

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The dates to ask Calendly for, from ?month= or else ?days=. */
function requestedRange(params) {
  const now = Date.now();
  /* Yesterday's date rather than today's. A UTC date runs ahead of US evenings,
     so starting from "today" dropped the rest of the evening's sessions once it
     was past midnight in London. The page discards anything already started. */
  const earliest = isoDate(now - DAY_MS);
  const month = params.get('month') || '';

  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    const y = Number(month.slice(0, 4));
    const m = Number(month.slice(5, 7));
    /* A day of margin each side. Calendly buckets days in one zone and the
       candidate may be in another, so the first morning and the last night of
       the month, as they see it, can sit on the neighboring month's dates. */
    const from = isoDate(Date.UTC(y, m - 1, 1) - DAY_MS);
    const to = isoDate(Date.UTC(y, m, 0) + DAY_MS);     // day 0 of the next month is this month's last day
    const start = from < earliest ? earliest : from;    // Calendly has nothing bookable in the past
    const t = new Date(now);
    const ahead = (y - t.getUTCFullYear()) * 12 + (m - 1 - t.getUTCMonth());
    return { month, start, end: to, empty: to < start || ahead > MAX_MONTHS_AHEAD };
  }

  const asked = parseInt(params.get('days') || '14', 10);
  // One day short of the limit: the span also includes yesterday.
  const days = Math.min(Math.max(Number.isFinite(asked) ? asked : 14, 1), MAX_SPAN_DAYS - 1);
  return { month: null, start: earliest, end: isoDate(now + days * DAY_MS), empty: false };
}

/* ---- upstream cache -------------------------------------------------------
 * Calendly throttles this endpoint hard. On 2026-09-13 a burst of about a
 * hundred calls in three minutes — just from verifying this Worker — got its
 * Cloudflare edge refused outright, and every request failed for a couple of
 * minutes. There was no cache to soften it: the cf cache options this Worker
 * used to pass do nothing on workers.dev, so every candidate's click cost seven
 * or eight fresh Calendly calls.
 *
 * So, cheapest first:
 *  - an in-memory copy of each Calendly reply, fresh for FRESH_MS, shared by
 *    every request this isolate serves;
 *  - requests that arrive together for the same URL share one fetch;
 *  - the Cache API, as a colo-wide copy wherever Cloudflare offers it;
 *  - and if Calendly refuses, the last good copy for up to STALE_MS, with the
 *    reply marked stale so the page can say when it was checked. A finder that
 *    is a few hours behind beats a blank calendar; Calendly confirms at booking.
 */
const FRESH_MS = 5 * 60 * 1000;
const STALE_MS = 6 * 60 * 60 * 1000;
const PROFILE_FRESH_MS = 60 * 60 * 1000;
const MEMORY_LIMIT = 300;

const memory = new Map();     // Calendly URL -> { at, data }
const inflight = new Map();   // Calendly URL -> Promise<{ at, data }>
const EDGE_KEY = 'https://availability-cache.parcradio.invalid/?u=';

function remember(url, entry) {
  memory.delete(url);
  memory.set(url, entry);
  if (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value);
}

async function edgeGet(url) {
  try {
    if (typeof caches === 'undefined') return null;
    const hit = await caches.default.match(EDGE_KEY + encodeURIComponent(url));
    return hit ? await hit.json() : null;
  } catch { return null; }
}

async function edgePut(url, entry) {
  try {
    if (typeof caches === 'undefined') return;
    await caches.default.put(EDGE_KEY + encodeURIComponent(url), new Response(JSON.stringify(entry), {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${STALE_MS / 1000}` },
    }));
  } catch { /* no Cache API here - the in-memory copy still stands */ }
}

/** A Calendly reply: { data, at, stale }. Throws only when there is nothing to fall back on. */
async function upstream(url, freshMs = FRESH_MS) {
  const held = memory.get(url);
  if (held && Date.now() - held.at < freshMs) return { ...held, stale: false };

  const edge = await edgeGet(url);
  if (edge && Date.now() - edge.at < freshMs) { remember(url, edge); return { ...edge, stale: false }; }

  let job = inflight.get(url);
  if (!job) {
    job = (async () => {
      try {
        const res = await fetch(url, {
          headers: { 'accept': 'application/json', 'user-agent': 'parcradio.net availability merger' },
        });
        if (!res.ok) throw new Error(`upstream ${res.status}`);
        const entry = { at: Date.now(), data: await res.json() };
        remember(url, entry);
        await edgePut(url, entry);
        return entry;
      } finally {
        inflight.delete(url);
      }
    })();
    inflight.set(url, job);
  }

  try {
    return { ...(await job), stale: false };
  } catch (err) {
    const fallback = [memory.get(url), edge].filter(Boolean).sort((a, b) => b.at - a.at)[0];
    if (fallback && Date.now() - fallback.at < STALE_MS) return { ...fallback, stale: true };
    throw err;
  }
}

function corsHeaders(origin) {
  const allow = originAllowed(origin) ? origin : DEFAULT_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  };
}

/** Resolve event names -> UUIDs. Done by name so a slug rename in Calendly
 *  doesn't break the merge. */
async function resolveEventTypes(includeYouth) {
  const { data: list } = await upstream(
    `https://calendly.com/api/booking/profiles/${PROFILE}/event_types`, PROFILE_FRESH_MS);
  const wanted = includeYouth ? SESSIONS.concat([YOUTH]) : SESSIONS;
  const out = [];
  for (const s of wanted) {
    const hit = list.find((e) => s.match.test(e.name || ''));
    if (hit) out.push({ letter: s.letter, uuid: hit.uuid, slug: hit.slug, name: hit.name, youth: !!s.youth });
  }
  return out;
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });

    const url = new URL(request.url);
    const tz = url.searchParams.get('tz') || 'America/Chicago';
    const includeYouth = url.searchParams.get('include') === 'youth';
    const range = requestedRange(url.searchParams);

    const reply = (body) => new Response(JSON.stringify({
      generated: new Date().toISOString(),
      timezone: tz,
      month: range.month,
      range: { start: range.start, end: range.end },
      ...body,
    }), {
      headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' },
    });

    // A month already over, or too far out: nothing to ask Calendly.
    if (range.empty) return reply({ sources: [], partial: false, stale: false, slots: [] });

    try {
      const types = await resolveEventTypes(includeYouth);
      if (!types.length) throw new Error('no matching event types');

      const results = await Promise.allSettled(types.map(async (t) => {
        const u = `https://calendly.com/api/booking/event_types/${t.uuid}/calendar/range`
          + `?timezone=${encodeURIComponent(QUERY_TZ)}&diagnostics=false`
          + `&range_start=${range.start}&range_end=${range.end}`;
        return { type: t, ...(await upstream(u)) };
      }));

      // Merge: one entry per start instant, listing which sessions offer it.
      const bucket = new Map();
      let okCount = 0, stale = false, oldest = Infinity;
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        okCount++;
        const { type, data } = r.value;
        if (r.value.stale) { stale = true; oldest = Math.min(oldest, r.value.at); }
        for (const day of data.days || []) {
          if (day.status !== 'available') continue;
          for (const spot of day.spots || []) {
            if (spot.status !== 'available') continue;
            const key = new Date(spot.start_time).toISOString();   // normalise the instant
            if (!bucket.has(key)) bucket.set(key, { start: spot.start_time, sessions: [], remaining: 0 });
            const row = bucket.get(key);
            const seats = Number(spot.invitees_remaining) || 0;
            row.sessions.push({ letter: type.letter, slug: type.slug, remaining: seats });
            row.remaining += seats;
          }
        }
      }
      if (!okCount) throw new Error('all upstream calendars failed');

      const slots = [...bucket.values()].sort((a, b) => new Date(a.start) - new Date(b.start));

      return reply({
        sources: types.map((t) => ({ letter: t.letter, slug: t.slug, youth: t.youth })),
        partial: okCount < types.length,   // some calendars failed outright; page can note it
        stale,                             // some came from the fallback copy
        ...(stale ? { checkedAt: new Date(oldest).toISOString() } : {}),
        slots,
      });
    } catch (err) {
      // The page falls back to the tabbed embeds on any non-200.
      return new Response(JSON.stringify({ error: String(err.message || err) }), {
        status: 502,
        headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
      });
    }
  },
};
