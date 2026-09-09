/**
 * Reviews page: shows approved reviews and submits new ones.
 *
 * Storage lives in a Cloudflare Worker (worker/parc-reviews.js) because
 * GitHub Pages cannot keep anything. Set the Worker URL on the
 * data-reviews-endpoint attribute of #reviews.
 *
 * Reviews publish immediately. Cloudflare Turnstile guards the form against
 * automated submissions; the Worker does the rest of the filtering. On success
 * the new review is shown at once, because telling someone it is live and then
 * not showing it reads as a failure.
 */
(function () {
  'use strict';

  var root = document.getElementById('reviews');
  if (!root) return;

  var ENDPOINT = (root.getAttribute('data-reviews-endpoint') || '').trim().replace(/\/+$/, '');
  var list = document.getElementById('reviews-list');
  var summary = document.getElementById('reviews-summary');
  var status = document.getElementById('reviews-status');
  var form = document.getElementById('review-form');
  var stars = document.getElementById('rating-stars');
  var result = document.getElementById('review-result');
  var submit = document.getElementById('review-submit');
  var textEl = document.getElementById('review-text');
  var remaining = document.getElementById('review-remaining');
  var formWrap = document.getElementById('review-form-wrap');
  var tsBox = document.getElementById('review-turnstile');
  var SITEKEY = (root.getAttribute('data-turnstile-sitekey') || '').trim();
  var tsWidget = null;
  var rating = 0;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function starsHtml(n) {
    var out = '';
    for (var i = 1; i <= 5; i++) {
      out += '<span class="star-mark' + (i <= n ? ' is-on' : '') + '" aria-hidden="true">★</span>';
    }
    return '<span class="stars-inline" role="img" aria-label="' + n + ' out of 5 stars">' + out + '</span>';
  }
  function when(iso) {
    try {
      return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
    } catch (e) { return ''; }
  }

  /* ---- render ----------------------------------------------------------- */
  function load(fresh) {
    /* Until the Worker is deployed there is nowhere for a review to go. Leaving
       the form up would let someone write one and lose it on submit, so take it
       down rather than accept text we cannot store. */
    if (!ENDPOINT) {
      status.textContent = 'Reviews are not available just yet. Please check back soon.';
      if (formWrap) formWrap.hidden = true;
      return;
    }
    if (!fresh) status.textContent = 'Loading reviews…';
    fetch(ENDPOINT + '/' + (fresh ? '?t=' + Date.now() : ''))
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) {
        status.textContent = '';
        var rv = d.reviews || [];
        if (!rv.length) {
          list.innerHTML = '<p class="reviews-empty">No reviews yet. Yours would be the first.</p>';
          return;
        }
        summary.innerHTML =
          '<span class="reviews-avg">' + d.average.toFixed(1) + '</span>' +
          starsHtml(Math.round(d.average)) +
          '<span class="reviews-count">from ' + d.count + ' review' + (d.count === 1 ? '' : 's') + '</span>';
        summary.hidden = false;

        list.innerHTML = rv.map(function (r) {
          return '<article class="review">' +
            '<header class="review__head">' + starsHtml(r.r) +
            '<span class="review__name">' + esc(r.n) + '</span>' +
            '<span class="review__date">' + esc(when(r.at)) + '</span></header>' +
            '<p class="review__text">' + esc(r.t) + '</p></article>';
        }).join('');
      })
      .catch(function () {
        status.textContent = 'Reviews could not be loaded right now. The form below still works.';
      });
  }

  /* ---- star input -------------------------------------------------------- */
  function paint() {
    [].forEach.call(stars.querySelectorAll('.star'), function (b) {
      var v = Number(b.getAttribute('data-value'));
      b.classList.toggle('is-on', v <= rating);
      b.setAttribute('aria-checked', v === rating ? 'true' : 'false');
      b.tabIndex = (rating === 0 ? v === 1 : v === rating) ? 0 : -1;
    });
  }
  if (stars) {
    stars.addEventListener('click', function (e) {
      var b = e.target.closest('.star');
      if (!b) return;
      rating = Number(b.getAttribute('data-value'));
      paint();
    });
    // Arrow keys, as a radiogroup should.
    stars.addEventListener('keydown', function (e) {
      if (['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown'].indexOf(e.key) === -1) return;
      e.preventDefault();
      var step = (e.key === 'ArrowRight' || e.key === 'ArrowUp') ? 1 : -1;
      rating = Math.min(5, Math.max(1, (rating || 0) + step));
      paint();
      var cur = stars.querySelector('.star[data-value="' + rating + '"]');
      if (cur) cur.focus();
    });
    paint();
  }

  if (textEl && remaining) {
    textEl.addEventListener('input', function () {
      remaining.textContent = String(1200 - textEl.value.length);
    });
  }

  /* ---- Turnstile ---------------------------------------------------------
     Loaded only when a site key is configured, so an unconfigured page makes no
     request to challenges.cloudflare.com at all. Rendered explicitly rather than
     by auto-scan, so the widget id is known and the token can be read and reset
     around each submit — Turnstile tokens are single use. */
  function initTurnstile() {
    if (!SITEKEY || !tsBox) return;

    window.parcTurnstileReady = function () {
      if (!window.turnstile) return;
      tsWidget = window.turnstile.render(tsBox, {
        sitekey: SITEKEY,
        action: 'review',
        theme: 'light',
        /* Tokens last five minutes. Somebody composing a 1200-character review
           can easily take longer than that, so let Turnstile mint a fresh one
           rather than fail them at the moment they press submit. */
        'refresh-expired': 'auto',
        'error-callback': function () {
          tsBox.innerHTML = '<p class="review-form-note">The human check could not run. '
            + 'If you use a content blocker, allow challenges.cloudflare.com and reload.</p>';
        },
      });
    };

    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
          + '?render=explicit&onload=parcTurnstileReady';
    s.async = true;
    s.defer = true;
    /* If the script is blocked the widget never appears. The Worker still
       refuses tokenless submissions, so say why rather than leaving a dead
       form. */
    s.onerror = function () {
      tsBox.innerHTML = '<p class="review-form-note">The human check could not load. '
        + 'If you use a content blocker, allow challenges.cloudflare.com and reload.</p>';
    };
    document.head.appendChild(s);
  }

  function turnstileToken() {
    if (!SITEKEY) return '';
    try { return window.turnstile ? window.turnstile.getResponse(tsWidget) || '' : ''; }
    catch (e) { return ''; }
  }

  function turnstileReset() {
    try { if (window.turnstile && tsWidget !== null) window.turnstile.reset(tsWidget); }
    catch (e) { /* nothing useful to do */ }
  }

  /* ---- submit ------------------------------------------------------------ */
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      result.className = 'review-result';

      if (!rating) { result.className = 'review-result is-error';
        result.textContent = 'Please choose a rating.'; return; }
      if (!textEl.value.trim()) { result.className = 'review-result is-error';
        result.textContent = 'Please add a few words about your experience.'; return; }
      if (!ENDPOINT) { result.className = 'review-result is-error';
        result.textContent = 'Reviews are not connected yet.'; return; }

      submit.disabled = true;
      var origLabel = submit.textContent;
      submit.textContent = 'Sending…';

      fetch(ENDPOINT + '/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rating: rating,
          name: document.getElementById('review-name').value,
          text: textEl.value,
          website: document.getElementById('review-website').value,
          turnstile: turnstileToken(),
        }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          submit.disabled = false;
          submit.textContent = origLabel;
          if (!res.ok) {
            /* The token is spent either way, so a retry needs a fresh one. */
            turnstileReset();
            result.className = 'review-result is-error';
            result.textContent = res.d.error || 'That did not send. Please try again.';
            return;
          }
          form.reset();
          rating = 0; paint();
          turnstileReset();
          if (remaining) remaining.textContent = '1200';
          result.className = 'review-result is-ok';
          result.textContent = res.d.message || 'Thank you — your review is on the page.';
          /* Re-read rather than splice the new one in by hand, so the average and
             the ordering come from the same place they always do. The cache
             buster is needed because the list is served with a short max-age. */
          load(true);
        })
        .catch(function () {
          submit.disabled = false;
          submit.textContent = origLabel;
          result.className = 'review-result is-error';
          result.textContent = 'That did not send. Please check your connection and try again.';
        });
    });
  }

  initTurnstile();
  load();
})();
