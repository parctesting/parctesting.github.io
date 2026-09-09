/**
 * Our Team page: shows approved volunteers and accepts new profiles.
 *
 * Photographs are resized in the browser before they are sent. A photo straight
 * from a phone is several megabytes; the page has no use for more than a few
 * hundred pixels, and uploading the original would be slow on the rural
 * connections a lot of our examiners are on.
 *
 * Profiles publish as soon as they are sent, and come off again with a delete.
 *
 * The form lives on a passcode-locked VE page and carries a submit code that
 * only exists inside that page's ciphertext. Without the VE passcode there is
 * no way to read the code, so the Worker can refuse submissions from anyone who
 * has not already been let into the VE section. That makes it a real gate
 * rather than a hidden URL.
 *
 * This one file drives both pages: the public list, and the locked form.
 */
(function () {
  'use strict';

  var root = document.getElementById('team') || document.getElementById('team-submit');
  if (!root) return;

  var ENDPOINT = (root.getAttribute('data-team-endpoint') || '').trim().replace(/\/+$/, '');
  var SITEKEY = (root.getAttribute('data-turnstile-sitekey') || '').trim();
  var CODE = (root.getAttribute('data-team-code') || '').trim();

  var grid = document.getElementById('team-grid');
  var status = document.getElementById('team-status');
  var form = document.getElementById('team-form');
  var result = document.getElementById('team-result');
  var submit = document.getElementById('team-submit-btn');
  var bio = document.getElementById('team-bio');
  var remaining = document.getElementById('team-remaining');
  var fileInput = document.getElementById('team-photo');
  var preview = document.getElementById('team-preview');
  var previewImg = document.getElementById('team-preview-img');
  var previewClear = document.getElementById('team-preview-clear');
  var tsBox = document.getElementById('team-turnstile');

  var photoData = '';
  var tsWidget = null;

  var MAX_EDGE = 480;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---- render ------------------------------------------------------------ */
  function load(fresh) {
    if (!grid || !status) return;
    if (!ENDPOINT) {
      status.textContent = 'The team page is not connected yet. Please check back soon.';
      return;
    }
    if (!fresh) status.textContent = 'Loading…';

    fetch(ENDPOINT + '/team' + (fresh ? '?t=' + Date.now() : ''))
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) {
        status.textContent = '';
        var members = d.members || [];
        if (!members.length) {
          grid.innerHTML = '<p class="reviews-empty">No profiles yet. '
            + 'If you examine with PARC, yours would be the first.</p>';
          return;
        }
        grid.innerHTML = members.map(function (m) {
          var photo = m.photo
            ? '<img class="team-card__photo" src="' + esc(ENDPOINT + m.photo) + '" alt="" loading="lazy" width="120" height="120">'
            : '<span class="team-card__photo team-card__photo--none" aria-hidden="true">'
              + esc((m.name || '?').trim().charAt(0).toUpperCase()) + '</span>';
          var who = esc(m.name) + (m.callsign
            ? ' <span class="team-card__call">' + esc(m.callsign) + '</span>' : '');
          return '<article class="team-card">'
            + photo
            + '<div class="team-card__body">'
            + '<h3 class="team-card__name">' + who + '</h3>'
            + (m.role ? '<p class="team-card__role">' + esc(m.role) + '</p>' : '')
            + '<p class="team-card__bio">' + esc(m.bio) + '</p>'
            + '</div></article>';
        }).join('');
      })
      .catch(function () {
        status.textContent = 'The team list could not be loaded just now.';
      });
  }

  /* ---- photo ------------------------------------------------------------- */
  /* Square-cropped from the centre so the grid stays even, and re-encoded as
     JPEG. createImageBitmap honours the EXIF orientation flag, which is what
     stops portrait phone photos arriving on their side. */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var done = function (bmp, w, h) {
        var side = Math.min(w, h);
        var canvas = document.createElement('canvas');
        canvas.width = MAX_EDGE; canvas.height = MAX_EDGE;
        var ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bmp, (w - side) / 2, (h - side) / 2, side, side, 0, 0, MAX_EDGE, MAX_EDGE);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };

      if (window.createImageBitmap) {
        createImageBitmap(file, { imageOrientation: 'from-image' })
          .then(function (bmp) { done(bmp, bmp.width, bmp.height); })
          .catch(reject);
        return;
      }
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () { done(img, img.naturalWidth, img.naturalHeight); URL.revokeObjectURL(url); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  function clearPhoto() {
    photoData = '';
    if (fileInput) fileInput.value = '';
    if (preview) preview.hidden = true;
    if (previewImg) previewImg.removeAttribute('src');
  }

  if (fileInput) {
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) { clearPhoto(); return; }
      result.className = 'review-result';
      result.textContent = 'Resizing your photo…';
      shrink(file).then(function (data) {
        photoData = data;
        previewImg.src = data;
        preview.hidden = false;
        result.textContent = '';
      }).catch(function () {
        clearPhoto();
        result.className = 'review-result is-error';
        result.textContent = 'That image could not be read. Please try a JPEG or PNG.';
      });
    });
  }
  if (previewClear) previewClear.addEventListener('click', clearPhoto);

  if (bio && remaining) {
    bio.addEventListener('input', function () {
      remaining.textContent = String(600 - bio.value.length);
    });
  }

  /* ---- Turnstile --------------------------------------------------------- */
  function initTurnstile() {
    if (!SITEKEY || !tsBox) return;
    window.parcTeamTurnstileReady = function () {
      if (!window.turnstile) return;
      tsWidget = window.turnstile.render(tsBox, {
        sitekey: SITEKEY, action: 'team', theme: 'light',
        'refresh-expired': 'auto',
        'error-callback': function () {
          tsBox.innerHTML = '<p class="review-form-note">The human check could not run. '
            + 'If you use a content blocker, allow challenges.cloudflare.com and reload.</p>';
        },
      });
    };
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
          + '?render=explicit&onload=parcTeamTurnstileReady';
    s.async = true; s.defer = true;
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

      var name = document.getElementById('team-name').value.trim();
      if (name.length < 2) {
        result.className = 'review-result is-error';
        result.textContent = 'Please give the name you would like shown.'; return;
      }
      if (bio.value.trim().length < 10) {
        result.className = 'review-result is-error';
        result.textContent = 'Please add a sentence or two about yourself.'; return;
      }

      submit.disabled = true;
      var origLabel = submit.textContent;
      submit.textContent = 'Sending…';

      fetch(ENDPOINT + '/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name,
          callsign: document.getElementById('team-callsign').value,
          role: document.getElementById('team-role').value,
          bio: bio.value,
          photo: photoData,
          code: CODE,
          website: document.getElementById('team-website').value,
          turnstile: turnstileToken(),
        }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          submit.disabled = false;
          submit.textContent = origLabel;
          turnstileReset();
          if (!res.ok) {
            result.className = 'review-result is-error';
            result.textContent = res.d.error || 'That did not send. Please try again.';
            return;
          }
          form.reset();
          clearPhoto();
          if (remaining) remaining.textContent = '600';
          result.className = 'review-result is-ok';
          result.textContent = res.d.message || 'Thank you — you are on the team page now.';
        })
        .catch(function () {
          submit.disabled = false;
          submit.textContent = origLabel;
          turnstileReset();
          result.className = 'review-result is-error';
          result.textContent = 'That did not send. Please check your connection and try again.';
        });
    });
  }

  initTurnstile();
  load();
})();
