#!/usr/bin/env node
'use strict';

/**
 * Development seed data for PostgreSQL.
 *
 * Inserts sample candidates, a job posting, and an application.
 * Safe to run multiple times — skips rows that already exist.
 *
 * Usage:
 *   node src/db/seed.js
 *
 * Requires POSTGRES_ENABLED=true.
 */

require('dotenv').config();

const db = require('./postgres');

async function seed() {
  if (!db.enabled) {
    console.error('[seed] POSTGRES_ENABLED is not true. Nothing to seed.');
    process.exit(1);
  }

  const pool = db.getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Sample job
    const jobRes = await client.query(
      `INSERT INTO jobs (title, department, description, visibility, open_date, close_date)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        'Administrative Aide IV (Clerk II)',
        'Administration',
        'Responsible for administrative support functions.',
        'public',
        '2026-01-01T00:00:00Z',
        '2026-04-07T23:59:59Z'
      ]
    );

    const jobId = jobRes.rows[0]?.id;

    // Sample candidates
    const candidatesData = [
      {
        id: '00000000-0000-0000-0000-000000000001',
        full_name: 'Alice Reyes',
        email: 'alice.reyes@example.com',
        position: 'Administrative Aide IV (Clerk II)',
        workflow_state: 'For Review',
        status_of_application: 'For Review',
        educational_attainment: 'College Graduate',
        work_experience: '1-3 years',
        awards: 'None submitted',
        trainings: 'With trainings',
        csc_eligibility: 'Sub-Professional',
        extraction_confidence: 'medium'
      },
      {
        id: '00000000-0000-0000-0000-000000000002',
        full_name: 'Bob Cruz',
        email: 'bob.cruz@example.com',
        position: 'Administrative Aide IV (Clerk II)',
        workflow_state: 'Docs Pending',
        status_of_application: 'Documents Pending',
        educational_attainment: 'Unknown',
        work_experience: 'Unknown',
        awards: 'None submitted',
        trainings: 'None submitted',
        csc_eligibility: 'Unknown',
        extraction_confidence: 'low'
      }
    ];

    for (const c of candidatesData) {
      await client.query(
        `INSERT INTO candidates (
           id, full_name, email, position, workflow_state, status_of_application,
           educational_attainment, work_experience, awards, trainings, csc_eligibility,
           extraction_confidence
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO NOTHING`,
        [
          c.id, c.full_name, c.email, c.position, c.workflow_state, c.status_of_application,
          c.educational_attainment, c.work_experience, c.awards, c.trainings,
          c.csc_eligibility, c.extraction_confidence
        ]
      );

      if (jobId) {
        await client.query(
          `INSERT INTO applications (candidate_id, job_id, status)
           VALUES ($1,$2,$3)
           ON CONFLICT DO NOTHING`,
          [c.id, jobId, 'applied']
        );
      }
    }

    await client.query('COMMIT');
    console.log('[seed] ✔ Seed data applied successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed] ✖ Seed failed:', err.message);
    throw err;
  } finally {
    client.release();
    await db.closePool();
  }
}

if (require.main === module) {
  seed().catch((err) => {
    console.error('[seed] Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { seed };
