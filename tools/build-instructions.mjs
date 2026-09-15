#!/usr/bin/env node
/**
 * Builds the Complete Text instructions, pages/Online_InstructionSeparation.html,
 * from the step-by-step pages.
 *
 *   node tools/build-instructions.mjs          # rewrite the page's content
 *   node tools/build-instructions.mjs --check  # exit 1 if it is out of date
 *
 * Until 2026-09-15 that page was a second copy of the steps, kept by hand. The two
 * copies drifted until they disagreed about when to join Zoom, which ID a minor
 * needs, how to name devices, when the CSCE arrives and more. Now there is one
 * copy: edit the step pages, then run this. Only the content zone is written, so
 * run tools/retheme.mjs afterwards (the sync scripts and deploy.mjs do both).
 *
 * From each step page it takes the <section> content and:
 *   - drops the Back/Next pager and the "next step" callout, which only make
 *     sense one page at a time, and anything between <!-- step-only --> markers
 *   - moves every heading down a level, so each page's h1 becomes a section h2
 *   - turns links to pages that are included here into links within this page
 *
 * It also keeps the step pages' own navigation current: each pager button is
 * named after the page it opens ("Next: Preparing Your Room"), and each step page
 * opens with its stage ("Step 3 of 5: Prepare"). --check fails when either is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PAGES_DIR = join(ROOT, 'pages');
const TARGET = join(PAGES_DIR, 'Online_InstructionSeparation.html');

/* Order is the order a candidate needs them. The ids keep links from before
   the rebuild working: #before-you-book, #registering, #what-to-prepare,
   #identification, #the-rules and #the-protocol all existed then. */
const SECTIONS = [
  { file: 'Online_GeneralInfo.html', id: 'before-you-book' },
  { file: 'Online_WhereandHowtoStudy.html', id: 'study' },
  { file: 'Online_HowtoScheduleandRegister.html', id: 'registering' },
  {
    title: 'Your situation', id: 'situation', parts: [
      { file: 'Online_SingleExam.html', id: 'one-exam' },
      { file: 'Online_MultiExam.html', id: 'multiple-exams' },
      { file: 'Online_MultiCandidate.html', id: 'multiple-candidates' },
      { file: 'Online_Handicapped.html', id: 'accommodations' },
    ],
  },
  { file: 'ID.html', id: 'identification' },
  { file: 'Online_Prep_Room.html', id: 'what-to-prepare' },
  { file: 'Online_Prep_Computer.html', id: 'computer' },
  { file: 'Online_Prep_2ndDevice.html', id: 'second-device' },
  { file: 'Online_Rules_IQ.html', id: 'the-rules' },
  { file: 'Online_Protocol.html', id: 'the-protocol' },
  { file: 'Online_CSCE_605.html', id: 'csce' },
];

const flat = SECTIONS.flatMap((s) => (s.parts ? s.parts : [s]));
const anchorFor = new Map(flat.map((s) => [s.file, s.id]));

/* The five stages Before You Book lists as its steps. Each step page opens with
   "Step 3 of 5: Prepare", so a reader always knows where they are. Before You
   Book itself is the introduction that lists the stages, so it has none. */
const STAGES = ['Study', 'Book, Pay and Register', 'Prepare', 'Rules', 'Exam Day'];
const STAGE_OF = {
  'Online_WhereandHowtoStudy.html': 1,
  'Online_HowtoScheduleandRegister.html': 2,
  'Online_SingleExam.html': 2,
  'Online_MultiExam.html': 2,
  'Online_MultiCandidate.html': 2,
  'Online_Handicapped.html': 2,
  'Online_Preparation.html': 3,
  'ID.html': 3,
  'Online_Prep_Room.html': 3,
  'Online_Prep_Computer.html': 3,
  'Online_Prep_2ndDevice.html': 3,
  'Online_Rules_IQ.html': 4,
  'Online_Protocol.html': 5,
  'Online_CSCE_605.html': 5,
};
/* Every page with a Back/Next pager. The checklist page is not part of the
   Complete Text, but it is part of the chain. */
const PAGER_PAGES = ['Online_GeneralInfo.html', ...Object.keys(STAGE_OF)];

