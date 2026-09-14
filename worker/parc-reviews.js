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
 * EDITING A PROFILE. Each profile gets an edit code when it is sent. The
 * volunteer is shown it once and their browser remembers it; this Worker keeps
 * only a hash. The code, not the call sign, is what proves a profile is yours:
 * everyone who can open the VE page can see everyone's call sign. A profile sent
 * before codes existed has none, and `tools/moderate-team.mjs reset-code <id>`
 * issues one to hand over. A call sign can hold only one profile, so sending a
 * second is refused with a pointer to editing. The duplicates that prompted all
 * this were one volunteer sending the form again to change a photo.
 *
 * ROUTES
 *   GET  /            published reviews (public)
 *   POST /            submit a review   (public, Turnstile + rate limited)
 *   GET  /list        every stored review with ids  -- requires ADMIN_KEY
 *   POST /moderate    delete one                    -- requires ADMIN_KEY
 *
 *   GET  /team                   every team profile (public)
 *   GET  /team/photo/<id>[/<v>]  one member's photo (public, immutable)
 *   POST /team                   add a profile, get its edit code (Turnstile)
 *   POST /team/lookup            a profile's details, given its edit code (Turnstile)
 *   POST /team/update            change a profile, given its edit code (Turnstile)
 *   GET  /team/list              every profile with ids   -- requires ADMIN_KEY
 *   POST /team/moderate          delete, or reset-code    -- requires ADMIN_KEY
 *
 * SETUP (see DEPLOY.md)
 *   1. Workers & Pages -> KV -> Create namespace, call it PARC_REVIEWS
 *   2. Bind it to this Worker as the variable REVIEWS
 *   3. Add a secret named ADMIN_KEY       (Settings -> Variables -> Encrypt)
 *   4. Add a secret named TURNSTILE_SECRET from the Turnstile widget
 *   5. Optional: TEAM_SUBMIT_CODE, matching data-team-code on the locked
 *      team-submit page, so only VEs can add or change team profiles
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

/* Edit codes are 12 characters of Crockford base32, which leaves out I, L, O
   and U so nothing reads as a digit it is not. That is 60 random bits. Wrong
   codes are counted per address per day, after the human check, so guessing
   one through the form is not a realistic attack. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_CODE_FAILS_PER_DAY = 10;
const MAX_TEAM_UPDATES_PER_DAY = 20;

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

/* ---- team profile helpers ------------------------------------------------ */

