/**
 * PARC reviews — Cloudflare Worker.
 *
 * GitHub Pages serves files and cannot store anything, so submissions go here
 * and are kept in Cloudflare KV.
 *
 * REVIEWS PUBLISH IMMEDIATELY, and are deleted after the fact if needed.
 * An earlier version held everything for approval. That is safer but only works
 * if somebody actually reads the queue — an unread queue means a candidate is
 * told "a volunteer will read this" and then nothing happens, which is worse
 * than not asking. Three things carry the load instead:
 *
 *   1. Cloudflare Turnstile, which stops automated submissions.
 *   2. A per-address daily cap, so one person cannot flood the page.
 *   3. A hard refusal of anything containing a phone number or email address,
 *      returned to the writer so they can fix it, rather than published.
 *
 * What none of that stops is a real person writing something abusive, or a
 * minor putting personal details in prose. That is now visible until somebody
 * notices and deletes it. tools/moderate-reviews.mjs lists and deletes.
 *
 * It also serves the Our Team page, because a second Worker would mean a second
 * deploy, a second KV binding and a second copy of both secrets for a volunteer
 * to keep straight. Team records share this namespace under a `team:` prefix.
 *
 * TEAM PROFILES PUBLISH IMMEDIATELY, like reviews, and are deleted afterwards if
 * something is wrong. What stands in for approval is where the form lives: on a
 * passcode-locked VE page, so a visitor never reaches it. Optionally also
 * TEAM_SUBMIT_CODE, which makes that a real gate rather than an unlisted URL —
 * see DEPLOY.md. Without the code set, anyone who works out the endpoint can
 * post, so keep an eye on the page.
 *
 * ROUTES
 *   GET  /            published reviews (public)
 *   POST /            submit a review   (public, Turnstile + rate limited)
 *   GET  /list        every stored review with ids  -- requires ADMIN_KEY
 *   POST /moderate    delete one                    -- requires ADMIN_KEY
 *
 *   GET  /team              approved team members (public)
 *   GET  /team/photo/<id>   one member's photo (public, immutable)
 *   POST /team              submit a bio + photo (Turnstile, publishes at once)
 *   GET  /team/list         every profile with ids  -- requires ADMIN_KEY
 *   POST /team/moderate     delete one              -- requires ADMIN_KEY
 *
 * SETUP (see DEPLOY.md)
 *   1. Workers & Pages -> KV -> Create namespace, call it PARC_REVIEWS
 *   2. Bind it to this Worker as the variable REVIEWS
 *   3. Add a secret named ADMIN_KEY       (Settings -> Variables -> Encrypt)
 *   4. Add a secret named TURNSTILE_SECRET from the Turnstile widget
 *   5. Optional: TEAM_SUBMIT_CODE, matching data-team-code on the locked
 *      team-submit page, so only VEs can add themselves to the team page
 */

const ALLOWED_DOMAINS = ['parcradio.net', 'parcradio.org', 'radiotests.org', 'github.io'];
const ALLOWED_EXACT = [
  'http://127.0.0.1:8088', 'http://localhost:8088',
  'http://127.0.0.1:8090', 'http://localhost:8090',
];
const DEFAULT_ORIGIN = 'https://radiotests.org';

const MAX_NAME = 60;
const MAX_TEXT = 1200;
const MAX_PER_IP_PER_DAY = 3;

/* The page downscales photographs to 480px before upload, which lands well
   under this. The cap is here so a hand-rolled POST cannot fill the namespace. */
const MAX_PHOTO_BYTES = 400 * 1024;
const MAX_BIO = 600;
const MAX_ROLE = 60;
const MAX_CALLSIGN = 12;

function originAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED_EXACT.includes(origin)) return true;
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  return ALLOWED_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': originAllowed(origin) ? origin : DEFAULT_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
  });

