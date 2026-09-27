import { ensureTable, json, noDb, TOTAL } from '../../lib/stats.js';

// GET /api/stats -> { total, modules: { "<id>": count } }
export async function onRequestGet({ env }) {
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
