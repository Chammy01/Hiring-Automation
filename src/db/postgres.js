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
const fs = require('node:fs');

let pool = null;

function getPool() {
  if (!config.postgresEnabled) {
    return null;
  }

  if (pool) {
    return pool;
  }

  const { Pool } = require('pg');
  const sslConfig = buildSslConfig();

  const poolConfig = config.postgresUrl
    ? {
        connectionString: config.postgresUrl,
        ssl: sslConfig
      }
    : {
        host: config.postgresHost,
        port: config.postgresPort,
        database: config.postgresDb,
        user: config.postgresUser,
        password: config.postgresPassword,
        ssl: sslConfig,
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

function readIfExists(filePath) {
  if (!filePath) return undefined;
  if (!fs.existsSync(filePath)) {
    throw new Error('SSL certificate file not found');
  }
  return fs.readFileSync(filePath, 'utf8');
}

function buildSslConfig() {
  if (!config.postgresSsl) {
    return false;
  }
  return {
    rejectUnauthorized: config.runtime.isProduction,
    ca: readIfExists(config.postgresSslCaPath),
    cert: readIfExists(config.postgresSslCertPath),
    key: readIfExists(config.postgresSslKeyPath)
  };
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
