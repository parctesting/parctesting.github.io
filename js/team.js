/**
 * Our Team page: shows the volunteers, and lets them add or update a profile.
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
 * Updating: sending a profile returns an edit code, shown once and remembered by
 * that browser. "Update my profile" looks the profile up by its code, fills the
 * form in, and saves over it. The switch between adding and updating is built
 * here, not written into the page, because the page is VE ciphertext deployed
 * from its own repository. It appears only once the Worker's team list says
 * canUpdate, so the page never offers an edit the deployed Worker cannot make.
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

  var MAX_EDGE = 480;
  var CODE_KEY = 'parc-team-edit-code';
  var SEND_LABEL = submit ? submit.textContent : '';

  var photoData = '';      // a newly chosen photo, as a data: URI
  var currentPhoto = '';   // the photo already on the profile being updated
  var removePhoto = false;
  var tsWidget = null;
  var tsFailed = false;

  var mode = 'add';
  var loaded = null;       // the profile being updated, once its code has been checked
  var loadedCode = '';
  var fieldsFromProfile = false;
  var fields = null, modeBox = null, codeInput = null, remembered = null;
  var removedNote = null, keepPhoto = null, codeBox = null, codeValue = null, copyBtn = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function say(kind, text) {
    if (!result) return;
    result.className = 'review-result' + (kind ? ' is-' + kind : '');
    result.textContent = text;
  }

  /* A message in the status line alone leaves a screen reader user hunting for
     the field. The field in error is marked invalid, linked to the message and
     focused; the mark comes off on the next attempt. */
  var flagged = [];
  function describedBy(el, add) {
    var ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(function (x) {
      return x && x !== 'team-result';
    });
    if (add) ids.push('team-result');
    if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
    else el.removeAttribute('aria-describedby');
  }
  function clearInvalid() {
    flagged.forEach(function (el) { el.removeAttribute('aria-invalid'); describedBy(el, false); });
    flagged = [];
  }
  function invalid(el, text) {
    say('error', text);
    if (!el) return;
    el.setAttribute('aria-invalid', 'true');
    describedBy(el, true);
    flagged.push(el);
    el.focus();
  }

  /* ---- render ------------------------------------------------------------ */
  function load(fresh) {
    if (!grid || !status) return;
    if (!ENDPOINT) {
      status.textContent = 'The team list is not available at this time.';
      return;
    }
    if (!fresh) status.textContent = 'Loading…';

    fetch(ENDPOINT + '/team' + (fresh ? '?t=' + Date.now() : ''))
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) {
        status.textContent = '';
        var members = d.members || [];
        if (!members.length) {
          grid.innerHTML = '<p class="reviews-empty">No profiles have been published.</p>';
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
        status.textContent = 'The team list could not be loaded.';
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

  /* The preview shows what the team page will show once the form is sent: a
     newly chosen photo, else the current one, else nothing. */
  function showPhoto() {
    if (!preview || !previewImg) return;
    var src = photoData || (removePhoto ? '' : currentPhoto);
    if (src) {
      if (previewImg.getAttribute('src') !== src) previewImg.src = src;
      previewImg.alt = photoData ? 'Preview of the photo you selected' : 'Your current photo';
      preview.hidden = false;
    } else {
      preview.hidden = true;
      previewImg.removeAttribute('src');
    }
    if (removedNote) removedNote.hidden = !(removePhoto && currentPhoto && !photoData);
  }

  function clearPhoto() {
    photoData = ''; currentPhoto = ''; removePhoto = false;
    if (fileInput) fileInput.value = '';
    showPhoto();
  }

  if (fileInput) {
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) { photoData = ''; showPhoto(); return; }
      say('', 'Resizing your photo…');
      shrink(file).then(function (data) {
        photoData = data;
        removePhoto = false;
        showPhoto();
        say('', '');
      }).catch(function () {
        photoData = '';
        fileInput.value = '';
        showPhoto();
        say('error', 'The image could not be read. Select a JPEG or PNG file.');
      });
    });
  }
  if (previewClear) {
    previewClear.addEventListener('click', function () {
      photoData = '';
      if (fileInput) fileInput.value = '';
      if (currentPhoto) removePhoto = true;
      showPhoto();
      // The button just hid itself; put focus somewhere that still exists.
      if (keepPhoto && removedNote && !removedNote.hidden) keepPhoto.focus();
      else if (fileInput) fileInput.focus();
    });
  }

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
          tsFailed = true;
          tsBox.innerHTML = '<p class="review-form-note">The security check could not be completed. '
            + 'If a content blocker is in use, allow challenges.cloudflare.com and reload the page.</p>';
        },
      });
    };
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
          + '?render=explicit&onload=parcTeamTurnstileReady';
    s.async = true; s.defer = true;
    s.onerror = function () {
      tsFailed = true;
      tsBox.innerHTML = '<p class="review-form-note">The human check could not load. '
        + 'If a content blocker is in use, allow challenges.cloudflare.com and reload the page.</p>';
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
  /* A token is used up by each request, and looking a profile up spends one
     before the save needs another. Wait for the fresh one rather than send
     without it. */
  function whenTokenReady(then) {
    if (!SITEKEY) { then(); return; }
    var waited = 0;
    (function poll() {
      if (turnstileToken() || tsFailed || waited >= 20000) { then(); return; }
      waited += 250;
      setTimeout(poll, 250);
    })();
  }

  /* ---- edit codes -------------------------------------------------------- */
  /* The same reading as the Worker: case, spaces and dashes do not matter, and
     O, I and L are taken as the digits they get mistaken for. */
  function normaliseCode(s) {
    var c = String(s == null ? '' : s).toUpperCase().replace(/[\s-]+/g, '')
      .replace(/O/g, '0').replace(/[IL]/g, '1');
    return /^[0-9A-HJKMNP-TV-Z]{12}$/.test(c) ? c : '';
  }
  function formatCode(c) { return c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8); }

  function storedCode() {
    try { return window.localStorage.getItem(CODE_KEY) || ''; } catch (e) { return ''; }
  }
  function rememberCode(c) {
    try { window.localStorage.setItem(CODE_KEY, formatCode(normaliseCode(c))); } catch (e) { /* private window */ }
  }
  function forgetCode() {
    try { window.localStorage.removeItem(CODE_KEY); } catch (e) { /* private window */ }
  }

  /* ---- add or update ----------------------------------------------------- */
  /* The profile fields go into one wrapper at once, before anyone can be typing
     in them: moving an input that has focus would drop the focus. */
  function wrapFields() {
    var first = form && form.querySelector('label[for="team-name"]');
    if (!first || !preview || preview.parentNode !== first.parentNode) return null;
    var box = document.createElement('div');
    box.className = 'team-fields';
    first.parentNode.insertBefore(box, first);
    var node = first;
    while (node) {
      var next = node.nextSibling;
      box.appendChild(node);
      if (node === preview) break;
      node = next;
    }
    return box;
  }

  function showLabel() {
    if (!submit) return;
    submit.textContent = mode === 'add' ? SEND_LABEL : (loaded ? 'Save Changes' : 'Load My Profile');
  }
  function showStep() {
    if (fields) fields.hidden = mode === 'update' && !loaded;
    showLabel();
  }

  function syncRemembered() {
    if (!remembered || !codeInput) return;
    var s = normaliseCode(storedCode());
    remembered.hidden = !(s && normaliseCode(codeInput.value) === s);
  }

  function fillText(m) {
    document.getElementById('team-name').value = m.name || '';
    document.getElementById('team-callsign').value = m.callsign || '';
    document.getElementById('team-role').value = m.role || '';
    bio.value = m.bio || '';
    if (remaining) remaining.textContent = String(600 - bio.value.length);
  }
  function fillFields(m) {
    fillText(m);
    photoData = ''; removePhoto = false;
    if (fileInput) fileInput.value = '';
    currentPhoto = m.photo ? ENDPOINT + m.photo : '';
    fieldsFromProfile = true;
    showPhoto();
  }
  function clearFields() {
    fillText({});
    clearPhoto();
    fieldsFromProfile = false;
  }

  function setMode(next) {
    if (next === mode || !modeBox) return;
    mode = next;
    var btns = modeBox.querySelectorAll('button[data-mode]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', String(btns[i].getAttribute('data-mode') === mode));
    }
    loaded = null; loadedCode = '';
    // Somebody else's details must not carry over into a new profile.
    if (fieldsFromProfile) clearFields();
    if (codeBox) codeBox.hidden = true;
    codeInput.parentNode.hidden = mode !== 'update';
    if (mode === 'update' && !codeInput.value) codeInput.value = storedCode();
    syncRemembered();
    showStep();
    say('', '');
  }

  function buildCodeBox() {
    if (codeBox || !result) return;
    codeBox = document.createElement('div');
    codeBox.className = 'callout team-code-box';
    codeBox.hidden = true;
    codeBox.innerHTML = '<p class="team-code-box__title">Your edit code</p>'
      + '<p class="team-code-box__code"><code></code>'
      + '<button type="button" class="btn">Copy</button></p>'
      // What the code is for is said once, in the page's introduction.
      + '<p class="team-code-box__note">This browser saves the code. Keep a copy in a safe '
      + 'place for use on another device.</p>';
    result.parentNode.insertBefore(codeBox, result.nextSibling);
    codeValue = codeBox.querySelector('code');
    copyBtn = codeBox.querySelector('button');
    copyBtn.addEventListener('click', function () {
      var select = function () {
        var range = document.createRange();
        range.selectNodeContents(codeValue);
        var sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
        copyBtn.textContent = 'Selected';
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(codeValue.textContent)
          .then(function () { copyBtn.textContent = 'Copied'; }, select);
      } else {
        select();
      }
    });
  }

  function buildEditing() {
    if (modeBox || !fields || !submit) return;

    modeBox = document.createElement('div');
    modeBox.className = 'team-mode';
    modeBox.setAttribute('role', 'group');
    modeBox.setAttribute('aria-label', 'Add or update a profile');
    modeBox.innerHTML = '<button type="button" class="team-mode__btn" data-mode="add" aria-pressed="true">Add a New Profile</button>'
      + '<button type="button" class="team-mode__btn" data-mode="update" aria-pressed="false">Update My Profile</button>';
    form.parentNode.insertBefore(modeBox, form);
    modeBox.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-mode]') : null;
      if (b && !b.disabled) setMode(b.getAttribute('data-mode'));
    });

    var entry = document.createElement('div');
    entry.className = 'team-code-entry';
    entry.hidden = true;
    entry.innerHTML = '<label class="review-label" for="team-edit-code">Your edit code</label>'
      + '<input class="review-input review-input--code" id="team-edit-code" type="text" maxlength="24"'
      + ' autocomplete="off" autocapitalize="characters" spellcheck="false"'
      + ' placeholder="XXXX-XXXX-XXXX" aria-describedby="team-edit-code-hint">'
      + '<p class="review-hint" id="team-edit-code-hint">No code, or lost it? Ask and a new one can be sent to you.</p>'
      + '<p class="review-hint team-code-remembered" hidden>This browser has saved your code. '
      + '<button type="button" class="team-link-btn">Forget Code</button></p>';
    form.insertBefore(entry, fields);
    codeInput = entry.querySelector('input');
    remembered = entry.querySelector('.team-code-remembered');

    codeInput.addEventListener('input', function () {
      if (loaded && normaliseCode(codeInput.value) !== loadedCode) {
        loaded = null; loadedCode = '';
        showStep();
        say('', '');
      }
      syncRemembered();
    });
    remembered.querySelector('button').addEventListener('click', function () {
      forgetCode();
      codeInput.value = '';
      loaded = null; loadedCode = '';
      if (fieldsFromProfile) clearFields();
      showStep();
      syncRemembered();
      say('', 'The code has been removed from this browser.');
      codeInput.focus();
    });

    removedNote = document.createElement('p');
    removedNote.className = 'review-hint team-photo-removed';
    removedNote.hidden = true;
    removedNote.innerHTML = 'Your photo will be removed from the team page when you save. '
      + '<button type="button" class="team-link-btn">Keep My Photo</button>';
    fields.appendChild(removedNote);
    keepPhoto = removedNote.querySelector('button');
    keepPhoto.addEventListener('click', function () {
      removePhoto = false;
      showPhoto();
      if (previewClear) previewClear.focus();
    });

    buildCodeBox();
  }

  /* Only offer updating once the Worker in Cloudflare can do it. */
  function offerEditing() {
    if (!fields || !ENDPOINT || !window.fetch) return;
    fetch(ENDPOINT + '/team')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.canUpdate) buildEditing(); })
      .catch(function () { /* the form adds profiles exactly as before */ });
  }

  /* ---- sending ----------------------------------------------------------- */
  function busy(on, label) {
    submit.disabled = on;
    if (modeBox) {
      var b = modeBox.querySelectorAll('button');
      for (var i = 0; i < b.length; i++) b[i].disabled = on;
    }
    if (on) submit.textContent = label; else showLabel();
  }

  function send(path, payload, label, done) {
    busy(true, turnstileToken() || !SITEKEY ? label : 'Checking…');
    whenTokenReady(function () {
      submit.textContent = label;
      payload.code = CODE;
      payload.website = document.getElementById('team-website').value;
      payload.turnstile = turnstileToken();
      fetch(ENDPOINT + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (r) {
          return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d || {} }; });
        })
        .then(function (res) {
          turnstileReset();
          try { done(res); } finally { busy(false); }
        })
        .catch(function () {
          turnstileReset();
          busy(false);
          say('error', 'The request could not be sent. Check the internet connection and try again.');
        });
    });
  }

  function profileFields() {
    var nameEl = document.getElementById('team-name');
    var name = nameEl.value.trim();
    clearInvalid();
    if (name.length < 2) { invalid(nameEl, 'Enter the name to be shown on the team page.'); return null; }
    if (bio.value.trim().length < 10) { invalid(bio, 'Enter a short description of at least one sentence.'); return null; }
    return {
      name: name,
      callsign: document.getElementById('team-callsign').value,
      role: document.getElementById('team-role').value,
      bio: bio.value,
    };
  }

  function addProfile() {
    var p = profileFields();
    if (!p) return;
    say('', '');
    // The last code shown belongs to the last profile sent, not this one.
    if (codeBox) codeBox.hidden = true;
    p.photo = photoData;
    send('/team', p, 'Sending…', function (res) {
      if (!res.ok) { say('error', res.d.error || 'The profile could not be submitted. Try again.'); return; }
      form.reset();
      clearFields();
      say('ok', res.d.message || 'Thank you. Your profile has been published on the Our Team page.');
      if (res.d.editCode) {
        rememberCode(res.d.editCode);
        buildEditing();
        buildCodeBox();
        codeValue.textContent = formatCode(normaliseCode(res.d.editCode));
        copyBtn.textContent = 'Copy';
        codeBox.hidden = false;
      }
    });
  }

  function lookupProfile() {
    var c = normaliseCode(codeInput.value);
    clearInvalid();
    if (!c) {
      invalid(codeInput, 'The edit code is not in the expected format: 12 letters and numbers, in three groups of four.');
      return;
    }
    say('', '');
    send('/team/lookup', { editCode: c }, 'Loading…', function (res) {
      if (!res.ok || !res.d.member) {
        say('error', res.d.error || 'The code could not be checked. Try again.');
        return;
      }
      loaded = res.d.member; loadedCode = c;
      codeInput.value = formatCode(c);
      rememberCode(c);
      syncRemembered();
      fillFields(loaded);
      showStep();
      say('ok', 'Your profile is shown below. Make any changes, then select Save Changes.');
    });
  }

  function saveProfile() {
    var p = profileFields();
    if (!p) return;
    say('', '');
    var sentPhoto = photoData;
    var sentRemove = removePhoto && !photoData;
    p.editCode = loadedCode;
    p.photo = sentPhoto;
    p.removePhoto = sentRemove;
    send('/team/update', p, 'Saving…', function (res) {
      if (!res.ok || !res.d.member) {
        say('error', res.d.error || 'The changes could not be saved. Try again.');
        return;
      }
      loaded = res.d.member;
      fillText(loaded);
      // Keep showing the photo just sent rather than fetch it straight back.
      if (sentPhoto) currentPhoto = sentPhoto;
      else if (sentRemove) currentPhoto = '';
      photoData = ''; removePhoto = false;
      if (fileInput) fileInput.value = '';
      showPhoto();
      say('ok', res.d.message || 'Your changes have been saved.');
    });
  }

  if (form) {
    fields = wrapFields();
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (submit.disabled) return;
      if (mode === 'update') { if (loaded) saveProfile(); else lookupProfile(); return; }
      addProfile();
    });
  }

  initTurnstile();
  load();
  offerEditing();
})();
