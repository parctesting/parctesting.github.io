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
  var GATE_KEY = 'parc-schedule-audience';

  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];

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
    bands: {}              // band id -> enabled
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
  /** "2026-08-22" for an instant, as seen in tz. en-CA gives ISO-ish order. */
  function dayKey(d, tz) {
    return new Intl.DateTimeFormat('en-CA',
      { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }
  /* hourCycle h23 rather than hour12:false. Several Safari and Firefox builds
     read hour12:false as h24 and return "24" for midnight, which would file a
     midnight session under Late night instead of Early morning — and PARC runs
     a midnight calendar. The modulo covers engines that ignore hourCycle. */
  function hourIn(d, tz) {
    var h = Number(new Intl.DateTimeFormat('en-US',
      { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(d));
    return isNaN(h) ? 0 : h % 24;
  }
  function timeLabel(d, tz) {
    return new Intl.DateTimeFormat('en-US',
      { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
  }
  function bandOf(hour) {
    for (var i = 0; i < BANDS.length; i++) {
      var b = BANDS[i];
      if (b.from < b.to ? (hour >= b.from && hour < b.to) : (hour >= b.from || hour < b.to)) return b.id;
    }
    return 'latenight';
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
      if (!m || !dd || !yy) { err.textContent = 'Please choose a month, day, and year.'; return; }
      var age = ageFrom(yy, m, dd);
      if (age < 0 || age > 120) { err.textContent = 'Please check that date.'; return; }
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

    fetchData()
      .then(function (data) {
        state.data = normalize(data);
        var youth = audience === 'youth';
        // Youth-only sessions are hidden from everyone else.
        state.data.sources = data.sources.filter(function (s) { return youth || !s.youth; });
        state.data.slots = data.slots
          .map(function (s) {
            var keep = s.sessions.filter(function (x) { return youth || x.letter !== 'Y'; });
            if (!keep.length) return null;
            return { start: s.start, sessions: keep,
                     remaining: keep.reduce(function (a, b) { return a + (b.remaining || 0); }, 0) };
          })
          .filter(Boolean);

        state.data.sources.forEach(function (s) { state.sessions[s.letter] = true; });
        BANDS.forEach(function (b) { state.bands[b.id] = true; });

        var first = state.data.slots[0];
        var base = first ? new Date(first.start) : new Date();
        state.month = { y: Number(dayKey(base, state.tz).slice(0, 4)),
                        m: Number(dayKey(base, state.tz).slice(5, 7)) - 1 };
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

  function fetchData() {
    var youth = state.audience === 'youth';
    if (WORKER_URL) {
      var u = WORKER_URL + (WORKER_URL.indexOf('?') === -1 ? '?' : '&') +
        'tz=' + encodeURIComponent(state.tz) + '&days=21' + (youth ? '&include=youth' : '');
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 5000);
      return fetch(u, ctrl ? { signal: ctrl.signal } : undefined)
        .then(function (r) { clearTimeout(timer); if (!r.ok) throw 0; state.live = true; return r.json(); })
        .catch(function () {
          state.live = false;               // Worker unreachable — fall back
          return fetch(SNAPSHOT_URL).then(function (r) { return r.json(); });
        });
    }
    return fetch(SNAPSHOT_URL).then(function (r) { if (!r.ok) throw 0; return r.json(); });
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

  function shiftMonth(n) {
    var m = state.month.m + n, y = state.month.y;
    if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
    state.month = { y: y, m: m };
    render();
  }

  /** Slots passing the current session + time-of-day filters, grouped by day. */
  function visibleByDay() {
    var out = {};
    state.data.slots.forEach(function (s) {
      var d = new Date(s.start);
      var keep = s.sessions.filter(function (x) { return state.sessions[x.letter]; });
      if (state.youthOnly) keep = keep.filter(function (x) { return x.letter === 'Y'; });
      if (!keep.length) return;
      if (!state.bands[bandOf(hourIn(d, state.tz))]) return;
      var k = dayKey(d, state.tz);
      (out[k] = out[k] || []).push({ start: s.start, date: d, sessions: keep,
        remaining: keep.reduce(function (a, b) { return a + (b.remaining || 0); }, 0) });
    });
    return out;
  }

  /* ---- render ----------------------------------------------------------- */
  function render() {
    var byDay = visibleByDay();
    renderGrid(byDay);
    renderDay(byDay);
    var total = Object.keys(byDay).reduce(function (a, k) { return a + byDay[k].length; }, 0);
    /* No running total. A candidate wants a time that suits them, not a tally
       of how many exist. Two things still earn this line: the empty state
       (otherwise an over-filtered calendar just looks broken with no
       explanation) and, for youth candidates, what the Youth badge means. */
    var sum = document.getElementById('cal-summary');
    if (sum) {
      if (!total) {
        sum.textContent = 'No times match these filters. Try turning another one on.';
      } else if (state.audience === 'youth' && !state.youthOnly) {
        /* Says which sessions are open to them, not what they cost. Terms are
           settled at booking; stating them here would invite people to work the
           date of birth backwards from the answer. */
        sum.textContent = 'Sessions for candidates 18 and under are marked “Youth”.';
      } else {
        sum.textContent = '';
      }
      sum.hidden = !sum.textContent;
    }
    renderFreshness();
  }

  /** Say plainly how old this data is.
   *
   *  When served from the build-time snapshot rather than the live Worker, the
   *  numbers can lag reality. A candidate deserves to know that before they
   *  click, rather than discovering it on Calendly's booking page. Anything
   *  older than a day says so out loud. */
  function renderFreshness() {
    var el = document.getElementById('cal-freshness');
    if (!el || !state.data || !state.data.generated) return;

    /* When a Worker is configured the data IS fetched per page load, so a
       "checked at" timestamp is noise — it would always read "just now".
       The line exists only to disclose that the committed snapshot can be
       out of date, which is a real risk worth telling candidates about.
       No Worker, no live data: Calendly's availability endpoint sends no
       Access-Control-Allow-Origin header, so a browser cannot call it. */
    if (state.live) { el.hidden = true; el.textContent = ''; return; }
    var ageMs = Date.now() - new Date(state.data.generated).getTime();
    var hours = ageMs / 3600000;
    var when = new Date(state.data.generated).toLocaleString('en-US',
      { timeZone: state.tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    if (hours < 24) {
      el.className = 'cal-freshness';
      el.textContent = 'Times last checked ' + when + '. Calendly confirms what is still free when you book.';
    } else {
      el.className = 'cal-freshness is-stale';
      el.textContent = 'Availability last checked ' + when + ' (' + Math.round(hours / 24) +
        ' day' + (Math.round(hours / 24) === 1 ? '' : 's') + ' ago). Some of these times may ' +
        'already be taken \u2014 Calendly will show what is really free when you click through.';
    }
    el.hidden = false;
  }

  function renderGrid(byDay) {
    var y = state.month.y, m = state.month.m;
    document.getElementById('cal-month').textContent = MONTHS[m] + ' ' + y;

    var grid = document.getElementById('cal-grid');
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
        cell.setAttribute('aria-label', slots.length + ' times available on ' + MONTHS[m] + ' ' + d);
        (function (k) { cell.addEventListener('click', function () { state.selectedDay = k; render(); }); })(key);
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
    return 'https://calendly.com/parctesting/' + best.slug + '/' + iso +
           '?month=' + iso.slice(0, 7) + '&date=' + iso.slice(0, 10);
  }

  function renderDay(byDay) {
    var panel = document.getElementById('cal-day');
    var key = state.selectedDay;
    if (!key || !byDay[key]) {
      var anyKey = Object.keys(byDay).sort()[0];
      if (!anyKey) { panel.innerHTML = '<p class="cal-day__empty">No times match these filters.</p>'; return; }
      key = state.selectedDay = anyKey;
    }
    var slots = byDay[key].slice().sort(function (a, b) { return a.date - b.date; });
    var heading = new Intl.DateTimeFormat('en-US',
      { timeZone: state.tz, weekday: 'long', month: 'long', day: 'numeric' })
      .format(new Date(slots[0].start));

    var groups = {};
    slots.forEach(function (s) { (groups[bandOf(hourIn(s.date, state.tz))] = groups[bandOf(hourIn(s.date, state.tz))] || []).push(s); });

    var html = '<h3 class="cal-day__title">' + heading +
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
          '</a></li>';
      });
      html += '</ul></div>';
    });
    panel.innerHTML = html;
  }

  initGate();
})();
