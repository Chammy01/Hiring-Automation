'use strict';

/**
 * Outbound dispatch repository.
 * Only used when POSTGRES_ENABLED=true.
 */

const db = require('../postgres');

async function create(dispatch) {
  const res = await db.query(
    `INSERT INTO outbound_dispatches
       (id, candidate_id, to_email, from_email, subject, body,
        template_key, template_vars, status, provider,
        retry_count, max_retries, queued_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      dispatch.id,
      dispatch.candidateId || null,
      dispatch.toEmail,
      dispatch.fromEmail,
      dispatch.subject,
      dispatch.body,
      dispatch.templateKey || null,
      JSON.stringify(dispatch.templateVars || {}),
      dispatch.status || 'queued',
      dispatch.provider || 'gmail',
      dispatch.retryCount || 0,
      dispatch.maxRetries || 3,
      dispatch.queuedAt || new Date().toISOString()
    ]
  );
  return res.rows[0];
}

async function findById(id) {
  const res = await db.query('SELECT * FROM outbound_dispatches WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function updateStatus(id, fields) {
  const allowed = ['status', 'provider_msg_id', 'retry_count', 'last_error', 'sent_at', 'next_retry_at', 'updated_at'];
  const sets = [];
  const values = [];
  let idx = 1;
  for (const [key, val] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      sets.push(`${key} = $${idx++}`);
      values.push(val);
    }
  }
  if (sets.length === 0) return findById(id);
  values.push(id);
  const res = await db.query(
    `UPDATE outbound_dispatches SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function listPending() {
  const res = await db.query(
    `SELECT * FROM outbound_dispatches
     WHERE status IN ('queued','failed') AND (next_retry_at IS NULL OR next_retry_at <= now())
     ORDER BY queued_at ASC`
  );
  return res.rows;
}

module.exports = { create, findById, updateStatus, listPending };
