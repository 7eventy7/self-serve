import { ensureTable, json, noDb, moduleKey, TOTAL } from '../../lib/stats.js';

// POST /api/download  { version: "26.3", modules: ["id", ...] }
// Bumps the total and each module's counter. Only ids that exist in the
// deployed manifest are counted, so random junk can't create rows.
export async function onRequestPost({ request, env }) {
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
