/**
 * Opens an encrypted VE training document (js/ve-manifest.json + ve/files/*.enc).
 *
 * The PDFs used to sit in /Documents/ as plain files, which meant that locking
 * the HTML pages achieved nothing for them — the direct URL still worked for
 * anyone. They are now published only as ciphertext and decrypted here into a
 * Blob URL, which never touches the network.
 *
 * Shares the key cache with js/ve-lock.js, so a VE who has already unlocked a
 * script page this session opens documents without being asked again.
 */
(function () {
  'use strict';


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

  var params = new URLSearchParams(location.search);
  var slug = (params.get('f') || '').replace(/[^a-z0-9-]/gi, '');

  var form = document.getElementById('ve-form');
  var input = document.getElementById('ve-pass');
  var remember = document.getElementById('ve-remember');
  var status = document.getElementById('ve-status');
  var submit = document.getElementById('ve-submit');
  var lockBox = document.getElementById('ve-file');
  var viewer = document.getElementById('ve-viewer');
  var pagesEl = document.getElementById('ve-pages');
  var pagesStatus = document.getElementById('ve-pages-status');
  var titleEl = document.getElementById('ve-file-title');
  var viewerTitle = document.getElementById('ve-viewer-title');

  var M = null, CACHE_KEY = null;

  function say(msg, isError) {
    if (!status) return;
    status.textContent = msg || '';
    status.className = 've-lock__status' + (isError ? ' is-error' : '');
  }
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

  if (!slug) { say('No file requested.', true); return; }
  if (!window.crypto || !window.crypto.subtle) {
    say('This browser cannot decrypt files. Please use an up-to-date browser over HTTPS.', true);
    return;
  }

  fetch(BASE + 'js/ve-manifest.json')
    .then(function (r) { return r.json(); })
    .then(function (m) {
      M = m;
      CACHE_KEY = 've-key:' + M.salt;
      if (!M.files || !M.files[slug]) { say('Unknown file.', true); return; }
      if (titleEl) titleEl.textContent = displayName();
      if (viewerTitle) viewerTitle.textContent = displayName();
      var cached = readCached();
      if (cached) {
        say('Opening…');
        importRawKey(cached).then(openFile).catch(function () { clearCached(); say(''); });
      }
    })
    .catch(function () { say('Could not load the file list.', true); });

  function deriveKey(pass) {
    return crypto.subtle
      .importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: b64ToBytes(M.salt), iterations: M.it, hash: 'SHA-256' },
          base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
      });
  }
  function importRawKey(raw) {
    return crypto.subtle.importKey('raw', b64ToBytes(raw), { name: 'AES-GCM' }, true, ['decrypt']);
  }
  function decrypt(key, blob) {
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(blob.iv) }, key, b64ToBytes(blob.ct));
  }

  /** Cheap passphrase check against a tiny known-plaintext blob, so a wrong
   *  passphrase doesn't cost a 3 MB download first. */
  function verify(key) { return decrypt(key, M.verify); }

  /**
   * Show the decrypted PDF as page images instead of handing it to the
   * browser's PDF viewer, which offers Download and Print buttons and a
   * blob: address that can be saved. PDF.js (js/vendor/pdfjs, Apache-2.0)
   * draws each page on a canvas when it scrolls near the screen. Each page's
   * text goes in a visually hidden block for screen readers; it cannot be
   * selected (js/ve-protect.js).
   */
  var pdfjsReady = null;
  function loadPdfjs() {
    if (pdfjsReady) return pdfjsReady;
    pdfjsReady = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = BASE + 'js/vendor/pdfjs/pdf.min.js';
      s.onload = function () {
        var lib = window.pdfjsLib;
        if (!lib) { reject(new Error('PDF.js missing')); return; }
        lib.GlobalWorkerOptions.workerSrc = BASE + 'js/vendor/pdfjs/pdf.worker.min.js';
        resolve(lib);
      };
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return pdfjsReady;
  }

  // The manifest stores the original file name; show it without ".pdf".
  function displayName() { return M.files[slug].name.replace(/\.pdf$/i, ''); }

  function pagesSay(msg, isError) {
    if (!pagesStatus) return;
    pagesStatus.textContent = msg || '';
    pagesStatus.className = 've-lock__status' + (isError ? ' is-error' : '');
  }

  function showPdf(buf) {
    return loadPdfjs().then(function (lib) {
      // isEvalSupported: false is the hardening advised for PDF.js 3.x.
      return lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
    }).then(function (pdf) {
      var n = pdf.numPages, pending = [], i;
      pagesEl.innerHTML = '';
      pagesSay(n + (n === 1 ? ' page.' : ' pages.'));

      function makePage(num) {
        var box = document.createElement('section');
        box.className = 've-file__page';
        box.setAttribute('aria-label', 'Page ' + num + ' of ' + n);
        var canvas = document.createElement('canvas');
        canvas.setAttribute('aria-hidden', 'true');
        var text = document.createElement('div');
        text.className = 'sr-only';
        box.appendChild(canvas); box.appendChild(text);
        pagesEl.appendChild(box);
        return { num: num, box: box, canvas: canvas, text: text, drawn: false };
      }

      function draw(p) {
        if (p.drawn) return;
        p.drawn = true;
        pdf.getPage(p.num).then(function (page) {
          var base = page.getViewport({ scale: 1 });
          var width = Math.max(pagesEl.clientWidth, 320);
          var ratio = Math.min(window.devicePixelRatio || 1, 2);
          var scale = Math.min(width * ratio * 1.25 / base.width, 4);
          var vp = page.getViewport({ scale: scale });
          p.canvas.width = Math.floor(vp.width);
          p.canvas.height = Math.floor(vp.height);
          p.box.style.aspectRatio = base.width + ' / ' + base.height;
          return page.render({ canvasContext: p.canvas.getContext('2d'), viewport: vp }).promise;
        }).catch(function () { p.drawn = false; });
      }

      for (i = 1; i <= n; i++) pending.push(makePage(i));

      // Page size from page 1, so the placeholders hold their space.
      pdf.getPage(1).then(function (page) {
        var v = page.getViewport({ scale: 1 });
        pending.forEach(function (p) { p.box.style.aspectRatio = v.width + ' / ' + v.height; });
      });

      if ('IntersectionObserver' in window) {
        var io = new IntersectionObserver(function (entries) {
          entries.forEach(function (en) {
            if (!en.isIntersecting) return;
            var idx = Number(en.target.getAttribute('data-page')) - 1;
            draw(pending[idx]);
            io.unobserve(en.target);
          });
        }, { rootMargin: '800px 0px' });
        pending.forEach(function (p) { p.box.setAttribute('data-page', p.num); io.observe(p.box); });
      } else {
        pending.forEach(draw);
      }

      // Text for screen readers, one page after another.
      pending.reduce(function (chain, p) {
        return chain.then(function () {
          return pdf.getPage(p.num).then(function (page) { return page.getTextContent(); })
            .then(function (tc) {
              p.text.textContent = tc.items.map(function (it) { return it.str; }).join(' ');
            }, function () {});
        });
      }, Promise.resolve());
    });
  }

  function openFile(key) {
    return fetch(BASE + 've/files/' + slug + '.enc')
      .then(function (r) { return r.json(); })
      .then(function (blob) { return decrypt(key, blob); })
      .then(function (buf) {
        if (lockBox) lockBox.hidden = true;
        if (viewer) viewer.hidden = false;
        document.title = displayName() + ' | PARC';
        pagesSay('Opening\u2026');
        return showPdf(buf).catch(function () {
          pagesSay('The document could not be displayed. Reload the page to try again.', true);
        });
      });
  }

  function readCached() {
    try {
      var rec = sessionStorage.getItem(CACHE_KEY) || localStorage.getItem(CACHE_KEY);
      if (!rec) return null;
      var o = JSON.parse(rec);
      if (!o.k || (o.exp && Date.now() > o.exp)) { clearCached(); return null; }
      return o.k;
    } catch (e) { return null; }
  }
  function clearCached() {
    try { sessionStorage.removeItem(CACHE_KEY); localStorage.removeItem(CACHE_KEY); } catch (e) {}
  }

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!M) return;
      submit.disabled = true; submit.textContent = 'Opening…';
      say('Checking passphrase…');
      setTimeout(function () {
        deriveKey(input.value)
          .then(function (key) {
            return verify(key).then(function () {
              return crypto.subtle.exportKey('raw', key).then(function (raw) {
                var rec = JSON.stringify({ k: bytesToB64(raw), exp: Date.now() + 12 * 3600 * 1000 });
                try {
                  sessionStorage.setItem(CACHE_KEY, rec);
                  if (remember && remember.checked) localStorage.setItem(CACHE_KEY, rec);
                } catch (err) {}
                return openFile(key);
              });
            });
          })
          .catch(function () {
            setTimeout(function () {
              say('Incorrect passphrase.', true);
              submit.disabled = false; submit.textContent = 'Open file';
              input.value = ''; input.focus();
            }, 400);
          });
      }, 30);
    });
  }

  var relock = document.getElementById('ve-relock');
  if (relock) relock.addEventListener('click', function () { clearCached(); location.reload(); });
})();