function stepContent(file) {
  const html = readFileSync(join(PAGES_DIR, file), 'utf8');
  const container = html.indexOf('<div class="container">');
  const start = html.indexOf('<section>', container);
  const end = html.lastIndexOf('</section>', html.search(/<footer\b/));
  if (container === -1 || start === -1 || end <= start) {
    throw new Error(`${file}: expected <div class="container"><section>…</section>`);
  }
  return html.slice(start + '<section>'.length, end);
}

function transform(file, id, shift) {
  let s = stepContent(file)
    .replace(/<!-- step-only[\s\S]*?<!-- \/step-only -->\s*/g, '')
    .replace(/<nav class="page-links page-links--pager"[^>]*>[\s\S]*?<\/nav>\s*/g, '')
    .replace(/<div class="callout callout--next">[\s\S]*?<\/div>\s*/g, '');

  if (!/<h1>/.test(s)) throw new Error(`${file}: no <h1> to become the section heading`);
  s = s.replace(/<(\/?)h([1-6])\b/g, (m, slash, n) => `<${slash}h${Math.min(6, Number(n) + shift)}`);
  const level = 1 + shift;
  s = s.replace(`<h${level}>`, `<h${level} id="${id}" class="doc-section">`);

  s = s.replace(/href="([A-Za-z0-9_]+\.html)(#[^"]*)?"/g, (m, target, frag) => {
    if (!anchorFor.has(target)) return m;
    return `href="${frag || '#' + anchorFor.get(target)}"`;
  });
  return s.trim();
}

function title(file) {
  const m = stepContent(file).match(/<h1>([\s\S]*?)<\/h1>/);
  return m ? m[1].trim() : file;
}

/* ---- the step pages' own navigation ---------------------------------------
   A pager reading only "Back" and "Next" tells a screen reader user, and anyone
   scanning, nothing about where it goes. Labels come from the destination's h1,
   so renaming a page cannot leave a stale label behind. */
