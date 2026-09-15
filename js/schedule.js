/**
 * PARC schedule — one merged availability calendar across every exam session.
 *
 * WHAT THIS REPLACED, AND WHY
 * First the page stacked seven Calendly iframes (~4,400px of scrolling). Then it
 * put them behind seven tabs, which was no better: you still had to click
 * through seven calendars and compare by eye, and the embedded iframes clipped.
 * Both versions made the candidate do the merging.
 *
 * This does the merging for them: every session's availability in ONE month
 * grid, duplicate start times collapsed, filterable, in the viewer's own
 * timezone. Picking a time links straight to the right Calendly page to book.
 *
 * DATA
 * Prefers a live Cloudflare Worker when data-availability-endpoint is set;
 * otherwise falls back to data/availability.json, refreshed by
 * `node tools/fetch-availability.mjs`. Same JSON shape either way.
 *
 * Availability loads a month at a time, as the candidate moves through the
 * calendar. It used to load the next three weeks once, at the start, so a
 * candidate looking at October saw only its first few days and November stayed
 * empty however many sessions were open. See loadMonth().
 *
 * The snapshot can be stale, so this is a FINDER, never the source of truth —
 * Calendly decides what is actually bookable at the moment of booking.
 */
(function () {
  'use strict';

  /** Candidates at or under this age are shown youth sessions.
   *  NOTE: ARRL VEC youth eligibility normally stops at UNDER 18. Change this
   *  to 17 if an 18-year-old should not be offered the youth calendar. */
  var YOUTH_MAX_AGE = 18;

  var root = document.getElementById('schedule');
  if (!root) return;


  /**
   * Site root, derived from this script's own URL.
   *
   * The site runs at the domain root in production (parcradio.net) but at a
   * subpath when a fork publishes it for review
   * (…github.io/parc-website-beta/). Hard-coding "/data/…" breaks the second
   * case; deriving the root from where this file was loaded from works in both
   * with nothing to configure.
   */
  var BASE = (function () {
    var s = document.currentScript;
    if (!s) {
      var all = document.getElementsByTagName('script');
      for (var i = all.length - 1; i >= 0; i--) {
        if (/\/js\/[a-z-]+\.js(\?|$)/.test(all[i].src)) { s = all[i]; break; }
      }
    }
    return s && s.src ? s.src.replace(/js\/[^/]+$/, '') : '/';
  })();

  var WORKER_URL = (root.getAttribute('data-availability-endpoint') || '').trim();
  var SNAPSHOT_URL = BASE + 'data/availability.json';
  var BOOK_DIRECT = 'https://calendly.com/parctesting';
  /* Every link that opens a new tab says so to screen readers; the page's other
     new-tab links carry the same text (tools/check-links.mjs enforces it). */
  var NEW_TAB = '<span class="sr-only"> (opens in a new tab)</span>';
  var GATE_KEY = 'parc-schedule-audience';

  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];

  var DAY_MS = 86400000;

  /* How far ahead the calendar goes. The Worker serves months up to twelve out. */
  var MONTHS_AHEAD = 12;

  /* The widest window a Worker older than month= support can return: Calendly
     refuses spans much past a month. The page asks for it alongside month=, so
     an older Worker, which ignores month=, still returns as much as it can. */
  var LEGACY_DAYS = 35;

  /* A month loads once the candidate stops on it. Clicking through five months to
     reach the one they want should fetch that one, not all five: each month is
     several calls to Calendly, which throttles hard. */
  var SETTLE_MS = 350;
  var settleTimer = null;

  /* Time-of-day buckets, so "I can only test after work" is one click.
     Listed in clock order across a single day. "Late night" used to wrap from
     10pm round to 6am, which lumped a 2am slot in with an 11pm one — very
     different propositions for a candidate. Split at midnight instead. */
  var BANDS = [
    { id: 'earlymorning', label: 'Early morning', hint: '12–6am', from: 0,  to: 6  },
    { id: 'morning',      label: 'Morning',       hint: '6am–12pm',     from: 6,  to: 12 },
    { id: 'afternoon',    label: 'Afternoon',     hint: '12–5pm',     from: 12, to: 17 },
    { id: 'evening',      label: 'Evening',       hint: '5–10pm',     from: 17, to: 22 },
    { id: 'latenight',    label: 'Late night',    hint: '10pm–12am', from: 22, to: 24 }
  ];

  var state = {
    audience: null, data: null, tz: guessTz(),
    month: null, selectedDay: null, youthOnly: false, live: false,
    sessions: {},          // letter -> enabled
    bands: {},             // band id -> enabled
    index: {},             // slot instant, as UTC ISO -> merged slot
    months: {},            // 'YYYY-MM' -> queued | loading | live | incomplete | snapshot | partial | unavailable | failed
    partialUntil: {},      // 'YYYY-MM' -> ms: the loaded data for that month stops here
    pending: {},           // 'YYYY-MM' -> the load in flight
    coverage: [],          // { from, to, source }: spans an older Worker or the snapshot covered
    monthAware: null,      // does the Worker answer month=? unknown until it first replies
    monthOpen: 0,          // future times in the month on screen, before time-of-day filters
    staleAt: {},           // 'YYYY-MM' -> when times the Worker served from its fallback copy were checked
    snapshotTried: false,
    snapshotGenerated: null
  };

  /* "America/Chicago" is an IANA identifier, not something a candidate in
     Alabama recognises. Ask the browser for the real display name, which tracks
     daylight saving on its own, and shorten it to "Central time". The map is
     the fallback for engines that return an abbreviation instead. */
  var ZONE_NAMES = {
    'America/New_York': 'Eastern time',
    'America/Chicago': 'Central time',
    'America/Denver': 'Mountain time',
    'America/Phoenix': 'Arizona time',
    'America/Los_Angeles': 'Pacific time',
    'America/Anchorage': 'Alaska time',
    'Pacific/Honolulu': 'Hawaii time'
  };

  function zoneLabel(tz) {
    try {
      var parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'long' })
        .formatToParts(new Date());
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'timeZoneName') {
          var n = parts[i].value;
          if (/Standard Time|Daylight Time/.test(n)) {
            return n.replace(/\s*(Standard|Daylight)\s+Time$/, ' time');
          }
          if (n && !/^GMT|^UTC/.test(n)) return n;
        }
      }
    } catch (e) { /* fall through to the map */ }
    return ZONE_NAMES[tz] || tz.split('/').pop().replace(/_/g, ' ');
  }

  function guessTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago'; }
    catch (e) { return 'America/Chicago'; }
  }

  /* ---- date helpers (all timezone-aware) -------------------------------- */
  /* One formatter per zone and kind, built once and reused. Constructing an
     Intl.DateTimeFormat costs far more than calling one, and a month of
     availability is thousands of calls per render. */
  var FORMATS = {};
  function formatter(kind, tz) {
    var k = kind + '|' + tz;
    if (!FORMATS[k]) {
      FORMATS[k] = kind === 'day'
        /* "2026-08-22" for an instant, as seen in tz. en-CA gives ISO-ish order. */
        ? new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
        /* hourCycle h23 rather than hour12:false. Several Safari and Firefox builds
           read hour12:false as h24 and return "24" for midnight, which would file a
           midnight session under Late night instead of Early morning — and PARC runs
           a midnight calendar. The modulo in hourIn covers engines that ignore it. */
        : kind === 'hour'
          ? new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' })
          : new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    }
    return FORMATS[k];
  }
  function dayKey(d, tz) { return formatter('day', tz).format(d); }
  function hourIn(d, tz) {
    var h = Number(formatter('hour', tz).format(d));
    return isNaN(h) ? 0 : h % 24;
  }
  function timeLabel(d, tz) { return formatter('time', tz).format(d); }
  function bandOf(hour) {
    for (var i = 0; i < BANDS.length; i++) {
      var b = BANDS[i];
      if (b.from < b.to ? (hour >= b.from && hour < b.to) : (hour >= b.from || hour < b.to)) return b.id;
    }
    return 'latenight';
  }

  /* ---- months ----------------------------------------------------------- */
  function monthKey(mo) { return mo.y + '-' + String(mo.m + 1).padStart(2, '0'); }
  function monthOf(d, tz) {
    var k = dayKey(d, tz);
    return { y: Number(k.slice(0, 4)), m: Number(k.slice(5, 7)) - 1 };
  }
  function thisMonth() { return monthOf(new Date(), state.tz); }
  function monthIndex(mo) { return mo.y * 12 + mo.m; }
  function addMonths(mo, n) { var i = monthIndex(mo) + n; return { y: Math.floor(i / 12), m: i % 12 }; }
  function sameMonth(a, b) { return !!a && !!b && a.y === b.y && a.m === b.m; }
  /** A month as UTC instants. With margin, a day wider each side, which puts
   *  every US zone's view of the month inside the span. */
  function monthSpan(mo, margin) {
    var pad = margin ? DAY_MS : 0;
    return { from: Date.UTC(mo.y, mo.m, 1) - pad, to: Date.UTC(mo.y, mo.m + 1, 1) + pad };
  }

  /* ---- age gate --------------------------------------------------------- */
  /**
   * PRIVACY — a legal posture, not a preference.
   * The date of birth is read, converted to an age, and dropped. It is never
   * sent to the Worker, to Calendly, to storage, or into a URL. Only the word
   * "youth" or "general" is remembered, for this tab session. The gate invites
   * minors to enter a birthdate, which is the territory COPPA governs; moving
   * that date anywhere changes what this page is under that regulation.
   */
  function ageFrom(y, m, d) {
    var t = new Date(), age = t.getFullYear() - y;
    if (t.getMonth() + 1 < m || (t.getMonth() + 1 === m && t.getDate() < d)) age--;
    return age;
  }
  /* Deliberately NOT remembered.
     The gate is shown on every page load. Remembering the answer meant a
     visitor who once entered a youth date kept seeing youth sessions on every
     later visit, which looked like youth exams showing for everyone. It also
     means nothing derived from a date of birth is stored anywhere at all,
     which is the stronger position for a form minors fill in. */
  function readAudience() { return null; }
  function saveAudience() { /* intentionally does not persist */ }

  function initGate() {
    var mSel = document.getElementById('dob-month');
    var dSel = document.getElementById('dob-day');
    var ySel = document.getElementById('dob-year');
    if (mSel) MONTHS.forEach(function (n, i) { mSel.appendChild(new Option(n, String(i + 1))); });
    if (dSel) for (var d = 1; d <= 31; d++) dSel.appendChild(new Option(String(d), String(d)));
    if (ySel) { var y0 = new Date().getFullYear(); for (var y = y0; y >= 1920; y--) ySel.appendChild(new Option(String(y), String(y))); }

    var existing = readAudience();
    if (existing) { start(existing); return; }

    var form = document.getElementById('age-form');
    var err = document.getElementById('age-error');
    if (form) form.addEventListener('submit', function (e) {
      e.preventDefault();
      var m = +mSel.value, dd = +dSel.value, yy = +ySel.value;
      /* Mark the field that needs attention and move to it, so a screen reader
         user hears what to correct instead of only a status line elsewhere. */
      var sels = [mSel, dSel, ySel];
      sels.forEach(function (s) { s.removeAttribute('aria-invalid'); s.removeAttribute('aria-describedby'); });
      var flag = function (s, msg) {
        err.textContent = msg;
        s.setAttribute('aria-invalid', 'true');
        s.setAttribute('aria-describedby', 'age-error');
        s.focus();
      };
      if (!m || !dd || !yy) { flag(!m ? mSel : !dd ? dSel : ySel, 'Select a month, day and year.'); return; }
      var age = ageFrom(yy, m, dd);
      if (age < 0 || age > 120) { flag(ySel, 'The date entered is not valid.'); return; }
      err.textContent = '';
      var aud = age <= YOUTH_MAX_AGE ? 'youth' : 'general';
      saveAudience(aud);            // the date itself goes no further
      start(aud);
    });
    var skip = document.getElementById('age-skip');
    if (skip) skip.addEventListener('click', function () { saveAudience('general'); start('general'); });
  }

  /* ---- load ------------------------------------------------------------- */
  function start(audience) {
    state.audience = audience;
    document.getElementById('age-gate').hidden = true;
    var cal = document.getElementById('calendars');
    cal.hidden = false;
    setStatus('Loading availability…');

    state.data = { sources: [], slots: [] };
    BANDS.forEach(function (b) { state.bands[b.id] = true; });

    var here = thisMonth();
    loadMonth(here)
      .then(function () {
        /* Open on the first time that can still be booked. Late in a month there
           may be none left in it, so load next month before choosing rather than
           open on an empty grid. The snapshot the page can fall back to always
           holds slots that have already started, so "first" means first future. */
        var first = firstOpen();
        if (state.monthAware !== true ||
            (first && sameMonth(monthOf(new Date(first.start), state.tz), here))) return first;
        return loadMonth(addMonths(here, 1)).then(firstOpen, firstOpen);
      })
      .then(function (first) {
        var base = first ? new Date(first.start) : new Date();
        state.month = monthOf(base, state.tz);
        state.selectedDay = first ? dayKey(base, state.tz) : null;
        buildControls();
        render();
        setStatus('');
      })
      .catch(function () {
        setStatus('');
        document.getElementById('cal-unavailable').hidden = false;
      });
  }

  function firstOpen() {
    var now = Date.now(), slots = state.data.slots;
    for (var i = 0; i < slots.length; i++) {
      if (Date.parse(slots[i].start) > now) return slots[i];
    }
    return null;
  }

  /**
   * Reconcile the two data sources.
   *
   * The Worker labels the youth calendar "YOUTH"; the committed snapshot and
   * every check in this file use "Y". Left unreconciled, a youth candidate on a
   * Worker-backed page gets no Youth badge and — worse — bookingUrl() stops
   * recognising youth sessions and routes them to a general one by seat count,
   * which is the wrong session type for that candidate.
   *
   * Normalising here rather than only in the Worker means the page is correct
   * even if the deployed Worker is an older build.
   */
  function normalize(data) {
    if (!data) return data;
    var isYouth = function (l) { return l === 'Y' || l === 'YOUTH'; };
    (data.sources || []).forEach(function (s) {
      if (isYouth(s.letter)) { s.letter = 'Y'; s.youth = true; s.label = s.label || 'Youth'; }
    });
    (data.slots || []).forEach(function (slot) {
      (slot.sessions || []).forEach(function (x) {
        if (isYouth(x.letter)) x.letter = 'Y';
      });
    });
    return data;
  }

  /**
   * Fold one reply into the merged calendar.
   *
   * `prune` is the span the reply speaks for with authority: anything already held
   * inside it is dropped first, so a time booked since an earlier load does not
   * linger. The margin days a month reply also carries are merged but never
   * pruned, because the neighboring month's own reply is the one that owns them.
   */
  function absorb(data, prune) {
    normalize(data);
    var youth = state.audience === 'youth';
    var have = {};
    state.data.sources.forEach(function (s) { have[s.letter] = true; });
    (data.sources || []).forEach(function (s) {
      if ((!youth && s.youth) || have[s.letter]) return;   // youth-only sessions are hidden from everyone else
      state.data.sources.push(s);
      have[s.letter] = true;
      state.sessions[s.letter] = true;
    });
    if (prune) {
      Object.keys(state.index).forEach(function (k) {
        var t = Date.parse(k);
        if (t >= prune.from && t < prune.to) delete state.index[k];
      });
    }
    (data.slots || []).forEach(function (s) {
      var keep = s.sessions.filter(function (x) { return youth || x.letter !== 'Y'; });
      if (!keep.length) return;
      /* Keyed by the instant, so a time that arrives twice - in two overlapping
         months, or from the snapshot and then the Worker - replaces the earlier
         copy instead of adding to it. Seats are never counted twice. */
      state.index[new Date(s.start).toISOString()] = { start: s.start, sessions: keep,
        remaining: keep.reduce(function (a, b) { return a + (b.remaining || 0); }, 0) };
    });
    state.data.slots = Object.keys(state.index).sort().map(function (k) { return state.index[k]; });
    if (data.generated) state.data.generated = data.generated;
  }

  function getJson(url, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms);
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined).then(
      function (r) { clearTimeout(timer); if (!r.ok) throw 0; return r.json(); },
      function (e) { clearTimeout(timer); throw e; });
  }

  function workerUrl(mo) {
    return WORKER_URL + (WORKER_URL.indexOf('?') === -1 ? '?' : '&') +
      'tz=' + encodeURIComponent(state.tz) +
      '&month=' + monthKey(mo) + '&days=' + LEGACY_DAYS +
      (state.audience === 'youth' ? '&include=youth' : '');
  }

  function loadSnapshot() {
    state.snapshotTried = true;
    return getJson(SNAPSHOT_URL, 10000).then(function (data) {
      absorb(data, null);
      var made = Date.parse(data.generated) || Date.now();
      state.snapshotGenerated = data.generated || null;
      state.coverage.push({ from: made, to: made + (data.days || 21) * DAY_MS, source: 'snapshot' });
    });
  }

  /* A month that failed, or came back with some sessions missing, is worth asking for again. */
  function retryable(status) { return status === 'failed' || status === 'incomplete'; }
  function isLoading(status) { return status === 'loading' || status === 'queued'; }

  /**
   * Make sure a month's times are loaded, then settle what the page can say
   * about that month.
   *
   * A current Worker answers ?month= with that month and echoes it back. An older
   * Worker ignores month= and returns LEGACY_DAYS from today; the missing echo is
   * how that is recognized, and from then on later months are judged by how far
   * that window reaches rather than fetched. If the Worker cannot be reached before
   * anything has loaded, the committed snapshot stands in. None of this can block
   * booking: every time links to Calendly, and a month that cannot be shown says
   * so and links there too.
   */
  function loadMonth(mo) {
    var key = monthKey(mo);
    if (state.pending[key]) return state.pending[key];
    if (state.months[key] && !retryable(state.months[key])) return Promise.resolve();
    state.months[key] = 'loading';

    var job;
    if (WORKER_URL && state.monthAware !== false) {
      job = getJson(workerUrl(mo), 10000).then(function (data) {
        state.live = true;
        if (data && data.month === key) {
          state.monthAware = true;
          absorb(data, monthSpan(mo, false));
          /* Some calendars answered and some did not. What arrived is real, but times
             may be missing, and a thin month must not pass for a full one. */
          state.months[key] = data.partial ? 'incomplete' : 'live';
          state.staleAt[key] = data.stale ? (data.checkedAt || data.generated || null) : null;
        } else {
          state.monthAware = false;
          absorb(data, null);
          var now = Date.now();
          state.coverage.push({ from: now, to: now + LEGACY_DAYS * DAY_MS, source: 'live' });
          classify(mo);
        }
      }, function () {
        if (!state.snapshotTried && !state.data.slots.length) {
          return loadSnapshot().then(function () { classify(mo); });
        }
        classify(mo);
        // Nothing loaded reaches this month, and it may be a passing failure: offer a retry.
        if (state.months[key] === 'unavailable') state.months[key] = 'failed';
      });
    } else if (!WORKER_URL && !state.snapshotTried) {
      job = loadSnapshot().then(function () { classify(mo); });
    } else {
      classify(mo);
      job = Promise.resolve();
    }

    state.pending[key] = job.then(
      function () { delete state.pending[key]; },
      function (e) { delete state.pending[key]; state.months[key] = 'failed'; throw e; });
    return state.pending[key];
  }

  /** What the data already loaded can say about a month nobody fetched for it. */
  function classify(mo) {
    var key = monthKey(mo), span = monthSpan(mo, false);
    var from = Math.max(span.from, Date.now()), best = null;
    state.coverage.forEach(function (c) {
      if (c.from <= from + DAY_MS && (!best || c.to > best.to)) best = c;
    });
    if (best && best.to >= span.to) {
      state.months[key] = best.source;
    } else if (best && best.to > from) {
      state.months[key] = 'partial';
      state.partialUntil[key] = best.to;
    } else {
      state.months[key] = 'unavailable';
    }
  }

  function setStatus(msg) {
    var el = document.getElementById('cal-status');
    if (el) { el.textContent = msg || ''; el.hidden = !msg; }
  }

  /* ---- filters ---------------------------------------------------------- */
  function buildControls() {
    /* No per-session filter. Which internal calendar a time belongs to is a PARC
       scheduling detail, not something a candidate should have to reason about —
       they just want a time that works. Every session stays enabled in state so
       bookingUrl() can still resolve the right Calendly event. */

    /* Youth candidates see general sessions too (youth availability can be thin),
       so give them a way to narrow to just the youth ones. Never shown to anyone
       else, who has no youth slots in their data at all. */
    var yWrap = document.getElementById('filter-audience-wrap');
    if (state.audience === 'youth' && yWrap) {
      /* Built here rather than shipped as hidden markup: hidden markup is still
         in View Source and is still picked up by the site search index, so it
         announced the youth calendar to everyone. */
      yWrap.className = 'cal-filter';
      yWrap.innerHTML =
        '<span class=\"cal-filter__label\">Youth</span>' +
        '<div class=\"chips\">' +
        '<button type=\"button\" class=\"chip\" id=\"filter-youth\" aria-pressed=\"false\">' +
        'Youth sessions only</button></div>';
      var yBtn = document.getElementById('filter-youth');
      yBtn.addEventListener('click', function () {
        state.youthOnly = !state.youthOnly;
        yBtn.classList.toggle('is-on', state.youthOnly);
        yBtn.setAttribute('aria-pressed', String(state.youthOnly));
        render();
      });
    }

    var bBox = document.getElementById('filter-bands');
    bBox.innerHTML = '';
    BANDS.forEach(function (band) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip is-on';
      b.setAttribute('aria-pressed', 'true');
      b.innerHTML = band.label + ' <span class="chip__hint">' + band.hint + '</span>';
      b.addEventListener('click', function () {
        state.bands[band.id] = !state.bands[band.id];
        b.classList.toggle('is-on', state.bands[band.id]);
        b.setAttribute('aria-pressed', String(state.bands[band.id]));
        render();
      });
      bBox.appendChild(b);
    });

    /* The browser already knows where the candidate is, so times appear in their
       own zone without anyone being asked. The picker stays available behind a
       "change" link, for a browser that has it wrong or somebody booking from a
       different zone to the one they will test in. */
    var tzSel = document.getElementById('tz-select');
    var tzName = document.getElementById('tz-name');
    var tzChange = document.getElementById('tz-change');
    if (tzName) tzName.textContent = zoneLabel(state.tz);
    if (tzSel) {
      tzSel.innerHTML = '';
      Object.keys(ZONE_NAMES).forEach(function (z) {
        tzSel.appendChild(new Option(ZONE_NAMES[z], z));
      });
      if (![].some.call(tzSel.options, function (o) { return o.value === state.tz; })) {
        tzSel.appendChild(new Option(zoneLabel(state.tz), state.tz));
      }
      tzSel.value = state.tz;
      tzSel.addEventListener('change', function () {
        state.tz = tzSel.value;
        if (tzName) tzName.textContent = zoneLabel(state.tz);
        render();
      });
    }
    if (tzChange && tzSel) {
      tzChange.addEventListener('click', function () {
        var open = !tzSel.hidden;
        tzSel.hidden = open;
        tzChange.setAttribute('aria-expanded', String(!open));
        if (!open) tzSel.focus();
      });
    }

    document.getElementById('cal-prev').addEventListener('click', function () { shiftMonth(-1); });
    document.getElementById('cal-next').addEventListener('click', function () { shiftMonth(1); });
  }

  /** Move the calendar, and load the month it lands on once the candidate stops there. */
  function shiftMonth(n) {
    var target = addMonths(state.month, n), here = thisMonth();
    if (monthIndex(target) < monthIndex(here) || monthIndex(target) > monthIndex(here) + MONTHS_AHEAD) return;
    // Passing through a month without stopping leaves it unloaded, not stuck "loading".
    if (state.months[monthKey(state.month)] === 'queued') delete state.months[monthKey(state.month)];
    state.month = target;
    clearTimeout(settleTimer);
    var st = state.months[monthKey(target)];
    if (!st || retryable(st)) {
      state.months[monthKey(target)] = 'queued';
      settleTimer = setTimeout(function () {
        if (!sameMonth(state.month, target) || state.months[monthKey(target)] !== 'queued') return;
        delete state.months[monthKey(target)];
        ensureMonth(target);
        render();
      }, SETTLE_MS);
    }
    render();
  }

  function ensureMonth(mo) {
    var st = state.months[monthKey(mo)];
    if (st && !retryable(st)) return;
    var redraw = function () { if (sameMonth(state.month, mo)) render(); };
    loadMonth(mo).then(redraw, redraw);
  }

  /** Slots in the month on screen passing the current filters, grouped by day. */
  function visibleByDay() {
    var out = {};
    var prefix = monthKey(state.month), span = monthSpan(state.month, true);
    /* A slot that has already started cannot be booked, and offering one sends a
       candidate to a Calendly page that turns them away. Checked on every render,
       so a tab left open overnight drops them as well. */
    var now = Date.now();
    state.monthOpen = 0;
    state.data.slots.forEach(function (s) {
      var t = Date.parse(s.start);
      /* Only the month on screen, with a day either side for other zones. Every
         loaded month is held, and formatting all of them on every render would
         make the calendar sluggish once a candidate has looked a few months out. */
      if (t < span.from || t >= span.to || t <= now) return;
      var d = new Date(t);
      var keep = s.sessions.filter(function (x) { return state.sessions[x.letter]; });
      if (!keep.length) return;
      var k = dayKey(d, state.tz);
      if (k.slice(0, 7) === prefix) state.monthOpen++;
      if (state.youthOnly) keep = keep.filter(function (x) { return x.letter === 'Y'; });
      if (!keep.length) return;
      if (!state.bands[bandOf(hourIn(d, state.tz))]) return;
      (out[k] = out[k] || []).push({ start: s.start, date: d, sessions: keep,
        remaining: keep.reduce(function (a, b) { return a + (b.remaining || 0); }, 0) });
    });
    return out;
  }

  /** The days of the month on screen that have times, in order. */
  function daysOf(byDay) {
    var prefix = monthKey(state.month);
    return Object.keys(byDay).filter(function (k) { return k.slice(0, 7) === prefix; }).sort();
  }

  /* ---- render ----------------------------------------------------------- */
  function render() {
    var byDay = visibleByDay();
    resolveSelectedDay(byDay);
    renderGrid(byDay);
    renderDay(byDay);
    renderSummary(byDay);
    renderFreshness();
  }

  /** The one line above the calendar.
   *
   *  No running total. A candidate wants a time that suits them, not a tally of
   *  how many exist. What earns this line: a month still loading, a month that
   *  cannot be shown (which must say so, and where to book instead, rather than
   *  look like a month with no sessions), the empty states, and for youth
   *  candidates what the Youth badge means. */
  function renderSummary(byDay) {
    var sum = document.getElementById('cal-summary');
    if (!sum) return;
    var key = monthKey(state.month), status = state.months[key], name = MONTHS[state.month.m];
    var total = daysOf(byDay).reduce(function (a, k) { return a + byDay[k].length; }, 0);
    var direct = function (text) {
      return '<a href="' + BOOK_DIRECT + '" target="_blank" rel="noopener">' + text + NEW_TAB + '</a>';
    };
    var html = '';
    if (isLoading(status)) {
      html = 'Loading times for ' + name + '…';
    } else if (status === 'failed') {
      html = 'Times for ' + name + ' could not be loaded. ' +
        '<button type="button" class="tz-change" id="cal-retry">Try Again</button>, or ' +
        direct('book directly on Calendly') + '.';
    } else if (status === 'unavailable') {
      html = 'Times for ' + name + ' cannot be displayed at this time. Every session may still be ' +
        direct('booked directly on Calendly') + '.';
    } else if (status === 'partial') {
      html = 'Times after ' + new Intl.DateTimeFormat('en-US', { timeZone: state.tz, month: 'long', day: 'numeric' })
        .format(new Date(state.partialUntil[key] - DAY_MS)) +
        ' cannot be displayed at this time. Later sessions may still be ' + direct('booked directly on Calendly') + '.';
    } else if (status === 'incomplete') {
      html = 'Some sessions for ' + name + ' could not be loaded, so some times may be missing. ' +
        '<button type="button" class="tz-change" id="cal-retry">Try Again</button>, or ' +
        direct('book directly on Calendly') + '.';
    } else if (!total && !state.monthOpen) {
      html = 'No examination times are open for ' + name + ' at this time.';
    } else if (!total) {
      html = 'No times match the selected filters. Change the filters to see more times.';
    } else if (state.audience === 'youth' && !state.youthOnly) {
      /* Says which sessions are open to them, not what they cost. Terms are
         settled at booking; stating them here would invite people to work the
         date of birth backwards from the answer. */
      html = 'Sessions for candidates 18 and under are marked “Youth”.';
    }
    sum.innerHTML = html;
    sum.hidden = !html;
    var retry = document.getElementById('cal-retry');
    if (retry) retry.addEventListener('click', function () { ensureMonth(state.month); render(); });
  }

  /** Say plainly how old this data is.
   *
   *  When served from the build-time snapshot rather than the live Worker, the
   *  numbers can lag reality. A candidate deserves to know that before they
   *  click, rather than discovering it on Calendly's booking page. Anything
   *  older than a day says so out loud. */
  function renderFreshness() {
    var el = document.getElementById('cal-freshness');
    if (!el) return;

    /* Live months are fetched when viewed, so a "checked at" timestamp would
       always read "just now" and is noise. The line exists only to disclose
       that the committed snapshot can be out of date, so it shows only for a
       month whose times came from the snapshot. No Worker, no live data:
       Calendly's availability endpoint sends no Access-Control-Allow-Origin
       header, so a browser cannot call it. */
    var key = monthKey(state.month), status = state.months[key];
    /* A live month the Worker could only answer from its fallback copy, because
       Calendly refused it just then. Say when those times were checked. */
    if ((status === 'live' || status === 'incomplete') && state.staleAt[key]) {
      el.className = 'cal-freshness is-stale';
      el.textContent = 'Some of these times were last checked ' +
        new Date(state.staleAt[key]).toLocaleString('en-US',
          { timeZone: state.tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) +
        ' and may no longer be available. Calendly confirms availability at booking.';
      el.hidden = false;
      return;
    }
    if (status !== 'snapshot' || !state.snapshotGenerated) {
      el.hidden = true; el.textContent = ''; return;
    }
    var ageMs = Date.now() - new Date(state.snapshotGenerated).getTime();
    var hours = ageMs / 3600000;
    var when = new Date(state.snapshotGenerated).toLocaleString('en-US',
      { timeZone: state.tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    if (hours < 24) {
      el.className = 'cal-freshness';
      el.textContent = 'Times last checked ' + when + '. Calendly confirms availability at booking.';
    } else {
      el.className = 'cal-freshness is-stale';
      el.textContent = 'Availability last checked ' + when + ' (' + Math.round(hours / 24) +
        ' day' + (Math.round(hours / 24) === 1 ? '' : 's') + ' ago). Some of these times may ' +
        'no longer be available. Calendly confirms availability at booking.';
    }
    el.hidden = false;
  }

  function renderGrid(byDay) {
    var y = state.month.y, m = state.month.m;
    /* The heading is a live region, so a new month is announced. Rewriting the
       same text on every day selection would announce it again. */
    var monthEl = document.getElementById('cal-month');
    if (monthEl.textContent !== MONTHS[m] + ' ' + y) monthEl.textContent = MONTHS[m] + ' ' + y;

    /* Nothing before this month can be booked, and the Worker serves twelve
       months out, so the arrows stop at both ends rather than lead to empty grids. */
    var at = monthIndex(state.month), here = monthIndex(thisMonth());
    document.getElementById('cal-prev').disabled = at <= here;
    document.getElementById('cal-next').disabled = at >= here + MONTHS_AHEAD;

    var grid = document.getElementById('cal-grid');
    grid.setAttribute('aria-busy', isLoading(state.months[monthKey(state.month)]) ? 'true' : 'false');
    grid.innerHTML = '';
    DAY_NAMES.forEach(function (n) {
      var h = document.createElement('div');
      h.className = 'cal-head'; h.textContent = n;
      grid.appendChild(h);
    });

    var first = new Date(y, m, 1);
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    for (var i = 0; i < first.getDay(); i++) {
      var pad = document.createElement('div');
      pad.className = 'cal-cell is-empty';
      grid.appendChild(pad);
    }
    var todayKey = dayKey(new Date(), state.tz);
    for (var d = 1; d <= daysInMonth; d++) {
      var key = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      var slots = byDay[key] || [];
      var cell = document.createElement(slots.length ? 'button' : 'div');
      cell.className = 'cal-cell';
      if (slots.length) {
        cell.type = 'button';
        cell.classList.add('has-slots');
        // Three density steps, so a glance shows where the room is.
        cell.classList.add(slots.length >= 30 ? 'lvl-3' : slots.length >= 10 ? 'lvl-2' : 'lvl-1');
        if (key === state.selectedDay) cell.classList.add('is-selected');
        cell.setAttribute('aria-pressed', key === state.selectedDay ? 'true' : 'false');
        cell.setAttribute('data-day', key);
        cell.setAttribute('aria-label', MONTHS[m] + ' ' + d + ', ' + slots.length +
          (slots.length === 1 ? ' time' : ' times') + ' available');
        (function (k) {
          cell.addEventListener('click', function (e) {
            state.selectedDay = k;
            render();
            /* render() rebuilt the grid, so the button that had focus is gone and
               focus would drop to the top of the page. From the keyboard (detail 0)
               the next step is choosing a time, so focus moves to the times; a
               click or tap stays on the day. */
            var title = document.getElementById('cal-day-title');
            var again = document.querySelector('#cal-grid [data-day="' + k + '"]');
            if (e.detail === 0 && title) title.focus();
            else if (again) again.focus({ preventScroll: true });
          });
        })(key);
      } else {
        cell.classList.add('is-none');
      }
      if (key === todayKey) cell.classList.add('is-today');
      cell.innerHTML = '<span class="cal-cell__num">' + d + '</span>' +
        (slots.length ? '<span class="cal-cell__count">' + slots.length + '</span>' : '');
      grid.appendChild(cell);
    }
  }

  /** Deep-link straight to Calendly's invitee form for one specific time.
   *
   *  Calendly accepts the slot's ISO start (with offset) as a path segment:
   *    /parctesting/<event-slug>/2026-08-23T13:15:00-05:00?month=…&date=…
   *  which opens "Enter Booking Details" with that time already chosen, rather
   *  than dropping the candidate on the month view to hunt for it again.
   *
   *  When several sessions offer the same time we send them to the one with the
   *  most seats left, so they are least likely to lose it to a race.
   */
  function youthPart(slot) {
    for (var i = 0; i < slot.sessions.length; i++) {
      if (slot.sessions[i].letter === 'Y') return slot.sessions[i];
    }
    return null;
  }

  function bookingUrl(slot) {
    /* A youth candidate must land on the YOUTH calendar whenever one exists at
     * that time. Picking "most seats left" instead would quietly route them to a
     * general session, which is booked and administered differently and is not
     * what they were offered. Seat count only breaks ties among general sessions. */
    var best = (state.audience === 'youth' && youthPart(slot)) || slot.sessions.reduce(
      function (a, b) { return (b.remaining || 0) > (a.remaining || 0) ? b : a; },
      slot.sessions[0]);
    var iso = slot.start;                       // keep the original offset
    var url = 'https://calendly.com/parctesting/' + best.slug + '/' + iso +
              '?month=' + iso.slice(0, 7) + '&date=' + iso.slice(0, 10);
    /* Carry where this visitor came from onto the booking, so Calendly can count
       scheduled exams by source. The capture and tagging live in js/site.js. */
    return window.parcTagBooking ? window.parcTagBooking(url) : url;
  }

  /** The day whose times are shown: the one chosen, or else the month's first day
   *  with times. Settled before the grid is drawn, so the grid marks the same day
   *  the panel shows. The selected day has to belong to the month on screen.
   *  Moving to November with an October day still selected used to leave
   *  October's times beside November's grid. */
  function resolveSelectedDay(byDay) {
    var key = state.selectedDay;
    if (key && byDay[key] && key.slice(0, 7) === monthKey(state.month)) return key;
    var days = daysOf(byDay);
    if (!days.length) return null;
    return (state.selectedDay = days[0]);
  }

  function renderDay(byDay) {
    var panel = document.getElementById('cal-day');
    var key = resolveSelectedDay(byDay);
    if (!key) {
      var loading = isLoading(state.months[monthKey(state.month)]);
      panel.innerHTML = '<p class="cal-day__empty">' +
        (loading ? 'Loading times…' : state.monthOpen ? 'No times match the selected filters.' : 'No times are available this month.') +
        '</p>';
      return;
    }
    var slots = byDay[key].slice().sort(function (a, b) { return a.date - b.date; });
    var heading = new Intl.DateTimeFormat('en-US',
      { timeZone: state.tz, weekday: 'long', month: 'long', day: 'numeric' })
      .format(new Date(slots[0].start));

    var groups = {};
    slots.forEach(function (s) { (groups[bandOf(hourIn(s.date, state.tz))] = groups[bandOf(hourIn(s.date, state.tz))] || []).push(s); });

    var html = '<h3 class="cal-day__title" id="cal-day-title" tabindex="-1">' + heading +
      ' <span class="cal-day__count">' + slots.length + ' time' + (slots.length === 1 ? '' : 's') + '</span></h3>';

    BANDS.forEach(function (band) {
      var g = groups[band.id];
      if (!g || !g.length) return;
      html += '<div class="slot-group"><h4>' + band.label + '</h4><ul class="slot-list">';
      g.forEach(function (s) {
        /* Seat counts are deliberately not displayed. Even from the live Worker
           the number is up to a minute behind Calendly, so "1 seat left" can be
           wrong by the time it is read — and a wrong scarcity claim is worse
           than none. Calendly shows the true count on the booking page.
           The value is still used internally: bookingUrl() picks the session
           with the most room when several offer the same time. */
        var y = state.audience === 'youth' && youthPart(s);
        html += '<li><a class="slot' + (y ? ' slot--youth' : '') + '" href="' + bookingUrl(s) +
          '" target="_blank" rel="noopener">' +
          '<span class="slot__time">' + timeLabel(s.date, state.tz) +
          (y ? ' <span class="slot__youth">Youth</span>' : '') + '</span>' +
          /* A list of links read out of context is only "9:00 AM", "9:15 AM"…
             The day and the new tab are spoken, not shown. */
          '<span class="sr-only"> on ' + heading + ' (opens Calendly in a new tab)</span>' +
          '</a></li>';
      });
      html += '</ul></div>';
    });
    panel.innerHTML = html;
  }

  initGate();
})();
