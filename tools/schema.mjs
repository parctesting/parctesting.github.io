/**
 * JSON-LD builders. Structured data doesn't rank a page by itself — it helps
 * search engines understand what the page *is*, and makes it eligible for
 * richer result formats.
 *
 * Reality check on FAQPage: Google limited FAQ rich results to authoritative
 * government and health sites in 2023, so this will very likely not produce
 * expandable Q&A in Google for PARC. It is still correct markup, still helps
 * comprehension, and Bing does still render it. Keep expectations there.
 */
import { readFileSync } from 'node:fs';
import { SITE } from './site-data.mjs';

const decode = (s) => s
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'")
  .replace(/&ldquo;|&rdquo;/g, '"').replace(/&hellip;/g, '...')
  .replace(/\s+/g, ' ').trim();

export function organizationSchema() {
  const a = SITE.address;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': SITE.origin + '/#organization',
        name: SITE.name,
        alternateName: 'PARC',
        url: SITE.origin + '/',
        email: SITE.email,
        logo: { '@type': 'ImageObject', url: SITE.origin + SITE.ogImage },
        description: SITE.tagline,
        address: {
          '@type': 'PostalAddress',
          postOfficeBoxNumber: a.po,
          addressLocality: a.city,
          addressRegion: a.state,
          postalCode: a.zip,
          addressCountry: 'US',
        },
        areaServed: { '@type': 'Country', name: 'United States' },
        sameAs: [SITE.facebook],
        knowsAbout: [
          'Amateur radio licensing',
          'FCC amateur radio examinations',
          'Volunteer Examiner sessions',
          'Technician, General and Amateur Extra class licenses',
        ],
      },
      {
        '@type': 'WebSite',
        '@id': SITE.origin + '/#website',
        url: SITE.origin + '/',
        name: SITE.name,
        publisher: { '@id': SITE.origin + '/#organization' },
        inLanguage: 'en-US',
      },
    ],
  };
}

/**
 * Pulls Q&A pairs out of pages/faq.html.
 *
 * The markup is <ol><li><strong>Question</strong></li> followed by loose answer
 * text until the next <li>. That is invalid-ish HTML but consistent, so parsing
 * it is reliable — and it means the schema regenerates from the page itself
 * rather than drifting out of sync with a hand-kept copy.
 */
export function faqSchema(faqPath) {
  const html = readFileSync(faqPath, 'utf8');
  const ol = html.slice(html.indexOf('<ol>'), html.lastIndexOf('</ol>'));
  if (ol.length < 50) return null;

  const chunks = ol.split(/<li\b[^>]*>/i).slice(1);
  const items = [];
  for (const chunk of chunks) {
    const qm = chunk.match(/^\s*<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/i);
    if (!qm) continue;
    const question = decode(qm[1]).replace(/\s*[:?]?\s*$/, (m) => (m.includes('?') ? '?' : ''));
    const after = chunk.slice(qm[0].length).replace(/<\/li>/i, '');
    const answer = decode(after);
    if (question.length < 8 || answer.length < 12) continue;
    items.push({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer.slice(0, 1200) },
    });
  }
  if (!items.length) return null;
  return { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items };
}

export function breadcrumb(trail) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({
      '@type': 'ListItem', position: i + 1, name: t.name, item: SITE.origin + t.href,
    })),
  };
}
