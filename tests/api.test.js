const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../src/server');
const { config } = require('../src/config');
const { readStore, updateStore } = require('../src/store');
const { decryptText } = require('../src/security');
const { WORKFLOW_STATES } = require('../src/constants');
const { resetStore } = require('./helpers');

function hr(requestBuilder) {
  return requestBuilder.set('x-api-key', 'test-hr-key');
}

function admin(requestBuilder) {
  return requestBuilder.set('x-api-key', 'test-admin-key');
}

function editor(requestBuilder) {
  return requestBuilder.set('x-api-key', 'test-editor-key');
}

test.beforeEach(() => {
  resetStore();
  config.hrApiKeys = new Map([
    ['test-hr-key', 'hr'],
    ['test-admin-key', 'admin'],
    ['test-editor-key', 'editor']
  ]);
});
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

test('settings GET returns default app settings', async () => {
  const res = await hr(request(app).get('/api/settings'));
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.hiringDeadline === 'string');
  assert.ok(typeof res.body.companyEmail === 'string');
  assert.ok(typeof res.body.mailboxAddress === 'string');
  assert.ok(typeof res.body.companyName === 'string');
  assert.ok(typeof res.body.notifyNewApplication === 'boolean');
  assert.ok(typeof res.body.followUpMessage === 'string');
  assert.ok(typeof res.body.scheduleInterviewMessage === 'string');
});

test('settings PUT updates persisted values', async () => {
  const updated = await hr(request(app).put('/api/settings')).send({
    hiringDeadline: '2027-06-30T23:59:59.000Z',
    companyEmail: 'newhiring@example.com',
    companyName: 'Test Corp',
    maxApplicationsPerRole: 50,
    followUpMessage: 'Hi {{candidateName}}',
    scheduleInterviewMessage: 'Interview for {{candidateName}} at {{interviewTime}}'
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.hiringDeadline, '2027-06-30T23:59:59.000Z');
  assert.equal(updated.body.companyEmail, 'newhiring@example.com');
  assert.equal(updated.body.companyName, 'Test Corp');
  assert.equal(updated.body.maxApplicationsPerRole, 50);
  assert.equal(updated.body.followUpMessage, 'Hi {{candidateName}}');
  assert.equal(updated.body.scheduleInterviewMessage, 'Interview for {{candidateName}} at {{interviewTime}}');

  const fetched = await hr(request(app).get('/api/settings'));
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.hiringDeadline, '2027-06-30T23:59:59.000Z');
  assert.equal(fetched.body.companyEmail, 'newhiring@example.com');
  assert.equal(fetched.body.followUpMessage, 'Hi {{candidateName}}');
  assert.equal(fetched.body.scheduleInterviewMessage, 'Interview for {{candidateName}} at {{interviewTime}}');
});

