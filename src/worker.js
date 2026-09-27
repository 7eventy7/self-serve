// Cloudflare Worker: serves the built site from dist/ and handles the two
// download-stats endpoints. Everything that isn't /api/* is a static file.

import { ensureTable, json, noDb, moduleKey, TOTAL } from '../lib/stats.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/stats') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, { status: 405 });
      return getStats(env);
    }
    if (url.pathname === '/api/download') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, { status: 405 });
      return recordDownload(request, env);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, { status: 404 });

    return env.ASSETS.fetch(request);
  },
};

// GET /api/stats -> { total, modules: { "<id>": count } }
async function getStats(env) {
  if (!env.DB) return noDb();
  await ensureTable(env.DB);
  const { results } = await env.DB.prepare('SELECT id, count FROM downloads').all();

  const modules = {};
  let total = 0;
  for (const row of results) {
    if (row.id === TOTAL) total = row.count;
    else if (row.id.startsWith('m:')) modules[row.id.slice(2)] = row.count;
  }
  return json({ total, modules }, { headers: { 'cache-control': 'public, max-age=30' } });
}

// POST /api/download  { version: "26.3", modules: ["id", ...] }
// Bumps the total and each module's counter. Only ids that exist in the
// deployed manifest are counted, so random junk can't create rows.
async function recordDownload(request, env) {
  if (!env.DB) return noDb();

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Expected JSON' }, { status: 400 }); }

  const requested = Array.isArray(body?.modules)
    ? [...new Set(body.modules.filter((x) => typeof x === 'string' && x.length <= 100))].slice(0, 500)
    : [];
  if (!requested.length) return json({ error: 'No modules given' }, { status: 400 });

  const res = await env.ASSETS.fetch(new URL('/manifest.json', request.url));
  if (!res.ok) return json({ error: 'Manifest unavailable' }, { status: 500 });
  const manifest = await res.json();
  const known = new Set(manifest.versions.flatMap((v) => v.categories.flatMap((c) => c.modules.map((m) => m.id))));
  const ids = requested.filter((id) => known.has(id));
  if (!ids.length) return json({ error: 'No known modules' }, { status: 400 });

  await ensureTable(env.DB);
  const bump = env.DB.prepare(
    'INSERT INTO downloads (id, count) VALUES (?1, 1) ON CONFLICT(id) DO UPDATE SET count = count + 1'
  );
  await env.DB.batch([bump.bind(TOTAL), ...ids.map((id) => bump.bind(moduleKey(id)))]);

  return json({ ok: true, counted: ids.length });
}
