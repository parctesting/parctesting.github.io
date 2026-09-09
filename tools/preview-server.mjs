#!/usr/bin/env node
/**
 * Password-protected preview server for sharing the site with reviewers.
 *
 *   PREVIEW_USER=parc PREVIEW_PASS=somepass node tools/preview-server.mjs [port]
 *
 * TWO THINGS THIS DOES THAT `python3 -m http.server` DOES NOT:
 *
 * 1. It honours the same exclusions as _config.yml. A plain static server
 *    happily hands out /_ve-source/script.html — every exam script in
 *    plaintext. That is survivable on a home LAN and absolutely not survivable
 *    once the port is exposed to the internet through a tunnel.
 *
 * 2. HTTP Basic Auth, so a tunnel URL that leaks still asks for a password.
 *
 * This is for review only. Production is GitHub Pages, where Jekyll enforces
 * the same exclusions from _config.yml.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PORT = Number(process.argv[2]) || 8090;
const USER = process.env.PREVIEW_USER || 'parc';
const PASS = process.env.PREVIEW_PASS || '';

if (!PASS) {
  console.error('Refusing to start without PREVIEW_PASS set.');
  console.error('  PREVIEW_USER=parc PREVIEW_PASS=<something> node tools/preview-server.mjs');
  process.exit(1);
}

/** Mirrors the exclude: list in _config.yml. Anything matching is 404, not 403 —
 *  a 403 confirms the path exists, which is information we do not owe anyone. */
const BLOCKED = [/^_ve-source(\/|$)/, /^tools(\/|$)/, /^worker(\/|$)/, /^design(\/|$)/,
                 /^\.baseline(\/|$)/, /^\.git(\/|$)/, /^README\.md$/, /^_config\.yml$/];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.enc': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
};

function eq(a, b) {
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
}

function authed(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  return eq(u || '', USER) && eq(rest.join(':'), PASS);
}

const server = createServer(async (req, res) => {
  if (!authed(req)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="PARC site preview", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
    });
    return res.end('Authentication required.\n');
  }

  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }

  let rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  if (rel === '' || rel.endsWith('/')) rel = join(rel, 'index.html');
  if (rel.split(sep).some((p) => p === '..')) { res.writeHead(400); return res.end('Bad request'); }

  const relPosix = rel.split(sep).join('/');
  if (BLOCKED.some((re) => re.test(relPosix))) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }

  const file = join(ROOT, rel);
  try {
    const s = await stat(file);
    if (s.isDirectory()) throw new Error('dir');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
      // Reviewers only. Keep it out of every index even if the URL escapes.
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch {
    try {
      const body = await readFile(join(ROOT, '404.html'));
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`preview server on :${PORT}  (user "${USER}", Basic Auth required)`);
  console.log('blocked from this server: _ve-source, tools, worker, design, .baseline, .git');
});
