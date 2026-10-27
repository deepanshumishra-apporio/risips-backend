// Copies an old SQLite database into the Postgres database in DATABASE_URL (the production cutover; see
// infra/aws/prod/cutover-postgres.sh on the fp-demo-invest-screens branch). Stop the backend first so nothing writes
// to SQLite meanwhile. Refuses if Postgres already has users. Reads the same env as the backend (RISIPS_ENV file,
// FP_ENV, RISIPS_STATE_DIR). Accepts both the JS backend's SQLite file and this backend's earlier one:
//   node --experimental-strip-types scripts/migrate-sqlite.ts /var/lib/risips/state/data/risips.db
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import '../src/config/env.ts'; // loads the env file into process.env

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('Usage: node --experimental-strip-types scripts/migrate-sqlite.ts <path to risips.db>');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL to the Postgres database to copy into.');
  process.exit(1);
}

const check = new DatabaseSync(file, { readOnly: true });
const ok = check.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
check.close();
if (Object.values(ok)[0] !== 'ok') {
  console.error('SQLite integrity check failed:', ok);
  process.exit(1);
}

const { db } = await import('../src/db/connection.ts'); // creates the tables
const { importSqlite } = await import('../src/db/sqliteImport.ts');
try {
  const counts = await importSqlite(db, file);
  console.log('MIGRATED', JSON.stringify(counts));
} catch (e) {
  console.error('Migration failed, nothing was copied:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await db.close();
}
