'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetStore } = require('./helpers');

const {
  enqueueDispatch,
  sendDispatch,
  getDispatch,
  listDispatches,
  renderTemplate,
  backoffDelayMs
} = require('../src/integrations/gmail-dispatcher');

test.beforeEach(() => resetStore());
test.after(() => resetStore());

// ─── renderTemplate ───────────────────────────────────────────────────────────

test('renderTemplate substitutes {{vars}} in subject and body', () => {
  const result = renderTemplate('Hello {{name}}, your position is {{position}}', {
    name: 'Alice',
    position: 'Engineer'
  });
  assert.equal(result, 'Hello Alice, your position is Engineer');
});

test('renderTemplate leaves unknown vars as empty string', () => {
  const result = renderTemplate('Hello {{unknown}}', {});
  assert.equal(result, 'Hello ');
});

// ─── backoffDelayMs ───────────────────────────────────────────────────────────

test('backoffDelayMs grows exponentially', () => {
  const d0 = backoffDelayMs(0, 1000);
  const d1 = backoffDelayMs(1, 1000);
  const d2 = backoffDelayMs(2, 1000);
  assert.ok(d1 > d0, 'attempt 1 delay should be greater than attempt 0');
  assert.ok(d2 > d1, 'attempt 2 delay should be greater than attempt 1');
  assert.ok(d2 <= 30_200, 'delay should be capped near 30 seconds');
});

// ─── enqueueDispatch ──────────────────────────────────────────────────────────

test('enqueueDispatch creates a queued dispatch record', () => {
  const { dispatch } = enqueueDispatch({
    to: 'alice@example.com',
    subject: 'Welcome {{name}}',
    body: 'Your application is {{status}}.',
    vars: { name: 'Alice', status: 'received' }
  });

  assert.ok(dispatch.id, 'dispatch has an id');
  assert.equal(dispatch.status, 'queued');
  assert.equal(dispatch.to, 'alice@example.com');
  assert.equal(dispatch.subject, 'Welcome Alice');
  assert.equal(dispatch.body, 'Your application is received.');
});

test('enqueueDispatch stores dispatch in the store', () => {
  const { dispatch } = enqueueDispatch({
    to: 'bob@example.com',
    subject: 'Interview Invitation',
    body: 'You are invited.'
  });

  const stored = getDispatch(dispatch.id);
  assert.ok(stored, 'dispatch should be retrievable from store');
  assert.equal(stored.status, 'queued');
});

test('enqueueDispatch supports candidateId linkage', () => {
  const { dispatch } = enqueueDispatch({
    to: 'carol@example.com',
    subject: 'Test',
    body: 'Test body',
    candidateId: 'cand-001'
  });
  assert.equal(dispatch.candidateId, 'cand-001');
});

test('listDispatches returns all dispatches without filter', () => {
  enqueueDispatch({ to: 'a@x.com', subject: 'S1', body: 'B1' });
  enqueueDispatch({ to: 'b@x.com', subject: 'S2', body: 'B2' });
  const all = listDispatches();
  assert.equal(all.length, 2);
});

test('listDispatches filters by status', () => {
  enqueueDispatch({ to: 'a@x.com', subject: 'S1', body: 'B1' });
  enqueueDispatch({ to: 'b@x.com', subject: 'S2', body: 'B2' });
  const queued = listDispatches({ status: 'queued' });
  assert.equal(queued.length, 2);
  const sent = listDispatches({ status: 'sent' });
  assert.equal(sent.length, 0);
});

test('listDispatches filters by candidateId', () => {
  enqueueDispatch({ to: 'a@x.com', subject: 'S', body: 'B', candidateId: 'cand-1' });
  enqueueDispatch({ to: 'b@x.com', subject: 'S', body: 'B', candidateId: 'cand-2' });
  const result = listDispatches({ candidateId: 'cand-1' });
  assert.equal(result.length, 1);
  assert.equal(result[0].candidateId, 'cand-1');
});

// ─── sendDispatch (simulated — GMAIL_DISPATCH_ENABLED defaults to false) ──────

test('sendDispatch transitions status to sent when GMAIL_DISPATCH_ENABLED=false', async () => {
  // GMAIL_DISPATCH_ENABLED is false in test env — simulate mode
  const { dispatch } = enqueueDispatch({
    to: 'dave@example.com',
    subject: 'Offer Letter',
    body: 'Congratulations!'
  });

  assert.equal(dispatch.status, 'queued');

  const updated = await sendDispatch(dispatch.id);
  assert.equal(updated.status, 'sent', 'dispatch should be marked sent');
  assert.ok(updated.sentAt, 'sentAt should be set');
});

test('sendDispatch returns early if already sent', async () => {
  const { dispatch } = enqueueDispatch({
    to: 'eve@example.com',
    subject: 'Already sent',
    body: 'Hello'
  });

  const first = await sendDispatch(dispatch.id);
  assert.equal(first.status, 'sent');

  // Should not throw or change state
  const second = await sendDispatch(dispatch.id);
  assert.equal(second.status, 'sent');
});

test('sendDispatch throws for unknown dispatch id', async () => {
  await assert.rejects(
    () => sendDispatch('non-existent-id'),
    /Dispatch not found/
  );
});

// ─── Deduplication via listDispatches ─────────────────────────────────────────

test('multiple dispatches to same recipient are all stored independently', () => {
  enqueueDispatch({ to: 'dup@example.com', subject: 'First', body: 'B1' });
  enqueueDispatch({ to: 'dup@example.com', subject: 'Second', body: 'B2' });
  const all = listDispatches();
  assert.equal(all.length, 2);
  assert.equal(all[0].subject, 'First');
  assert.equal(all[1].subject, 'Second');
});
