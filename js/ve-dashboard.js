/* VE Session Dashboard (pages/ve-dashboard.html, a locked VE page).
 *
 * Adapted from the QCWA / PARC Exam Observer Dashboard (NX9J, KA0YPE, AI1U).
 * The page itself is encrypted; this file holds no session details. The Zoom
 * link and the next-steps link come from data attributes on the decrypted page.
 *
 * Nothing here calls ExamTools, Telegram or any other service. Results are
 * copied to the clipboard and a VE pastes them where they belong.
 *
 * ES5 on purpose, like the rest of the site's scripts: no arrow functions,
 * classes, template literals or optional chaining (Safari 15 is the floor).
 */
(function () {
  'use strict';

  var root = document.getElementById('main');
  if (!root || !root.classList.contains('dash') || root.getAttribute('data-ready')) return;
  root.setAttribute('data-ready', '1');

  var STORE = 'parcVeDashboard', TAB_STORE = 'parcVeDashboardTab';
  var NOTES_MAX = 200000;
  var EXAMS = { KT: { label: 'Technician', max: 35 }, AG: { label: 'General', max: 35 }, AE: { label: 'Extra', max: 50 } };
  var READERS = {
    current: { label: 'Single Room', page: 'script.html' },
    full:    { label: 'F · Foxtrot', page: 'Online_ScriptF.html' },
    id:      { label: 'I · India', page: 'Online_ScriptI.html' },
    scan:    { label: 'S · Sierra', page: 'Online_ScriptS.html' },
    main:    { label: 'Main Room Setup', page: 'Online_MainRoomSetupScript.html' },
    preread: { label: 'Break Out Room Pre-Read', page: 'ScriptBreakOutPreRead.html' },
    romeo:   { label: 'R · Romeo', page: 'Online_ScriptR.html' },
    delta:   { label: 'D · Delta', page: 'Online_ScriptD.html' },
    easy:    { label: 'Easy Read', page: 'easyread.html' },
    compact: { label: 'No-Space Version', page: 'scriptnospace.html' },
    w5yi:    { label: 'W5YI Version', page: 'Online_ScriptW5YI.html' }
  };
  var COMMON = ['current', 'full', 'id', 'scan'];
  var DEFAULT_ZOOM = root.getAttribute('data-zoom') || '';
  var NEXT_STEPS = root.getAttribute('data-next-steps') || '';

  function $(id) { return document.getElementById(id); }
  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  function text(v, max) { return typeof v === 'string' ? v.slice(0, max || NOTES_MAX) : ''; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  /* ---------- pure helpers ---------------------------------------------- */
  function fmt(ms) {
    var sec = Math.floor(Math.max(0, isFinite(ms) ? ms : 0) / 1000);
    var min = Math.floor(sec / 60);
    return (min < 10 ? '0' : '') + min + ':' + pad(sec % 60);
  }
  function validZoom(value) {
    try {
      var u = new URL(value);
      return u.protocol === 'https:' && !u.username && !u.password &&
        (u.hostname === 'zoom.us' || /\.zoom\.us$/.test(u.hostname));
    } catch (e) { return false; }
  }
  function telegramUser(value) {
    var s = text(value, 80).replace(/^\s+|\s+$/g, '').replace(/^@/, '');
    return /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(s) ? s : '';
  }
  function scoreResult(exam, raw) {
    if (!EXAMS[exam]) return { ok: false, message: 'Select an exam.' };
    var value = String(raw).replace(/^\s+|\s+$/g, '');
    var max = EXAMS[exam].max;
    if (value === '') return { ok: false, message: 'Enter the number correct before saving a result.' };
    if (!/^\d+$/.test(value)) return { ok: false, message: 'Enter a whole number of correct answers.' };
    var n = Number(value);
    if (n < 0 || n > max) return { ok: false, message: 'Enter a score from 0 to ' + max + '.' };
    return { ok: true, number: n, max: max };
  }
  function buildResult(name, exam, score, ms) {
    var candidate = text(name, 100).replace(/\s+/g, ' ').replace(/^ | $/g, '');
    if (!candidate) return { ok: false, field: 'dash-applicant', message: 'Enter the applicant name before saving.' };
    var r = scoreResult(exam, score);
    if (!r.ok) { r.field = 'dash-score'; return r; }
    return {
      ok: true,
      line: candidate + ', ' + fmt(ms) + ', ' + exam + ', ' + r.number + '/' + r.max,
      fingerprint: JSON.stringify([candidate, exam, r.number, fmt(ms)])
    };
  }
  function cleanState(raw) {
    var r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    var p = r.preferences && typeof r.preferences === 'object' ? r.preferences : {};
    var t = r.timer && typeof r.timer === 'object' ? r.timer : {};
    var exam = EXAMS[r.exam] ? r.exam : 'KT';
    var score = (typeof r.score === 'string' || typeof r.score === 'number') ? String(r.score) : '';
    return {
      applicant: text(r.applicant, 100), exam: exam,
      score: scoreResult(exam, score).ok ? score : '',
      notes: text(r.notes), lastSummary: text(r.lastSummary, 1000), fingerprint: text(r.fingerprint, 1500),
      reader: READERS[r.reader] ? r.reader : 'current',
      timer: {
        elapsedMs: isFinite(t.elapsedMs) ? Math.max(0, Math.min(t.elapsedMs, 31536000000)) : 0,
        running: t.running === true,
        startedAtEpoch: isFinite(t.startedAtEpoch) ? t.startedAtEpoch : 0
      },
      preferences: {
        theme: p.theme === 'dark' ? 'dark' : 'light',
        remember: p.remember !== false,
        telegram: telegramUser(p.telegram || ''),
        zoom: validZoom(p.zoom) ? p.zoom : DEFAULT_ZOOM,
        textSize: p.textSize === 'large' ? 'large' : 'normal'
      }
    };
  }
  function restoreElapsed(timer) {
    var delta = timer.running && timer.startedAtEpoch > 0 ? Math.max(0, Date.now() - timer.startedAtEpoch) : 0;
    return Math.min(31536000000, Math.max(0, timer.elapsedMs) + delta);
  }
  function prependNote(notes, line) {
    var stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    var rest = notes.replace(/\s+$/, '');
    return '[' + stamp + '] ' + line + (rest.replace(/^\s+/, '') ? '\n' + rest : '');
  }

  /* ---------- storage ---------------------------------------------------- */
  var storageFailed = false;
  function read(kind, key) { try { return window[kind].getItem(key); } catch (e) { storageFailed = true; return null; } }
  function remove(kind, key) { try { window[kind].removeItem(key); return true; } catch (e) { storageFailed = true; return false; } }
  function decode(raw) {
    try { var d = JSON.parse(raw); return d && typeof d === 'object' && !Array.isArray(d) ? d : null; }
    catch (e) { return null; }
  }

  var saved = decode(read('sessionStorage', TAB_STORE)) || decode(read('localStorage', STORE));
  var state = cleanState(saved);
  var elapsed = restoreElapsed(state.timer), running = state.timer.running, start = now(), raf = 0;
  var lastSavedAt = 0, copying = false;

  function currentMs() { return elapsed + (running ? Math.max(0, now() - start) : 0); }
  function checkedExam() {
    var r = root.querySelector('input[name="dash-exam"]:checked');
    return r ? r.value : 'KT';
  }

  var statusEl = $('dash-status'), storageEl = $('dash-storage');
  function feedback(message, error) {
    statusEl.textContent = message;
    statusEl.classList.toggle('is-error', !!error);
  }
  function showStorage() {
    storageEl.classList.toggle('is-error', storageFailed);
    storageEl.textContent = storageFailed
      ? 'Browser storage is unavailable or full. Export the notes to keep a copy.'
      : state.preferences.remember
        ? 'Notes and session details are saved in this browser on this device.'
        : 'Notes and session details are kept only until this tab is closed. Export them before closing.';
  }
  function persist() {
    state.applicant = $('dash-applicant').value.slice(0, 100);
    state.score = $('dash-score').value;
    state.exam = checkedExam();
    state.notes = $('dash-notes').value.slice(0, NOTES_MAX);
    state.timer = { elapsedMs: currentMs(), running: running, startedAtEpoch: Date.now() };
    state.updatedAt = Date.now();
    var keep = state.preferences.remember;
    try {
      window[keep ? 'localStorage' : 'sessionStorage'].setItem(keep ? STORE : TAB_STORE, JSON.stringify(state));
      if (remove(keep ? 'sessionStorage' : 'localStorage', keep ? TAB_STORE : STORE)) storageFailed = false;
    } catch (e) { storageFailed = true; }
    lastSavedAt = Date.now();
    showStorage();
  }

  /* ---------- stopwatch -------------------------------------------------- */
  function draw() {
    $('dash-sw-time').textContent = fmt(currentMs());
    if (running) raf = window.requestAnimationFrame(draw);
  }
  function syncTimer() {
    $('dash-sw-toggle').textContent = running ? 'Pause Stopwatch' : elapsed > 0 ? 'Resume Stopwatch' : 'Start Stopwatch';
    $('dash-sw-state').textContent = running ? 'Running' : elapsed > 0 ? 'Paused' : 'Ready';
    $('dash-sw-reset').disabled = !running && elapsed === 0;
    $('dash-sw-time').textContent = fmt(currentMs());
  }
  function pause() {
    if (!running) return;
    elapsed = currentMs(); running = false;
    window.cancelAnimationFrame(raf); syncTimer();
  }
  function resetTimer() {
    running = false; window.cancelAnimationFrame(raf);
    elapsed = 0; start = now(); syncTimer();
  }

  $('dash-sw-toggle').addEventListener('click', function () {
    if (running) pause();
    else { running = true; start = now(); syncTimer(); draw(); }
    persist();
  });
  $('dash-sw-reset').addEventListener('click', function () {
    if (currentMs() > 0 && !window.confirm('Reset the stopwatch to 00:00? The notes and recorded results are kept.')) return;
    resetTimer(); persist(); feedback('Stopwatch reset.');
  });

  /* ---------- session form ---------------------------------------------- */
  function examChanged() {
    var ex = checkedExam();
    state.exam = ex;
    $('dash-score-label').textContent = 'Correct / ' + EXAMS[ex].max;
    $('dash-score').max = EXAMS[ex].max;
    $('dash-score').removeAttribute('aria-invalid');
    persist();
  }
  $('dash-applicant').addEventListener('input', function () { this.removeAttribute('aria-invalid'); persist(); });
  $('dash-score').addEventListener('input', function () { this.removeAttribute('aria-invalid'); persist(); });
  each(root.querySelectorAll('input[name="dash-exam"]'), function (r) { r.addEventListener('change', examChanged); });

  function copyText(value) {
    return new Promise(function (resolve) {
      if (!value.replace(/\s/g, '')) { resolve(false); return; }
      function fallback() {
        var ta;
        try {
          ta = document.createElement('textarea');
          ta.value = value; ta.readOnly = true;
          ta.style.cssText = 'position:fixed;left:-9999px;top:0';
          document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, ta.value.length);
          resolve(typeof document.execCommand === 'function' && document.execCommand('copy'));
        } catch (e) { resolve(false); }
        finally { if (ta && ta.parentNode) ta.parentNode.removeChild(ta); }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(function () { resolve(true); }, fallback);
      } else fallback();
    });
  }
  function copyLast() {
    if (!state.lastSummary) { feedback('Save a result before copying.'); return Promise.resolve(); }
    return copyText(state.lastSummary).then(function (ok) {
      if (ok) feedback('Result copied. Confirm the Telegram recipient before pasting.');
      else {
        $('dash-last').focus(); $('dash-last').select();
        feedback('The result was saved, but the browser blocked copying. Copy the selected result by hand.', true);
      }
    });
  }

  $('dash-save').addEventListener('click', function () {
    if (copying) return;
    var result = buildResult($('dash-applicant').value, checkedExam(), $('dash-score').value, currentMs());
    if (!result.ok) {
      feedback(result.message, true);
      $(result.field).setAttribute('aria-invalid', 'true');
      $(result.field).focus();
      return;
    }
    copying = true; $('dash-save').disabled = true;
    pause();
    result = buildResult($('dash-applicant').value, checkedExam(), $('dash-score').value, elapsed);
    if (state.fingerprint !== result.fingerprint) {
      var note = prependNote($('dash-notes').value, result.line);
      if (note.length > NOTES_MAX) {
        feedback('The notes are full. Export them and clear space before saving this result.', true);
        persist(); copying = false; $('dash-save').disabled = false;
        return;
      }
      state.lastSummary = result.line; state.fingerprint = result.fingerprint;
      $('dash-notes').value = note;
    }
    $('dash-last').value = state.lastSummary;
    $('dash-copy-last').disabled = false;
    persist();
    copyLast().then(function () { copying = false; $('dash-save').disabled = false; });
  });
  $('dash-copy-last').addEventListener('click', copyLast);

  $('dash-new').addEventListener('click', function () {
    var cur = buildResult($('dash-applicant').value, checkedExam(), $('dash-score').value, currentMs());
    var unsaved = running || ($('dash-applicant').value.replace(/\s/g, '') && (!cur.ok || cur.fingerprint !== state.fingerprint));
    if (unsaved && !window.confirm('Start a new applicant? Unsaved entries and the stopwatch time will be cleared. The notes and the last recorded result are kept.')) return;
    resetTimer();
    $('dash-applicant').value = ''; $('dash-score').value = '';
    $('dash-applicant').removeAttribute('aria-invalid'); $('dash-score').removeAttribute('aria-invalid');
    persist(); $('dash-applicant').focus();
    feedback('Ready for a new applicant. The notes and the last result are kept.');
  });

  /* ---------- notes ------------------------------------------------------ */
  $('dash-notes').addEventListener('input', persist);
  $('dash-clear-notes').addEventListener('click', function () {
    if (!$('dash-notes').value) return;
    if (!window.confirm('Clear all session notes? Export a copy first if it is needed.')) return;
    $('dash-notes').value = ''; persist(); feedback('Session notes cleared.');
  });
  $('dash-export').addEventListener('click', function () {
    if (!$('dash-notes').value.replace(/\s/g, '')) { feedback('There are no notes to export.'); return; }
    var stamp = new Date().toISOString();
    var blob = new Blob(['PARC VE session notes\nExported ' + stamp + '\n\n' + $('dash-notes').value + '\n'], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = 'PARC-VE-notes-' + stamp.slice(0, 10) + '.txt';
    document.body.appendChild(a); a.click(); a.parentNode.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    feedback('Notes exported to a text file.');
  });

  $('dash-copy-next').addEventListener('click', function () {
    copyText(NEXT_STEPS).then(function (ok) {
      feedback(ok ? 'Next-steps link copied.' : 'The browser blocked copying. Open the next-steps link from the Quick Guide.', !ok);
    });
  });

  /* ---------- reader ----------------------------------------------------- */
  var frame = $('dash-reader-frame');
  function chooseReader(key, save) {
    if (!READERS[key]) return;
    state.reader = key;
    var r = READERS[key];
    if (frame.getAttribute('src') !== r.page) frame.setAttribute('src', r.page);
    frame.title = 'Reader script: ' + r.label;
    $('dash-reader-tab').href = r.page;
    $('dash-reader-name').textContent = r.label;
    each(root.querySelectorAll('[data-reader]'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-reader') === key));
    });
    $('dash-reader-more').value = COMMON.indexOf(key) === -1 ? key : '';
    if (save !== false) persist();
  }
  each(root.querySelectorAll('[data-reader]'), function (b) {
    b.addEventListener('click', function () { chooseReader(b.getAttribute('data-reader')); });
  });
  $('dash-reader-more').addEventListener('change', function () { if (this.value) chooseReader(this.value); });
  $('dash-reader-focus').addEventListener('click', function () {
    var on = $('dash-workspace').classList.toggle('is-reader-focus');
    this.setAttribute('aria-pressed', String(on));
    this.textContent = on ? 'Show Session Tools' : 'Expand Reader';
  });

  /* ---------- appearance, settings, help --------------------------------- */
  function applyAppearance() {
    var dark = state.preferences.theme === 'dark';
    document.documentElement.setAttribute('data-dash-theme', dark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-dash-size', state.preferences.textSize);
    $('dash-theme').setAttribute('aria-pressed', String(dark));
    $('dash-zoom').href = state.preferences.zoom;
    $('dash-telegram').title = state.preferences.telegram
      ? 'Open @' + state.preferences.telegram
      : 'Set a Telegram destination in Settings';
  }
  $('dash-theme').addEventListener('click', function () {
    state.preferences.theme = state.preferences.theme === 'dark' ? 'light' : 'dark';
    applyAppearance(); persist();
  });

  var settings = $('dash-settings'), help = $('dash-help');
  function openDialog(d) {
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
  }
  function closeDialog(d) {
    if (typeof d.close === 'function') d.close();
    else d.removeAttribute('open');
  }
  function openSettings(focusTelegram) {
    $('dash-telegram-user').value = state.preferences.telegram ? '@' + state.preferences.telegram : '';
    $('dash-zoom-url').value = state.preferences.zoom;
    $('dash-text-size').value = state.preferences.textSize;
    $('dash-remember').checked = state.preferences.remember;
    $('dash-settings-status').textContent = '';
    openDialog(settings);
    if (focusTelegram) $('dash-telegram-user').focus();
  }
  $('dash-open-settings').addEventListener('click', function () { openSettings(false); });
  $('dash-settings-cancel').addEventListener('click', function () { closeDialog(settings); });
  $('dash-settings-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var raw = $('dash-telegram-user').value.replace(/^\s+|\s+$/g, '');
    var user = telegramUser(raw);
    var zoom = $('dash-zoom-url').value.replace(/^\s+|\s+$/g, '');
    if (raw && !user) {
      $('dash-settings-status').textContent = 'Enter a Telegram username of letters, numbers and underscores, optionally starting with @.';
      $('dash-telegram-user').focus(); return;
    }
    if (!validZoom(zoom)) {
      $('dash-settings-status').textContent = 'Enter an HTTPS meeting link on zoom.us.';
      $('dash-zoom-url').focus(); return;
    }
    state.preferences.telegram = user;
    state.preferences.zoom = zoom;
    state.preferences.textSize = $('dash-text-size').value === 'large' ? 'large' : 'normal';
    state.preferences.remember = $('dash-remember').checked;
    applyAppearance(); persist(); closeDialog(settings);
    feedback('Workspace settings updated.');
  });
  $('dash-erase').addEventListener('click', function () {
    if (!window.confirm('Erase this dashboard’s notes, session details and settings from this browser? Export the notes first if they are needed.')) return;
    resetTimer();
    var ok = true;
    each(['localStorage', 'sessionStorage'], function (kind) {
      each([STORE, TAB_STORE], function (key) { if (!remove(kind, key)) ok = false; });
    });
    state = cleanState(null);
    $('dash-applicant').value = ''; $('dash-score').value = ''; $('dash-notes').value = '';
    $('dash-last').value = ''; $('dash-copy-last').disabled = true;
    root.querySelector('input[name="dash-exam"][value="KT"]').checked = true;
    $('dash-score-label').textContent = 'Correct / 35'; $('dash-score').max = 35;
    applyAppearance(); chooseReader('current', false); closeDialog(settings);
    storageEl.textContent = ok
      ? 'Saved dashboard data was erased from this browser. New entries are saved as they are made.'
      : 'Some saved data could not be erased. Use the browser’s site data controls.';
    storageEl.classList.toggle('is-error', !ok);
    feedback(ok ? 'Dashboard data erased.' : 'Some saved data could not be erased.', !ok);
  });

  $('dash-open-help').addEventListener('click', function () { openDialog(help); });
  $('dash-help-close').addEventListener('click', function () { closeDialog(help); });

  $('dash-telegram').addEventListener('click', function () {
    if (!state.preferences.telegram) {
      openSettings(true);
      $('dash-settings-status').textContent = 'Enter the Telegram destination for results. No chat is preselected.';
      return;
    }
    window.open('https://t.me/' + encodeURIComponent(state.preferences.telegram), '_blank', 'noopener');
  });

  /* ---------- clocks ----------------------------------------------------- */
  function zoneParts(date, zone) {
    var opts = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short' };
    if (zone) opts.timeZone = zone;
    var f = new Intl.DateTimeFormat('en-US', opts);
    var parts = f.formatToParts ? f.formatToParts(date) : [];
    var out = { time: '', zone: '' };
    each(parts, function (p) {
      if (p.type === 'hour') out.time += (p.value === '24' ? '00' : p.value);
      else if (p.type === 'minute' || p.type === 'second') out.time += p.value;
      else if (p.type === 'literal' && p.value === ':') out.time += ':';
      else if (p.type === 'timeZoneName') out.zone = p.value;
    });
    return out;
  }
  function updateClocks() {
    var d = new Date();
    each([['central', 'America/Chicago'], ['local', undefined], ['utc', 'UTC']], function (c) {
      var p = zoneParts(d, c[1]);
      var t = $('dash-' + c[0] + '-time');
      t.textContent = p.time; t.setAttribute('datetime', d.toISOString());
      var dopts = { month: 'short', day: '2-digit', year: 'numeric' };
      if (c[1]) dopts.timeZone = c[1];
      $('dash-' + c[0] + '-date').textContent = new Intl.DateTimeFormat('en-US', dopts).format(d);
      if (c[0] !== 'utc') $('dash-' + c[0] + '-label').textContent = (c[0] === 'central' ? 'Central ' : 'Local ') + p.zone;
    });
  }

  /* ---------- start ------------------------------------------------------ */
  // The unlock form sits below the site banner, so the decrypted page would
  // otherwise open at the unlock form's scroll position, part-way down.
  if (!location.hash) window.scrollTo(0, 0);
  $('dash-applicant').value = state.applicant;
  $('dash-score').value = state.score;
  $('dash-notes').value = state.notes;
  $('dash-last').value = state.lastSummary;
  $('dash-copy-last').disabled = !state.lastSummary;
  root.querySelector('input[name="dash-exam"][value="' + state.exam + '"]').checked = true;
  $('dash-score-label').textContent = 'Correct / ' + EXAMS[state.exam].max;
  $('dash-score').max = EXAMS[state.exam].max;
  applyAppearance();
  chooseReader(state.reader, false);
  syncTimer();
  if (running) { draw(); feedback('A running stopwatch was restored. Check the restored time against the session record.'); }
  showStorage();
  updateClocks();
  setInterval(updateClocks, 1000);
  setInterval(function () { if (running && Date.now() - lastSavedAt >= 5000) persist(); }, 5000);
  window.addEventListener('pagehide', persist);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') persist(); });
})();
