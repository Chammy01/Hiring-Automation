const crypto = require('node:crypto');
const { readStore, updateStore, normalizeState } = require('./store');
const {
  WORKFLOW_STATES,
  TRANSITIONS,
  POSITION_CHECKLISTS,
  DEFAULT_REQUIRED_DOCUMENTS,
  SCORING_WEIGHTS,
  SCORING_MULTIPLIERS,
  EMAIL_STATUSES,
  DEFAULT_TEMPLATES
} = require('./constants');
const { config } = require('./config');
const { encryptText, decryptText } = require('./security');
const { upsertCandidateSheetRows } = require('./integrations/googleSheets');
const { classifyDocument } = require('./docClassifier');

function nowIso() {
  return new Date().toISOString();
}

let googleSheetsSyncTimeout = null;
let latestGoogleSheetsSyncReason = '';

function getGoogleSheetsState(state) {
  return (((state.settings || {}).integrations || {}).googleSheets || {});
}

function getIntegrationsStatus() {
  const state = readStore();
  const googleSheetsState = getGoogleSheetsState(state);
  const spreadsheetId = googleSheetsState.spreadsheetId || config.googleSheetsSpreadsheetId;
  const spreadsheetUrl =
    googleSheetsState.spreadsheetUrl ||
    (spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}` : '');
  return {
    googleSheets: {
      enabled: config.googleSheetsEnabled,
      configured: Boolean(config.googleSheetsCredentialsJson),
      spreadsheetId,
      spreadsheetUrl,
      autoCreateSpreadsheet: !spreadsheetId,
      lastSyncedAt: googleSheetsState.lastSyncedAt || '',
      lastError: googleSheetsState.lastError || ''
    },
    upgrades: [
      { key: 'gmail_dispatch', label: 'Gmail inbox + outbound dispatcher', status: 'planned' },
      { key: 'postgres_storage', label: 'PostgreSQL persistence', status: 'planned' },
      { key: 'ocr_pipeline', label: 'OCR + document parsing workers', status: 'planned' }
    ]
  };
}

function toSheetRowsFromCandidates(candidates = []) {
  return candidates.map((candidate) => ({
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

async function syncGoogleSheets(reason = 'manual') {
  if (!config.googleSheetsEnabled) {
    return { synced: false, reason: 'Google Sheets integration is disabled' };
  }

  const snapshot = readStore();
  const googleSheetsState = getGoogleSheetsState(snapshot);
  const currentSpreadsheetId = googleSheetsState.spreadsheetId || config.googleSheetsSpreadsheetId || '';
  const rows = toSheetRowsFromCandidates(snapshot.candidates || []);

  try {
    const result = await upsertCandidateSheetRows({
      rows,
      spreadsheetId: currentSpreadsheetId,
      spreadsheetTitle: config.googleSheetsTitle
    });
    updateStore((state) => {
      state.settings.integrations.googleSheets = {
        ...state.settings.integrations.googleSheets,
        spreadsheetId: result.spreadsheetId,
        spreadsheetUrl: result.spreadsheetUrl,
        lastSyncedAt: nowIso(),
        lastError: ''
      };
      addAuditLog(state, 'integration.google_sheets_synced', null, { reason, rowCount: rows.length });
      return state;
    });
    return { synced: true, spreadsheetId: result.spreadsheetId, spreadsheetUrl: result.spreadsheetUrl };
  } catch (error) {
    updateStore((state) => {
      state.settings.integrations.googleSheets = {
        ...state.settings.integrations.googleSheets,
        lastError: error.message,
        lastSyncedAt: state.settings.integrations.googleSheets.lastSyncedAt || ''
      };
      addAuditLog(state, 'integration.google_sheets_sync_failed', null, { reason, error: error.message });
      return state;
    });
    return { synced: false, error: error.message };
  }
}

function triggerGoogleSheetsSync(reason) {
  if (!config.googleSheetsEnabled) {
    return;
  }
  latestGoogleSheetsSyncReason = reason;
  if (googleSheetsSyncTimeout) {
    clearTimeout(googleSheetsSyncTimeout);
  }
  googleSheetsSyncTimeout = setTimeout(() => {
    const reasonToSync = latestGoogleSheetsSyncReason;
    latestGoogleSheetsSyncReason = '';
    googleSheetsSyncTimeout = null;
    syncGoogleSheets(`auto:${reasonToSync}`).catch((error) => {
      console.error('Google Sheets sync failed:', error.message);
    });
  }, 1500);
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

function queueEmailEvent(state, eventInput) {
  const event = {
    id: crypto.randomUUID(),
    timestamp: nowIso(),
    candidateId: eventInput.candidateId || null,
    direction: eventInput.direction || 'outbound',
    to: eventInput.to || null,
    from: eventInput.from || config.fromEmail,
    subject: eventInput.subject,
    bodyEncrypted: encryptText(eventInput.body || ''),
    status: eventInput.simulateFailure ? EMAIL_STATUSES.FAILED : EMAIL_STATUSES.SENT,
    retries: Number(eventInput.retries || 0),
    lastError: eventInput.simulateFailure ? 'Simulated send failure' : ''
  };
  state.emailEvents.push(event);

  if (event.status === EMAIL_STATUSES.FAILED) {
    state.retryQueue.push({
      id: crypto.randomUUID(),
      emailEventId: event.id,
      timestamp: nowIso(),
      status: 'pending',
      error: event.lastError
    });
  }

  return event;
}

function decryptEmailEvent(event) {
  return {
    ...event,
    body: decryptText(event.bodyEncrypted)
  };
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

function renderTemplate(templateKey, vars = {}, templates = DEFAULT_TEMPLATES) {
  const source = templates[templateKey] || '';
  return source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => String(vars[key] || ''));
}

function acknowledgementTemplate(deadline, templates = DEFAULT_TEMPLATES) {
  return renderTemplate('acknowledgement', { deadline }, templates);
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
  const result = updateStore((state) => {
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
    const ackBody = acknowledgementTemplate(config.defaultDeadline, state.templates);
    const event = queueEmailEvent(state, {
      candidateId: candidate.id,
      to: candidate.email,
      subject: ackSubject,
      body: ackBody,
      simulateFailure: Boolean(payload.simulateAckFailure)
    });
    candidate.emailSent = event.status === EMAIL_STATUSES.SENT;

    state.candidates.push(candidate);
    addAuditLog(state, 'candidate.created', candidate.id, { source: 'email_intake' });
    addAuditLog(state, 'email.ack_sent', candidate.id, { subject: ackSubject, status: event.status });

    state.__result = { duplicate: false, candidate, ackStatus: event.status };
    return state;
  }).__result;
  triggerGoogleSheetsSync('candidate.created');
  return result;
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
  const result = updateStore((state) => {
    const candidate = state.candidates.find((x) => x.id === candidateId);
    if (!candidate) {
      throw new Error('Candidate not found');
    }

    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    const invalidAttachments = new Set(
      (Array.isArray(payload.invalidAttachments) ? payload.invalidAttachments : []).map((x) => normalize(x))
    );

    for (const requiredDoc of candidate.requiredDocuments) {
      const matches = attachments.filter((attachment) => attachmentMatchesDoc(attachment, requiredDoc));
      if (matches.length === 0) {
        candidate.documentStatus[requiredDoc] = 'missing';
      } else if (matches.some((m) => invalidAttachments.has(normalize(m)))) {
        candidate.documentStatus[requiredDoc] = 'invalid';
      } else {
        candidate.documentStatus[requiredDoc] = 'received';
      }
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
      candidate.statusOfApplication = 'Documents Pending';
      const missing = Object.entries(candidate.documentStatus)
        .filter(([, status]) => status !== 'received')
        .map(([docName, status]) => `${docName} (${status})`);
      const body = renderTemplate(
        'missingDocs',
        {
          fullName: candidate.fullName,
          deadline: config.defaultDeadline,
          missingList: missing.join('\n')
        },
        state.templates
      );
      queueEmailEvent(state, {
        candidateId: candidate.id,
        to: candidate.email,
        subject: 'Missing Documentary Requirements',
        body
      });
      addAuditLog(state, 'email.missing_docs_sent', candidate.id, { missing });
    }

    candidate.updatedAt = nowIso();
    addAuditLog(state, 'candidate.documents_submitted', candidate.id, {
      attachments,
      invalidAttachments: [...invalidAttachments],
      compliance: candidate.compliance
    });

    state.__result = candidate;
    return state;
  }).__result;
  triggerGoogleSheetsSync('candidate.documents_submitted');
  return result;
}

function extractCandidateProfile(candidateId, payload) {
  const result = updateStore((state) => {
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

    if (candidate.extractionConfidence !== 'high') {
      state.verificationQueue.push({
        id: crypto.randomUUID(),
        candidateId: candidate.id,
        createdAt: nowIso(),
        status: 'pending',
        reason: `Extraction confidence is ${candidate.extractionConfidence}`
      });
    }

    addAuditLog(state, 'candidate.profile_extracted', candidate.id, {
      extractionConfidence: candidate.extractionConfidence
    });

    state.__result = candidate;
    return state;
  }).__result;
  triggerGoogleSheetsSync('candidate.profile_extracted');
  return result;
}

function enqueueExtractionJob(candidateId, files = []) {
  return updateStore((state) => {
    const candidate = state.candidates.find((x) => x.id === candidateId);
    if (!candidate) {
      throw new Error('Candidate not found');
    }
    const job = {
      id: crypto.randomUUID(),
      candidateId,
      files,
      createdAt: nowIso(),
      status: 'queued'
    };
    state.extractionQueue.push(job);
    addAuditLog(state, 'extraction.job_queued', candidateId, { files });
    state.__result = job;
    return state;
  }).__result;
}

function processExtractionJob(jobId, payload = {}) {
  const candidateId = updateStore((state) => {
    const job = state.extractionQueue.find((x) => x.id === jobId);
    if (!job) {
      throw new Error('Job not found');
    }
    job.status = 'completed';
    job.completedAt = nowIso();
    state.__result = job.candidateId;
    return state;
  }).__result;
  return extractCandidateProfile(candidateId, payload);
}

function calculateRecommendation(candidateId) {
  const result = updateStore((state) => {
    const candidate = state.candidates.find((x) => x.id === candidateId);
    if (!candidate) {
      throw new Error('Candidate not found');
    }

    const weights = state.settings.scoringWeights || SCORING_WEIGHTS;
    const docsComplete = Object.values(candidate.documentStatus).every((status) => status === 'received');
    const docsScore = docsComplete ? weights.docsComplete : 0;

    const eligibilityScore =
      candidate.cscEligibility === 'Professional'
        ? weights.eligibility
        : candidate.cscEligibility === 'Sub-Professional'
          ? Math.round(weights.eligibility * 0.8)
          : candidate.cscEligibility === 'PRC' || candidate.cscEligibility === 'Honor Graduate Eligibility'
            ? Math.round(weights.eligibility * 0.7)
            : 0;

    const experienceScore =
      candidate.workExperience === 'More than 3 years'
        ? weights.experience
        : candidate.workExperience === '1-3 years'
          ? Math.round(weights.experience * 0.75)
          : candidate.workExperience === 'Less than 1 year'
            ? Math.round(weights.experience * 0.4)
            : 0;

    const educationScore =
      candidate.educationalAttainment === 'Graduate School'
        ? weights.education
        : candidate.educationalAttainment === 'College Graduate'
          ? Math.round(weights.education * 0.85)
          : candidate.educationalAttainment === 'Senior High School'
            ? Math.round(weights.education * 0.4)
            : 0;

    const trainingsScore =
      candidate.trainings === 'With trainings'
        ? weights.trainings
        : Math.round(weights.trainings * SCORING_MULTIPLIERS.TRAININGS_PARTIAL_CREDIT);
    const awardsScore = candidate.awards === 'With awards' ? weights.awards : 0;

    const total = docsScore + eligibilityScore + experienceScore + educationScore + trainingsScore + awardsScore;

    const rankLabel =
      total >= 85 ? 'Strongly Recommended' : total >= 70 ? 'Recommended' : total >= 50 ? 'Consider' : 'Low Priority';

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
  triggerGoogleSheetsSync('candidate.scored');
  return result;
}

function updateScoringWeights(partialWeights = {}) {
  return updateStore((state) => {
    state.settings.scoringWeights = {
      ...state.settings.scoringWeights,
      ...partialWeights
    };
    addAuditLog(state, 'scoring.weights_updated', null, state.settings.scoringWeights);
    state.__result = state.settings.scoringWeights;
    return state;
  }).__result;
}

function updateCandidateStatus(candidateId, action, payload = {}) {
  const result = updateStore((state) => {
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
      const body = renderTemplate(
        'interviewInvite',
        {
          fullName: candidate.fullName,
          date: payload.date,
          time: payload.time,
          location: payload.meetingLink || payload.venue || ''
        },
        state.templates
      );
      queueEmailEvent(state, {
        candidateId: candidate.id,
        to: candidate.email,
        subject,
        body
      });
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
    } else if (action === 'followUp') {
      const missing = Object.entries(candidate.documentStatus)
        .filter(([, status]) => status !== 'received')
        .map(([doc, status]) => `${doc} (${status})`);
      const body = renderTemplate(
        'missingDocs',
        {
          fullName: candidate.fullName,
          deadline: config.defaultDeadline,
          missingList: missing.join('\n') || 'No missing items recorded.'
        },
        state.templates
      );
      queueEmailEvent(state, {
        candidateId: candidate.id,
        to: candidate.email,
        subject: 'Follow-up: Application Requirements',
        body
      });
      addAuditLog(state, 'candidate.follow_up_sent', candidate.id);
    } else {
      throw new Error('Unsupported action');
    }

    candidate.updatedAt = nowIso();
    state.__result = candidate;
    return state;
  }).__result;
  triggerGoogleSheetsSync(`candidate.${action}`);
  return result;
}

function retryEmailEvent(eventId) {
  return updateStore((state) => {
    const event = state.emailEvents.find((x) => x.id === eventId);
    if (!event) {
      throw new Error('Email event not found');
    }

    event.retries = (event.retries || 0) + 1;
    event.status = EMAIL_STATUSES.SENT;
    event.lastError = '';

    const queueItem = state.retryQueue.find((x) => x.emailEventId === eventId && x.status === 'pending');
    if (queueItem) {
      queueItem.status = 'resolved';
      queueItem.resolvedAt = nowIso();
    }

    addAuditLog(state, 'email.retry_processed', event.candidateId, { eventId });
    state.__result = decryptEmailEvent(event);
    return state;
  }).__result;
}

function processInboundEmail(payload) {
  const subject = String(payload.subject || '').trim();
  const fromEmail = String(payload.fromEmail || '').trim();
  const fromName = String(payload.fromName || fromEmail).trim();
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const body = String(payload.body || '');

  updateStore((state) => {
    queueEmailEvent(state, {
      direction: 'inbound',
      from: fromEmail,
      to: config.mailboxAddress,
      subject,
      body
    });
    state.__result = true;
    return state;
  });

  if (subject.toLowerCase().startsWith('application for ')) {
    const position = subject.slice('Application for '.length).trim();
    const snapshot = readStore();
    const existing = findCandidateByIdentity(snapshot, fromName, fromEmail, position);
    if (!existing) {
      const created = createCandidateFromApplication({
        fullName: fromName,
        email: fromEmail,
        position,
        receivedAt: payload.receivedAt
      });
      return { action: 'candidate_created', candidateId: created.candidate.id };
    }

    if (attachments.length > 0) {
      submitCandidateDocuments(existing.id, {
        attachments,
        subject,
        submittedAt: payload.receivedAt
      });
      return { action: 'documents_processed', candidateId: existing.id };
    }
  }

  const target = readStore().candidates.find((candidate) => normalize(candidate.email) === normalize(fromEmail));
  if (target && /acknowledge|confirmed|confirm/i.test(body)) {
    updateCandidateStatus(target.id, 'confirmInterview');
    return { action: 'acknowledged', candidateId: target.id };
  }

  return { action: 'logged_only' };
}

function mergeDuplicateCandidates(primaryId, duplicateId) {
  const result = updateStore((state) => {
    const primary = state.candidates.find((x) => x.id === primaryId);
    const duplicate = state.candidates.find((x) => x.id === duplicateId);
    if (!primary || !duplicate) {
      throw new Error('Candidate not found');
    }
    if (primary.id === duplicate.id) {
      throw new Error('Cannot merge same candidate');
    }

    for (const doc of duplicate.requiredDocuments) {
      if (!primary.requiredDocuments.includes(doc)) {
        primary.requiredDocuments.push(doc);
        primary.documentStatus[doc] = duplicate.documentStatus[doc] || 'missing';
      } else if (duplicate.documentStatus[doc] === 'received') {
        primary.documentStatus[doc] = 'received';
      }
    }

    primary.specialNote = [primary.specialNote, `Merged duplicate record ${duplicate.id}`].filter(Boolean).join('; ');
    state.candidates = state.candidates.filter((x) => x.id !== duplicate.id);

    addAuditLog(state, 'candidate.duplicate_merged', primary.id, { removedCandidateId: duplicate.id });
    state.__result = primary;
    return state;
  }).__result;
  triggerGoogleSheetsSync('candidate.duplicate_merged');
  return result;
}

function verifyCandidateExtraction(candidateId, updates = {}) {
  const result = updateStore((state) => {
    const candidate = state.candidates.find((x) => x.id === candidateId);
    if (!candidate) {
      throw new Error('Candidate not found');
    }

    const allowed = [
      'educationalAttainment',
      'workExperience',
      'awards',
      'trainings',
      'cscEligibility',
      'specialNote'
    ];

    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        candidate[key] = updates[key];
      }
    }

    const pendingItem = state.verificationQueue.find(
      (item) => item.candidateId === candidateId && item.status === 'pending'
    );
    if (pendingItem) {
      pendingItem.status = 'resolved';
      pendingItem.resolvedAt = nowIso();
    }

    candidate.extractionConfidence = 'high';
    candidate.updatedAt = nowIso();
    addAuditLog(state, 'candidate.extraction_verified', candidateId, { updates });
    state.__result = candidate;
    return state;
  }).__result;
  triggerGoogleSheetsSync('candidate.extraction_verified');
  return result;
}

function listCandidates(filters = {}) {
  const candidates = readStore().candidates;
  return candidates.filter((candidate) => {
    if (filters.position && normalize(candidate.position) !== normalize(filters.position)) {
      return false;
    }
    if (filters.status && normalize(candidate.workflowState) !== normalize(filters.status)) {
      return false;
    }
    return true;
  });
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
      interviewScheduled: state.candidates.filter((x) => x.workflowState === WORKFLOW_STATES.INTERVIEW_SCHEDULED).length,
      retryQueue: state.retryQueue.filter((x) => x.status === 'pending').length,
      verificationQueue: state.verificationQueue.filter((x) => x.status === 'pending').length
    },
    byState,
    topCandidates
  };
}

function toSheetRows() {
  return toSheetRowsFromCandidates(readStore().candidates);
}

function listAuditLogs() {
  return readStore().auditLogs;
}

function listEmailEvents() {
  return readStore().emailEvents.map(decryptEmailEvent);
}

function listRetryQueue() {
  return readStore().retryQueue;
}

function listVerificationQueue() {
  return readStore().verificationQueue;
}

function listExtractionQueue() {
  return readStore().extractionQueue;
}

function getTemplates() {
  return readStore().templates;
}

function updateTemplate(templateKey, content) {
  return updateStore((state) => {
    if (!Object.prototype.hasOwnProperty.call(state.templates, templateKey)) {
      throw new Error('Unknown template key');
    }
    state.templates[templateKey] = String(content);
    addAuditLog(state, 'template.updated', null, { templateKey });
    state.__result = state.templates;
    return state;
  }).__result;
}

function getScoringWeights() {
  return readStore().settings.scoringWeights;
}

function getAnalytics() {
  const state = readStore();
  const total = state.candidates.length;
  const forReview = state.candidates.filter((x) => x.workflowState === WORKFLOW_STATES.FOR_REVIEW).length;
  const docsComplete = state.candidates.filter((x) => Object.values(x.documentStatus).every((v) => v === 'received')).length;
  const interviewConfirmed = state.candidates.filter((x) => x.confirmedAttendance).length;

  const durations = state.candidates
    .filter((x) => x.createdAt && x.updatedAt)
    .map((x) => new Date(x.updatedAt).getTime() - new Date(x.createdAt).getTime())
    .filter((x) => Number.isFinite(x) && x >= 0);

  const avgTimeHours = durations.length
    ? Math.round((durations.reduce((acc, n) => acc + n, 0) / durations.length / 1000 / 60 / 60) * 100) / 100
    : 0;

  return {
    totals: {
      candidates: total,
      forReview,
      docsComplete,
      interviewConfirmed
    },
    rates: {
      completionRate: total ? Math.round((docsComplete / total) * 10000) / 100 : 0,
      forReviewRate: total ? Math.round((forReview / total) * 10000) / 100 : 0
    },
    averageProcessingHours: avgTimeHours
  };
}

function exportBackup() {
  return readStore();
}

function importBackup(payload) {
  const result = updateStore(() => {
    const restored = normalizeState(payload);
    restored.__result = restored;
    return restored;
  }).__result;
  triggerGoogleSheetsSync('backup.restored');
  return result;
}

/**
 * Content-based document ingestion: classifies files by filename + extracted text,
 * then updates candidate document status. Used by the Gmail intake worker.
 *
 * @param {string} candidateId
 * @param {{ submittedAt?: string, subject?: string, files: Array<{fileName:string, text?:string, mimeType?:string}> }} payload
 */
function submitCandidateDocumentsContent(candidateId, payload) {
  const result = updateStore((state) => {
    const candidate = state.candidates.find((x) => x.id === candidateId);
    if (!candidate) {
      throw new Error('Candidate not found');
    }

    const files = Array.isArray(payload.files) ? payload.files : [];
    const classificationResults = [];

    for (const file of files) {
      const classification = classifyDocument(file.fileName, file.text);
      if (classification) {
        classificationResults.push({
          fileName: file.fileName,
          mimeType: file.mimeType || '',
          docName: classification.docName,
          score: classification.score,
          matchedBy: classification.matchedBy
        });
      } else {
        classificationResults.push({
          fileName: file.fileName,
          mimeType: file.mimeType || '',
          docName: null,
          score: 0,
          matchedBy: 'unclassified'
        });
      }
    }

    for (const requiredDoc of candidate.requiredDocuments) {
      const matched = classificationResults.filter((r) => r.docName === requiredDoc);
      if (matched.length > 0) {
        if (!candidate.documentStatus[requiredDoc] || candidate.documentStatus[requiredDoc] !== 'received') {
          candidate.documentStatus[requiredDoc] = 'received';
        }
      }
    }

    if (payload.subject) {
      applyCompliance(candidate, payload.submittedAt, payload.subject);
    }

    const allReceived = Object.values(candidate.documentStatus).every((status) => status === 'received');

    if (candidate.compliance.disqualified) {
      transitionCandidate(candidate, WORKFLOW_STATES.REJECTED);
      candidate.statusOfApplication = 'Disqualified';
      candidate.specialNote = candidate.compliance.reasons.join('; ');
    } else if (allReceived) {
      if (candidate.workflowState === WORKFLOW_STATES.DOCS_PENDING) {
        transitionCandidate(candidate, WORKFLOW_STATES.DOCS_COMPLETE);
        transitionCandidate(candidate, WORKFLOW_STATES.FOR_REVIEW);
        candidate.statusOfApplication = 'For Review';
      }
    } else {
      candidate.statusOfApplication = 'Documents Pending';
    }

    candidate.updatedAt = nowIso();
    addAuditLog(state, 'candidate.documents_content_submitted', candidate.id, {
      fileCount: files.length,
      classified: classificationResults.filter((r) => r.docName).map((r) => ({
        fileName: r.fileName,
        docName: r.docName,
        matchedBy: r.matchedBy
      }))
    });

    state.__result = { candidate, classifications: classificationResults };
    return state;
  }).__result;
  triggerGoogleSheetsSync('candidate.documents_submitted');
  return result;
}

module.exports = {
  createCandidateFromApplication,
  submitCandidateDocuments,
  submitCandidateDocumentsContent,
  extractCandidateProfile,
  enqueueExtractionJob,
  processExtractionJob,
  verifyCandidateExtraction,
  calculateRecommendation,
  updateScoringWeights,
  getScoringWeights,
  updateCandidateStatus,
  retryEmailEvent,
  processInboundEmail,
  mergeDuplicateCandidates,
  listCandidates,
  getCandidate,
  listPositions,
  getDashboard,
  toSheetRows,
  listAuditLogs,
  listEmailEvents,
  listRetryQueue,
  listVerificationQueue,
  listExtractionQueue,
  getTemplates,
  updateTemplate,
  acknowledgementTemplate,
  findChecklist,
  getAnalytics,
  exportBackup,
  importBackup,
  getIntegrationsStatus,
  syncGoogleSheets,
  WORKFLOW_STATES
};
