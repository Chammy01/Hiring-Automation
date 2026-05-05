'use strict';

/**
 * Tests for all new APIs added in the improvement implementation:
 *   - Position management (GET/POST/DELETE /api/positions)
 *   - Candidate notes (POST/GET /api/candidates/:id/notes)
 *   - Bulk candidate actions (POST /api/candidates/bulk)
 *   - Webhook management (GET/POST/DELETE /api/webhooks)
 *   - Reminder trigger (POST /api/reminders/send)
 *   - Audit-log pagination + filtering
 *   - Email-events pagination + filtering
 *   - importBackup validation
 *   - getDashboard/getAnalytics excludes archived candidates
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../src/server');
const { resetStore } = require('./helpers');

function hr(req) {
  return req.set('x-role', 'hr');
}

test.beforeEach(() => resetStore());
test.after(() => resetStore());

// ─── Helper: create a candidate via API ──────────────────────────────────────

async function createCandidate(fullName = 'Test Candidate', email = 'test@example.com') {
  const res = await hr(request(app).post('/api/applications/intake')).send({
    fullName,
    email,
    position: 'Administrative Aide IV (Clerk II)'
  });
  assert.equal(res.status, 201);
  return res.body.candidate;
}

// ─── Position management ──────────────────────────────────────────────────────

test('positions GET returns built-in positions', async () => {
  const res = await request(app).get('/api/positions');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.positions));
  assert.ok(res.body.positions.length > 0);
  // Each item has name and checklist
  const pos = res.body.positions[0];
  assert.ok(typeof pos.name === 'string');
  assert.ok(Array.isArray(pos.checklist));
});

test('positions POST creates a custom position', async () => {
  const res = await hr(request(app).post('/api/positions')).send({
    name: 'Test Position Alpha',
    checklist: ['Resume', 'Cover Letter']
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Test Position Alpha');
  assert.deepEqual(res.body.checklist, ['Resume', 'Cover Letter']);

  // It should appear in the list
  const list = await request(app).get('/api/positions');
  assert.ok(list.body.positions.some((p) => p.name === 'Test Position Alpha'));
});

test('positions POST rejects duplicate names', async () => {
  await hr(request(app).post('/api/positions')).send({
    name: 'Duplicate Pos',
    checklist: ['Resume']
  });
  const dup = await hr(request(app).post('/api/positions')).send({
    name: 'Duplicate Pos',
    checklist: ['Cover Letter']
  });
  assert.equal(dup.status, 400);
});

test('positions POST rejects missing checklist', async () => {
  const res = await hr(request(app).post('/api/positions')).send({
    name: 'Bad Position'
  });
  assert.equal(res.status, 400);
});

test('positions DELETE removes a custom position', async () => {
  await hr(request(app).post('/api/positions')).send({
    name: 'DeleteMe',
    checklist: ['Doc A']
  });
  const del = await hr(request(app).delete('/api/positions/DeleteMe'));
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);

  const list = await request(app).get('/api/positions');
  assert.ok(!list.body.positions.some((p) => p.name === 'DeleteMe'));
});

test('positions DELETE returns 400 for built-in position', async () => {
  const res = await hr(
    request(app).delete('/api/positions/Administrative%20Assistant%20I%20(Computer%20Operator%20I)')
  );
  assert.equal(res.status, 400);
});

test('positions DELETE returns 404 for unknown position', async () => {
  const res = await hr(request(app).delete('/api/positions/NonExistent'));
  assert.equal(res.status, 404);
});

// ─── Candidate notes ──────────────────────────────────────────────────────────

test('notes POST adds a note to a candidate', async () => {
  const candidate = await createCandidate('Notes Tester', 'notes@example.com');
  const res = await hr(request(app).post(`/api/candidates/${candidate.id}/notes`)).send({
    author: 'HR Admin',
    content: 'Strong candidate, follow up after docs.'
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.content, 'Strong candidate, follow up after docs.');
  assert.equal(res.body.author, 'HR Admin');
  assert.ok(res.body.id);
  assert.ok(res.body.createdAt);
});

test('notes POST requires content', async () => {
  const candidate = await createCandidate('Notes Tester 2', 'notes2@example.com');
  const res = await hr(request(app).post(`/api/candidates/${candidate.id}/notes`)).send({
    author: 'HR Admin'
  });
  assert.equal(res.status, 400);
});

test('notes POST returns 404 for unknown candidate', async () => {
  const res = await hr(
    request(app).post('/api/candidates/00000000-0000-0000-0000-000000000000/notes')
  ).send({ content: 'Test note' });
  assert.equal(res.status, 404);
});

test('notes GET returns all notes for a candidate', async () => {
  const candidate = await createCandidate('Notes Tester 3', 'notes3@example.com');

  await hr(request(app).post(`/api/candidates/${candidate.id}/notes`)).send({ content: 'First note' });
  await hr(request(app).post(`/api/candidates/${candidate.id}/notes`)).send({ content: 'Second note' });

  const res = await hr(request(app).get(`/api/candidates/${candidate.id}/notes`));
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
  assert.equal(res.body.items.length, 2);
  assert.equal(res.body.items[0].content, 'First note');
  assert.equal(res.body.items[1].content, 'Second note');
});

test('notes GET returns 404 for unknown candidate', async () => {
  const res = await hr(
    request(app).get('/api/candidates/00000000-0000-0000-0000-000000000000/notes')
  );
  assert.equal(res.status, 404);
});

// ─── Bulk candidate actions ───────────────────────────────────────────────────

test('bulk action shortlists multiple candidates', async () => {
  // Candidates need to be in FOR_REVIEW to be shortlistable
  // Create + push to FOR_REVIEW via scoring path
  const c1 = await createCandidate('Bulk One', 'bulk1@example.com');
  const c2 = await createCandidate('Bulk Two', 'bulk2@example.com');

  // Force them into FOR_REVIEW state via documents/content with all docs
  const fullDocs = [
    { fileName: 'letter_of_intent.pdf', text: 'I wish to apply', mimeType: 'application/pdf' },
    { fileName: 'pds.pdf', text: 'Personal Data Sheet civil service', mimeType: 'application/pdf' },
    { fileName: 'wes.pdf', text: 'Work Experience Sheet detailed', mimeType: 'application/pdf' },
    { fileName: 'training_certs.pdf', text: 'Training Seminar Certificates completed', mimeType: 'application/pdf' },
    { fileName: 'awards.pdf', text: 'Awards from Last Promotion recognition', mimeType: 'application/pdf' },
    { fileName: 'ipcr.pdf', text: 'Latest IPCR Individual Performance Commitment and Review', mimeType: 'application/pdf' },
    { fileName: 'csc_eligibility.pdf', text: 'career service professional eligibility', mimeType: 'application/pdf' }
  ];
  for (const cand of [c1, c2]) {
    await hr(request(app).post(`/api/candidates/${cand.id}/documents/content`)).send({
      submittedAt: '2099-01-01T00:00:00.000Z',
      subject: `Application for Administrative Aide IV (Clerk II)`,
      files: fullDocs
    });
  }

  const res = await hr(request(app).post('/api/candidates/bulk')).send({
    ids: [c1.id, c2.id],
    action: 'shortlist'
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.succeeded.sort(), [c1.id, c2.id].sort());
  assert.equal(res.body.failed.length, 0);
});

test('bulk action reports failures for invalid candidate IDs', async () => {
  const res = await hr(request(app).post('/api/candidates/bulk')).send({
    ids: ['nonexistent-1', 'nonexistent-2'],
    action: 'reject',
    reason: 'No docs submitted'
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.succeeded.length, 0);
  assert.equal(res.body.failed.length, 2);
  assert.ok(res.body.failed[0].error);
});

test('bulk action rejects empty ids array', async () => {
  const res = await hr(request(app).post('/api/candidates/bulk')).send({
    ids: [],
    action: 'shortlist'
  });
  assert.equal(res.status, 400);
});

test('bulk action rejects unsupported actions', async () => {
  const res = await hr(request(app).post('/api/candidates/bulk')).send({
    ids: ['some-id'],
    action: 'hire' // hire is not allowed in bulk
  });
  assert.equal(res.status, 400);
});

// ─── Webhook management ───────────────────────────────────────────────────────

test('webhooks GET returns empty list initially', async () => {
  const res = await hr(request(app).get('/api/webhooks'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items, []);
});

test('webhooks POST registers a webhook', async () => {
  const res = await hr(request(app).post('/api/webhooks')).send({
    url: 'https://example.com/hook',
    events: ['candidate.created', 'candidate.hired'],
    secret: 'my-secret'
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.url, 'https://example.com/hook');
  assert.deepEqual(res.body.events, ['candidate.created', 'candidate.hired']);
  assert.ok(res.body.id);
  assert.equal(res.body.active, true);
});

test('webhooks POST rejects invalid URL', async () => {
  const res = await hr(request(app).post('/api/webhooks')).send({
    url: 'not-a-url'
  });
  assert.equal(res.status, 400);
});

test('webhooks DELETE removes a registered webhook', async () => {
  const created = await hr(request(app).post('/api/webhooks')).send({
    url: 'https://example.com/removable'
  });
  assert.equal(created.status, 201);
  const hookId = created.body.id;

  const del = await hr(request(app).delete(`/api/webhooks/${hookId}`));
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);

  const list = await hr(request(app).get('/api/webhooks'));
  assert.ok(!list.body.items.some((h) => h.id === hookId));
});

test('webhooks DELETE returns 404 for unknown webhook', async () => {
  const res = await hr(request(app).delete('/api/webhooks/nonexistent-id'));
  assert.equal(res.status, 404);
});

// ─── Audit-log pagination + filtering ────────────────────────────────────────

test('audit-logs supports pagination via limit and page', async () => {
  // Create a couple of candidates to generate audit log entries
  await createCandidate('Audit A', 'auditA@example.com');
  await createCandidate('Audit B', 'auditB@example.com');

  const all = await hr(request(app).get('/api/audit-logs'));
  assert.equal(all.status, 200);
  assert.ok(all.body.total >= 2);

  const paged = await hr(request(app).get('/api/audit-logs?limit=1&page=1'));
  assert.equal(paged.status, 200);
  assert.equal(paged.body.items.length, 1);
  assert.equal(paged.body.limit, 1);
  assert.equal(paged.body.page, 1);
  assert.ok(paged.body.totalPages >= 1);
});

test('audit-logs supports action filter', async () => {
  await createCandidate('Filter Test', 'filter@example.com');

  const res = await hr(request(app).get('/api/audit-logs?action=candidate.created'));
  assert.equal(res.status, 200);
  assert.ok(res.body.items.every((x) => x.action === 'candidate.created'));
  assert.ok(res.body.items.length >= 1);
});

// ─── Email-events pagination + filtering ────────────────────────────────────

test('email-events supports pagination via limit and page', async () => {
  await createCandidate('Email Paged A', 'epA@example.com');
  await createCandidate('Email Paged B', 'epB@example.com');

  const all = await hr(request(app).get('/api/email-events'));
  assert.equal(all.status, 200);
  assert.ok(all.body.items.length >= 2);

  const paged = await hr(request(app).get('/api/email-events?limit=1&page=1'));
  assert.equal(paged.status, 200);
  assert.equal(paged.body.items.length, 1);
  assert.equal(paged.body.limit, 1);
});

test('email-events supports direction filter', async () => {
  await createCandidate('Email Dir Test', 'emaildir@example.com');

  const res = await hr(request(app).get('/api/email-events?direction=outbound'));
  assert.equal(res.status, 200);
  assert.ok(res.body.items.every((x) => x.direction === 'outbound'));
});

// ─── importBackup validation ──────────────────────────────────────────────────

test('importBackup rejects non-object payload', async () => {
  const res = await hr(request(app).post('/api/restore')).send(['not', 'an', 'object']);
  assert.equal(res.status, 400);
});

test('importBackup rejects candidate with missing id', async () => {
  const res = await hr(request(app).post('/api/restore')).send({
    candidates: [
      { fullName: 'No ID', email: 'noid@example.com' }
    ]
  });
  assert.equal(res.status, 400);
});

test('importBackup rejects candidate with missing email', async () => {
  const res = await hr(request(app).post('/api/restore')).send({
    candidates: [
      { id: 'abc-123', fullName: 'No Email' }
    ]
  });
  assert.equal(res.status, 400);
});

test('importBackup accepts valid backup payload', async () => {
  const res = await hr(request(app).post('/api/restore')).send({
    candidates: [
      {
        id: 'abc-123',
        fullName: 'Valid Import',
        email: 'valid@example.com',
        position: 'Administrative Aide IV (Clerk II)'
      }
    ]
  });
  assert.equal(res.status, 200);
});

// ─── Dashboard / analytics excludes archived candidates ───────────────────────

test('getDashboard excludes archived candidates from totals', async () => {
  const c1 = await createCandidate('Active Person', 'active@example.com');
  const c2 = await createCandidate('Archived Person', 'archived@example.com');

  // Archive c2
  await hr(request(app).patch(`/api/candidates/${c2.id}/archive`)).send({ archived: true });

  const dash = await hr(request(app).get('/api/dashboard'));
  assert.equal(dash.status, 200);
  // Only c1 should count
  assert.equal(dash.body.totals.candidates, 1);
  // c2 should not appear in topCandidates
  assert.ok(!dash.body.topCandidates.some((c) => c.id === c2.id));
});

test('getAnalytics excludes archived candidates', async () => {
  const c1 = await createCandidate('Analytics Active', 'analytics_active@example.com');
  const c2 = await createCandidate('Analytics Archived', 'analytics_archived@example.com');

  await hr(request(app).patch(`/api/candidates/${c2.id}/archive`)).send({ archived: true });

  const res = await hr(request(app).get('/api/analytics'));
  assert.equal(res.status, 200);
  assert.equal(res.body.totals.candidates, 1);
});

// ─── Reminder trigger ─────────────────────────────────────────────────────────

test('reminders send endpoint is reachable and returns result', async () => {
  const res = await hr(request(app).post('/api/reminders/send'));
  assert.equal(res.status, 200);
  // Returns { sent: N } or { sent: 0, reason: '...' }
  assert.ok(typeof res.body.sent === 'number' || typeof res.body.reason === 'string');
});
