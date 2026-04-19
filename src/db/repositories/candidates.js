'use strict';

/**
 * Candidate repository — thin query layer over the candidates table.
 * Only used when POSTGRES_ENABLED=true; callers should check db.enabled first.
 */

const db = require('../postgres');

async function findById(id) {
  const res = await db.query('SELECT * FROM candidates WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function findByEmail(email) {
  const res = await db.query('SELECT * FROM candidates WHERE lower(email) = lower($1)', [email]);
  return res.rows;
}

async function findByIdentity(fullName, email, position) {
  const res = await db.query(
    'SELECT * FROM candidates WHERE lower(full_name)=lower($1) AND lower(email)=lower($2) AND lower(position)=lower($3)',
    [fullName, email, position]
  );
  return res.rows[0] || null;
}

async function list(filters = {}) {
  const conditions = [];
  const values = [];
  let idx = 1;

  if (filters.position) {
    conditions.push(`lower(position) = lower($${idx++})`);
    values.push(filters.position);
  }
  if (filters.status) {
    conditions.push(`lower(workflow_state) = lower($${idx++})`);
    values.push(filters.status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const res = await db.query(
    `SELECT * FROM candidates ${where} ORDER BY created_at DESC`,
    values
  );
  return res.rows;
}

async function create(candidate) {
  const res = await db.query(
    `INSERT INTO candidates (
       id, full_name, email, phone, position, workflow_state, status_of_application,
       educational_attainment, work_experience, awards, trainings, csc_eligibility,
       special_note, link, email_sent, confirmed_attendance, extraction_confidence,
       document_status, required_documents, compliance, recommendation,
       interview_schedule, created_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24
     ) RETURNING *`,
    [
      candidate.id,
      candidate.fullName,
      candidate.email,
      candidate.phone || null,
      candidate.position,
      candidate.workflowState,
      candidate.statusOfApplication,
      candidate.educationalAttainment,
      candidate.workExperience,
      candidate.awards,
      candidate.trainings,
      candidate.cscEligibility,
      candidate.specialNote,
      candidate.link,
      candidate.emailSent,
      candidate.confirmedAttendance,
      candidate.extractionConfidence,
      JSON.stringify(candidate.documentStatus),
      JSON.stringify(candidate.requiredDocuments),
      JSON.stringify(candidate.compliance),
      JSON.stringify(candidate.recommendation),
      candidate.interviewSchedule ? JSON.stringify(candidate.interviewSchedule) : null,
      candidate.createdAt,
      candidate.updatedAt
    ]
  );
  return res.rows[0];
}

async function update(id, fields) {
  const allowed = [
    'full_name', 'email', 'phone', 'position', 'workflow_state', 'status_of_application',
    'educational_attainment', 'work_experience', 'awards', 'trainings', 'csc_eligibility',
    'special_note', 'link', 'email_sent', 'confirmed_attendance', 'extraction_confidence',
    'document_status', 'required_documents', 'compliance', 'recommendation',
    'interview_schedule', 'updated_at'
  ];

  const sets = [];
  const values = [];
  let idx = 1;

  for (const [key, val] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      sets.push(`${key} = $${idx++}`);
      // Stringify JSON fields
      if (['document_status', 'required_documents', 'compliance', 'recommendation', 'interview_schedule'].includes(key)) {
        values.push(val != null ? JSON.stringify(val) : null);
      } else {
        values.push(val);
      }
    }
  }

  if (sets.length === 0) return findById(id);
  values.push(id);

  const res = await db.query(
    `UPDATE candidates SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

module.exports = { findById, findByEmail, findByIdentity, list, create, update };
