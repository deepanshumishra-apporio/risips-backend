// Postgres. With DATABASE_URL (production: AWS RDS) a `pg` connection pool; without it (laptop, sandbox) an embedded
// Postgres (PGlite) keeps the data in <state>/data/pg, so every environment runs the same SQL. Production refuses to
// start without DATABASE_URL. Most user/order data lives in JSONB columns.
//
// Two handles on the same connection(s):
// - `orm`: Drizzle (typed queries on schema.ts). The repositories use it for everything.
// - `db`: plain SQL, for what a query builder doesn't fit: migrations (DDL), the one-time SQLite import, and tests.
// Schema changes go in migrations.ts AND schema.ts (test/schema.test.ts checks that they agree).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { PGlite, Transaction } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { config, paths } from '../config/env.ts';
import { errMsg, log } from '../utils/logger.ts';

const TIMESTAMPTZ = 1184;
const INT8 = 20;
// Timestamps reach the app and the Admin API as 'YYYY-MM-DD HH:MM:SS' (UTC), the format they have always had.
// The session time zone is UTC, so Postgres sends e.g. '2026-10-22 09:51:37.161+00'.
const timestamp = (v: string) => v.slice(0, 19);
// int8: COUNT(*), SUM over integers and the OTP expiry (epoch ms), all far below 2^53
const int8 = (v: string) => Number(v);

/** A parameter for a statement (undefined is sent as NULL). */
export type Param = string | number | boolean | null | undefined | string[];

/** What a pool, PGlite or an open transaction can run. */
export interface Queryable {
  /** Every row. */
  all<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T[]>;
  /** The first row, or null. */
  get<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T | null>;
  /** Rows affected. */
  run(sql: string, params?: Param[]): Promise<number>;
}

interface Handle { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null; affectedRows?: number }> }

const clean = (params: Param[]) => params.map((p) => (p === undefined ? null : p));

function api(handle: Handle): Queryable {
  const query = async (sql: string, params: Param[] = []) => {
    const r = await handle.query(sql, clean(params));
    return { rows: r.rows, count: r.rowCount ?? r.affectedRows ?? 0 };
  };
  return {
    all: async <T>(sql: string, params?: Param[]) => (await query(sql, params)).rows as T[],
    get: async <T>(sql: string, params?: Param[]) => ((await query(sql, params)).rows[0] as T | undefined) ?? null,
    run: async (sql: string, params?: Param[]) => (await query(sql, params)).count,
  };
}

let pool: Pool | null = null;
let lite: PGlite | null = null;
/** Drizzle on whichever driver runs; both share this type, and so does a transaction (orm.transaction(tx => ...)). */
export type Orm = PgDatabase<PgQueryResultHKT>;
let drizzleDb: Orm;
let releaseLock = () => {};

/**
 * PGlite is single-process: two processes on one data folder corrupt it (an App Service restart can briefly overlap the
 * old and new process; so can two local backends on one state folder). The lock file holds its owner and a heartbeat
 * time, rewritten every 10 s; one not rewritten for 30 s belongs to a process that died. A second process waits up to
 * a minute for the first to let go, then refuses to start.
 */
async function lockDataDir(file: string) {
  const me = `${os.hostname()}:${process.pid}`;
  const write = (flag: string) => fs.writeFileSync(file, JSON.stringify({ owner: me, at: Date.now() }), { flag });
  for (let waited = 0; ; waited += 1000) {
    try {
      write('wx');
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let held: { owner: string; at: number } | null;
      try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { held = null; } // released, or half-written
      if (!held || Date.now() - held.at > 30e3) { fs.rmSync(file, { force: true }); continue; }
      if (waited >= 60e3) throw new Error(`${file}: another backend (${held.owner}) is using this database.`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const beat = setInterval(() => { try { write('w'); } catch (e) { log.error('Database lock heartbeat failed', { err: errMsg(e) }); } }, 10e3);
  beat.unref();
  releaseLock = () => {
    clearInterval(beat);
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).owner === me) fs.rmSync(file); } catch { /* already gone */ }
  };
  process.once('exit', releaseLock);
}

if (config.databaseUrl) {
  const { default: pg } = await import('pg');
  const parsers: Record<number, (v: string) => unknown> = { [TIMESTAMPTZ]: timestamp, [INT8]: int8 };
  pool = new pg.Pool({
    connectionString: config.databaseUrl,
    options: '-c TimeZone=UTC',
    max: 10,
    idleTimeoutMillis: 30e3,
    connectionTimeoutMillis: 10e3,
    types: { getTypeParser: ((oid: number, format?: string) => parsers[oid] || pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser },
  });
  // an idle connection dropped by the server (RDS restart, failover) must not crash the process; the pool reconnects
  pool.on('error', (e) => log.error('Database idle connection error', { err: e.message }));
  const { drizzle } = await import('drizzle-orm/node-postgres');
  drizzleDb = drizzle({ client: pool }) as unknown as Orm;
} else {
  if (config.production) throw new Error('FP_ENV=production needs DATABASE_URL (the RDS Postgres database).');
  const { PGlite } = await import('@electric-sql/pglite');
  fs.mkdirSync(paths.data, { recursive: true });
  const dir = path.join(paths.data, 'pg');
  await lockDataDir(`${dir}.lock`);
  lite = await PGlite.create(dir, { parsers: { [TIMESTAMPTZ]: timestamp, [INT8]: int8 } });
  await lite.exec("SET TIME ZONE 'UTC'");
  const { drizzle } = await import('drizzle-orm/pglite');
  drizzleDb = drizzle({ client: lite }) as unknown as Orm;
}

/** Drizzle: what the repositories query with. */
export const orm: Orm = drizzleDb;

export const db = {
  ...api((pool || lite) as Handle),
  /** Several statements, no parameters (schema). */
  exec: async (sql: string): Promise<void> => { if (pool) await pool.query(sql); else await lite!.exec(sql); },
  /** Runs fn(tx) in one transaction; rolls back if fn throws. */
  async tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    if (lite) return lite.transaction((t: Transaction) => fn(api(t as unknown as Handle)));
    const client: PoolClient = await pool!.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(api(client as unknown as Handle));
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  },
  /** Closes the pool / flushes PGlite and releases its lock. */
  async close() {
    try {
      if (pool) await pool.end(); else await lite!.close();
    } finally {
      releaseLock();
    }
  },
  kind: pool ? 'postgres' as const : 'pglite' as const,
};

// Schema, then (laptop / sandbox) a one-time copy of an older SQLite database.
const { migrate } = await import('./migrations.ts');
await migrate(db);
if (lite) {
  const { importLegacySqlite } = await import('./sqliteImport.ts');
  await importLegacySqlite(db);
}

/** A users / sessions id from a request, or null when it can't be one (Postgres rejects NaN and out-of-range integers). */
export const intId = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
};

/** Keys set to undefined in a merge patch are removed, as JSON.stringify({ ...data, ...patch }) would do. */
export const droppedKeys = (patch: object) => Object.entries(patch).filter(([, v]) => v === undefined).map(([k]) => k);

/** The keys a merge patch sets to undefined, as a text[] for `jsonb - text[]` (removes them from the stored data). */
export const removeKeys = (patch: object) => {
  const keys = droppedKeys(patch);
  return keys.length ? sql`ARRAY[${sql.join(keys.map((k) => sql`${k}`), sql`, `)}]::text[]` : sql`ARRAY[]::text[]`;
};
