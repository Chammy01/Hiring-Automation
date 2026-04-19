'use strict';

/**
 * Document classifier: maps an attachment to a required doc slot
 * using filename hints + content keywords with scoring.
 *
 * Returns the best-matching required doc name (or null if nothing scores).
 */

const DOC_RULES = [
  {
    docName: 'Letter of Intent',
    fileKeywords: ['intent', 'letter of intent', 'loi'],
    contentKeywords: ['letter of intent', 'i hereby express', 'i wish to apply', 'applying for the position']
  },
  {
    docName: 'PDS',
    fileKeywords: ['pds', 'personal data sheet', 'personal_data'],
    contentKeywords: ['personal data sheet', 'civil service form', 'csc form', 'date of birth', 'place of birth']
  },
  {
    docName: 'WES',
    fileKeywords: ['wes', 'work experience', 'work_experience'],
    contentKeywords: ['work experience sheet', 'position title', 'inclusive dates', 'monthly salary', 'status of appointment']
  },
  {
    docName: 'Training/Seminar Certificates',
    fileKeywords: ['training', 'seminar', 'certificate', 'cert', 'workshop'],
    contentKeywords: ['certificate of completion', 'certificate of attendance', 'seminar', 'training', 'workshop', 'hours of training']
  },
  {
    docName: 'Awards from Last Promotion',
    fileKeywords: ['award', 'recognition', 'commendation', 'promotion'],
    contentKeywords: ['award', 'recognition', 'commendation', 'best employee', 'outstanding', 'plaque']
  },
  {
    docName: 'Latest IPCR',
    fileKeywords: ['ipcr', 'performance', 'commitment', 'review'],
    contentKeywords: ['individual performance commitment', 'ipcr', 'performance rating', 'ratee', 'rater', 'final average rating']
  },
  {
    docName: 'Proof of CSC Eligibility',
    fileKeywords: ['csc', 'eligibility', 'civil service', 'prc', 'bar', 'board', 'sub-prof', 'honor'],
    contentKeywords: [
      'civil service commission',
      'eligibility',
      'career service',
      'professional',
      'sub-professional',
      'prc',
      'honor graduate',
      'bar passer',
      'board passer'
    ]
  },
  {
    docName: 'Computer Skill Evidence',
    fileKeywords: ['computer', 'it cert', 'nc ii', 'tesda', 'operator', 'tech'],
    contentKeywords: ['computer', 'information technology', 'tesda', 'nc ii', 'technical education', 'computer operator']
  }
];

/**
 * @param {string} fileName
 * @param {string} text  extracted text (may be empty)
 * @returns {{ docName: string, score: number, matchedBy: string }|null}
 */
function classifyDocument(fileName, text) {
  const normalizedFile = String(fileName || '').toLowerCase();
  const normalizedText = String(text || '').toLowerCase();

  let best = null;

  for (const rule of DOC_RULES) {
    let score = 0;
    const matchedBy = [];

    for (const kw of rule.fileKeywords) {
      if (normalizedFile.includes(kw)) {
        score += 10;
        matchedBy.push(`filename:${kw}`);
        break;
      }
    }

    for (const kw of rule.contentKeywords) {
      if (normalizedText.includes(kw)) {
        score += 5;
        matchedBy.push(`content:${kw}`);
        if (matchedBy.length >= 4) break;
      }
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { docName: rule.docName, score, matchedBy: matchedBy.join(', ') };
    }
  }

  return best;
}

module.exports = { classifyDocument, DOC_RULES };