/** Strip anything that could become markup, and collapse whitespace. */
function clean(s, max) {
  return String(s == null ? '' : s)
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/* Refused outright now rather than flagged, because there is no longer a human
   between the form and the page. A submission carrying a phone number or an
   email is nearly always somebody trying to reach the team, and publishing it
   would put their contact details on a public page — the writer may well be a
   minor. The refusal says which one it found so it can be removed and resent.
   Call signs are deliberately NOT blocked: on a ham radio site people sign with
   them, and the form only advises against it. */
const PHONE_RE = /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/;

/** Verify a Turnstile token. Skipped when no secret is configured. */
async function humanChecked(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return { ok: true };
  if (!token) return { ok: false, error: 'Please complete the "I am human" check and try again.' };

  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip && ip !== 'unknown') form.append('remoteip', ip);

  let data = null;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',
      { method: 'POST', body: form });
    data = await res.json();
  } catch {
    /* Cloudflare's own verifier being unreachable is not the writer's fault, and
       failing closed here would silently break the form. Turnstile has already
       run in their browser; let it through. */
    return { ok: true };
  }

  if (!data || data.success !== true) {
    return { ok: false, error: 'The human check did not pass. Please try again.' };
  }
  return { ok: true };
}

async function listByPrefix(kv, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor, limit: 100 });
    for (const k of page.keys) {
      const v = await kv.get(k.name, 'json');
      if (v) out.push(v);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const H = cors(origin);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: H });
    if (!env || !env.REVIEWS) {
      return json({ error: 'KV namespace REVIEWS is not bound to this Worker' }, 500, H);
    }

    /* ---- public: published reviews --------------------------------------- */
    if (request.method === 'GET' && path === '/') {
      const items = await listByPrefix(env.REVIEWS, 'approved:');
      const shown = items.map((r) => ({ id: r.id, n: r.name, r: r.rating, t: r.text, at: r.at }));
      const avg = shown.length
        ? Math.round((shown.reduce((a, b) => a + b.r, 0) / shown.length) * 10) / 10
        : null;
      return json({ count: shown.length, average: avg, reviews: shown }, 200,
        { ...H, 'cache-control': 'public, max-age=30' });
    }

    /* ---- public: submit --------------------------------------------------- */
    if (request.method === 'POST' && path === '/') {
      if (!originAllowed(origin)) return json({ error: 'origin not allowed' }, 403, H);

      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400, H); }

      // Honeypot: a real person never fills a field they cannot see.
      if (clean(body.website, 50)) return json({ ok: true }, 200, H);

      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

      const human = await humanChecked(env, clean(body.turnstile, 4096), ip);
      if (!human.ok) return json({ error: human.error }, 400, H);

      const rating = Number(body.rating);
      const text = clean(body.text, MAX_TEXT);
      const name = clean(body.name, MAX_NAME) || 'Anonymous';

      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return json({ error: 'Please choose a rating from 1 to 5 stars.' }, 400, H);
      }
      if (text.length < 4) {
        return json({ error: 'Please add a few words about your experience.' }, 400, H);
      }
      if (EMAIL_RE.test(text) || EMAIL_RE.test(name)) {
        return json({ error: 'Please remove the email address — this page is public. '
          + 'To reach us, use the address in the footer instead.' }, 400, H);
      }
      if (PHONE_RE.test(text) || PHONE_RE.test(name)) {
        return json({ error: 'Please remove the phone number — this page is public.' }, 400, H);
      }

      // Coarse per-address daily cap, so one person cannot flood the page.
      const day = new Date().toISOString().slice(0, 10);
      const rlKey = `rl:${day}:${ip}`;
      const used = Number(await env.REVIEWS.get(rlKey)) || 0;
      if (used >= MAX_PER_IP_PER_DAY) {
        return json({ error: 'You have already submitted a review today. Thank you!' }, 429, H);
      }
      await env.REVIEWS.put(rlKey, String(used + 1), { expirationTtl: 60 * 60 * 26 });

      const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const record = { id, name, rating, text, at: new Date().toISOString() };
      await env.REVIEWS.put(`approved:${id}`, JSON.stringify(record));

      return json({ ok: true, message: 'Thank you — your review is on the page.', review: record }, 200, H);
    }

    /* ---- moderation ------------------------------------------------------- */
    const key = url.searchParams.get('key') || request.headers.get('X-Admin-Key') || '';
    const authed = env.ADMIN_KEY && key && key === env.ADMIN_KEY;

    /* Includes anything left in `pending:` by the older hold-for-approval
       version, so those can still be found and cleared. */
    if (path === '/list' || path === '/pending') {
      if (!authed) return json({ error: 'unauthorised' }, 401, H);
      const live = await listByPrefix(env.REVIEWS, 'approved:');
      const held = await listByPrefix(env.REVIEWS, 'pending:');
      return json({
        count: live.length,
        reviews: live,
        leftoverPending: held,
      }, 200, H);
    }

    if (request.method === 'POST' && path === '/moderate') {
      if (!authed) return json({ error: 'unauthorised' }, 401, H);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400, H); }
      const id = clean(body.id, 60);
      const action = clean(body.action, 20) || 'delete';
      if (!id) return json({ error: 'id required' }, 400, H);
      if (action !== 'delete') return json({ error: 'action must be delete' }, 400, H);

      const inLive = await env.REVIEWS.get(`approved:${id}`);
      const inHeld = await env.REVIEWS.get(`pending:${id}`);
      if (!inLive && !inHeld) return json({ error: 'not found' }, 404, H);

      if (inLive) await env.REVIEWS.delete(`approved:${id}`);
      if (inHeld) await env.REVIEWS.delete(`pending:${id}`);
      return json({ ok: true, action: 'deleted', id }, 200, H);
    }

    /* ================= Our Team =========================================== */

    /* Photos are served from their own URL rather than inlined in the list, so
       the JSON stays small and each image caches on its own. */
    if (request.method === 'GET' && path.startsWith('/team/photo/')) {
      const id = path.slice('/team/photo/'.length);
      const rec = await env.REVIEWS.get(`teamphoto:${id}`, 'json');
      if (!rec) return json({ error: 'not found' }, 404, H);
      const bytes = Uint8Array.from(atob(rec.data), (c) => c.charCodeAt(0));
      return new Response(bytes, {
        headers: {
          ...H,
          'content-type': rec.type || 'image/jpeg',
          /* The id changes whenever the photo does, so this can cache hard. */
          'cache-control': 'public, max-age=31536000, immutable',
        },
      });
    }

    if (request.method === 'GET' && path === '/team') {
      const items = await listByPrefix(env.REVIEWS, 'team:');
      /* Every stored profile is shown. Nothing sets approved:false any more, so
         filtering on it only hid profiles submitted while the earlier
         hold-for-approval build was deployed — which is exactly what happened to
         the first VE who used the form. Delete is the control now, not a flag. */
      const shown = items
        .map((m) => ({
          id: m.id, name: m.name, callsign: m.callsign,
          role: m.role, bio: m.bio,
          photo: m.hasPhoto ? `/team/photo/${m.id}` : null,
        }));
      return json({ count: shown.length, members: shown }, 200,
        { ...H, 'cache-control': 'public, max-age=60' });
    }

    if (request.method === 'POST' && path === '/team') {
      if (!originAllowed(origin)) return json({ error: 'origin not allowed' }, 403, H);

      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400, H); }
      if (clean(body.website, 50)) return json({ ok: true }, 200, H);

      /* The submit code lives only inside the AES-encrypted VE page, so holding
         it is proof of holding the VE passcode. Optional: without the secret set
         the form still works, it is simply not gated. */
      if (env.TEAM_SUBMIT_CODE && clean(body.code, 200) !== env.TEAM_SUBMIT_CODE) {
        return json({ error: 'This form is for PARC volunteer examiners. '
          + 'Please open it from the VE section so it can identify you.' }, 403, H);
      }

      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const human = await humanChecked(env, clean(body.turnstile, 4096), ip);
      if (!human.ok) return json({ error: human.error }, 400, H);

      const name = clean(body.name, MAX_NAME);
      const callsign = clean(body.callsign, MAX_CALLSIGN).toUpperCase();
      const role = clean(body.role, MAX_ROLE);
      const bio = clean(body.bio, MAX_BIO);

      if (name.length < 2) return json({ error: 'Please give the name you would like shown.' }, 400, H);
      if (bio.length < 10) return json({ error: 'Please add a sentence or two about yourself.' }, 400, H);
      if (EMAIL_RE.test(bio) || PHONE_RE.test(bio)) {
        return json({ error: 'Please remove the contact details — this page is public. '
          + 'Candidates reach the team through the address in the footer.' }, 400, H);
      }

      const day = new Date().toISOString().slice(0, 10);
      const rlKey = `rl:team:${day}:${ip}`;
      const used = Number(await env.REVIEWS.get(rlKey)) || 0;
      if (used >= MAX_PER_IP_PER_DAY) {
        return json({ error: 'You have already sent a profile today. Thank you!' }, 429, H);
      }
      await env.REVIEWS.put(rlKey, String(used + 1), { expirationTtl: 60 * 60 * 26 });

      const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

      /* A data: URI from the page's canvas. Decoded here so a malformed one is
         rejected on submit rather than breaking the photo route later. */
      let hasPhoto = false;
      const photo = typeof body.photo === 'string' ? body.photo : '';
      if (photo) {
        const m = photo.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
        if (!m) return json({ error: 'That photo could not be read. Please choose a JPEG or PNG.' }, 400, H);
        const data = m[2];
        if (data.length * 0.75 > MAX_PHOTO_BYTES) {
          return json({ error: 'That photo is too large even after resizing. Please try another.' }, 400, H);
        }
        try { atob(data.slice(0, 64)); } catch {
          return json({ error: 'That photo could not be read.' }, 400, H);
        }
        await env.REVIEWS.put(`teamphoto:${id}`, JSON.stringify({ type: m[1], data }));
        hasPhoto = true;
      }

      const record = {
        id, name, callsign, role, bio, hasPhoto,
        approved: true,
        at: new Date().toISOString(),
      };
      await env.REVIEWS.put(`team:${id}`, JSON.stringify(record));

      return json({ ok: true,
        message: 'Thank you — you are on the team page now.' }, 200, H);
    }

    if (path === '/team/list' || path === '/team/pending') {
      if (!authed) return json({ error: 'unauthorised' }, 401, H);
      const items = await listByPrefix(env.REVIEWS, 'team:');
      return json({
        count: items.length,
        members: items,
        /* Anything left unapproved by the earlier hold-for-approval build. It is
           not on the page; publish it by asking, or delete it. */
        notShown: items.filter((m) => !m.approved),
      }, 200, H);
    }

    if (request.method === 'POST' && path === '/team/moderate') {
      if (!authed) return json({ error: 'unauthorised' }, 401, H);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400, H); }
      const id = clean(body.id, 60);
      const action = clean(body.action, 20);
      if (!id) return json({ error: 'id required' }, 400, H);

      const rec = await env.REVIEWS.get(`team:${id}`, 'json');
      if (!rec) return json({ error: 'not found' }, 404, H);

      if (action === 'show') {
        rec.approved = true;
        await env.REVIEWS.put(`team:${id}`, JSON.stringify(rec));
        return json({ ok: true, action: 'shown', id }, 200, H);
      }
      if (action === 'delete') {
        await env.REVIEWS.delete(`team:${id}`);
        if (rec.hasPhoto) await env.REVIEWS.delete(`teamphoto:${id}`);
        return json({ ok: true, action: 'deleted', id }, 200, H);
      }
      return json({ error: 'action must be delete or show' }, 400, H);
    }

    return json({ error: 'not found' }, 404, H);
  },
};
