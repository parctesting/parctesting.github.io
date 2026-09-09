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
 * DEPLOY
 *   cd worker && npx wrangler deploy
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

const PROFILE_TTL = 3600;   // event-type list: changes rarely
const RANGE_TTL = 60;       // availability: fresh enough to act on, gentle upstream

function corsHeaders(origin) {
  const allow = originAllowed(origin) ? origin : DEFAULT_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  };
}

async function cachedJson(url, ttl) {
  const res = await fetch(url, {
    cf: { cacheTtl: ttl, cacheEverything: true },
    headers: { 'accept': 'application/json', 'user-agent': 'parcradio.net availability merger' },
  });
  if (!res.ok) throw new Error(`upstream ${res.status} for ${url}`);
  return res.json();
}

/** Resolve event names -> UUIDs. Done by name so a slug rename in Calendly
 *  doesn't break the merge. */
async function resolveEventTypes(includeYouth) {
  const list = await cachedJson(
    `https://calendly.com/api/booking/profiles/${PROFILE}/event_types`, PROFILE_TTL);
  const wanted = includeYouth ? SESSIONS.concat([YOUTH]) : SESSIONS;
  const out = [];
  for (const s of wanted) {
    const hit = list.find((e) => s.match.test(e.name || ''));
    if (hit) out.push({ letter: s.letter, uuid: hit.uuid, slug: hit.slug, name: hit.name });
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
    const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '14', 10), 1), 60);
    const includeYouth = url.searchParams.get('include') === 'youth';

    const today = new Date();
    const start = today.toISOString().slice(0, 10);
    const end = new Date(today.getTime() + days * 86400000).toISOString().slice(0, 10);

    try {
      const types = await resolveEventTypes(includeYouth);
      if (!types.length) throw new Error('no matching event types');

      const results = await Promise.allSettled(types.map(async (t) => {
        const u = `https://calendly.com/api/booking/event_types/${t.uuid}/calendar/range`
          + `?timezone=${encodeURIComponent(tz)}&diagnostics=false`
          + `&range_start=${start}&range_end=${end}`;
        return { type: t, data: await cachedJson(u, RANGE_TTL) };
      }));

      // Merge: one entry per start instant, listing which sessions offer it.
      const bucket = new Map();
      let okCount = 0;
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        okCount++;
        const { type, data } = r.value;
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

      return new Response(JSON.stringify({
        generated: new Date().toISOString(),
        timezone: tz,
        sources: types.map((t) => ({ letter: t.letter, slug: t.slug, youth: !!t.youth })),
        partial: okCount < types.length,   // some calendars failed; page can note it
        slots,
      }), {
        headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' },
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
