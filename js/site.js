/**
 * Site chrome: mobile menu + dropdown behaviour.
 *
 * Progressive enhancement. css/site.css opens submenus on :hover at >=901px,
 * so with JS blocked the desktop nav still works. This file adds click-to-open
 * (which is what touch devices need) and the aria-expanded state that makes the
 * menus usable with a keyboard or screen reader.
 */
(function () {
  'use strict';

  var nav = document.querySelector('.site-nav');
  if (!nav) return;

  var toggle = nav.querySelector('.nav-toggle');
  var subs = Array.prototype.slice.call(nav.querySelectorAll('.has-sub'));

  function closeAllSubs(except) {
    subs.forEach(function (li) {
      if (li === except) return;
      li.classList.remove('is-open');
      var b = li.querySelector('.nav-sub-toggle');
      if (b) b.setAttribute('aria-expanded', 'false');
    });
  }

  /* --- mobile menu --- */
  if (toggle) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open) closeAllSubs();
    });
  }

  /* --- dropdowns --- */
  subs.forEach(function (li) {
    var btn = li.querySelector('.nav-sub-toggle');
    if (!btn) return;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = !li.classList.contains('is-open');
      closeAllSubs(li);
      li.classList.toggle('is-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });

  document.addEventListener('click', function (e) {
    if (!nav.contains(e.target)) closeAllSubs();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    closeAllSubs();
    if (nav.classList.contains('is-open') && toggle) {
      nav.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.focus();
    }
  });

  /* Reset mobile state when resizing up to the desktop layout, so a menu left
     open on a phone doesn't strand the desktop nav in a half-open state. */
  var mq = window.matchMedia('(min-width: 901px)');
  var onChange = function (e) {
    if (!e.matches) return;
    nav.classList.remove('is-open');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    closeAllSubs();
  };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
})();

/* The checklist is designed to be printed and ticked off the day before an exam.
   The button is progressive enhancement: without JavaScript the page still
   prints from the browser's own menu, so nothing is lost. */
(function () {
  var block = document.querySelector('.checklist-block');
  if (!block) return;

  /* Print the checklist, not the page it lives on. The class scopes a print
     rule that hides everything else; afterprint drops it again so the page is
     unchanged on screen. beforeprint covers Ctrl+P as well as the button. */
  /* Mark every sibling of every ancestor, so only the checklist's own branch of
     the tree survives the print rule. Keeping it in normal flow is what lets it
     run to a second page — Firefox will not paginate an absolutely positioned
     element, it just clips it. */
  function isolate(on) {
    var node = block;
    while (node && node !== document.body) {
      var kids = node.parentNode.children;
      for (var i = 0; i < kids.length; i++) {
        if (kids[i] !== node) kids[i].classList.toggle('print-hide', on);
      }
      node = node.parentNode;
    }
    document.body.classList.toggle('print-checklist-only', on);
  }

  var btn = document.getElementById('print-checklist');
  if (btn) {
    btn.addEventListener('click', function () {
      isolate(true);
      window.print();
      /* Firefox returns from print() before afterprint fires reliably in some
         versions, so restore on a timer as well. Both paths are idempotent. */
      setTimeout(function () { isolate(false); }, 1000);
    });
  }
  window.addEventListener('afterprint', function () { isolate(false); });

  /* Remember ticks on this device, so the list can be worked through the night
     before and still be there in the morning. Per-browser only; nothing is sent
     anywhere. Wrapped because storage throws outright in some privacy modes. */
  var KEY = 'parc-checklist';
  var boxes = block.querySelectorAll('input[type="checkbox"]');
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { saved = {}; }

  Array.prototype.forEach.call(boxes, function (box, i) {
    box.setAttribute('data-i', i);
    if (saved[i]) box.checked = true;
    box.addEventListener('change', function () {
      saved[i] = box.checked;
      try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) { /* not fatal */ }
      if (reset) reset.hidden = !Array.prototype.some.call(boxes, function (b) { return b.checked; });
    });
  });

  var reset = document.getElementById('checklist-reset');
  if (reset) {
    reset.hidden = !Array.prototype.some.call(boxes, function (b) { return b.checked; });
    reset.addEventListener('click', function () {
      Array.prototype.forEach.call(boxes, function (b) { b.checked = false; });
      saved = {};
      try { localStorage.removeItem(KEY); } catch (e) { /* not fatal */ }
      reset.hidden = true;
    });
  }
})();

/**
 * Where did this visitor come from? Recorded once per visit and passed to
 * Calendly with the booking, so scheduled exams can be counted by source -
 * "8 visits from ARRL, 3 booked" - without anyone changing the links that point
 * here. ARRL, HamRadioPrep and HamStudy link to us from their own sites, so tags
 * on those links were never an option; the referrer is.
 *
 * Privacy governs every line. Only the referring site's name is kept (arrl.org),
 * never its full address, which can carry search terms. It lives in
 * sessionStorage: per tab, gone when the tab closes, no cookie, nothing that
 * identifies anyone. Calendly stores it with the booking as a utm_* tag, which is
 * how its Scheduled Events filter groups them. The schedule page asks minors for
 * a date of birth; that never leaves the browser, and this must never carry it.
 */
(function () {
  'use strict';

  var KEY = 'parc-src';
  var TAGS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

  /* A narrow alphabet, so a crafted link cannot put anything else into the
     booking URL. Calendly caps values at 255 characters; 100 is plenty. */
  function clean(v) {
    return String(v || '').toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  }

  function read() {
    try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }

  /* The first source in a visit wins. Every page after the first has this site
     as its referrer, which must not overwrite ARRL. Tags on the link, where we
     control it, beat the referrer. */
  if (!read()) {
    var src = {};
    var q = new URLSearchParams(location.search);
    TAGS.forEach(function (t) { var v = clean(q.get(t)); if (v) src[t] = v; });
    if (!src.utm_source) {
      var host = '';
      try { host = document.referrer ? new URL(document.referrer).hostname : ''; } catch (e) { host = ''; }
      host = host.replace(/^www\./, '');
      if (host && host !== location.hostname.replace(/^www\./, '')) {
        src.utm_source = clean(host);
        src.utm_medium = src.utm_medium || 'referral';
      } else {
        src.utm_source = 'direct';
      }
    }
    try { sessionStorage.setItem(KEY, JSON.stringify(src)); } catch (e) { /* not fatal */ }
  }

  /* Add the visit's tags to a Calendly link; anything else is returned as-is.
     schedule.js calls this for the time-slot links it draws. */
  function tag(url) {
    var src = read();
    if (!src) return url;
    try {
      var u = new URL(url);
      if (!/(^|\.)calendly\.com$/.test(u.hostname)) return url;
      TAGS.forEach(function (t) { if (src[t] && !u.searchParams.has(t)) u.searchParams.set(t, src[t]); });
      return u.toString();
    } catch (e) { return url; }
  }
  window.parcTagBooking = tag;

  /* Calendly links already in the page - the schedule page's fallback, and any
     others - get the same tags. Time-slot links are drawn later by schedule.js. */
  function decorate() {
    Array.prototype.forEach.call(document.querySelectorAll('a[href*="calendly.com"]'), function (a) {
      a.href = tag(a.href);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', decorate);
  else decorate();
})();
