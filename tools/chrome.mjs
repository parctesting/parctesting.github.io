/**
 * Shared page chrome: <head>, header/nav, footer.
 *
 * Imported by BOTH tools/retheme.mjs (public pages) and tools/parc-lock.mjs
 * (encrypted VE unlock shells), so a locked page is visually identical to the
 * rest of the site and there is exactly one copy of the nav in the codebase.
 */
import { SITE, NAV } from './site-data.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Relative-path prefix for a page, so a build works at ANY mount point.
 *
 * The site is served from the domain root in production (parcradio.net) but
 * from a SUBPATH when a fork publishes it for review
 * (collinpikeusa.github.io/parc-website-beta/). Root-relative "/css/site.css"
 * breaks in the second case. Emitting "../css/site.css" from pages/ and
 * "css/site.css" from the root works in both, with no build flag to remember.
 */
export function relPrefix(rel) {
  const depth = rel.replace(/\\/g, '/').split('/').length - 1;
  return depth ? '../'.repeat(depth) : '';
}

/** Turn a site-absolute path ("/pages/faq.html") into one relative to `rel`. */
export function link(rel, path) {
  if (!path || !path.startsWith('/')) return path;
  return relPrefix(rel) + path.slice(1);
}

/* ---------- head ---------------------------------------------------------- */
export function buildHead(rel, meta) {
  const url = SITE.origin + '/' + rel.replace(/\\/g, '/');
  const title = `${meta.title} | ${SITE.short}`;
  const noindex = !!meta.noindex;
  const L = [];
  L.push('<meta charset="UTF-8">');
  L.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  L.push(`<title>${esc(title)}</title>`);
  if (meta.desc) L.push(`<meta name="description" content="${esc(meta.desc)}">`);
  L.push(`<link rel="canonical" href="${esc(url)}">`);
  if (noindex) {
    L.push('<meta name="robots" content="noindex, nofollow">');
  } else {
    L.push('<meta name="robots" content="index, follow, max-image-preview:large">');
    if (SITE.googleSiteVerification)
      L.push(`<meta name="google-site-verification" content="${esc(SITE.googleSiteVerification)}">`);
  }
  L.push('');
  if (!noindex) {
    L.push(`<meta property="og:type" content="website">`);
    L.push(`<meta property="og:site_name" content="${esc(SITE.name)}">`);
    L.push(`<meta property="og:title" content="${esc(meta.title)}">`);
    if (meta.desc) L.push(`<meta property="og:description" content="${esc(meta.desc)}">`);
    L.push(`<meta property="og:url" content="${esc(url)}">`);
    L.push(`<meta property="og:image" content="${esc(SITE.origin + SITE.ogImage)}">`);
    L.push(`<meta name="twitter:card" content="summary_large_image">`);
    L.push('');
  }
  L.push('<meta name="theme-color" content="#BA0005">');
  /* Chrome on Android auto-darkens pages that state no preference, inverting
     colours in the compositor after CSS has run. It gets menus wrong — a light
     dropdown panel keeps light text and becomes unreadable. Declaring a scheme
     opts the page out. This site is light by design; if a dark palette is ever
     added, change this to "light dark" rather than removing it. */
  L.push('<meta name="color-scheme" content="light">');
  L.push(`<link rel="icon" href="${link(rel, '/favicon.ico')}" sizes="any">`);
  L.push(`<link rel="stylesheet" href="${link(rel, '/css/site.css')}">`);
  if (meta.preloadBanner !== false)
    L.push(`<link rel="preload" as="image" href="${link(rel, SITE.banner)}" fetchpriority="high">`);
  /* Cloudflare Web Analytics. Matches the snippet Cloudflare issues verbatim
     (type="module", which defers by default). The token is not a secret — it
     ships in the HTML of every page by design. */
  /* Not on noindex pages. The VE script pages are the reason: examiners open
     them repeatedly during a live exam session, which would inflate pageviews
     and distort any comparison of public traffic between two sites. Also keeps
     volunteers off the analytics entirely. */
  if (SITE.analyticsToken && !noindex) {
    L.push('');
    L.push('<!-- Cloudflare Web Analytics -->');
    L.push('<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js" ' +
           `data-cf-beacon='{"token": "${esc(SITE.analyticsToken)}"}'></script>`);
    L.push('<!-- End Cloudflare Web Analytics -->');
  }
  if (meta.schemaJson) {
    L.push('');
    L.push('<script type="application/ld+json">');
    L.push(JSON.stringify(meta.schemaJson, null, 2));
    L.push('</script>');
  }
  return L.join('\n');
}

