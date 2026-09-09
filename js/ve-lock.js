/**
 * Unlocks an encrypted VE page in the browser.
 *
 * The page ships as ciphertext only. This script derives an AES key from the
 * passphrase with PBKDF2, decrypts the payload, and replaces the document with
 * the original page. If the passphrase is wrong, AES-GCM's authentication tag
 * fails and there is nothing to show — no plaintext ever reaches the browser.
 *
 * The derived key (not the passphrase) is cached so a VE unlocks once and can
 * move between script pages during a session. The cache key includes the build
 * salt, so re-running tools/parc-lock.mjs invalidates every cached key
 * automatically and everyone is prompted again.
 */
(function () {
  'use strict';

  var payloadEl = document.getElementById('ve-payload');
  if (!payloadEl) return;

  var P;
  try { P = JSON.parse(payloadEl.textContent); } catch (e) { return; }

  var CACHE_KEY = 've-key:' + P.salt;
  var form = document.getElementById('ve-form');
  var input = document.getElementById('ve-pass');
  var remember = document.getElementById('ve-remember');
  var status = document.getElementById('ve-status');
  var submit = document.getElementById('ve-submit');

  function b64ToBytes(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(b) {
    var s = '', a = new Uint8Array(b);
    for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s);
  }

  if (!window.crypto || !window.crypto.subtle) {
    say('This browser cannot decrypt the page. Please use an up-to-date browser over HTTPS.', true);
    return;
  }

  function say(msg, isError) {
    if (!status) return;
    status.textContent = msg;
    status.className = 've-lock__status' + (isError ? ' is-error' : '');
  }

  function deriveKey(pass) {
    return crypto.subtle
      .importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: b64ToBytes(P.salt), iterations: P.it, hash: 'SHA-256' },
          base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']
        );
      });
  }

  function importRawKey(rawB64) {
    return crypto.subtle.importKey('raw', b64ToBytes(rawB64), { name: 'AES-GCM' }, true, ['decrypt']);
  }

  function decryptPage(key) {
    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(P.iv) }, key, b64ToBytes(P.ct)
    ).then(function (buf) { return new TextDecoder().decode(buf); });
  }

  /** Cache the derived key, not the passphrase. sessionStorage clears with the
   *  tab; localStorage is opt-in and expires on its own. */
  function cacheKey(key, persist) {
    return crypto.subtle.exportKey('raw', key).then(function (raw) {
      var rec = JSON.stringify({ k: bytesToB64(raw), exp: Date.now() + 12 * 3600 * 1000 });
      try {
        sessionStorage.setItem(CACHE_KEY, rec);
        if (persist) localStorage.setItem(CACHE_KEY, rec);
      } catch (e) { /* private mode — unlocking still works, just not remembered */ }
    });
  }

  function readCached() {
    var rec = null;
    try { rec = sessionStorage.getItem(CACHE_KEY) || localStorage.getItem(CACHE_KEY); } catch (e) { return null; }
    if (!rec) return null;
    try {
      var o = JSON.parse(rec);
      if (!o.k || (o.exp && Date.now() > o.exp)) { clearCached(); return null; }
      return o.k;
    } catch (e) { return null; }
  }

  function clearCached() {
    try { sessionStorage.removeItem(CACHE_KEY); localStorage.removeItem(CACHE_KEY); } catch (e) {}
  }

  /** Swap the ciphertext shell for the decrypted page.
   *
   *  Uses DOMParser + replaceChild rather than document.open()/write(). write()
   *  is only defined to replace the document when no parser is active; called
   *  from an async callback it can instead APPEND, leaving the unlock form and
   *  the decrypted script in the same DOM with two <title> elements. That is
   *  exactly what happened here in testing.
   *
   *  Trade-off: nodes created by DOMParser are inert, so any <script> in the
   *  decrypted page has to be re-created by hand to run. See rerunScripts().
   */
  function render(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');

    var bar = doc.createElement('div');
    bar.className = 've-bar no-print';
    bar.innerHTML =
      '<span class="ve-bar__label">VE material \u2014 not for public distribution</span>' +
      '<button type="button" class="ve-bar__lock" id="ve-relock">Lock</button>';
    doc.body.insertBefore(bar, doc.body.firstChild);

    document.replaceChild(
      document.importNode(doc.documentElement, true),
      document.documentElement
    );

    if (P.t) document.title = P.t + ' | PARC';
    rerunScripts();

    var btn = document.getElementById('ve-relock');
    if (btn) btn.addEventListener('click', function () { clearCached(); location.reload(); });
  }

  /** Imported <script> elements never execute. Re-create them so the site
   *  chrome (js/site.js: mobile menu, dropdowns) still works once unlocked. */
  function rerunScripts() {
    var olds = document.querySelectorAll('script');
    for (var i = 0; i < olds.length; i++) {
      var o = olds[i];
      if (o.id === 've-payload' || (o.src && o.src.indexOf('ve-lock.js') !== -1)) continue;
      var s = document.createElement('script');
      for (var j = 0; j < o.attributes.length; j++) {
        s.setAttribute(o.attributes[j].name, o.attributes[j].value);
      }
      if (!o.src) s.textContent = o.textContent;
      o.parentNode.replaceChild(s, o);
    }
  }

  function fail(msg) {
    say(msg, true);
    if (submit) { submit.disabled = false; submit.textContent = 'Unlock'; }
    if (input) { input.value = ''; input.focus(); }
  }

  /* --- auto-unlock from a cached key --- */
  var cached = readCached();
  if (cached) {
    say('Unlocking…');
    importRawKey(cached).then(decryptPage).then(render).catch(function () {
      clearCached();
      say('');
    });
  }

  /* --- manual unlock --- */
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var pass = input ? input.value : '';
      if (!pass) return;
      submit.disabled = true;
      submit.textContent = 'Unlocking…';
      say('Checking passphrase…');

      // Yield first so the button state paints before PBKDF2 blocks the thread.
      setTimeout(function () {
        deriveKey(pass).then(function (key) {
          return decryptPage(key).then(function (html) {
            return cacheKey(key, remember && remember.checked).then(function () { render(html); });
          });
        }).catch(function () {
          // A failed GCM tag is indistinguishable from a wrong passphrase, which
          // is exactly what we want to report. Delay slightly to slow guessing.
          setTimeout(function () { fail('Incorrect passphrase.'); }, 400);
        });
      }, 30);
    });
    if (input) input.focus();
  }
})();
