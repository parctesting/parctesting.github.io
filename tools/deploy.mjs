#!/usr/bin/env node
/**
 * PARC site build-and-deploy.
 *
 *   node tools/deploy.mjs             # build + verify, change nothing in git
 *   node tools/deploy.mjs --commit    # build + verify + commit
 *   node tools/deploy.mjs --push      # build + verify + commit + push
 *   node tools/deploy.mjs --check     # verify only, no rebuild
 *   node tools/deploy.mjs --refresh   # also refresh schedule availability first
 *
 * Every gate below exists because something actually went wrong during the
 * rebuild. None of them are hypothetical:
 *
 *   - build ORDER matters: retheme regenerates pages/ and would wipe the
 *     encrypted VE payloads if it ran after parc-lock
 *   - _ve-source/ must never be committed: this repo is a public fork, forks
 *     cannot be made private, and commits stay reachable through the upstream
 *     network even after a fork is deleted
 *   - .nojekyll must never exist: it disables the _config.yml exclude list
 *   - exam script TEXT must match the pre-rebuild tag exactly; these are read
 *     aloud during live FCC exams
 *
 * Any failed gate stops the run. Nothing is pushed unless every check passes.
 */
import { execSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { VE_PAGES, PAGES } from './site-data.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const args = process.argv.slice(2);
const DO_PUSH = args.includes('--push');
const DO_COMMIT = DO_PUSH || args.includes('--commit');
const CHECK_ONLY = args.includes('--check');
const REFRESH = args.includes('--refresh');
const BASELINE_TAG = 'pre-facelift-2026-08-22';

let failed = 0;
const ok = (m) => console.log(`  \x1b[32mok\x1b[0m    ${m}`);
const bad = (m) => { failed++; console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`); };
const warn = (m) => console.log(`  \x1b[33mwarn\x1b[0m  ${m}`);
const step = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);
const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });

/* ---------- helpers -------------------------------------------------------- */
const ENT = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&copy;': '(c)', '&rsquo;': "'", '&ldquo;': '"', '&rdquo;': '"',
  '&hellip;': '...', '&mdash;': '-', '&ndash;': '-' };
function textOf(h) {
  let s = h.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  for (const [k, v] of Object.entries(ENT)) s = s.split(k).join(v);
  return s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/\s+/g, ' ').trim();
}
function zone(h) {
  const a = h.search(/<div\s+class=["']container["']/i);
  const b = h.search(/<footer\b/i);
  const body = a === -1 || b === -1 || b <= a ? h : h.slice(a, b);

  /* The four toolbar dropdowns sit inside the container, so they land in this
     comparison even though they are navigation rather than exam text. Adding a
     link to a menu would otherwise report as script drift and train everyone to
     ignore that line. Verified across all 18 sources that no dropdown-content
     block contains a nested <div>, so the non-greedy match is safe. */
  return body
    .replace(/<div class="dropdown-content">[\s\S]*?<\/div>/g, '')
    .replace(/<button class="dropbtn">[\s\S]*?<\/button>/g, '')
    /* The toolbar also carries plain links styled as buttons, which are not
       inside a menu — the profile link is one. Same reasoning: navigation. */
    .replace(/<a class="[^"]*dropbtn[^"]*"[^>]*>[\s\S]*?<\/a>/g, '');
}

/* ---------- 1. build ------------------------------------------------------- */
if (!CHECK_ONLY) {
  if (REFRESH) {
    step('Refreshing schedule availability');
    try { console.log(run('node tools/fetch-availability.mjs --days=21').trim().split('\n').map(l => '  ' + l).join('\n')); }
    catch (e) { warn('availability refresh failed (Calendly unreachable?) — keeping the existing snapshot'); }
  }

  step('Building (order matters — see header)');
  // 1. public pages
  run('node tools/retheme.mjs');            ok('retheme.mjs   — public pages regenerated');
  // 2. alt text + sitemap
  run('node tools/fix-alt.mjs');            ok('fix-alt.mjs   — image descriptions applied');
  run('node tools/build-seo.mjs');          ok('build-seo.mjs — sitemap.xml regenerated');
  run('node tools/build-search-index.mjs'); ok('build-search-index.mjs — site search index rebuilt');
  // 3. encrypted pages LAST, so retheme cannot clobber them
  if (!process.env.PARC_PASSCODE) {
    warn('PARC_PASSCODE not set — skipping re-encryption, existing pages/ kept');
    warn('set it to rebuild the locked pages:  PARC_PASSCODE=… node tools/deploy.mjs');
  } else {
    const weak = process.env.PARC_PASSCODE.length < 8 ? ' --allow-weak' : '';
    run(`node tools/parc-lock.mjs${weak}`);  ok('parc-lock.mjs — VE pages re-encrypted');
  }
}

/* ---------- 2. verify ------------------------------------------------------ */
step('Verifying');

// exam script text unchanged since before the rebuild
try {
  let same = 0, added = 0, checked = 0;
  for (const rel of VE_PAGES) {
    const name = rel.split('/').pop();
    const src = join(ROOT, '_ve-source', name);
    if (!existsSync(src)) continue;

    /* A locked page written after the rebuild has nothing in the baseline to
       drift from. Counting it as a mismatch would turn "we added a page" into
       a failed integrity check and train everyone to ignore this line. */
    let before;
    try {
      before = textOf(zone(execSync(`git show ${BASELINE_TAG}:"${rel}"`,
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 1e8, stdio: ['pipe', 'pipe', 'ignore'] })));
    } catch { added++; continue; }

    checked++;
    if (before === textOf(zone(readFileSync(src, 'utf8')))) same++;
  }
  same === checked
    ? ok(`exam script text unchanged (${same}/${checked})`
        + (added ? `, ${added} locked page(s) added since` : ''))
    : bad(`exam script text DRIFTED — only ${same}/${checked} match ${BASELINE_TAG}`);
} catch { warn(`could not compare against ${BASELINE_TAG} (tag missing?)`); }

// every VE page carries ciphertext, and none leaks plaintext
{
  let withPayload = 0, leaks = 0;
  for (const rel of VE_PAGES) {
    const f = join(ROOT, rel);
    if (!existsSync(f)) { bad(`missing encrypted page: ${rel}`); continue; }
    let s = readFileSync(f, 'utf8');
    if (s.includes('ve-payload')) withPayload++;
    s = s.replace(/<script type="application\/json" id="ve-payload">[\s\S]*?<\/script>/, '')
         .replace(/<link rel="canonical"[^>]*>/, '');
    leaks += (s.match(/examinee|proctor|read aloud|force quit/gi) || []).length;
  }
  withPayload === VE_PAGES.length
    ? ok(`all ${withPayload} VE pages carry a ciphertext payload`)
    : bad(`only ${withPayload}/${VE_PAGES.length} VE pages have a payload — did retheme run after parc-lock?`);
  leaks === 0 ? ok('no plaintext script text in any published page')
              : bad(`${leaks} plaintext script phrase(s) found in published pages`);
}

// search index must never contain exam-script text
{
  const f = join(ROOT, 'data', 'search-index.json');
  if (!existsSync(f)) warn('data/search-index.json missing — site search will be unavailable');
  else {
    const raw = readFileSync(f, 'utf8');
    const leak = /All bracketed text is VE instruction|DO NOT READ|force quit which is/i.test(raw);
    const n = (JSON.parse(raw).docs || []).length;
    leak ? bad('search index contains VE script text — rebuild it')
         : ok(`search index clean (${n} public pages)`);
  }
}

// .nojekyll would disable the _config.yml excludes
existsSync(join(ROOT, '.nojekyll'))
  ? bad('.nojekyll EXISTS — this disables _config.yml and publishes build directories. Delete it.')
  : ok('.nojekyll absent (required — it would disable the exclude list)');

// _config.yml still excludes the build dirs
{
  const cfg = existsSync(join(ROOT, '_config.yml')) ? readFileSync(join(ROOT, '_config.yml'), 'utf8') : '';
  ['_ve-source', 'tools', 'worker', 'design'].every((d) => cfg.includes(d))
    ? ok('_config.yml excludes _ve-source, tools, worker, design')
    : bad('_config.yml is missing one of the required excludes');
}

// links
try {
  execFileSync('node', ['tools/check-links.mjs'], { cwd: ROOT, stdio: 'pipe' });
  ok('no broken internal links');
} catch (e) {
  bad('broken internal links — run: node tools/check-links.mjs');
}

// markup balance
{
  const walk = (d, a = []) => {
    for (const n of readdirSync(d)) {
      if (['.git', '.baseline', 'node_modules', 'design', 'tools', 'worker', '__preview'].includes(n)) continue;
      const f = join(d, n);
      statSync(f).isDirectory() ? walk(f, a) : n.endsWith('.html') && a.push(f);
    }
    return a;
  };
  let unbalanced = 0;
  for (const f of walk(ROOT)) {
    const s = readFileSync(f, 'utf8');
    if ((s.match(/<main\b/g) || []).length !== 1 || (s.match(/<\/main>/g) || []).length !== 1) unbalanced++;
  }
  unbalanced === 0 ? ok('every page has exactly one <main>…</main>')
                   : bad(`${unbalanced} page(s) with unbalanced <main> — re-run retheme`);
}

// schedule data: live Worker, or the committed snapshot?
{
  const page = join(ROOT, 'pages', 'calendar.html');
  const m = existsSync(page) && readFileSync(page, 'utf8').match(/data-availability-endpoint="([^"]*)"/);
  const worker = m && m[1] ? m[1] : '';
  const f = join(ROOT, 'data', 'availability.json');
  const age = existsSync(f)
    ? (Date.now() - new Date(JSON.parse(readFileSync(f, 'utf8')).generated)) / 3600000
    : null;

  if (worker) {
    ok(`live availability via Worker: ${worker}`);
    if (age === null) warn('no data/availability.json — nothing to fall back on if the Worker fails');
    else if (age > 24 * 14) warn(`fallback snapshot is ${(age / 24).toFixed(0)} days old — refresh it occasionally`);
    else ok(`fallback snapshot present (${(age / 24).toFixed(1)} days old)`);
  } else if (age === null) {
    bad('no Worker configured AND no data/availability.json — the schedule page has no data at all');
  } else if (age < 24) {
    ok(`schedule availability is ${age.toFixed(1)}h old (snapshot; no Worker configured)`);
  } else {
    warn(`schedule availability is ${(age / 24).toFixed(1)} days old — run with --refresh, or configure the Worker`);
  }
}

/* ---------- 3. the gate that protects the fork ----------------------------- */
step('Checking what git would publish');
{
  const staged = run('git status --porcelain').trim().split('\n').filter(Boolean);
  const danger = staged.filter((l) => /_ve-source\/|design\//.test(l));
  danger.length === 0
    ? ok('no plaintext scripts or PSDs would be committed')
    : bad(`REFUSING: these must never enter a public fork:\n${danger.map((d) => '          ' + d).join('\n')}`);

  const tracked = run('git ls-files').split('\n');
  tracked.some((f) => f.startsWith('_ve-source/'))
    ? bad('REFUSING: _ve-source/ is TRACKED in git. Run: git rm -r --cached _ve-source')
    : ok('_ve-source/ is not tracked');
}

/* ---------- 4. result ------------------------------------------------------ */
if (failed) {
  console.log(`\n\x1b[31m${failed} check(s) failed. Nothing was committed or pushed.\x1b[0m\n`);
  process.exit(1);
}
console.log('\n\x1b[32mAll checks passed.\x1b[0m');

if (!DO_COMMIT) {
  console.log('\nNothing committed (dry run). To commit:  node tools/deploy.mjs --commit');
  console.log('To commit and push:                     node tools/deploy.mjs --push\n');
  process.exit(0);
}

step('Committing');
const changes = run('git status --porcelain').trim();
if (!changes) { console.log('  nothing to commit — working tree is clean'); process.exit(0); }
run('git add -A');
const msg = process.env.DEPLOY_MSG || `Site update ${new Date().toISOString().slice(0, 10)}`;
execSync(`git commit -q -m "${msg.replace(/"/g, '\\"')}"`, { cwd: ROOT, stdio: 'inherit' });
ok(run('git log --oneline -1').trim());

if (!DO_PUSH) {
  console.log('\nCommitted but not pushed. To push:  git push\n');
  process.exit(0);
}

step('Pushing');
const branch = run('git branch --show-current').trim();
console.log(`  pushing ${branch} to origin…`);
execSync(`git push -u origin ${branch}`, { cwd: ROOT, stdio: 'inherit' });
console.log('\n\x1b[32mPushed.\x1b[0m If this is the PR branch, open the pull request against parctesting/beta.\n');
