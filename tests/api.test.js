const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../src/server');
const { resetStore } = require('./helpers');

function hr(requestBuilder) {
  return requestBuilder.set('x-role', 'hr');
}

test.beforeEach(() => resetStore());
test.after(() => resetStore());

test('health endpoint is reachable', async () => {
  const response = await request(app).get('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
});

test('intake endpoint creates candidate', async () => {
  const response = await hr(request(app).post('/api/applications/intake')).send({
    fullName: 'Mia Santos',
    email: 'mia@example.com',
    position: 'Administrative Assistant I (Computer Operator I)'
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.candidate.fullName, 'Mia Santos');
});

test('failed ack appears in retry queue and can be retried', async () => {
  const intake = await hr(request(app).post('/api/applications/intake')).send({
    fullName: 'Queue Test',
    email: 'queue@example.com',
    position: 'Administrative Aide IV (Clerk II)',
    simulateAckFailure: true
  });
  assert.equal(intake.status, 201);

  const queue = await hr(request(app).get('/api/retry-queue'));
  assert.equal(queue.status, 200);
  assert.equal(queue.body.items.length, 1);

  const emailEvents = await hr(request(app).get('/api/email-events'));
  const failed = emailEvents.body.items.find((x) => x.status === 'failed');
  assert.ok(failed);

  const retried = await hr(request(app).post(`/api/email-events/${failed.id}/retry`));
  assert.equal(retried.status, 200);
  assert.equal(retried.body.status, 'sent');
});

test('integration endpoints expose status and manual sync response', async () => {
  const status = await hr(request(app).get('/api/integrations'));
  assert.equal(status.status, 200);
  assert.equal(typeof status.body.googleSheets.enabled, 'boolean');
  assert.ok(Array.isArray(status.body.upgrades));

  const sync = await hr(request(app).post('/api/integrations/google-sheets/sync'));
  assert.equal(sync.status, 200);
  assert.equal(sync.body.synced, false);
});

test('documents/content endpoint classifies files and updates doc status', async () => {
  const intake = await hr(request(app).post('/api/applications/intake')).send({
    fullName: 'Content Test',
    email: 'content@example.com',
    position: 'Administrative Aide IV (Clerk II)'
  });
  assert.equal(intake.status, 201);
  const candidateId = intake.body.candidate.id;

  const result = await hr(
    request(app).post(`/api/candidates/${candidateId}/documents/content`)
  ).send({
    submittedAt: '2026-04-01T00:00:00.000Z',
    subject: 'Application for Administrative Aide IV (Clerk II)',
    files: [
      { fileName: 'letter_of_intent.pdf', text: 'I wish to apply for the position', mimeType: 'application/pdf' },
      { fileName: 'pds.pdf', text: 'Personal Data Sheet civil service form date of birth', mimeType: 'application/pdf' },
      { fileName: 'csc_eligibility.pdf', text: 'career service professional eligibility', mimeType: 'application/pdf' }
    ]
  });

  assert.equal(result.status, 200);
  assert.ok(result.body.candidate);
  assert.ok(Array.isArray(result.body.classifications));
  assert.equal(result.body.candidate.documentStatus['Letter of Intent'], 'received');
  assert.equal(result.body.candidate.documentStatus['PDS'], 'received');
  assert.equal(result.body.candidate.documentStatus['Proof of CSC Eligibility'], 'received');
});

test('documents/content endpoint returns 400 for missing files field', async () => {
  // Schema validation fails before any candidate lookup — use a fake UUID
  const fakeId = '00000000-0000-0000-0000-000000000000';
  const result = await hr(
    request(app).post(`/api/candidates/${fakeId}/documents/content`)
  ).send({ submittedAt: '2026-04-01T00:00:00.000Z' });

  assert.equal(result.status, 400);
});
