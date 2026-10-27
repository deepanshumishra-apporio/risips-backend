// An old SQLite database (the JS backend's, with plain session tokens) is copied into Postgres on the first start:
// every row, sessions hashed on the way in, so nobody is signed out.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

describe('migration from the JS backend SQLite file', () => {
  it('copies every row into Postgres and keeps sessions working', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risips-mig-'));
    fs.mkdirSync(path.join(stateDir, 'data'));
    const old = new DatabaseSync(path.join(stateDir, 'data', 'risips.db'));
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, mobile TEXT, pin_hash TEXT, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), device TEXT, os TEXT, ip TEXT, last_seen TEXT);
      CREATE TABLE otps (purpose TEXT NOT NULL, target TEXT NOT NULL, code TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (purpose, target));
      CREATE TABLE orders (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, isin TEXT, isin_to TEXT, amount REAL, state TEXT, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE watchlist (user_id INTEGER NOT NULL, isin TEXT NOT NULL, PRIMARY KEY (user_id, isin));
      INSERT INTO users (email, data) VALUES ('old@example.com', '{"email_verified":true,"name":"Old"}');
      INSERT INTO users (email, data) VALUES ('two@example.com', '{}');
      INSERT INTO sessions (token, user_id, last_seen) VALUES ('legacyTokenAbcdefghijklmnop0123', 1, datetime('now'));
      INSERT INTO orders (id, user_id, kind, isin, amount, state, data) VALUES ('mfp_old1', 1, 'purchase', 'INF109KC19T7', 500, 'successful', '{"fp":{"folio_number":"F1"}}');
      INSERT INTO watchlist (user_id, isin) VALUES (1, 'INF109KC19T7');
    `);
    old.close();

    const { startServer, signUp, testDb } = await import('./helpers.ts');
    const t = await startServer({ RISIPS_STATE_DIR: stateDir });
    try {
      const me = await t.call('GET', '/me', undefined, 'legacyTokenAbcdefghijklmnop0123');
      assert.equal(me.status, 200);
      assert.equal((me.json!.user as Record<string, unknown>).email, 'old@example.com');
      const db = await testDb();
      const s = (await db.get<Record<string, unknown>>('SELECT * FROM sessions'))!;
      assert.equal(s.token ?? null, null, 'no plain token stored');
      assert.match(String(s.token_hash), /^[a-f0-9]{64}$/);
      assert.equal((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users'))!.n, 2);
      const o = (await db.get<{ data: { fp: { folio_number: string } }; amount: number }>("SELECT * FROM orders WHERE id = 'mfp_old1'"))!;
      assert.equal(o.data.fp.folio_number, 'F1');
      assert.equal(o.amount, 500);
      assert.ok(await db.get("SELECT 1 FROM watchlist WHERE user_id = 1 AND isin = 'INF109KC19T7'"));
      assert.ok(await db.get("SELECT 1 FROM meta WHERE key = 'sqlite_import'"), 'the import is recorded, so it runs once');
      assert.equal((await db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'"))!.value, '2');
      // new rows continue after the copied ids
      const fresh = await signUp(t);
      assert.equal(fresh.user.id, 3);
    } finally {
      await t.close();
    }
  });
});
