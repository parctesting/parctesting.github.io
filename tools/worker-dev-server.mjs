#!/usr/bin/env node
/**
 * Runs worker/parc-reviews.js locally against an in-memory KV, so the reviews
 * and team logic can be exercised without deploying to Cloudflare or touching
 * live data.
 *
 *   node tools/worker-dev-server.mjs            # Turnstile off, no submit code
 *   WITH_TURNSTILE=1 node tools/worker-dev-server.mjs
 *   TEAM_CODE=ve-code node tools/worker-dev-server.mjs
 *
 * Then point a page at it:
 *   node tools/set-reviews-url.mjs http://127.0.0.1:8123
 * and put it back afterwards:
 *   node tools/set-reviews-url.mjs https://parc-reviews.<you>.workers.dev
 *
 * Bound to 127.0.0.1 deliberately. An earlier version listened on every
 * interface, which put a writable test endpoint on the whole LAN.
 *
 * Storage is in memory: restarting resets it, which is usually what you want.
 */
import { createServer } from 'node:http';
import worker from '../worker/parc-reviews.js';

const store = new Map();
const KV = {
  async get(k, type) {
    const v = store.get(k);
    return v == null ? null : (type === 'json' ? JSON.parse(v) : v);
  },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
  async list({ prefix, limit }) {
    const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
    return { keys: keys.slice(0, limit || 100), list_complete: true, cursor: null };
  },
};

const env = {
  REVIEWS: KV,
  ADMIN_KEY: process.env.ADMIN_KEY || 'test-admin-key',
  TEAM_SUBMIT_CODE: process.env.TEAM_CODE || undefined,
  /* Cloudflare's published always-passes test secret, so the real siteverify
     endpoint is exercised rather than a stand-in. 2x00…AA always fails. */
  TURNSTILE_SECRET: process.env.WITH_TURNSTILE
    ? '1x0000000000000000000000000000000AA' : undefined,
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://127.0.0.1:8123${req.url}`, {
    method: req.method,
    headers: { ...req.headers, 'CF-Connecting-IP': req.headers['x-test-ip'] || '203.0.113.9' },
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
  const out = await worker.fetch(request, env);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(8123, '127.0.0.1', () => {
  console.log('worker dev server: http://127.0.0.1:8123');
  console.log(`  admin key      : ${env.ADMIN_KEY}`);
  console.log(`  turnstile      : ${env.TURNSTILE_SECRET ? 'on (always passes)' : 'off'}`);
  console.log(`  team submit code: ${env.TEAM_SUBMIT_CODE || '(none — gate open)'}`);
});
