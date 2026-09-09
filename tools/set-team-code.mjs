#!/usr/bin/env node
/**
 * Sets the code that lets a VE add themselves to the team page.
 *
 *   node tools/set-team-code.mjs "some-long-random-string"
 *   node tools/set-team-code.mjs --clear
 *
 * The code goes into _ve-source/team-submit.html, which parc-lock encrypts. It
 * therefore exists only inside that page's ciphertext: without the VE passcode
 * there is no way to read it, so it is a real gate rather than a hidden URL.
 *
 * The same value goes into the Worker as the secret TEAM_SUBMIT_CODE. With the
 * secret unset the Worker does not check, so the form keeps working while this
 * is being set up.
 *
 * Re-run this whenever the VE passcode changes: anyone who had the old passcode
 * kept a copy of this code along with it.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PAGE = join(ROOT, '_ve-source', 'team-submit.html');
const arg = process.argv[2];

if (!arg) {
  console.error('usage: node tools/set-team-code.mjs <code> | --clear');
  process.exit(2);
}
if (!existsSync(PAGE)) {
  console.error(`Not found: ${PAGE}`);
  console.error('The VE sources live outside this repository — check they are present.');
  process.exit(1);
}

const code = arg === '--clear' ? '' : arg.trim();
if (code && code.length < 16) {
  console.error(`Refusing: that code is ${code.length} characters.`);
  console.error('Use at least 16 — generate one with:  openssl rand -base64 24');
  process.exit(1);
}
if (/["<>]/.test(code)) {
  console.error('Refusing: the code cannot contain quotes or angle brackets.');
  process.exit(1);
}

const before = readFileSync(PAGE, 'utf8');
const after = before.replace(/(data-team-code=")[^"]*(")/, `$1${code}$2`);
if (after === before && code) {
  console.error('Could not find data-team-code in the team-submit page.');
  process.exit(1);
}
writeFileSync(PAGE, after);

console.log(code ? 'Team submit code set in the locked page.' : 'Team submit code cleared.');
console.log('\nSet the SAME value on the Worker:');
console.log('  Workers & Pages → parc-reviews → Settings → Variables and Secrets');
console.log('  Add a secret named TEAM_SUBMIT_CODE\n');
console.log('Then rebuild so the page is re-encrypted with it:');
console.log('  PARC_PASSCODE=... node tools/parc-lock.mjs');
