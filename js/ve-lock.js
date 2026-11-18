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
  // Where this file was loaded from, to load js/ve-protect.js beside it.
  var SELF = (document.currentScript && document.currentScript.src) || '';

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
  /** Put the shell's site header and footer into the decrypted page.
   *
   *  The shell is built by tools/parc-lock.mjs from tools/chrome.mjs, so its
   *  header and footer are the site's current ones. The scripts in VE_Scripts
   *  carry copies made years ago (an older menu with no Search, Reviews or
   *  Our Team), and the dashboard carries none. Swapping them here keeps every
   *  VE page in step with the site without editing the scripts.
   */
  function useCurrentChrome(doc) {
    var main = doc.querySelector('main') || doc.body.firstChild;
    var parts = [['.site-header', 'before'], ['.site-footer', 'after']];
    for (var i = 0; i < parts.length; i++) {
      var current = document.querySelector(parts[i][0]);
      if (!current) continue;
      var fresh = doc.importNode(current, true);
      var old = doc.querySelector(parts[i][0]);
      if (old) old.parentNode.replaceChild(fresh, old);
      else if (parts[i][1] === 'before') main.parentNode.insertBefore(fresh, main);
      else main.parentNode.insertBefore(fresh, main.nextSibling);
    }
    // The current header needs the shell's scripts too (search.js for Search).
    var have = {}, olds = doc.querySelectorAll('script[src]'), j;
    for (j = 0; j < olds.length; j++) have[olds[j].getAttribute('src').split('/').pop()] = true;
    var shellScripts = document.querySelectorAll('script[src]');
    for (j = 0; j < shellScripts.length; j++) {
      var src = shellScripts[j].getAttribute('src'), name = src.split('/').pop();
      if (have[name] || name === 've-lock.js') continue;
      var add = doc.createElement('script');
      add.src = src;
      doc.body.appendChild(add);
    }
  }

  function render(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    useCurrentChrome(doc);

    /* Inside the dashboard's reader frame the dashboard carries the bar, so the
       framed page hides its own (css: html.ve-framed .ve-bar). */
    var framed = false;
    try { framed = window.self !== window.top; } catch (e) { framed = true; }
    if (framed) {
      doc.documentElement.className += ' ve-framed';
      /* The scripts' Special Links menu points at the dashboard; inside the
         dashboard's own reader that would nest the dashboard in itself. */
      var dl = doc.querySelectorAll('a[href="ve-dashboard.html"]');
      for (var d = 0; d < dl.length; d++) dl[d].parentNode.removeChild(dl[d]);
    }

    /* Every VE page links to the public site (the dashboard has no site menu,
       and a phone had no other way back), and every other VE page links to
       the session dashboard. */
    var onDash = /(^|\/)ve-dashboard\.html$/.test(location.pathname);
    var bar = doc.createElement('div');
    bar.className = 've-bar no-print';
    bar.innerHTML =
      '<span class="ve-bar__label">VE material \u2014 not for public distribution</span>' +
      '<span class="ve-bar__links">' +
      '<a class="ve-bar__link" href="../index.html">Main Website</a>' +
      (onDash || framed ? '' : '<a class="ve-bar__link" href="ve-dashboard.html"><span class="ve-bar__long">Session </span>Dashboard</a>') +
      '<button type="button" class="ve-bar__lock" id="ve-relock">Lock</button></span>';
    doc.body.insertBefore(bar, doc.body.firstChild);

    document.replaceChild(
      document.importNode(doc.documentElement, true),
      document.documentElement
    );

    if (P.t) document.title = P.t + ' | PARC';
    rerunScripts();

    // Copy, save and print deterrents for the unlocked material.
    if (SELF) {
      var guard = document.createElement('script');
      guard.src = SELF.replace(/ve-lock\.js(\?.*)?$/, 've-protect.js');
      document.body.appendChild(guard);
    }

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
    /* Not when framed (the dashboard's reader): focusing inside the frame
       scrolls the dashboard down to it. Not when a cached key is unlocking the
       page anyway. */
    var top = true;
    try { top = window.self === window.top; } catch (e) { top = false; }
    if (input && top && !cached) input.focus();
  }
})();
