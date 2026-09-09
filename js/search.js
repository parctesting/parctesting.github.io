/**
 * Site search.
 *
 * The site is static, so there is no server to query. Instead a small index is
 * built at deploy time (tools/build-search-index.mjs) and searched in the
 * browser.
 *
 * The index is 51 KB gzipped, so it is fetched LAZILY — on first focus or first
 * keystroke — and never for the majority of visitors who don't search.
 *
 * It contains public pages only. VE script pages are excluded at build time by
 * three separate checks; nothing here should ever surface exam-script content.
 */
(function () {
  'use strict';

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

  var form = document.getElementById('site-search');
  if (!form) return;
  var input = document.getElementById('site-search-input');
  var panel = document.getElementById('site-search-results');
  var box = document.getElementById('site-search-panel');
  var toggle = document.getElementById('site-search-toggle');
  var closeBtn = document.getElementById('site-search-close');
  if (!input || !panel) return;

  /* The field lives in a panel that drops below the bar rather than sitting in
     it. In the bar it was taking 176px from the navigation, squeezing the menu
     links from 902px down to 626px on a narrower desktop window — the menu was
     paying for the search box. */
  function openBox() {
    if (!box) return;
    box.hidden = false;
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
    load();
    setTimeout(function () { input.focus(); }, 20);
  }
  function closeBox() {
    if (!box) return;
    box.hidden = true;
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    hide();
    input.value = '';
    lastQuery = '';
  }
  if (toggle) toggle.addEventListener('click', function () {
    box && box.hidden ? openBox() : closeBox();
  });
  if (closeBtn) closeBtn.addEventListener('click', function () { closeBox(); if (toggle) toggle.focus(); });

  var docs = null, loading = false, lastQuery = '', activeIndex = -1;

  /* ---- index ------------------------------------------------------------ */
  function load() {
    if (docs || loading) return Promise.resolve();
    loading = true;
    return fetch(BASE + 'data/search-index.json')
      .then(function (r) { if (!r.ok) throw new Error('index ' + r.status); return r.json(); })
      .then(function (d) {
        docs = d.docs || [];
        // Pre-lowercase once rather than on every keystroke.
        docs.forEach(function (x) { x._t = x.t.toLowerCase(); x._b = x.b.toLowerCase();
                                    x._h = (x.h || []).join(' ').toLowerCase(); });
        loading = false;
        if (lastQuery) run(lastQuery);
      })
      .catch(function () {
        loading = false;
        show('<p class="search-msg">Search is unavailable right now. Try the menu above.</p>');
      });
  }

  /* ---- matching --------------------------------------------------------- */
  function terms(q) {
    return q.toLowerCase().split(/[^a-z0-9]+/).filter(function (t) { return t.length > 1; });
  }

  /* Whole-word matching. Plain substring search made "id" hit inside
     "provide" and "candidate", which produced results and snippets that looked
     broken. A prefix match still counts (so "exam" finds "exams") but only at
     the start of a word. */
  function wordRe(t) {
    return new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  }

  function countWord(hay, t) {
    var re = wordRe(t), n = 0;
    while (re.exec(hay) !== null && n < 8) n++;
    return n;
  }

  function score(doc, ts) {
    var s = 0;
    for (var i = 0; i < ts.length; i++) {
      var t = ts[i];
      var inTitle = countWord(doc._t, t);
      var inHead = countWord(doc._h, t);
      var inBody = countWord(doc._b, t);
      if (!inTitle && !inHead && !inBody) return 0;   // every term must appear
      s += inTitle * 12 + inHead * 5 + inBody;
    }
    return s;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** A readable window of text around the first hit, with the term marked. */
  function snippet(doc, ts) {
    var body = doc.b, low = doc._b, at = -1, hit = '';
    for (var i = 0; i < ts.length; i++) {
      var re = wordRe(ts[i]), m = re.exec(low);
      if (m && (at === -1 || m.index < at)) { at = m.index; hit = ts[i]; }
    }
    if (at === -1) return esc(body.slice(0, 150)) + '…';
    var start = Math.max(0, at - 70);
    // don't slice mid-word
    if (start > 0) { var sp = body.indexOf(' ', start); if (sp !== -1 && sp < at) start = sp + 1; }
    var end = Math.min(body.length, at + 130);
    var out = esc(body.slice(start, end));
    var re = new RegExp('\\b(' + hit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\w*)', 'ig');
    out = out.replace(re, '<mark>$1</mark>');
    return (start > 0 ? '…' : '') + out + (end < body.length ? '…' : '');
  }

  /* ---- rendering -------------------------------------------------------- */
  function show(html) {
    panel.innerHTML = html;
    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }
  function hide() {
    panel.hidden = true;
    panel.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    activeIndex = -1;
  }

  function run(q) {
    lastQuery = q;
    if (!q || q.trim().length < 2) { hide(); return; }
    if (!docs) { load(); show('<p class="search-msg">Searching…</p>'); return; }

    var ts = terms(q);
    if (!ts.length) { hide(); return; }

    var hits = [];
    for (var i = 0; i < docs.length; i++) {
      var s = score(docs[i], ts);
      if (s > 0) hits.push({ d: docs[i], s: s });
    }
    hits.sort(function (a, b) { return b.s - a.s; });
    hits = hits.slice(0, 8);

    if (!hits.length) {
      show('<p class="search-msg">Nothing found for &ldquo;' + esc(q) + '&rdquo;. ' +
           'Try a different word, or the <a href="' + BASE + 'pages/faq.html">FAQ</a>.</p>');
      return;
    }

    var html = '<ul class="search-list" role="listbox">';
    hits.forEach(function (h, i) {
      html += '<li role="option" id="search-opt-' + i + '" aria-selected="false">' +
        '<a href="' + BASE + h.d.u.replace(/^\//, '') + '">' +
        '<span class="search-title">' + esc(h.d.t) + '</span>' +
        '<span class="search-snip">' + snippet(h.d, ts) + '</span></a></li>';
    });
    html += '</ul>';
    show(html);
    activeIndex = -1;
  }

  /* ---- events ----------------------------------------------------------- */
  var timer;
  input.addEventListener('input', function () {
    clearTimeout(timer);
    var v = input.value;
    timer = setTimeout(function () { run(v); }, 120);
  });
  input.addEventListener('focus', load);
  form.addEventListener('submit', function (e) { e.preventDefault(); run(input.value); });

  input.addEventListener('keydown', function (e) {
    var opts = panel.querySelectorAll('.search-list li');
    if (e.key === 'Escape') { closeBox(); if (toggle) toggle.focus(); return; }
    if (!opts.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex += (e.key === 'ArrowDown' ? 1 : -1);
      if (activeIndex < 0) activeIndex = opts.length - 1;
      if (activeIndex >= opts.length) activeIndex = 0;
      for (var i = 0; i < opts.length; i++) {
        opts[i].classList.toggle('is-active', i === activeIndex);
        opts[i].setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
      }
      input.setAttribute('aria-activedescendant', 'search-opt-' + activeIndex);
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      var a = opts[activeIndex].querySelector('a');
      if (a) window.location.href = a.getAttribute('href');
    }
  });

  document.addEventListener('click', function (e) {
    if (box && !box.hidden &&
        !box.contains(e.target) && (!toggle || !toggle.contains(e.target))) closeBox();
  });

  /* "/" focuses search, the convention on documentation sites. Ignored while
     typing in another field. */
  document.addEventListener('keydown', function (e) {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    var el = document.activeElement, tag = el ? el.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable)) return;
    e.preventDefault();
    openBox();
  });
})();
