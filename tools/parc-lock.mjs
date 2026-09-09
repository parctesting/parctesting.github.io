#!/usr/bin/env node
/**
 * Encrypts the VE pages and training PDFs for publication.
 *
 *   node tools/parc-lock.mjs             # prompts for the passphrase
 *   PARC_PASSCODE='…' node tools/parc-lock.mjs
 *
 * WHY ENCRYPTION AND NOT A LOGIN FORM
 * GitHub Pages serves static files; there is no server to check a password
 * against. A JavaScript gate would leave the script text sitting in View Source
 * for anyone who looked. Here the published page contains only ciphertext — the
 * plaintext is not on the server in any form.
 *
 * SHAPE
 *   _ve-source/*.html  ->  pages/*.html   (unlock shell + AES-GCM ciphertext)
 *   _ve-source/documents/* -> ve/files/*.enc
 *
 * CRYPTO
 *   PBKDF2-HMAC-SHA256, 600k iterations, one random salt per build (so a single
 *   unlock opens every page), then AES-256-GCM with a FRESH RANDOM IV per file.
 *   Reusing an IV under one key breaks GCM catastrophically — hence randomBytes
 *   inside the loop, never hoisted out of it.
 *
 * THREAT MODEL — be honest about this
 *   The ciphertext is public, so an attacker can guess offline at their leisure.
 *   600k iterations makes each guess expensive but a short passcode still falls
 *   quickly. Use a multi-word passphrase. This protects against casual discovery
 *   and search-engine indexing; it is not a defence against a determined
 *   attacker with a weak passphrase.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { pbkdf2Sync, randomBytes, createCipheriv } from 'node:crypto';
import { createInterface } from 'node:readline';
import { VE_PAGES, VE_SHELL_META, VE_TITLES, SITE } from './site-data.mjs';
import { buildHead, buildHeader, buildFooter, link } from './chrome.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SRC = join(ROOT, '_ve-source');
const ITERATIONS = 600_000;
const VERIFY_TOKEN = 'parc-ve-ok';

const b64 = (b) => Buffer.from(b).toString('base64');

function encrypt(key, plaintextBuf) {
  const iv = randomBytes(12);                       // fresh per file — see note above
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintextBuf), c.final()]);
  // WebCrypto expects the GCM tag appended to the ciphertext.
  return { iv: b64(iv), ct: b64(Buffer.concat([ct, c.getAuthTag()])) };
}

async function askPassphrase() {
  if (process.env.PARC_PASSCODE) return process.env.PARC_PASSCODE;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (q) => new Promise((res) => {
    process.stdout.write(q);
    rl.question('', (a) => res(a));
  });
  const a = await ask('VE passphrase (4+ words recommended): ');
  const b = await ask('Confirm: ');
  rl.close();
  if (a !== b) { console.error('\nPassphrases do not match.'); process.exit(1); }
  return a;
}

function lockShell(rel, payload) {
  const meta = { ...VE_SHELL_META, preloadBanner: false };
  return `<!doctype html>
<html lang="en">
<head>
${buildHead(rel, meta)}
</head>
<body>

${buildHeader(rel)}

<div class="container">
<section>
  <div class="ve-lock" id="ve-lock">
    <h1>Volunteer Examiner Access</h1>
    <p class="ve-lock__hint">This page is encrypted. Enter the VE passphrase to open it.</p>
    <form class="ve-lock__form" id="ve-form" autocomplete="off">
      <label class="ve-lock__label" for="ve-pass">Passphrase</label>
      <input class="ve-lock__input" id="ve-pass" name="passphrase" type="password"
             autocomplete="current-password" autocapitalize="off" spellcheck="false" required>
      <label class="ve-lock__remember">
        <input type="checkbox" id="ve-remember"> Remember on this device for 12 hours
      </label>
      <button class="btn btn--primary" type="submit" id="ve-submit">Unlock</button>
      <p class="ve-lock__status" id="ve-status" role="status" aria-live="polite"></p>
    </form>
    <p class="ve-lock__foot">Not a VE? <a href="${link(rel, '/index.html')}">Return to the PARC home page</a>.
      For access, email <a href="mailto:${SITE.veEmail}">${SITE.veEmail}</a>.</p>
  </div>
</section>
</div>

${buildFooter(rel)}

<script type="application/json" id="ve-payload">${JSON.stringify(payload)}</script>
<script src="${link(rel, '/js/site.js')}" defer></script>
<script src="${link(rel, '/js/search.js')}" defer></script>
<script src="${link(rel, '/js/ve-lock.js')}" defer></script>
</body>
</html>
`;
}

/* ---------- build -------------------------------------------------------- */
const allowWeak = process.argv.includes('--allow-weak');
const pass = await askPassphrase();

