'use strict';

/**
 * Parsing results repository.
 * Only used when POSTGRES_ENABLED=true.
 */

const db = require('../postgres');

async function create(result) {
  const res = await db.query(
    `INSERT INTO parsing_results
       (id, document_id, candidate_id, raw_text, structured_fields, confidence, notes, ocr_used)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      result.id,
      result.documentId || null,
      result.candidateId || null,
      result.rawText || '',
      JSON.stringify(result.structuredFields || {}),
      result.confidence || 'low',
      result.notes || null,
      result.ocrUsed || false
    ]
  );
  return res.rows[0];
}

async function findByCandidate(candidateId) {
  const res = await db.query(
    'SELECT * FROM parsing_results WHERE candidate_id = $1 ORDER BY created_at DESC',
    [candidateId]
  );
  return res.rows;
}

async function findByDocument(documentId) {
  const res = await db.query(
    'SELECT * FROM parsing_results WHERE document_id = $1 ORDER BY created_at DESC',
    [documentId]
  );
  return res.rows;
}

module.exports = { create, findByCandidate, findByDocument };
