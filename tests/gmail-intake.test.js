'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePositionFromSubject,
  parseTokenFromSubject,
  parseFullNameFromFrom,
  resolveCandidate
} = require('../src/workers/gmail-intake');

// ─── parsePositionFromSubject ─────────────────────────────────────────────────

test('parsePositionFromSubject extracts position from standard subject', () => {
  assert.equal(
    parsePositionFromSubject('Application for Software Engineer'),
    'Software Engineer'
  );
});

test('parsePositionFromSubject is case-insensitive', () => {
  assert.equal(
    parsePositionFromSubject('APPLICATION FOR Administrative Aide IV (Clerk II)'),
    'Administrative Aide IV (Clerk II)'
  );
});

test('parsePositionFromSubject returns null when pattern is absent', () => {
  assert.equal(parsePositionFromSubject('Hello there'), null);
  assert.equal(parsePositionFromSubject(''), null);
  assert.equal(parsePositionFromSubject(null), null);
});

// ─── parseTokenFromSubject ────────────────────────────────────────────────────

test('parseTokenFromSubject extracts CandidateID token', () => {
  assert.equal(parseTokenFromSubject('Re: something CandidateID:abc123'), 'abc123');
});

test('parseTokenFromSubject extracts [HA:...] token', () => {
  assert.equal(parseTokenFromSubject('Application for Dev [HA:xyz-99]'), 'xyz-99');
});

test('parseTokenFromSubject returns null when no token present', () => {
  assert.equal(parseTokenFromSubject('Application for Software Engineer'), null);
  assert.equal(parseTokenFromSubject(''), null);
});

// ─── parseFullNameFromFrom ────────────────────────────────────────────────────

test('parseFullNameFromFrom extracts display name from "Name <email>" format', () => {
  assert.equal(parseFullNameFromFrom('Jane Doe <jane@example.com>'), 'Jane Doe');
});

test('parseFullNameFromFrom extracts display name from quoted "Name <email>" format', () => {
  assert.equal(parseFullNameFromFrom('"John Smith" <john@example.com>'), 'John Smith');
});

test('parseFullNameFromFrom falls back to local-part when no display name', () => {
  assert.equal(parseFullNameFromFrom('<jane@example.com>'), 'jane');
  assert.equal(parseFullNameFromFrom('jane@example.com'), 'jane');
});

test('parseFullNameFromFrom returns "Email Applicant" when from header is empty', () => {
  assert.equal(parseFullNameFromFrom(''), 'Email Applicant');
  assert.equal(parseFullNameFromFrom(null), 'Email Applicant');
});

// ─── resolveCandidate ─────────────────────────────────────────────────────────

const sampleCandidates = [
  { id: 'c1', fullName: 'Alice Reyes', email: 'alice@example.com', position: 'Software Engineer' },
  { id: 'c2', fullName: 'Bob Cruz',   email: 'bob@example.com',   position: 'Data Analyst' },
  { id: 'c3', fullName: 'Carol Tan',  email: 'alice@example.com', position: 'Data Analyst' }
];

test('resolveCandidate matches unique email+position', () => {
  const result = resolveCandidate(sampleCandidates, 'alice@example.com', 'Application for Software Engineer');
  assert.ok(result);
  assert.equal(result.candidate.id, 'c1');
  assert.equal(result.reason, 'email+position');
});

test('resolveCandidate returns no-match resolution when no candidate found', () => {
  const result = resolveCandidate(sampleCandidates, 'newbie@example.com', 'Application for DevOps Engineer');
  assert.ok(result, 'result should not be null');
  assert.equal(result.candidate, null);
  assert.equal(result.reason, 'no-match');
});

test('resolveCandidate returns null (skip) when match is ambiguous and no token', () => {
  // alice@example.com matches two candidates when no position is given
  const result = resolveCandidate(sampleCandidates, 'alice@example.com', 'some random subject');
  assert.equal(result, null);
});

test('resolveCandidate resolves ambiguous match via subject token', () => {
  const result = resolveCandidate(
    sampleCandidates,
    'alice@example.com',
    'some subject [HA:c3]'
  );
  assert.ok(result);
  assert.equal(result.candidate.id, 'c3');
  assert.equal(result.reason, 'subject-token');
});

test('resolveCandidate returns null when token does not match any candidate', () => {
  const result = resolveCandidate(
    sampleCandidates,
    'nobody@example.com',
    'Application for DevOps CandidateID:nonexistent'
  );
  assert.equal(result, null);
});