/** A fresh edit code, grouped in fours: XXXX-XXXX-XXXX. */
function newEditCode() {
  let s = '';
  // 256 divides evenly by 32, so masking a random byte keeps every character equally likely.
  for (const b of crypto.getRandomValues(new Uint8Array(12))) s += CODE_ALPHABET[b & 31];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** Uppercase it, drop spaces and dashes, and read O as 0 and I or L as 1, the
    way people copy codes down. Returns '' for anything that cannot be a code. */
function normaliseCode(s) {
  const c = String(s == null ? '' : s).toUpperCase().replace(/[\s-]+/g, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{12}$/.test(c) ? c : '';
}

/* Unsalted SHA-256 is enough: the code is 60 random bits rather than a password
   somebody chose, so there is no list of likely codes to precompute. */
async function codeHash(code) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`parc-team-edit:${code}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* Version 0 is the key every photo had before profiles could be edited. */
const photoKey = (id, ver) => (ver ? `teamphoto:${id}:${ver}` : `teamphoto:${id}`);

/** A profile as the public page sees it. A replaced photo gets a new URL, so a
    browser that cached the old one for a year never shows it again. */
const publicMember = (m) => ({
  id: m.id, name: m.name, callsign: m.callsign, role: m.role, bio: m.bio,
  photo: m.hasPhoto ? `/team/photo/${m.id}${m.photoVer ? '/' + m.photoVer : ''}` : null,
});

/** The fields the add and update forms both send, checked the same way. */
function readProfile(body) {
  const profile = {
    name: clean(body.name, MAX_NAME),
    callsign: clean(body.callsign, MAX_CALLSIGN).toUpperCase(),
    role: clean(body.role, MAX_ROLE),
    bio: clean(body.bio, MAX_BIO),
  };
  if (profile.name.length < 2) return { error: 'Please give the name you would like shown.' };
  if (profile.bio.length < 10) return { error: 'Please add a sentence or two about yourself.' };
  if (EMAIL_RE.test(profile.bio) || PHONE_RE.test(profile.bio)) {
    return { error: 'Please remove the contact details — this page is public. '
      + 'Candidates reach the team through the address in the footer.' };
  }
  return { profile };
}

/** A data: URI from the page's canvas. Decoded here so a malformed one is
    rejected on submit rather than breaking the photo route later. */
function readPhoto(photo) {
  if (typeof photo !== 'string' || !photo) return null;
  const m = photo.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return { error: 'That photo could not be read. Please choose a JPEG or PNG.' };
  if (m[2].length * 0.75 > MAX_PHOTO_BYTES) {
    return { error: 'That photo is too large even after resizing. Please try another.' };
  }
  try { atob(m[2].slice(0, 64)); } catch {
    return { error: 'That photo could not be read.' };
  }
  return { type: m[1], data: m[2] };
}

/* A replaced or removed photo stays readable for ten minutes instead of
   vanishing. The team list is cached for a minute, and a page still holding the
   old list would otherwise show a broken image. */
async function retirePhoto(kv, id, ver) {
  const key = photoKey(id, ver);
  const old = await kv.get(key);
  if (old) await kv.put(key, old, { expirationTtl: 600 });
}

/** The profile, other than `exceptId`, already listed under this call sign. */
async function callsignTaken(kv, callsign, exceptId) {
  if (!callsign) return null;
  const all = await listByPrefix(kv, 'team:');
  return all.find((m) => m.id !== exceptId && String(m.callsign || '').toUpperCase() === callsign) || null;
}

/** Everything a team form POST must pass before anything is read or written:
    an allowed origin, an empty honeypot, the VE submit code and the human
    check. Returns { body, ip }, or { response } to send back as it is. */
async function teamGate(request, env, origin, H) {
  if (!originAllowed(origin)) return { response: json({ error: 'origin not allowed' }, 403, H) };

  let body;
  try { body = await request.json(); } catch { body = null; }
  if (!body || typeof body !== 'object') return { response: json({ error: 'bad request' }, 400, H) };
  if (clean(body.website, 50)) return { response: json({ ok: true }, 200, H) };

  /* The submit code lives only inside the AES-encrypted VE page, so holding
     it is proof of holding the VE passcode. Optional: without the secret set
     the form still works, it is simply not gated. */
  if (env.TEAM_SUBMIT_CODE && clean(body.code, 200) !== env.TEAM_SUBMIT_CODE) {
    return { response: json({ error: 'This form is for PARC volunteer examiners. '
      + 'Please open it from the VE section so it can identify you.' }, 403, H) };
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const human = await humanChecked(env, clean(body.turnstile, 4096), ip);
  if (!human.ok) return { response: json({ error: human.error }, 400, H) };
  return { body, ip };
}

/** The profile an edit code belongs to, or { status, error }. */
async function findByCode(kv, raw, ip) {
  const code = normaliseCode(raw);
  if (!code) {
    return { status: 400, error: 'That does not look like an edit code. '
      + 'It is 12 letters and numbers, in three groups of four.' };
  }

  const day = new Date().toISOString().slice(0, 10);
  const failKey = `rl:teamcode:${day}:${ip}`;
  const fails = Number(await kv.get(failKey)) || 0;
  if (fails >= MAX_CODE_FAILS_PER_DAY) {
    return { status: 429, error: 'Too many wrong codes from this connection today. Please try again tomorrow.' };
  }

  const hash = await codeHash(code);
  const id = await kv.get(`teamcode:${hash}`);
  const rec = id ? await kv.get(`team:${id}`, 'json') : null;
  // The hash on the record is checked too, so an index entry left behind by a reset cannot open a profile.
  if (!rec || rec.editHash !== hash) {
    await kv.put(failKey, String(fails + 1), { expirationTtl: 60 * 60 * 26 });
    return { status: 403, error: 'That code does not match a profile. Please check it and try again. '
      + 'Profiles sent before edit codes existed do not have one yet; ask and one can be sent to you.' };
  }
  return { rec };
}

/** Give a profile a new edit code, retiring any old one. Returns the code. */
async function issueEditCode(kv, rec) {
  const editCode = newEditCode();
  const hash = await codeHash(normaliseCode(editCode));
  if (rec.editHash) await kv.delete(`teamcode:${rec.editHash}`);
  rec.editHash = hash;
  await kv.put(`team:${rec.id}`, JSON.stringify(rec));
  await kv.put(`teamcode:${hash}`, rec.id);
  return editCode;
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
      const parts = path.slice('/team/photo/'.length).split('/');
      if (parts.length > 2 || (parts.length === 2 && !/^\d{1,6}$/.test(parts[1]))) {
        return json({ error: 'not found' }, 404, H);
      }
      const rec = await env.REVIEWS.get(photoKey(parts[0], Number(parts[1] || 0)), 'json');
      if (!rec) return json({ error: 'not found' }, 404, H);
      const bytes = Uint8Array.from(atob(rec.data), (c) => c.charCodeAt(0));
      return new Response(bytes, {
        headers: {
          ...H,
          'content-type': rec.type || 'image/jpeg',
          /* A replaced photo is stored under a new version, so this URL's bytes never change. */
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
      const shown = items.map(publicMember);
      /* canUpdate tells the VE page this Worker accepts edit codes, so it offers
         editing only once this version is the one deployed. */
      return json({ count: shown.length, members: shown, canUpdate: true }, 200,
        { ...H, 'cache-control': 'public, max-age=60' });
    }

    if (request.method === 'POST' && path === '/team') {
      const gate = await teamGate(request, env, origin, H);
      if (gate.response) return gate.response;
      const { body, ip } = gate;

      const read = readProfile(body);
      if (read.error) return json({ error: read.error }, 400, H);
      const photo = readPhoto(body.photo);
      if (photo && photo.error) return json({ error: photo.error }, 400, H);

      const { callsign } = read.profile;
      if (await callsignTaken(env.REVIEWS, callsign, null)) {
        return json({ error: `${callsign} already has a profile on the team page. To change it, `
          + 'choose "Update my profile" and enter your edit code.', exists: true }, 409, H);
      }

      const day = new Date().toISOString().slice(0, 10);
      const rlKey = `rl:team:${day}:${ip}`;
      const used = Number(await env.REVIEWS.get(rlKey)) || 0;
      if (used >= MAX_PER_IP_PER_DAY) {
        return json({ error: 'You have already sent a profile today. Thank you!' }, 429, H);
      }
      await env.REVIEWS.put(rlKey, String(used + 1), { expirationTtl: 60 * 60 * 26 });

      const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      if (photo) await env.REVIEWS.put(photoKey(id, 0), JSON.stringify({ type: photo.type, data: photo.data }));

      const record = {
        id, ...read.profile, hasPhoto: !!photo,
        approved: true,
        at: new Date().toISOString(),
      };
      const editCode = await issueEditCode(env.REVIEWS, record);

      return json({ ok: true, id, editCode,
        message: 'Thank you — you are on the team page now.' }, 200, H);
    }

    if (request.method === 'POST' && path === '/team/lookup') {
      const gate = await teamGate(request, env, origin, H);
      if (gate.response) return gate.response;
      const found = await findByCode(env.REVIEWS, gate.body.editCode, gate.ip);
      if (found.error) return json({ error: found.error }, found.status, H);
      return json({ ok: true, member: publicMember(found.rec) }, 200, H);
    }

    if (request.method === 'POST' && path === '/team/update') {
      const gate = await teamGate(request, env, origin, H);
      if (gate.response) return gate.response;
      const { body, ip } = gate;

      const found = await findByCode(env.REVIEWS, body.editCode, ip);
      if (found.error) return json({ error: found.error }, found.status, H);
      const rec = found.rec;

      const read = readProfile(body);
      if (read.error) return json({ error: read.error }, 400, H);
      const photo = readPhoto(body.photo);
      if (photo && photo.error) return json({ error: photo.error }, 400, H);

      const { callsign } = read.profile;
      if (await callsignTaken(env.REVIEWS, callsign, rec.id)) {
        return json({ error: `${callsign} is already on another profile on the team page.` }, 409, H);
      }

      const day = new Date().toISOString().slice(0, 10);
      const rlKey = `rl:teamupd:${day}:${ip}`;
      const used = Number(await env.REVIEWS.get(rlKey)) || 0;
      if (used >= MAX_TEAM_UPDATES_PER_DAY) {
        return json({ error: 'That is a lot of changes for one day. Please try again tomorrow.' }, 429, H);
      }
      await env.REVIEWS.put(rlKey, String(used + 1), { expirationTtl: 60 * 60 * 26 });

      // `at` stays as it was, so editing a profile does not move it up the page.
      const next = { ...rec, ...read.profile, updatedAt: new Date().toISOString() };
      if (photo) {
        next.photoVer = (rec.photoVer || 0) + 1;
        next.hasPhoto = true;
        await env.REVIEWS.put(photoKey(rec.id, next.photoVer), JSON.stringify({ type: photo.type, data: photo.data }));
        if (rec.hasPhoto) await retirePhoto(env.REVIEWS, rec.id, rec.photoVer);
      } else if (body.removePhoto === true && rec.hasPhoto) {
        next.hasPhoto = false;
        await retirePhoto(env.REVIEWS, rec.id, rec.photoVer);
      }
      await env.REVIEWS.put(`team:${rec.id}`, JSON.stringify(next));

      return json({ ok: true, member: publicMember(next),
        message: 'Saved. Your changes will be on the team page within a minute or two.' }, 200, H);
    }

    if (path === '/team/list' || path === '/team/pending') {
      if (!authed) return json({ error: 'unauthorised' }, 401, H);
      /* Says whether each profile has an edit code, never what its hash is. */
      const items = (await listByPrefix(env.REVIEWS, 'team:'))
        .map(({ editHash, ...m }) => ({ ...m, hasEditCode: !!editHash }));
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
        if (rec.hasPhoto) await env.REVIEWS.delete(photoKey(id, rec.photoVer));
        if (rec.editHash) await env.REVIEWS.delete(`teamcode:${rec.editHash}`);
        return json({ ok: true, action: 'deleted', id }, 200, H);
      }
      /* For a profile sent before edit codes existed, or a lost code. The old
         code stops working at once. */
      if (action === 'reset-code') {
        const editCode = await issueEditCode(env.REVIEWS, rec);
        return json({ ok: true, action: 'code-reset', id, editCode }, 200, H);
      }
      return json({ error: 'action must be delete, show or reset-code' }, 400, H);
    }

    return json({ error: 'not found' }, 404, H);
  },
};
