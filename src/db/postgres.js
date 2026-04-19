'use strict';

/**
 * PostgreSQL connection pool (optional persistence layer).
 *
 * Only active when POSTGRES_ENABLED=true is set in the environment.
 * All other code safely falls back to the JSON store when this module
 * returns { enabled: false }.
 *
 * Environment variables:
 *   POSTGRES_ENABLED   - set to "true" to enable
 *   POSTGRES_URL       - full connection string (overrides individual fields)
 *   POSTGRES_HOST      - host (default: localhost)
 *   POSTGRES_PORT      - port (default: 5432)
 *   POSTGRES_DB        - database name (default: hiring_automation)
 *   POSTGRES_USER      - user (default: postgres)
 *   POSTGRES_PASSWORD  - password
 *   POSTGRES_SSL       - set to "true" to enable SSL
 */

const { config } = require('../config');

let pool = null;

function getPool() {
  if (!config.postgresEnabled) {
    return null;
  }

  if (pool) {
    return pool;
  }

  const { Pool } = require('pg');

  const poolConfig = config.postgresUrl
    ? {
        connectionString: config.postgresUrl,
        ssl: config.postgresSsl ? { rejectUnauthorized: false } : false
      }
    : {
        host: config.postgresHost,
        port: config.postgresPort,
        database: config.postgresDb,
        user: config.postgresUser,
        password: config.postgresPassword,
        ssl: config.postgresSsl ? { rejectUnauthorized: false } : false,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000
      };

  pool = new Pool(poolConfig);

  pool.on('error', (err) => {
    console.error('[postgres] Unexpected client error:', err.message);
  });

  return pool;
}

async function query(sql, params = []) {
  const p = getPool();
  if (!p) {
    throw new Error('PostgreSQL is not enabled (POSTGRES_ENABLED != true)');
  }
  return p.query(sql, params);
}

async function transaction(fn) {
  const p = getPool();
  if (!p) {
    throw new Error('PostgreSQL is not enabled (POSTGRES_ENABLED != true)');
  }
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  get enabled() {
    return config.postgresEnabled;
  },
  getPool,
  query,
  transaction,
  closePool
};
