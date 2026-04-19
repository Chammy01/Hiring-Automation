const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const storePath = path.resolve('data/store.json');

function resetStore() {
  fs.writeFileSync(
    storePath,
    JSON.stringify({ candidates: [], emailEvents: [], auditLogs: [] }, null, 2)
  );
}

test('scoring returns transparent recommendation output', () => {
  resetStore();
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
