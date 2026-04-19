#!/usr/bin/env node
'use strict';

/**
 * Database migration runner.
 *
 * Usage:
 *   node src/db/migrate.js           # apply all pending migrations
 *   node src/db/migrate.js --status  # show applied vs pending migrations
 *
 * Required env vars:
 *   POSTGRES_ENABLED=true
 *   POSTGRES_URL  (or POSTGRES_HOST / POSTGRES_DB / POSTGRES_USER / POSTGRES_PASSWORD)
 *
 * Migrations are .sql files in src/db/migrations/, applied in filename order.
 * Applied migrations are tracked in the schema_migrations table.
 */

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const db = require('./postgres');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function getMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function getAppliedVersions(client) {
  try {
    const res = await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    TEXT        PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );
    void res;
  } catch (_) {
    // table may already exist
  }
  const res = await client.query('SELECT version FROM schema_migrations ORDER BY version');
  return new Set(res.rows.map((r) => r.version));
}

async function runMigrations() {
  if (!db.enabled) {
    console.error('[migrate] POSTGRES_ENABLED is not true. Set it in your .env and retry.');
    process.exit(1);
  }

  const showStatus = process.argv.includes('--status');
  const pool = db.getPool();
  const client = await pool.connect();

  try {
    const files = getMigrationFiles();
    const applied = await getAppliedVersions(client);

    if (showStatus) {
      console.log('\nMigration status:');
      for (const file of files) {
        const version = path.basename(file, '.sql');
        const status = applied.has(version) ? '✔ applied' : '◌ pending';
        console.log(`  ${status}  ${file}`);
      }
      console.log();
      return;
    }

    const pending = files.filter((f) => !applied.has(path.basename(f, '.sql')));

    if (pending.length === 0) {
      console.log('[migrate] All migrations are up to date.');
      return;
    }

    for (const file of pending) {
      const version = path.basename(file, '.sql');
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`[migrate] Applying ${file}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        console.log(`[migrate] ✔ ${file} applied`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[migrate] ✖ ${file} failed: ${err.message}`);
        throw err;
      }
    }

    console.log(`[migrate] Done — ${pending.length} migration(s) applied.`);
  } finally {
    client.release();
    await db.closePool();
  }
}

if (require.main === module) {
  runMigrations().catch((err) => {
    console.error('[migrate] Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { runMigrations };
