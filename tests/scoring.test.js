const test = require('node:test');
const assert = require('node:assert/strict');
const { resetStore } = require('./helpers');

test.beforeEach(() => resetStore());
test.after(() => resetStore());

test('scoring returns transparent recommendation output', () => {
  const {
    createCandidateFromApplication,
    extractCandidateProfile,
    submitCandidateDocuments,
    calculateRecommendation,
    getCandidate
  } = require('../src/services');

  const result = createCandidateFromApplication({
    fullName: 'Anna Perez',
    email: 'anna@example.com',
    position: 'Administrative Aide IV (Clerk II)'
  });

  const id = result.candidate.id;

  submitCandidateDocuments(id, {
    subject: 'Application for Administrative Aide IV (Clerk II)',
    attachments: [
      'letter_of_intent.pdf',
      'pds_form.pdf',
      'wes_form.pdf',
      'training_certificate.pdf',
      'award_doc.pdf',
      'latest_ipcr.pdf',
      'proof_csc_professional.pdf'
    ],
    submittedAt: '2026-04-01T00:00:00.000Z'
  });

  extractCandidateProfile(id, {
    documentTexts: [
      {
        fileName: 'resume.pdf',
        text: 'College graduate with 5 years experience. Professional eligibility. Training and seminar attended. Academic award.'
      }
    ]
  });

  const recommendation = calculateRecommendation(id);

  assert.ok(recommendation.score >= 80);
  assert.ok(recommendation.breakdown.docsScore > 0);

  const candidate = getCandidate(id);
  assert.equal(candidate.recommendation.score, recommendation.score);
});

test('scoring weights can be updated', () => {
  const {
    getScoringWeights,
    updateScoringWeights
  } = require('../src/services');

  const before = getScoringWeights();
  assert.equal(before.awards, 5);

  // Provide a full weight set that sums to exactly 100.
  const updated = updateScoringWeights({
    docsComplete: 23,
    eligibility: 20,
    experience: 20,
    education: 15,
    trainings: 10,
    awards: 12
  });
  assert.equal(updated.awards, 12);
  const total = Object.values(updated).reduce((s, n) => s + n, 0);
  assert.equal(total, 100);
});

test('updateScoringWeights rejects weights that do not sum to 100', () => {
  const { updateScoringWeights } = require('../src/services');
  assert.throws(
    () => updateScoringWeights({ docsComplete: 30, eligibility: 20, experience: 20, education: 15, trainings: 10, awards: 12 }),
    /sum to 100/
  );
});
