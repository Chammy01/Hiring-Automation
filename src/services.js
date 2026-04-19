const crypto = require('node:crypto');
const { readStore, updateStore } = require('./store');
const {
  WORKFLOW_STATES,
  TRANSITIONS,
  POSITION_CHECKLISTS,
  DEFAULT_REQUIRED_DOCUMENTS,
  SCORING_WEIGHTS
} = require('./constants');
const { config } = require('./config');

function nowIso() {
  return new Date().toISOString();
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePosition(position) {
  return String(position || '').trim();
}

function findChecklist(position) {
  return POSITION_CHECKLISTS[normalizePosition(position)] || DEFAULT_REQUIRED_DOCUMENTS;
}

function createDocStatus(requiredDocs) {
  return requiredDocs.reduce((acc, docName) => {
    acc[docName] = 'missing';
    return acc;
  }, {});
}

function addAuditLog(state, action, candidateId, metadata = {}) {
  state.auditLogs.push({
    id: crypto.randomUUID(),
    timestamp: nowIso(),
    action,
    candidateId,
    metadata
  });
}

function addEmailEvent(state, candidateId, direction, subject, body) {
  state.emailEvents.push({
    id: crypto.randomUUID(),
    timestamp: nowIso(),
    candidateId,
    direction,
    subject,
    body,
    status: 'sent'
  });
}

function assertTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

function transitionCandidate(candidate, toState) {
  if (candidate.workflowState === toState) {
    return;
  }
  if (!assertTransition(candidate.workflowState, toState)) {
    throw new Error(`Invalid transition from ${candidate.workflowState} to ${toState}`);
  }
  candidate.workflowState = toState;
  candidate.updatedAt = nowIso();
}

function acknowledgementTemplate(deadline) {
  return `Dear Applicant,\n\nThank you for your interest in applying to our Office.\n\nIn view that the position you are applying for is a regular position, you are hereby requested to submit the following documentary requirements on or before ${deadline}:\n\n• Letter of Intent\n• One (1) copy of a fully accomplished Personal Data Sheet (PDS) and Work Experience Sheet (WES) (CSC Form No. 212, s. 2025)\n(Forms may be downloaded from the Civil Service Commission website)\n• One (1) copy of relevant training/seminar certificates (if applicable)\n• One (1) copy of awards received from your last promotion (if applicable)\n• One (1) copy of your latest Individual Performance Commitment and Review (IPCR) (if applicable)\n• One (1) copy of proof of CSC Eligibility\n \nKindly submit the above documents through email using the prescribed subject format:\n\nApplication for (Position and Title)\n(ex: Application for Administrative Assistant I (Computer Operator I))\n\nPlease be advised that non-compliance with the required documents, failure to follow the prescribed subject format, or submission beyond the stated deadline shall result in automatic disqualification from the selection process.\n\nThis is an automated reminder. If this has already been taken care of, please disregard. We kindly ask that you reply to acknowledge receipt of this message.\n\nThank you.\nVery truly yours,`;
}

function findCandidateByIdentity(state, fullName, email, position) {
  return state.candidates.find(
    (candidate) =>
      normalize(candidate.fullName) === normalize(fullName) &&
      normalize(candidate.email) === normalize(email) &&
      normalize(candidate.position) === normalize(position)
  );
}

function createCandidateFromApplication(payload) {
  const receivedAt = payload.receivedAt ? new Date(payload.receivedAt) : new Date();
  return updateStore((state) => {
    const duplicate = findCandidateByIdentity(state, payload.fullName, payload.email, payload.position);
    if (duplicate) {
      addAuditLog(state, 'candidate.duplicate_skipped', duplicate.id, {
        fullName: payload.fullName,
        email: payload.email,
        position: payload.position
      });
      state.__result = { duplicate: true, candidate: duplicate };
      return state;
    }

    const checklist = findChecklist(payload.position);
    const candidate = {
      id: crypto.randomUUID(),
      fullName: payload.fullName,
      email: payload.email,
      position: normalizePosition(payload.position),
      workflowState: WORKFLOW_STATES.APPLIED,
      statusOfApplication: 'Hiring',
      documentStatus: createDocStatus(checklist),
      requiredDocuments: checklist,
      compliance: {
        subjectFormatValid: true,
        submittedBeforeDeadline: true,
        disqualified: false,
        reasons: []
      },
      educationalAttainment: 'Unknown',
      workExperience: 'Unknown',
      awards: 'None submitted',
      trainings: 'None submitted',
      cscEligibility: 'Unknown',
      specialNote: '',
      link: '',
      emailSent: false,
      confirmedAttendance: false,
      extractionConfidence: 'low',
      recommendation: {
        score: 0,
        reason: 'Not scored yet',
        rankLabel: 'Unranked',
        breakdown: {}
      },
      interviewSchedule: null,
      createdAt: receivedAt.toISOString(),
      updatedAt: receivedAt.toISOString()
    };

    transitionCandidate(candidate, WORKFLOW_STATES.ACK_SENT);
    transitionCandidate(candidate, WORKFLOW_STATES.DOCS_PENDING);

    const ackSubject = `Application Received: ${candidate.position}`;
    const ackBody = acknowledgementTemplate('07 April 2026');
    addEmailEvent(state, candidate.id, 'outbound', ackSubject, ackBody);
    candidate.emailSent = true;

    state.candidates.push(candidate);
    addAuditLog(state, 'candidate.created', candidate.id, { source: 'email_intake' });
    addAuditLog(state, 'email.ack_sent', candidate.id, { subject: ackSubject });

    state.__result = { duplicate: false, candidate };
    return state;
  }).__result;
}

function attachmentMatchesDoc(attachment, docName) {
  const a = normalize(attachment);
  const d = normalize(docName);
  const synonyms = {
    'letter of intent': ['intent'],
    pds: ['personal data sheet', 'pds'],
    wes: ['work experience sheet', 'wes'],
    'training/seminar certificates': ['training', 'seminar', 'certificate'],
    'awards from last promotion': ['award'],
    'latest ipcr': ['ipcr'],
    'proof of csc eligibility': ['csc', 'eligibility', 'prc', 'honor', 'sub-prof', 'professional'],
    'computer skill evidence': ['computer', 'operator', 'it', 'tech']
  };
  const keys = synonyms[d] || [d];
  return keys.some((key) => a.includes(key));
}

function applyCompliance(candidate, submittedAt, subject) {
  const expectedSubject = `Application for ${candidate.position}`;
  const deadline = new Date(config.defaultDeadline);
  const actualDate = submittedAt ? new Date(submittedAt) : new Date();

  candidate.compliance.subjectFormatValid = subject === expectedSubject;
  candidate.compliance.submittedBeforeDeadline = actualDate <= deadline;
  candidate.compliance.disqualified =
    !candidate.compliance.subjectFormatValid || !candidate.compliance.submittedBeforeDeadline;

  const reasons = [];
  if (!candidate.compliance.subjectFormatValid) {
    reasons.push(`Invalid subject format. Expected \"${expectedSubject}\"`);
  }
  if (!candidate.compliance.submittedBeforeDeadline) {
    reasons.push(`Submitted after deadline ${deadline.toISOString()}`);
  }
  candidate.compliance.reasons = reasons;
}

function submitCandidateDocuments(candidateId, payload) {
  return updateStore((state) => {
    const candidate = state.candidates.find((x) => x.id === candidateId);
    if (!candidate) {
      throw new Error('Candidate not found');
    }

    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    for (const requiredDoc of candidate.requiredDocuments) {
      const found = attachments.some((attachment) => attachmentMatchesDoc(attachment, requiredDoc));
      candidate.documentStatus[requiredDoc] = found ? 'received' : 'missing';
    }

    applyCompliance(candidate, payload.submittedAt, payload.subject);

    const allReceived = Object.values(candidate.documentStatus).every((status) => status === 'received');

    if (candidate.compliance.disqualified) {
      transitionCandidate(candidate, WORKFLOW_STATES.REJECTED);
      candidate.statusOfApplication = 'Disqualified';
      candidate.specialNote = candidate.compliance.reasons.join('; ');
    } else if (allReceived) {
      transitionCandidate(candidate, WORKFLOW_STATES.DOCS_COMPLETE);
      transitionCandidate(candidate, WORKFLOW_STATES.FOR_REVIEW);
      candidate.statusOfApplication = 'For Review';
    } else {
      candidate.statusOfApplication = 'Documents Missing';
      const missing = Object.entries(candidate.documentStatus)
        .filter(([, status]) => status !== 'received')
        .map(([docName]) => docName);
      const body = `You still need to submit the following requirements: ${missing.join(', ')}`;
      addEmailEvent(state, candidate.id, 'outbound', 'Missing Documentary Requirements', body);
      addAuditLog(state, 'email.missing_docs_sent', candidate.id, { missing });
    }

    candidate.updatedAt = nowIso();
    addAuditLog(state, 'candidate.documents_submitted', candidate.id, {
      attachments,
      compliance: candidate.compliance
    });

    state.__result = candidate;
    return state;
  }).__result;
}

function extractCandidateProfile(candidateId, payload) {
  return updateStore((state) => {
    const candidate = state.candidates.find((x) => x.id === candidateId);
    if (!candidate) {
      throw new Error('Candidate not found');
    }

    const documentTexts = Array.isArray(payload.documentTexts) ? payload.documentTexts : [];
    const combined = documentTexts.map((item) => `${item.fileName || ''}\n${item.text || ''}`).join('\n');
    const text = normalize(combined);

    const education = text.includes('master')
      ? 'Graduate School'
      : text.includes('college')
        ? 'College Graduate'
        : text.includes('senior high')
          ? 'Senior High School'
          : 'Unknown';

    const experienceMatch = text.match(/(\d+)\s*(?:\+)?\s*years?/);
    const experienceYears = experienceMatch ? Number(experienceMatch[1]) : 0;
    const experience =
      experienceYears >= 4
        ? 'More than 3 years'
        : experienceYears >= 1
          ? '1-3 years'
          : experienceYears > 0
            ? 'Less than 1 year'
            : 'None';

    const awards = text.includes('cum laude') || text.includes('award') ? 'With awards' : 'None submitted';
    const trainings = text.includes('training') || text.includes('seminar') ? 'With trainings' : 'None submitted';

    const csc = text.includes('professional')
      ? 'Professional'
      : text.includes('sub-prof')
        ? 'Sub-Professional'
        : text.includes('honor')
          ? 'Honor Graduate Eligibility'
          : text.includes('prc')
            ? 'PRC'
            : 'Unknown';

    candidate.educationalAttainment = education;
    candidate.workExperience = experience;
    candidate.awards = awards;
    candidate.trainings = trainings;
    candidate.cscEligibility = csc;

    const foundFields = [education, experience, csc].filter((x) => x !== 'Unknown' && x !== 'None').length;
    candidate.extractionConfidence = foundFields >= 3 ? 'high' : foundFields === 2 ? 'medium' : 'low';

    candidate.updatedAt = nowIso();
    addAuditLog(state, 'candidate.profile_extracted', candidate.id, {
      extractionConfidence: candidate.extractionConfidence
    });

    state.__result = candidate;
    return state;
  }).__result;
}

function calculateRecommendation(candidateId) {
  return updateStore((state) => {
    const candidate = state.candidates.find((x) => x.id === candidateId);
    if (!candidate) {
      throw new Error('Candidate not found');
    }

    const docsComplete = Object.values(candidate.documentStatus).every((status) => status === 'received');
    const docsScore = docsComplete ? SCORING_WEIGHTS.docsComplete : 0;

    const eligibilityScore =
      candidate.cscEligibility === 'Professional'
        ? SCORING_WEIGHTS.eligibility
        : candidate.cscEligibility === 'Sub-Professional'
          ? Math.round(SCORING_WEIGHTS.eligibility * 0.8)
          : candidate.cscEligibility === 'PRC' || candidate.cscEligibility === 'Honor Graduate Eligibility'
            ? Math.round(SCORING_WEIGHTS.eligibility * 0.7)
            : 0;

    const experienceScore =
      candidate.workExperience === 'More than 3 years'
        ? SCORING_WEIGHTS.experience
        : candidate.workExperience === '1-3 years'
          ? Math.round(SCORING_WEIGHTS.experience * 0.75)
          : candidate.workExperience === 'Less than 1 year'
            ? Math.round(SCORING_WEIGHTS.experience * 0.4)
            : 0;

    const educationScore =
      candidate.educationalAttainment === 'Graduate School'
        ? SCORING_WEIGHTS.education
        : candidate.educationalAttainment === 'College Graduate'
          ? Math.round(SCORING_WEIGHTS.education * 0.85)
          : candidate.educationalAttainment === 'Senior High School'
            ? Math.round(SCORING_WEIGHTS.education * 0.4)
            : 0;

    const trainingsScore =
      candidate.trainings === 'With trainings' ? SCORING_WEIGHTS.trainings : Math.round(SCORING_WEIGHTS.trainings * 0.2);
    const awardsScore = candidate.awards === 'With awards' ? SCORING_WEIGHTS.awards : 0;

    const total =
      docsScore +
      eligibilityScore +
      experienceScore +
      educationScore +
      trainingsScore +
      awardsScore;

    const rankLabel = total >= 85 ? 'Strongly Recommended' : total >= 70 ? 'Recommended' : total >= 50 ? 'Consider' : 'Low Priority';

    candidate.recommendation = {
      score: total,
      rankLabel,
      reason: `Score ${total}/100 based on document completeness, eligibility, experience, education, trainings, and awards.`,
      breakdown: {
        docsScore,
        eligibilityScore,
        experienceScore,
        educationScore,
        trainingsScore,
        awardsScore
      }
    };

    candidate.updatedAt = nowIso();
    addAuditLog(state, 'candidate.scored', candidate.id, candidate.recommendation);

    state.__result = candidate.recommendation;
    return state;
  }).__result;
}

function updateCandidateStatus(candidateId, action, payload = {}) {
  return updateStore((state) => {
    const candidate = state.candidates.find((x) => x.id === candidateId);
    if (!candidate) {
      throw new Error('Candidate not found');
    }

    if (action === 'shortlist') {
      transitionCandidate(candidate, WORKFLOW_STATES.SHORTLISTED);
      candidate.statusOfApplication = 'Shortlisted';
      addAuditLog(state, 'candidate.shortlisted', candidate.id);
    } else if (action === 'scheduleInterview') {
      transitionCandidate(candidate, WORKFLOW_STATES.INTERVIEW_SCHEDULED);
      candidate.statusOfApplication = 'Interview Scheduled';
      candidate.interviewSchedule = {
        date: payload.date,
        time: payload.time,
        meetingLink: payload.meetingLink || '',
        venue: payload.venue || ''
      };
      const subject = `Initial Interview Schedule - ${candidate.position}`;
      const body = `Hello ${candidate.fullName}, your initial interview is scheduled on ${payload.date} ${payload.time}. ${payload.meetingLink || payload.venue || ''}`;
      addEmailEvent(state, candidate.id, 'outbound', subject, body);
      addAuditLog(state, 'candidate.interview_scheduled', candidate.id, candidate.interviewSchedule);
    } else if (action === 'hire') {
      transitionCandidate(candidate, WORKFLOW_STATES.HIRED);
      candidate.statusOfApplication = 'Hired';
      addAuditLog(state, 'candidate.hired', candidate.id);
    } else if (action === 'reject') {
      transitionCandidate(candidate, WORKFLOW_STATES.REJECTED);
      candidate.statusOfApplication = 'Rejected';
      candidate.specialNote = payload.reason || candidate.specialNote;
      addAuditLog(state, 'candidate.rejected', candidate.id, { reason: payload.reason || '' });
    } else if (action === 'confirmInterview') {
      candidate.confirmedAttendance = true;
      addAuditLog(state, 'candidate.interview_confirmed', candidate.id);
    } else {
      throw new Error('Unsupported action');
    }

    candidate.updatedAt = nowIso();
    state.__result = candidate;
    return state;
  }).__result;
}

function listCandidates() {
  return readStore().candidates;
}

function getCandidate(candidateId) {
  return readStore().candidates.find((x) => x.id === candidateId);
}

function listPositions() {
  return Object.keys(POSITION_CHECKLISTS).filter((x) => x !== 'default');
}

function getDashboard() {
  const state = readStore();
  const byState = state.candidates.reduce((acc, candidate) => {
    acc[candidate.workflowState] = (acc[candidate.workflowState] || 0) + 1;
    return acc;
  }, {});

  const topCandidates = [...state.candidates]
    .sort((a, b) => b.recommendation.score - a.recommendation.score)
    .slice(0, 5)
    .map((candidate) => ({
      id: candidate.id,
      fullName: candidate.fullName,
      position: candidate.position,
      score: candidate.recommendation.score,
      rankLabel: candidate.recommendation.rankLabel
    }));

  return {
    totals: {
      candidates: state.candidates.length,
      disqualified: state.candidates.filter((x) => x.compliance.disqualified).length,
      interviewScheduled: state.candidates.filter((x) => x.workflowState === WORKFLOW_STATES.INTERVIEW_SCHEDULED).length
    },
    byState,
    topCandidates
  };
}

function toSheetRows() {
  return readStore().candidates.map((candidate) => ({
    'Name of Applicant': candidate.fullName,
    'Position Applying For': candidate.position,
    'Status of Application': candidate.statusOfApplication,
    'Letter of Intent': candidate.documentStatus['Letter of Intent'] === 'received',
    PDS: candidate.documentStatus.PDS === 'received',
    WES: candidate.documentStatus.WES === 'received',
    'Educational Attainment': candidate.educationalAttainment,
    'Work Experience': candidate.workExperience,
    Awards: candidate.awards,
    Trainings: candidate.trainings,
    CSC: candidate.cscEligibility,
    'Email Address': candidate.email,
    Status: candidate.workflowState,
    Link: candidate.link,
    'Special Note': candidate.specialNote,
    'Email sent': candidate.emailSent,
    'Confirmed attendance': candidate.confirmedAttendance,
    'System Score': candidate.recommendation.score,
    Recommendation: candidate.recommendation.rankLabel
  }));
}

function listAuditLogs() {
  return readStore().auditLogs;
}

function listEmailEvents() {
  return readStore().emailEvents;
}

module.exports = {
  createCandidateFromApplication,
  submitCandidateDocuments,
  extractCandidateProfile,
  calculateRecommendation,
  updateCandidateStatus,
  listCandidates,
  getCandidate,
  listPositions,
  getDashboard,
  toSheetRows,
  listAuditLogs,
  listEmailEvents,
  acknowledgementTemplate,
  findChecklist,
  WORKFLOW_STATES
};
