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
