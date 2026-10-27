// One-time copy of an older SQLite database (data/risips.db) into Postgres. One transaction: every row, with the same
// ids and timestamps, or nothing. Runs on the first PGlite start (laptop, sandbox); production runs it through
// scripts/migrate-sqlite.ts during the cutover. Reads both SQLite formats: the JS backend's (plain session tokens) and
// this backend's earlier one (token hashes). Open OTP codes are not copied (they last minutes).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { paths } from '../config/env.ts';
import { sha256Hex } from '../utils/crypto.ts';
import { log } from '../utils/logger.ts';
import type { Param, Queryable } from './connection.ts';

interface Db extends Queryable { tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> }
type Row = Record<string, unknown>;

// Copied in this order (foreign keys point at users). mfc_sandbox is skipped: its links last minutes.
const TABLES: Record<string, string[]> = {
  users: ['id', 'email', 'mobile', 'pin_hash', 'data', 'created_at'],
  sessions: ['id', 'token_hash', 'user_id', 'device', 'os', 'ip', 'created_at', 'last_seen'],
  orders: ['id', 'user_id', 'kind', 'isin', 'isin_to', 'amount', 'state', 'data', 'created_at', 'updated_at'],
  checkouts: ['id', 'user_id', 'data', 'created_at'],
  watchlist: ['user_id', 'isin'],
  ext_imports: ['user_id', 'data', 'updated_at'],
};
const JSON_COLS = new Set(['data']);

/** Every row of a SQLite table (sessions' id is its rowid); a table or column the old file never had reads as empty / null. */
function readTable(src: DatabaseSync, table: string, cols: string[]): Row[] {
  if (!src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return [];
  const have = new Set((src.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  const select = cols.map((c) => {
    if (table === 'sessions' && c === 'id') return have.has('id') ? 'id' : 'rowid AS id';
    if (table === 'sessions' && c === 'token_hash' && !have.has('token_hash')) return 'token AS token_plain';
    return have.has(c) ? c : `NULL AS ${c}`;
  });
  const rows = src.prepare(`SELECT ${select.join(', ')} FROM ${table} ORDER BY rowid`).all() as Row[]; // insertion order (orders.seq follows it)
  // the JS backend stored session tokens in clear: hash them on the way in
  return table === 'sessions' ? rows.map(({ token_plain, ...r }) => (token_plain != null ? { ...r, token_hash: sha256Hex(String(token_plain)) } : r)) : rows;
}

/** Copies `file` into db; refuses when Postgres already has users. Returns the row count per table. */
export async function importSqlite(db: Db, file: string) {
  const src = new DatabaseSync(file, { readOnly: true });
  try {
    return await db.tx(async (tx) => {
      if (await tx.get('SELECT 1 FROM users LIMIT 1')) throw new Error('Postgres already has users; not importing over them.');
      const counts: Record<string, number> = {};
      for (const [table, cols] of Object.entries(TABLES)) {
        const rows = readTable(src, table, cols);
        for (const row of rows) {
          const values = cols.map((c): Param => {
            const v = row[c];
            if (!JSON_COLS.has(c)) return typeof v === 'bigint' ? Number(v) : (v as Param);
            try { JSON.parse((v as string | null) ?? '{}'); } catch { throw new Error(`${table} row ${String(row.id ?? row.user_id)}: data is not valid JSON`); }
            return (v as string | null) ?? '{}';
          });
          const params = cols.map((c, i) => `$${i + 1}${JSON_COLS.has(c) ? '::jsonb' : ''}`);
          await tx.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${params.join(', ')})`, values);
        }
        const n = (await tx.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;
        if (n !== rows.length) throw new Error(`${table}: copied ${n} of ${rows.length} rows`);
        counts[table] = n;
      }
      // the next new user / session continues after the copied ids
      for (const table of ['users', 'sessions']) {
        await tx.get(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`);
      }
      await tx.run("INSERT INTO meta (key, value) VALUES ('sqlite_import', $1)", [JSON.stringify({ file, at: new Date().toISOString(), counts })]);
      return counts;
    });
  } finally {
    src.close();
  }
}

/** Laptop / sandbox: the first start on Postgres copies the old SQLite database over, once. */
export async function importLegacySqlite(db: Db) {
  const legacy = path.join(paths.data, 'risips.db');
  if (!fs.existsSync(legacy) || (await db.get("SELECT 1 FROM meta WHERE key = 'sqlite_import'"))) return;
  const counts = await importSqlite(db, legacy);
  log.info(`Copied ${legacy} into Postgres`, counts);
}
