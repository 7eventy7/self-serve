// Shared helpers for the download-stats Pages Functions.
// Counters live in one D1 table: "total" plus one "m:<module-id>" row per module.
// Counts are per module id, so a tweak's count spans every Minecraft version.

const SCHEMA = 'CREATE TABLE IF NOT EXISTS downloads (id TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0)';
export const TOTAL = 'total';
export const moduleKey = (id) => `m:${id}`;

export async function ensureTable(db) {
  await db.prepare(SCHEMA).run();
}

export function json(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function noDb() {
  return json({ error: 'Stats database not configured (bind a D1 database as DB).' }, { status: 503 });
}
