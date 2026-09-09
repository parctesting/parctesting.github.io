#!/usr/bin/env node
/**
 * Adds real alt text to the instructional images.
 *
 * These are not decoration. The exam-prep screenshots carry their instructions
 * as text baked INTO the image ("Door Within View of a Camera", "Put Phone in
 * Horizontal View"). With alt="" a blind candidate gets nothing at all — and
 * PARC actively serves candidates with disabilities, so this is a real failure
 * rather than a checklist item.
 *
 * Descriptions were written after looking at each image, not inferred from
 * filenames.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const ALT = {
  'DesktopSetup.png':
    'Overhead diagram of a correct exam desk: laptop centered with its camera facing the ' +
    'examinee, the room door inside the camera view, and a phone clipped upright in a stand ' +
    'at the front edge of the desk in horizontal orientation. A phone lying flat on the desk ' +
    'is crossed out.',
  'SS1.png':
    'Example screen layout for the exam: the basic calculator app open on the left side of the ' +
    'screen, and the ExamTools "Take an exam" page open in a browser on the right, showing the ' +
    'Join Exam Session button.',
  'SS2.jpg':
    'Second-device camera view of a candidate at their desk, showing the keyboard, monitor, and ' +
    'the candidate’s hands from a front and side angle.',
  'mount.jpg':
    'A phone held upright in a clip-style stand on a desk, positioned to view the candidate and ' +
    'their workspace during the exam.',
  'rotation.png':
    'Two phones side by side: one turned on its side labelled Horizontal, one upright labelled ' +
    'Vertical. The exam requires the horizontal orientation.',
  'exam1.png':
    'Screenshot of the ExamTools signing page listing the documents that require the ' +
    'candidate’s signature.',
  'exam2.png':
    'Screenshot of the Review Quick Form 605, showing the candidate’s name, address, and ' +
    'license details for checking before signing.',
  'exam3.png':
    'Screenshot of the CSCE (Certificate of Successful Completion of Examination) shown for ' +
    'review before signing.',
  'exam4.png':
    'Screenshot of the certification bullet points the candidate agrees to when signing.',
  'controlcenter.png':
    'Screenshot of the phone Control Center, used to turn on Do Not Disturb before the exam.',
  'dnd.png':
    'Screenshot of the Do Not Disturb setting switched on.',
  'PAUSE_BANNER.png':
    'Notice banner announcing that exam sessions are temporarily paused.',
  'Handiham_Logo.png': 'HandiHam logo',
  'letter.png': 'Auburn University Amateur Radio Club K4RY call sign plate',
  'PARC3.jpeg': 'PARC Radio & Technology club logo',
  'FB_LOGO.png': 'Facebook logo',
};

const files = [];
const walk = (d) => {
  for (const n of readdirSync(d, { withFileTypes: true })) {
    if (['.git', '.baseline', 'node_modules', 'design', 'tools', 'worker', 'data'].includes(n.name)) continue;
    const f = join(d, n.name);
    if (n.isDirectory()) walk(f);
    else if (n.name.endsWith('.html')) files.push(f);
  }
};
walk(ROOT);
walk(join(ROOT, '_ve-source'));

let changed = 0, filled = 0;
for (const f of files) {
  const before = readFileSync(f, 'utf8');
  const after = before.replace(/<img\b[^>]*>/gi, (tag) => {
    if (tag.includes('banner-')) return tag;
    const src = (tag.match(/src="([^"]*)"/i) || [])[1];
    if (!src) return tag;
    const base = decodeURIComponent(src.split('/').pop());
    const alt = ALT[base];
    if (!alt) return tag;
    const cur = tag.match(/\salt="([^"]*)"/i);
    if (cur && cur[1].trim()) return tag;               // already described
    filled++;
    return cur ? tag.replace(/\salt="[^"]*"/i, ` alt="${alt}"`)
               : tag.replace(/<img/i, `<img alt="${alt}"`);
  });
  if (after !== before) { writeFileSync(f, after); changed++; }
}
console.log(`alt text written: ${filled} image(s) across ${changed} file(s)`);
