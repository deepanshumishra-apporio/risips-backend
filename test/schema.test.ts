// schema.ts (what Drizzle queries) must describe exactly the tables migrations.ts creates: same columns, types,
// nullability and indexes. A schema change made in one place only fails here.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import { startServer, testDb } from './helpers.ts';
import type { TestServer } from './helpers.ts';

let t: TestServer;
before(async () => { t = await startServer(); });
after(async () => { await t.close(); });

describe('schema.ts matches the migrated database', () => {
  it('has the same tables, columns, types, nullability and indexes', async () => {
    const schema = await import('../src/db/schema.ts');
    const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => typeof v === 'object' && v !== null && Symbol.for('drizzle:IsDrizzleTable') in v);
    const db = await testDb();
    const dbTables = (await db.all<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).map((r) => r.table_name).sort();
    assert.deepEqual(tables.map((tb) => getTableConfig(tb).name).sort(), dbTables, 'tables');

    for (const tb of tables) {
      const cfg = getTableConfig(tb);
      const cols = await db.all<{ column_name: string; data_type: string; is_nullable: string }>(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [cfg.name]);
      const inDb = Object.fromEntries(cols.map((c) => [c.column_name, `${c.data_type}${c.is_nullable === 'NO' ? ' not null' : ''}`]));
      const inSchema = Object.fromEntries(cfg.columns.map((c) => [c.name, `${c.getSQLType()}${c.notNull ? ' not null' : ''}`]));
      assert.deepEqual(inSchema, inDb, `columns of ${cfg.name}`);

      const idx = (await db.all<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1", [cfg.name])).map((r) => r.indexname);
      for (const i of cfg.indexes) assert.ok(idx.includes(i.config.name!), `index ${i.config.name} on ${cfg.name}`);
    }
  });
});
