#!/usr/bin/env node
/**
 * Generates sitemap.xml from tools/site-data.mjs.
 *
 * Only indexable public pages are listed. A sitemap containing noindex URLs
 * sends search engines contradictory signals, so VE shells and transactional
 * pages (payhere, waitlist) are omitted.
 */
import { writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SITE, PAGES } from './site-data.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

// Rough crawl priority: the pages candidates actually need, first.
const PRIORITY = {
  'index.html': '1.0',
  'pages/calendar.html': '0.9',
  'pages/Online_InstructionSeparation.html': '0.9',
  'pages/inperson.html': '0.8',
  'pages/faq.html': '0.8',
  'pages/whatnext.html': '0.7',
};

const urls = Object.entries(PAGES)
  .filter(([, meta]) => !meta.noindex)
  .map(([rel]) => {
    let lastmod = new Date().toISOString().slice(0, 10);
    try { lastmod = statSync(join(ROOT, rel)).mtime.toISOString().slice(0, 10); } catch {}
    return { loc: `${SITE.origin}/${rel}`, lastmod, priority: PRIORITY[rel] || '0.6' };
  })
  .sort((a, b) => Number(b.priority) - Number(a.priority));

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${u.lastmod}</lastmod>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>
`;
writeFileSync(join(ROOT, 'sitemap.xml'), xml);

// robots.txt has to name the same host, or it points crawlers at another site.
writeFileSync(join(ROOT, 'robots.txt'), `# ${SITE.origin.replace('https://','')}

User-agent: *
Allow: /

# VE pages are deliberately NOT disallowed: they carry a noindex meta tag, and a
# crawler has to be able to fetch a page to read it. A Disallow here would block
# the crawl, the noindex would never be seen, and URLs already known to a search
# engine could sit in the index with no way to remove them. The pages are
# encrypted, so there is nothing to read even when fetched.
Disallow: /ve/files/

Sitemap: ${SITE.origin}/sitemap.xml
`);
console.log(`sitemap.xml: ${urls.length} public URLs`);
console.log(`robots.txt : sitemap -> ${SITE.origin}/sitemap.xml`);