test('settings PUT allows editor role updates', async () => {
  const updated = await editor(request(app).put('/api/settings')).send({
    followUpMessage: 'Editor updated {{candidateName}}',
    scheduleInterviewMessage: 'Editor schedule {{interviewDate}}'
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.followUpMessage, 'Editor updated {{candidateName}}');
  assert.equal(updated.body.scheduleInterviewMessage, 'Editor schedule {{interviewDate}}');
});

test('follow-up email uses message template from settings with placeholder replacement', async () => {
  await hr(request(app).put('/api/settings')).send({
    followUpMessage: 'Hello {{candidateName}} for {{position}}. Missing:\n{{missingDocuments}}\nDeadline: {{deadline}}'
  });

  const intake = await hr(request(app).post('/api/applications/intake')).send({
    fullName: 'Template Followup',
    email: 'followup-template@example.com',
    position: 'Administrative Aide IV (Clerk II)'
  });
  assert.equal(intake.status, 201);

  const res = await hr(request(app).post(`/api/candidates/${intake.body.candidate.id}/follow-up`));
  assert.equal(res.status, 200);

  const dispatch = readStore().outboundDispatches.find((item) => item.candidateId === intake.body.candidate.id);
  assert.ok(dispatch, 'follow-up dispatch should be queued');
  const body = decryptText(dispatch.bodyEncrypted);
  assert.ok(body.includes('Hello Template Followup for Administrative Aide IV (Clerk II).'));
  assert.ok(body.includes('Missing:'));
  assert.ok(!body.includes('{{candidateName}}'));
});

test('interview email uses message template from settings with placeholder replacement', async () => {
  await hr(request(app).put('/api/settings')).send({
    scheduleInterviewMessage: 'Hi {{candidateName}}, your {{position}} interview is {{interviewDate}} {{interviewTime}} at {{interviewLocation}}'
  });

  const intake = await hr(request(app).post('/api/applications/intake')).send({
    fullName: 'Template Interview',
    email: 'interview-template@example.com',
    position: 'Administrative Aide IV (Clerk II)'
  });
  assert.equal(intake.status, 201);

  updateStore((state) => {
    const candidate = state.candidates.find((item) => item.id === intake.body.candidate.id);
    candidate.workflowState = WORKFLOW_STATES.SHORTLISTED;
    candidate.statusOfApplication = 'Shortlisted';
    return state;
  });

  const interview = await hr(request(app).post(`/api/candidates/${intake.body.candidate.id}/interview`)).send({
    date: '2026-08-01',
    time: '09:30',
    meetingLink: 'https://meet.example.com/interview-room'
  });
  assert.equal(interview.status, 200);

  const events = await hr(request(app).get('/api/email-events'));
  const scheduled = events.body.items.find(
    (item) =>
      item.candidateId === intake.body.candidate.id &&
      item.subject === 'Initial Interview Schedule - Administrative Aide IV (Clerk II)'
  );
  assert.ok(scheduled, 'interview email event should exist');
  assert.ok(scheduled.body.includes('Hi Template Interview, your Administrative Aide IV (Clerk II) interview is 2026-08-01 09:30 at https://meet.example.com/interview-room'));
  assert.ok(!scheduled.body.includes('{{interviewDate}}'));
});

test('settings PUT rejects invalid email for companyEmail', async () => {
  const res = await hr(request(app).put('/api/settings')).send({
    companyEmail: 'not-an-email'
  });
  assert.equal(res.status, 400);
});

test('intake ack email uses deadline from settings', async () => {
  await hr(request(app).put('/api/settings')).send({
    hiringDeadline: '2099-01-01T00:00:00.000Z',
    companyEmail: 'custom@example.com'
  });

  const intake = await hr(request(app).post('/api/applications/intake')).send({
    fullName: 'Settings Test',
    email: 'settingstest@example.com',
    position: 'Administrative Aide IV (Clerk II)'
  });
  assert.equal(intake.status, 201);

  const events = await hr(request(app).get('/api/email-events'));
  const ack = events.body.items.find((e) => e.candidateId === intake.body.candidate.id && e.direction === 'outbound');
  assert.ok(ack, 'outbound ack event should exist');
  assert.equal(ack.from, 'custom@example.com');
  assert.ok(ack.body.includes('2099'), 'ack body should contain the configured deadline year');
});

test('compliance uses deadline from settings', async () => {
  await hr(request(app).put('/api/settings')).send({
    hiringDeadline: '2099-12-31T23:59:59.000Z'
  });

  const intake = await hr(request(app).post('/api/applications/intake')).send({
    fullName: 'Compliance Test',
    email: 'compliance@example.com',
    position: 'Administrative Aide IV (Clerk II)'
  });
  assert.equal(intake.status, 201);
  const candidateId = intake.body.candidate.id;

  const docs = await hr(request(app).post(`/api/candidates/${candidateId}/documents`)).send({
    attachments: [],
    subject: 'Application for Administrative Aide IV (Clerk II)',
    submittedAt: new Date().toISOString()
  });
  assert.equal(docs.status, 200);
  assert.equal(docs.body.compliance.submittedBeforeDeadline, true);
});

test('archive endpoint toggles isArchived on a candidate', async () => {
  const intake = await hr(request(app).post('/api/applications/intake')).send({
    fullName: 'Archive Test',
    email: 'archivetest@example.com',
    position: 'Administrative Aide IV (Clerk II)'
  });
  assert.equal(intake.status, 201);
  const candidateId = intake.body.candidate.id;

  // Archive the candidate
  const archived = await hr(request(app).patch(`/api/candidates/${candidateId}/archive`)).send({ archived: true });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.isArchived, true);

  // Candidate should not appear in the active list
  const activeList = await hr(request(app).get('/api/candidates'));
  assert.ok(!activeList.body.items.some((c) => c.id === candidateId));

  // Candidate should appear in archived list
  const archivedList = await hr(request(app).get('/api/candidates?archived=true'));
  assert.ok(archivedList.body.items.some((c) => c.id === candidateId));

  // Unarchive the candidate
  const unarchived = await hr(request(app).patch(`/api/candidates/${candidateId}/archive`)).send({ archived: false });
  assert.equal(unarchived.status, 200);
  assert.equal(unarchived.body.isArchived, false);

  // Candidate should be visible in active list again
  const activeList2 = await hr(request(app).get('/api/candidates'));
  assert.ok(activeList2.body.items.some((c) => c.id === candidateId));
});

test('archive endpoint returns 404 for unknown candidate', async () => {
  const res = await hr(request(app).patch('/api/candidates/00000000-0000-0000-0000-000000000000/archive')).send({});
  assert.equal(res.status, 404);
});

test('delete endpoint permanently removes a candidate', async () => {
  const intake = await hr(request(app).post('/api/applications/intake')).send({
    fullName: 'Delete Test',
    email: 'deletetest@example.com',
    position: 'Administrative Aide IV (Clerk II)'
  });
  assert.equal(intake.status, 201);
  const candidateId = intake.body.candidate.id;

  const deleted = await hr(request(app).delete(`/api/candidates/${candidateId}`));
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, true);
  assert.equal(deleted.body.candidate.id, candidateId);

  // Candidate should no longer be retrievable
  const fetched = await hr(request(app).get(`/api/candidates/${candidateId}`));
  assert.equal(fetched.status, 404);

  // Candidate should not appear in either list
  const activeList = await hr(request(app).get('/api/candidates'));
  assert.ok(!activeList.body.items.some((c) => c.id === candidateId));
  const archivedList = await hr(request(app).get('/api/candidates?archived=true'));
  assert.ok(!archivedList.body.items.some((c) => c.id === candidateId));
});

test('delete endpoint returns 404 for unknown candidate', async () => {
  const res = await hr(request(app).delete('/api/candidates/00000000-0000-0000-0000-000000000000'));
  assert.equal(res.status, 404);
});

test('auth returns 401 for invalid API key when auth mapping is configured', async () => {
  const res = await request(app)
    .get('/api/candidates')
    .set('x-api-key', 'invalid-key');
  assert.equal(res.status, 401);
});

test('backup endpoint requires admin role', async () => {
  const asHr = await hr(request(app).get('/api/backup'));
  assert.equal(asHr.status, 403);

  const asAdmin = await admin(request(app).get('/api/backup'));
  assert.equal(asAdmin.status, 200);
});