/* ---------- header + nav -------------------------------------------------- */
export function navHtml(rel) {
  const here = '/' + rel.replace(/\\/g, '/');
  const item = (n) => {
    if (!n.children) {
      const cur = n.href === here ? ' aria-current="page"' : '';
      return `        <li><a href="${esc(link(rel, n.href))}"${cur}>${esc(n.label)}</a></li>`;
    }
    const kids = n.children.map((c) => {
      const ext = c.external ? ' target="_blank" rel="noopener"' : '';
      return `            <li><a href="${esc(link(rel, c.href))}"${ext}>${esc(c.label)}</a></li>`;
    }).join('\n');
    return `        <li class="has-sub">
          <button type="button" class="nav-sub-toggle" aria-expanded="false">${esc(n.label)}</button>
          <ul class="nav-sub">
${kids}
          </ul>
        </li>`;
  };
  return `      <ul class="nav-menu" id="nav-menu">
${NAV.map(item).join('\n')}
      </ul>`;
}

export function buildHeader(rel) {
  return `<a class="skip-link" href="#main">Skip to content</a>

<header class="site-header">
  <a class="site-banner" href="${link(rel, '/index.html')}" aria-label="${esc(SITE.name)} home">
    <picture>
      <source media="(max-width: 700px)" srcset="${link(rel, SITE.bannerMobile)}">
      <img src="${link(rel, SITE.banner)}" width="1600" height="192" fetchpriority="high"
           alt="${esc(SITE.name)}">
    </picture>
  </a>

  <nav class="site-nav" id="menu" aria-label="Main">
    <div class="site-nav__inner">
      <button type="button" class="nav-toggle" aria-expanded="false" aria-controls="nav-menu">
        <span class="nav-toggle__bars" aria-hidden="true"></span> Menu
      </button>
${navHtml(rel)}
      <button type="button" class="nav-search-toggle" id="site-search-toggle"
              aria-expanded="false" aria-controls="site-search-panel" aria-label="Search this site">
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
          <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="2"/>
          <line x1="12.8" y1="12.8" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <span class="nav-search-toggle__label">Search</span>
      </button>

      <form class="nav-donate-form" action="https://www.paypal.com/cgi-bin/webscr" method="post" target="_top">
        <input type="hidden" name="cmd" value="_s-xclick">
        <input type="hidden" name="hosted_button_id" value="${SITE.paypalButton}">
        <button type="submit" class="nav-donate">Donate</button>
      </form>
    </div>

    <div class="search-panel" id="site-search-panel" hidden>
      <form class="search-panel__inner" id="site-search" role="search" autocomplete="off">
        <label class="sr-only" for="site-search-input">Search this site</label>
        <input id="site-search-input" type="search" name="q"
               placeholder="Search for fees, ID, scheduling, what to expect…"
               aria-controls="site-search-results" aria-expanded="false"
               aria-autocomplete="list" role="combobox">
        <button type="button" class="search-panel__close" id="site-search-close"
                aria-label="Close search">&times;</button>
        <div class="nav-search__results" id="site-search-results" hidden></div>
      </form>
    </div>
  </nav>
</header>

<main id="main">`;
}

/* ---------- footer -------------------------------------------------------- */
export function buildFooter(rel = 'index.html') {
  const a = SITE.address;
  return `</main>

<footer class="site-footer">
  <div class="site-footer__inner">
    <div>
      <h2>Contact Us</h2>
      <p>${esc(SITE.name)}<br>
         ${esc(a.po)}<br>
         ${esc(a.city)}, ${esc(a.state)} ${esc(a.zip)}<br>
         ${esc(a.country)}</p>
      <p><a href="mailto:${esc(SITE.email)}">${esc(SITE.email)}</a></p>
      <p>Our examiners are volunteers. Please allow up to 24 hours for a reply.</p>
    </div>
    <div>
      <h2>Exams</h2>
      <ul>
        <li><a href="${link(rel, '/pages/calendar.html')}">Schedule an exam</a></li>
        <li><a href="${link(rel, '/pages/Online_InstructionSeparation.html')}">Online testing</a></li>
        <li><a href="${link(rel, '/pages/inperson.html')}">In-person testing</a></li>
        <li><a href="${link(rel, '/pages/faq.html')}">FAQ</a></li>
      </ul>
    </div>
    <div>
      <h2>More</h2>
      <ul>
        <li><a href="${link(rel, '/pages/whatnext.html')}">What's next after passing</a></li>
        <li><a href="${link(rel, '/pages/handiham.html')}">Accessible testing</a></li>
        <li><a href="${link(rel, '/pages/donations.html')}">Support PARC</a></li>
        <li><a href="${esc(SITE.facebook)}" target="_blank" rel="noopener">Facebook group</a></li>
      </ul>
    </div>
  </div>
  <div class="site-footer__bottom">
    <span>&copy; 2020&ndash;${new Date().getFullYear()} ${esc(SITE.name)}</span>
    <a class="site-footer__ve" href="${link(rel, '/pages/script.html')}" rel="nofollow">VE Access</a>
  </div>
</footer>`;
}