function headingOf(file) {
  const html = readFileSync(join(PAGES_DIR, file), 'utf8');
  const zone = html.slice(html.indexOf('<div class="container">'));
  const m = zone.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  if (!m) throw new Error(`${file}: no <h1> to name the pager link after`);
  return m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function progressBlock(stage) {
  const bar = STAGES.map((_, i) =>
    `<span${i + 1 < stage ? ' class="is-done"' : i + 1 === stage ? ' class="is-current"' : ''}></span>`).join('');
  return `<!-- step-only: progress -->
<p class="step-progress"><span class="step-progress__text">Step ${stage} of ${STAGES.length}: ${STAGES[stage - 1]}</span>
  <span class="step-progress__bar" aria-hidden="true">${bar}</span></p>
<!-- /step-only -->
`;
}

function withNavigation(file) {
  const path = join(PAGES_DIR, file);
  const html = readFileSync(path, 'utf8');
  let out = html.replace(
    /<nav class="page-links page-links--pager"[^>]*>([\s\S]*?)<\/nav>/,
    (m, inner) => '<nav class="page-links page-links--pager" aria-label="Instruction steps">' +
      inner.replace(/<a class="page-link page-link--(back|next)" href="([^"#]+)"[^>]*>[\s\S]*?<\/a>/g,
        (a, dir, href) => `<a class="page-link page-link--${dir}" href="${href}">` +
          `<span class="page-link__label">${dir === 'back' ? 'Back' : 'Next'}: ${headingOf(href)}</span></a>`) +
      '</nav>');
  if (out === html && !/page-links--pager/.test(html)) throw new Error(`${file}: no pager`);

  out = out.replace(/<!-- step-only: progress -->[\s\S]*?<!-- \/step-only -->\s*/, '');
  if (STAGE_OF[file]) {
    const zone = out.indexOf('<div class="container">');
    const h1 = out.indexOf('<h1', zone);
    if (zone === -1 || h1 === -1) throw new Error(`${file}: no <h1> to place the progress line above`);
    out = out.slice(0, h1) + progressBlock(STAGE_OF[file]) + '\n' + out.slice(h1);
  }
  return { path, html, out };
}

function build() {
  const blocks = [];
  const toc = [];
  for (const sec of SECTIONS) {
    if (sec.parts) {
      blocks.push(`<h2 id="${sec.id}" class="doc-section">${sec.title}</h2>`);
      for (const part of sec.parts) blocks.push(transform(part.file, part.id, 2));
      toc.push(`    <a class="page-link" href="#${sec.id}">${sec.title}</a>`);
    } else {
      blocks.push(transform(sec.file, sec.id, 1));
      toc.push(`    <a class="page-link" href="#${sec.id}">${title(sec.file)}</a>`);
    }
  }
  const body = blocks.join('\n\n');

  const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
  if (dupes.length) throw new Error(`duplicate ids on the combined page: ${[...new Set(dupes)].join(', ')}`);

  return `<div class="container">
<section>

<!-- Generated by tools/build-instructions.mjs from the step-by-step pages.
     Edit those pages, not this one: changes made here are overwritten. -->

<h1>Online Exam Instructions</h1>

<h2 class="instruction-choice__title">Choose an Instruction Format</h2>
<nav class="page-links instruction-choice" aria-label="Choose how to read the instructions">
  <div class="instruction-choice__item">
    <a class="page-link" href="Online_GeneralInfo.html">Step-by-Step Instructions</a>
    <p>One step per page, with a Next button at the end of each page.</p>
  </div>
  <div class="instruction-choice__item">
    <a class="page-link" href="#before-you-book">Complete Text Instructions</a>
    <p>All steps on this page, below, for reading in full or printing.</p>
  </div>
</nav>
<p>Candidates new to online examinations should first read the overview.</p>
<p class="btn-row"><a class="btn" href="online.html">Online Testing Overview</a></p>

<nav class="doc-toc" aria-label="On this page">
  <h2>Contents</h2>
  <div class="page-links">
${toc.join('\n')}
  </div>
  <p class="doc-toc__note">This page contains the complete requirements for online examinations. Select a section above to go directly to it.</p>
</nav>

<p class="checklist-cta"><a class="btn" href="Online_Preparation.html#checklist">Pre-Exam Checklist</a>
  <span>The same requirements as a printable checklist.</span></p>

${body}

<div class="callout callout--next">
  <h2>Book Your Exam</h2>
  <p>Select a time on the schedule. After the examination, refer to After Passing the Exam.</p>
  <p class="callout__actions">
    <a class="btn btn--primary" href="calendar.html">Book Your Exam</a>
    <a class="btn" href="whatnext.html">After Passing the Exam</a>
  </p>
</div>

</section>
</div>

</main>


`;
}

const CHECK = process.argv.includes('--check');

/* Step pages first: their progress lines are step-only, so the Complete Text
   built from them comes out the same either way, but it is built from what is
   on disk. */
const staleSteps = [];
for (const file of PAGER_PAGES) {
  const { path, html: before, out } = withNavigation(file);
  if (out === before) continue;
  if (CHECK) staleSteps.push(file);
  else writeFileSync(path, out);
}

const html = readFileSync(TARGET, 'utf8');
const zoneStart = html.indexOf('<div class="container">');
const zoneEnd = html.search(/<footer\b/);
if (zoneStart === -1 || zoneEnd <= zoneStart) throw new Error('Online_InstructionSeparation.html: no content zone');

const next = html.slice(0, zoneStart) + build() + html.slice(zoneEnd);
if (CHECK) {
  /* Compare content zones only: retheme owns the head and footer, and strips
     the <main> tags this writes, so whole-file equality would never hold. */
  const zoneOf = (h) => h.slice(h.indexOf('<div class="container">'), h.search(/<footer\b/))
    .replace(/<\/?main\b[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  let stale = false;
  if (staleSteps.length) {
    console.error(`Step navigation is out of date in ${staleSteps.join(', ')}: run node tools/build-instructions.mjs`);
    stale = true;
  }
  if (zoneOf(next) !== zoneOf(html)) {
    console.error('Online_InstructionSeparation.html is out of date: run node tools/build-instructions.mjs');
    stale = true;
  }
  if (stale) process.exit(1);
  console.log('Online_InstructionSeparation.html and the step navigation match the step pages');
} else {
  writeFileSync(TARGET, next);
  console.log(`Online_InstructionSeparation.html rebuilt from ${flat.length} step pages; ` +
    `navigation checked on ${PAGER_PAGES.length} step pages`);
}
