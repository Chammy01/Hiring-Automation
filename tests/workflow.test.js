const test = require('node:test');
const assert = require('node:assert/strict');
const { resetStore } = require('./helpers');

test.beforeEach(() => resetStore());
test.after(() => resetStore());

test('intake creates candidate and prevents duplicates', () => {
  const { createCandidateFromApplication, listCandidates } = require('../src/services');

  const first = createCandidateFromApplication({
    fullName: 'Jane Doe',
    email: 'jane@example.com',
    position: 'Administrative Aide IV (Clerk II)'
  });
  assert.equal(first.duplicate, false);

  const second = createCandidateFromApplication({
    fullName: 'Jane Doe',
    email: 'jane@example.com',
    position: 'Administrative Aide IV (Clerk II)'
  });
  assert.equal(second.duplicate, true);

  const candidates = listCandidates();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].workflowState, 'Docs Pending');
});

test('documents submission disqualifies on invalid subject', () => {
  const {
    createCandidateFromApplication,
    submitCandidateDocuments,
    getCandidate
  } = require('../src/services');

  const created = createCandidateFromApplication({
    fullName: 'John Smith',
    email: 'john@example.com',
    position: 'Administrative Aide IV (Clerk II)'
  });

  submitCandidateDocuments(created.candidate.id, {
    subject: 'Wrong subject',
    attachments: ['letter_of_intent.pdf', 'pds.pdf', 'wes.pdf'],
    submittedAt: '2026-04-01T00:00:00.000Z'
  });

  const candidate = getCandidate(created.candidate.id);
  assert.equal(candidate.workflowState, 'Rejected');
  assert.equal(candidate.compliance.disqualified, true);
});

test('invalid attachment marks document as invalid', () => {
  const {
    createCandidateFromApplication,
    submitCandidateDocuments,
    getCandidate
  } = require('../src/services');

  const created = createCandidateFromApplication({
    fullName: 'Invalid Doc',
    email: 'invalid@example.com',
    position: 'Administrative Aide IV (Clerk II)'
  });

  submitCandidateDocuments(created.candidate.id, {
    subject: 'Application for Administrative Aide IV (Clerk II)',
    attachments: ['proof_csc_professional.pdf'],
    invalidAttachments: ['proof_csc_professional.pdf'],
    submittedAt: '2026-04-01T00:00:00.000Z'
  });

  const candidate = getCandidate(created.candidate.id);
  assert.equal(candidate.documentStatus['Proof of CSC Eligibility'], 'invalid');
});