/* Short passcodes are a deliberate, informed choice here, not an oversight.
 * The published ciphertext lets an attacker guess offline with no rate limit,
 * so a 4-digit code is ~10,000 tries: about two hours on a Raspberry Pi and
 * under a second on a GPU. PBKDF2 cannot rescue a secret that small.
 *
 * It still fully delivers the anti-indexing goal (there is no plaintext for a
 * crawler to read, ever) and stops casual discovery. It does not stop someone
 * who decides to target it. --allow-weak says you accept that trade. */
if (pass.length < 8 && !allowWeak) {
  console.error('\nRefusing to build: passphrase is under 8 characters.');
  console.error('The ciphertext is public, so short passcodes are brute-forced offline.');
  console.error('Re-run with --allow-weak if that trade-off is intentional.');
  process.exit(1);
}
if (pass.length < 8) {
  console.warn('\n! Building with a short passcode (--allow-weak).');
  console.warn('! Protects against crawlers and casual discovery, NOT a determined attacker.');
  console.warn('! Upgrade any time: node tools/parc-lock.mjs\n');
} else if (!/\s|-|_/.test(pass) && pass.length < 16) {
  console.warn('\n! This looks like a single short token. A 4-word passphrase is much stronger.\n');
}

const salt = randomBytes(16);
const key = pbkdf2Sync(pass, salt, ITERATIONS, 32, 'sha256');
const base = { v: 1, salt: b64(salt), it: ITERATIONS };

let pages = 0;
for (const rel of VE_PAGES) {
  const name = basename(rel);
  const srcFile = join(SRC, name);
  if (!existsSync(srcFile)) { console.warn(`missing source: _ve-source/${name}`); continue; }
  const plain = readFileSync(srcFile);
  const enc = encrypt(key, plain);
  const title = VE_TITLES[name] || 'PARC VE';
  writeFileSync(join(ROOT, rel), lockShell(rel, { ...base, ...enc, t: title }));
  pages++;
}

/* Training PDFs. Encrypted the same way and served as opaque blobs, because a
   plain PDF under /Documents/ would stay downloadable no matter what the HTML
   pages do. */
const filesDir = join(ROOT, 've', 'files');
if (existsSync(filesDir)) rmSync(filesDir, { recursive: true });
mkdirSync(filesDir, { recursive: true });

const docDir = join(SRC, 'documents');
const manifest = { ...base, files: {} };
let docs = 0;
if (existsSync(docDir)) {
  for (const name of readdirSync(docDir)) {
    if (name.startsWith('.')) continue;
    const slug = name.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const enc = encrypt(key, readFileSync(join(docDir, name)));
    writeFileSync(join(filesDir, slug + '.enc'), JSON.stringify(enc));
    manifest.files[slug] = { name, type: extname(name) === '.pdf' ? 'application/pdf' : 'application/octet-stream' };
    docs++;
  }
}

// A tiny known-plaintext blob so ve-file.html can check a passphrase without
// downloading and decrypting a 3 MB PDF first.
manifest.verify = encrypt(key, Buffer.from(VERIFY_TOKEN, 'utf8'));
writeFileSync(join(ROOT, 'js', 've-manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`\nLocked ${pages} page(s) and ${docs} document(s).`);
console.log(`PBKDF2-SHA256 x${ITERATIONS.toLocaleString()}, AES-256-GCM, new salt this build.`);
console.log('Every VE must be given the new passphrase — the old one no longer opens anything.');
