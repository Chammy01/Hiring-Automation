'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetStore } = require('./helpers');

test.beforeEach(() => resetStore());
test.after(() => resetStore());

// Helper: create a candidate then submit documents with given subject/date
function setupAndSubmit(services, { subject, submittedAt }) {
  const { createCandidateFromApplication, submitCandidateDocuments, getCandidate } = services;

  const { candidate } = createCandidateFromApplication({
    fullName: 'Compliance Tester',
    email: 'compliance@example.com',
    position: 'Administrative Aide IV (Clerk II)'
  });

  submitCandidateDocuments(candidate.id, {
    subject,
    attachments: ['letter_of_intent.pdf', 'pds.pdf', 'wes.pdf'],
    submittedAt
  });

  return getCandidate(candidate.id);
}

// ── Subject format compliance ──────────────────────────────────

test('compliance: correct subject (exact case) passes', () => {
  const services = require('../src/services');
  const result = setupAndSubmit(services, {
    subject: 'Application for Administrative Aide IV (Clerk II)',
    submittedAt: '2020-01-01T00:00:00.000Z'
  });
  assert.equal(result.compliance.subjectFormatValid, true);
});

test('compliance: subject in all-caps passes (case-insensitive)', () => {
  const services = require('../src/services');
  const result = setupAndSubmit(services, {
    subject: 'APPLICATION FOR ADMINISTRATIVE AIDE IV (CLERK II)',
    submittedAt: '2020-01-01T00:00:00.000Z'
  });
  assert.equal(result.compliance.subjectFormatValid, true, 'Uppercase subject should be case-insensitively valid');
  assert.equal(result.compliance.disqualified, false);
});

test('compliance: subject in mixed case passes (case-insensitive)', () => {
  const services = require('../src/services');
  const result = setupAndSubmit(services, {
    subject: 'application for administrative aide iv (clerk ii)',
    submittedAt: '2020-01-01T00:00:00.000Z'
  });
  assert.equal(result.compliance.subjectFormatValid, true);
  assert.equal(result.compliance.disqualified, false);
});

test('compliance: wrong subject disqualifies candidate', () => {
  const services = require('../src/services');
  const result = setupAndSubmit(services, {
    subject: 'Re: Application',
    submittedAt: '2020-01-01T00:00:00.000Z'
  });
  assert.equal(result.compliance.subjectFormatValid, false);
  assert.equal(result.compliance.disqualified, true);
  assert.ok(result.compliance.reasons.length > 0);
});

// ── Deadline compliance ────────────────────────────────────────

test('compliance: submission before deadline passes', () => {
  const services = require('../src/services');

  // Set a deadline in the far future via updateAppSettings
  const { updateAppSettings } = services;
  updateAppSettings({ hiringDeadline: '2099-12-31T23:59:59.000Z' });

  const result = setupAndSubmit(services, {
    subject: 'Application for Administrative Aide IV (Clerk II)',
    submittedAt: new Date().toISOString()
  });

  assert.equal(result.compliance.submittedBeforeDeadline, true);
  assert.equal(result.compliance.disqualified, false);
});

test('compliance: submission after deadline disqualifies candidate', () => {
  const services = require('../src/services');

  // Set a deadline well in the past
  const { updateAppSettings } = services;
  updateAppSettings({ hiringDeadline: '2000-01-01T00:00:00.000Z' });

  const result = setupAndSubmit(services, {
    subject: 'Application for Administrative Aide IV (Clerk II)',
    submittedAt: '2001-01-01T00:00:00.000Z'
  });

  assert.equal(result.compliance.submittedBeforeDeadline, false);
  assert.equal(result.compliance.disqualified, true);
  assert.ok(result.compliance.reasons.some((r) => r.includes('deadline')));
});

test('compliance: submission exactly at deadline passes', () => {
  const deadline = '2030-06-15T23:59:59.000Z';
  const services = require('../src/services');
  const { updateAppSettings } = services;
  updateAppSettings({ hiringDeadline: deadline });

  const result = setupAndSubmit(services, {
    subject: 'Application for Administrative Aide IV (Clerk II)',
    submittedAt: deadline // exactly at the boundary
  });

  assert.equal(result.compliance.submittedBeforeDeadline, true);
});

// ── Combined compliance ────────────────────────────────────────

test('compliance: bad subject AND late submission produces two reasons', () => {
  const services = require('../src/services');
  const { updateAppSettings } = services;
  updateAppSettings({ hiringDeadline: '2000-01-01T00:00:00.000Z' });

  const result = setupAndSubmit(services, {
    subject: 'Wrong subject format',
    submittedAt: '2001-01-01T00:00:00.000Z'
  });

  assert.equal(result.compliance.disqualified, true);
  assert.equal(result.compliance.reasons.length, 2, 'Should have both subject and deadline reasons');
});
