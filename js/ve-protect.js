/**
 * Copy and download deterrents for unlocked VE material.
 *
 * Loaded by js/ve-lock.js once a script page is decrypted, and by
 * pages/ve-file.html for the training documents. A browser that can show a
 * page can always be made to give it up (developer tools, a photograph), so
 * this does not make copying impossible. It removes the easy routes:
 * selecting text, the right-click menu, copy and cut, dragging, the save,
 * print, view-source and select-all shortcuts, and printing from the menu
 * (css: html.ve-protected).
 *
 * Form fields stay usable: the dashboard's notes, result and settings can
 * still be typed in, selected and copied, and its Copy buttons still work.
 * Screen readers are unaffected; user-select does not hide text from them.
 */
(function () {
  'use strict';
  var de = document.documentElement;
  if (de.getAttribute('data-ve-protected') === '1') return;
  de.setAttribute('data-ve-protected', '1');
  de.className += ' ve-protected';

  var ALLOW = 'input, textarea, select, [contenteditable="true"], .ve-allow-copy';
  function allowed(t) {
    if (t && t.nodeType !== 1) t = t.parentNode;
    return !!(t && t.closest && t.closest(ALLOW));
  }

  var toast = null, timer = null;
  function notice() {
    if (!document.body) return;
    if (!toast) {
      toast = document.createElement('p');
      toast.className = 've-protect-notice';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      document.body.appendChild(toast);
    }
    toast.textContent = 'VE material may not be copied, saved or printed.';
    toast.classList.add('is-shown');
    clearTimeout(timer);
    timer = setTimeout(function () { toast.classList.remove('is-shown'); }, 3000);
  }

  function block(e) {
    if (allowed(e.target)) return;
    e.preventDefault();
    if (e.type !== 'selectstart' && e.type !== 'dragstart') notice();
  }
  ['copy', 'cut', 'contextmenu', 'selectstart', 'dragstart'].forEach(function (t) {
    document.addEventListener(t, block, true);
  });

  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    var k = (e.key || '').toLowerCase();
    // Save, print and view source everywhere; select all outside form fields.
    if (k === 's' || k === 'p' || k === 'u' || (k === 'a' && !allowed(e.target))) {
      e.preventDefault();
      notice();
    }
  }, true);

  window.addEventListener('beforeprint', notice);
})();
