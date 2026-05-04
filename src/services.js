const crypto = require('node:crypto');
const { readStore, updateStore, normalizeState, makeDefaultAppSettings } = require('./store');
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
const { nowIso } = require('./utils');
const { upsertCandidateSheetRows } = require('./integrations/googleSheets');
const { classifyDocument } = require('./docClassifier');
const { enqueueDispatch, sendDispatch, getDispatch, listDispatches } = require('./integrations/gmail-dispatcher');
const { enqueueParsingJob, processParsingJob, getParsingJob, listParsingJobs, enrichCandidateFromFields } = require('./workers/doc-parser');

let googleSheetsSyncTimeout = null;
let latestGoogleSheetsSyncReason = '';

function getGoogleSheetsState(state) {
  return (((state.settings || {}).integrations || {}).googleSheets || {});
}

function getStateAppSettings(state) {
  return Object.assign({}, makeDefaultAppSettings(), (state.settings && state.settings.appSettings) || {});
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
      { key: 'gmail_dispatch', label: 'Gmail inbox + outbound dispatcher', status: config.gmailDispatchEnabled ? 'active' : 'configured' },
      { key: 'postgres_storage', label: 'PostgreSQL persistence', status: config.postgresEnabled ? 'active' : 'configured' },
      { key: 'ocr_pipeline', label: 'OCR + document parsing workers', status: config.ocrEnabled ? 'active' : 'configured' }
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
  const appSettings = getStateAppSettings(state);
  const event = {
    id: crypto.randomUUID(),
    timestamp: nowIso(),
    candidateId: eventInput.candidateId || null,
    direction: eventInput.direction || 'outbound',
    to: eventInput.to || null,
    from: eventInput.from || appSettings.companyEmail,
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
  let result;
  updateStore((state) => {
    const duplicate = findCandidateByIdentity(state, payload.fullName, payload.email, payload.position);
    if (duplicate) {
      addAuditLog(state, 'candidate.duplicate_skipped', duplicate.id, {
        fullName: payload.fullName,
        email: payload.email,
        position: payload.position
      });
      result = { duplicate: true, candidate: duplicate };
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
      notes: [],
      createdAt: receivedAt.toISOString(),
      updatedAt: receivedAt.toISOString()
    };

    transitionCandidate(candidate, WORKFLOW_STATES.ACK_SENT);
    transitionCandidate(candidate, WORKFLOW_STATES.DOCS_PENDING);

    const appSettings = getStateAppSettings(state);
    const ackSubject = `Application Received: ${candidate.position}`;
    const ackBody = acknowledgementTemplate(appSettings.hiringDeadline, state.templates);
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

    result = { duplicate: false, candidate, ackStatus: event.status };
    return state;
  });
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

function applyCompliance(candidate, submittedAt, subject, deadline) {
  const expectedSubject = `Application for ${candidate.position}`;

  // Build a valid deadline date only when the deadline string is non-empty and parseable.
  const rawDeadline = deadline || config.defaultDeadline;
  const deadlineDate = rawDeadline ? new Date(rawDeadline) : null;
  const deadlineIsValid = deadlineDate && !isNaN(deadlineDate.getTime());

  const actualDate = submittedAt ? new Date(submittedAt) : new Date();

  candidate.compliance.subjectFormatValid = subject.toLowerCase() === expectedSubject.toLowerCase();
  // When no deadline is configured, the submission-timing check always passes.
  candidate.compliance.submittedBeforeDeadline = !deadlineIsValid || actualDate <= deadlineDate;
  candidate.compliance.disqualified =
    !candidate.compliance.subjectFormatValid || !candidate.compliance.submittedBeforeDeadline;

  const reasons = [];
  if (!candidate.compliance.subjectFormatValid) {
    reasons.push(`Invalid subject format. Expected \"${expectedSubject}\"`);
  }
  if (!candidate.compliance.submittedBeforeDeadline) {
    reasons.push(`Submitted after deadline ${deadlineDate.toISOString()}`);
  }
  candidate.compliance.reasons = reasons;
}

function submitCandidateDocuments(candidateId, payload) {
  let result;
  updateStore((state) => {
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

    applyCompliance(candidate, payload.submittedAt, payload.subject, getStateAppSettings(state).hiringDeadline);

    const allReceived = Object.values(candidate.documentStatus).every((status) => status === 'received');

    // Only attempt transitions that are valid from the current state to avoid
    // crashing on idempotent re-submissions (item 8).
    const DOCS_COMPLETE_STATES = new Set([
      WORKFLOW_STATES.DOCS_COMPLETE,
      WORKFLOW_STATES.FOR_REVIEW,
      WORKFLOW_STATES.SHORTLISTED,
      WORKFLOW_STATES.INTERVIEW_SCHEDULED,
      WORKFLOW_STATES.HIRED
    ]);

    if (candidate.compliance.disqualified) {
      if (candidate.workflowState !== WORKFLOW_STATES.REJECTED) {
        transitionCandidate(candidate, WORKFLOW_STATES.REJECTED);
      }
      candidate.statusOfApplication = 'Disqualified';
      candidate.specialNote = candidate.compliance.reasons.join('; ');
    } else if (allReceived) {
      if (!DOCS_COMPLETE_STATES.has(candidate.workflowState)) {
        transitionCandidate(candidate, WORKFLOW_STATES.DOCS_COMPLETE);
        transitionCandidate(candidate, WORKFLOW_STATES.FOR_REVIEW);
      }
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
          deadline: getStateAppSettings(state).hiringDeadline,
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

    result = candidate;
    return state;
  });
  triggerGoogleSheetsSync('candidate.documents_submitted');
  return result;
}

function extractCandidateProfile(candidateId, payload) {
  let result;
  updateStore((state) => {
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

    result = candidate;
    return state;
  });
  triggerGoogleSheetsSync('candidate.profile_extracted');
  return result;
}

function enqueueExtractionJob(candidateId, files = []) {
  let job;
  updateStore((state) => {
    const candidate = state.candidates.find((x) => x.id === candidateId);
    if (!candidate) {
      throw new Error('Candidate not found');
    }
    job = {
      id: crypto.randomUUID(),
      candidateId,
      files,
      createdAt: nowIso(),
      status: 'queued'
    };
    state.extractionQueue.push(job);
    addAuditLog(state, 'extraction.job_queued', candidateId, { files });
    return state;
  });
  return job;
}

function processExtractionJob(jobId, payload = {}) {
  let candidateId;
  updateStore((state) => {
    const job = state.extractionQueue.find((x) => x.id === jobId);
    if (!job) {
      throw new Error('Job not found');
    }
    job.status = 'completed';
    job.completedAt = nowIso();
    candidateId = job.candidateId;
    return state;
  });
  return extractCandidateProfile(candidateId, payload);
}

function calculateRecommendation(candidateId) {
  let result;
  updateStore((state) => {
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

    result = candidate.recommendation;
    return state;
  });
  triggerGoogleSheetsSync('candidate.scored');
  return result;
}

function updateScoringWeights(partialWeights = {}) {
  let result;
  updateStore((state) => {
    const updated = {
      ...state.settings.scoringWeights,
      ...partialWeights
    };
    const sum = Object.values(updated).reduce((acc, n) => acc + n, 0);
    if (sum !== 100) {
      throw new Error(`Scoring weights must sum to 100 (current total: ${sum})`);
    }
    state.settings.scoringWeights = updated;
    addAuditLog(state, 'scoring.weights_updated', null, state.settings.scoringWeights);
    result = state.settings.scoringWeights;
    return state;
  });
  return result;
}

function updateCandidateStatus(candidateId, action, payload = {}) {
  let result;
  updateStore((state) => {
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
          deadline: getStateAppSettings(state).hiringDeadline,
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
    result = candidate;
    return state;
  });
  triggerGoogleSheetsSync(`candidate.${action}`);
  return result;
}

function retryEmailEvent(eventId) {
  // Collect enough data to attempt the resend before mutating state.
  let decrypted;
  updateStore((state) => {
    const event = state.emailEvents.find((x) => x.id === eventId);
    if (!event) {
      throw new Error('Email event not found');
    }
    decrypted = decryptEmailEvent(event);
    return state;
  });

  // Attempt the actual re-send via the outbound dispatcher (item 5).
  // When Gmail dispatch is not configured this enqueues the message and marks
  // it as 'queued'; a real send attempt is made when it is.
  let sendError = '';
  try {
    enqueueDispatch({
      to: decrypted.to,
      from: decrypted.from,
      subject: decrypted.subject,
      body: decrypted.body,
      candidateId: decrypted.candidateId
    });
  } catch (err) {
    sendError = err.message || String(err);
    console.error('[retryEmailEvent] Re-send failed:', sendError);
  }

  // Update event status based on whether dispatch was queued successfully.
  let result;
  updateStore((state) => {
    const event = state.emailEvents.find((x) => x.id === eventId);
    if (!event) return state;

    event.retries = (event.retries || 0) + 1;
    event.lastError = sendError;
    event.status = sendError ? EMAIL_STATUSES.FAILED : EMAIL_STATUSES.SENT;

    const queueItem = state.retryQueue.find((x) => x.emailEventId === eventId && x.status === 'pending');
    if (queueItem && !sendError) {
      queueItem.status = 'resolved';
      queueItem.resolvedAt = nowIso();
    }

    addAuditLog(state, 'email.retry_processed', event.candidateId, { eventId, sendError });
    result = decryptEmailEvent(event);
    return state;
  });
  return result;
}

function processInboundEmail(payload) {
  const subject = String(payload.subject || '').trim();
  const fromEmail = String(payload.fromEmail || '').trim();
  const fromName = String(payload.fromName || fromEmail).trim();
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const body = String(payload.body || '');

  // Log the inbound email event in a single store write; read state once.
  let snapshot;
  updateStore((state) => {
    queueEmailEvent(state, {
      direction: 'inbound',
      from: fromEmail,
      to: getStateAppSettings(state).mailboxAddress,
      subject,
      body
    });
    // Capture the full candidate list here to avoid a separate readStore() call
    // after this write (item 6 — read-after-update inconsistency).
    snapshot = state.candidates.slice();
    return state;
  });

  if (subject.toLowerCase().startsWith('application for ')) {
    const position = subject.slice('Application for '.length).trim();
    const existing = findCandidateByIdentity({ candidates: snapshot }, fromName, fromEmail, position);
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

  const target = snapshot.find((candidate) => normalize(candidate.email) === normalize(fromEmail));
  if (target && /acknowledge|confirmed|confirm/i.test(body)) {
    updateCandidateStatus(target.id, 'confirmInterview');
    return { action: 'acknowledged', candidateId: target.id };
  }

  return { action: 'logged_only' };
}

function mergeDuplicateCandidates(primaryId, duplicateId) {
  let result;
  updateStore((state) => {
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
    result = primary;
    return state;
  });
  triggerGoogleSheetsSync('candidate.duplicate_merged');
  return result;
}

function verifyCandidateExtraction(candidateId, updates = {}) {
  let result;
  updateStore((state) => {
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
    result = candidate;
    return state;
  });
  triggerGoogleSheetsSync('candidate.extraction_verified');
  return result;
}

function listCandidates(filters = {}) {
  const candidates = readStore().candidates;
  const archived = filters.archived === true || filters.archived === 'true';
  return candidates.filter((candidate) => {
    if (Boolean(candidate.isArchived) !== archived) return false;
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
  // Exclude archived candidates from all dashboard metrics (item 20).
  const active = state.candidates.filter((c) => !c.isArchived);
  const byState = active.reduce((acc, candidate) => {
    acc[candidate.workflowState] = (acc[candidate.workflowState] || 0) + 1;
    return acc;
  }, {});

  const topCandidates = [...active]
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
      candidates: active.length,
      disqualified: active.filter((x) => x.compliance.disqualified).length,
      interviewScheduled: active.filter((x) => x.workflowState === WORKFLOW_STATES.INTERVIEW_SCHEDULED).length,
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
  let result;
  updateStore((state) => {
    if (!Object.prototype.hasOwnProperty.call(state.templates, templateKey)) {
      throw new Error('Unknown template key');
    }
    state.templates[templateKey] = String(content);
    addAuditLog(state, 'template.updated', null, { templateKey });
    result = state.templates;
    return state;
  });
  return result;
}

function getScoringWeights() {
  return readStore().settings.scoringWeights;
}

function getAnalytics() {
  const state = readStore();
  // Exclude archived candidates from analytics (item 20).
  const active = state.candidates.filter((c) => !c.isArchived);
  const total = active.length;
  const forReview = active.filter((x) => x.workflowState === WORKFLOW_STATES.FOR_REVIEW).length;
  const docsComplete = active.filter((x) => Object.values(x.documentStatus).every((v) => v === 'received')).length;
  const interviewConfirmed = active.filter((x) => x.confirmedAttendance).length;

  const durations = active
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

/**
 * Validate backup candidate records before import to prevent malformed data
 * from crashing subsequent operations (item 9).
 */
function validateBackupPayload(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Backup payload must be a plain object');
  }
  if (payload.candidates !== undefined && !Array.isArray(payload.candidates)) {
    throw new Error('Backup payload.candidates must be an array');
  }
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (typeof c !== 'object' || c === null) {
      throw new Error(`Candidate at index ${i} must be an object`);
    }
    if (typeof c.id !== 'string' || !c.id) {
      throw new Error(`Candidate at index ${i} is missing a valid "id" field`);
    }
    if (typeof c.fullName !== 'string' || !c.fullName) {
      throw new Error(`Candidate at index ${i} is missing a valid "fullName" field`);
    }
    if (typeof c.email !== 'string' || !c.email) {
      throw new Error(`Candidate at index ${i} is missing a valid "email" field`);
    }
  }
}

function importBackup(payload) {
  validateBackupPayload(payload);
  let result;
  updateStore(() => {
    const restored = normalizeState(payload);
    result = restored;
    return restored;
  });
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
  let result;
  updateStore((state) => {
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
        if (candidate.documentStatus[requiredDoc] !== 'received') {
          candidate.documentStatus[requiredDoc] = 'received';
        }
      }
    }

    if (payload.subject) {
      applyCompliance(candidate, payload.submittedAt, payload.subject, getStateAppSettings(state).hiringDeadline);
    }

    const allReceived = Object.values(candidate.documentStatus).every((status) => status === 'received');

    if (candidate.compliance.disqualified) {
      if (candidate.workflowState !== WORKFLOW_STATES.REJECTED) {
        transitionCandidate(candidate, WORKFLOW_STATES.REJECTED);
      }
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

    result = { candidate, classifications: classificationResults };
    return state;
  });
  triggerGoogleSheetsSync('candidate.documents_submitted');
  return result;
}

function getAppSettings() {
  return readStore().settings.appSettings;
}

const ALLOWED_APP_SETTINGS_KEYS = [
  'hiringDeadline',
  'companyEmail',
  'mailboxAddress',
  'companyName',
  'replyToEmail',
  'hiringManagerName',
  'applicationOpenDate',
  'timezone',
  'autoResponseSubject',
  'interviewWindowStart',
  'interviewWindowEnd',
  'maxApplicationsPerRole',
  'allowedFileTypes',
  'maxUploadSizeMb',
  'notifyNewApplication',
  'reminderCadenceDays',
  'careerPageBanner',
  'defaultJobVisibility',
  'dataRetentionDays'
];

function updateAppSettings(updates = {}) {
  let result;
  updateStore((state) => {
    const current = state.settings.appSettings || makeDefaultAppSettings();
    const next = { ...current };
    for (const key of ALLOWED_APP_SETTINGS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        next[key] = updates[key];
      }
    }
    state.settings.appSettings = next;
    addAuditLog(state, 'settings.app_settings_updated', null, { keys: Object.keys(updates) });
    result = state.settings.appSettings;
    return state;
  });
  return result;
}

// ─── Gmail outbound dispatch service methods ──────────────────────────────────

/**
 * Queue an outbound email for delivery via the Gmail dispatcher.
 * Falls back gracefully when GMAIL_DISPATCH_ENABLED is false.
 *
 * @param {object} opts  - see gmail-dispatcher.enqueueDispatch
 * @returns {{ dispatch: object }}
 */
function queueOutboundDispatch(opts = {}) {
  return enqueueDispatch(opts);
}

/**
 * Attempt (or retry) sending a queued dispatch.
 * @param {string} dispatchId
 * @returns {Promise<object>}
 */
async function sendOutboundDispatch(dispatchId) {
  return sendDispatch(dispatchId);
}

function getOutboundDispatch(id) {
  return getDispatch(id);
}

function listOutboundDispatches(filters = {}) {
  return listDispatches(filters);
}

// ─── Document parsing service methods ────────────────────────────────────────

/**
 * Enqueue a document parsing job for the async worker.
 *
 * @param {object} opts
 * @param {string}  opts.candidateId
 * @param {string}  opts.fileName
 * @param {string}  [opts.mimeType]
 * @param {string}  [opts.text]        - pre-extracted text (optional)
 * @param {string}  [opts.storageRef]
 * @returns {object} job record
 */
function queueDocumentParsing(opts = {}) {
  return enqueueParsingJob(opts);
}

/**
 * Process a parsing job immediately (synchronous in process).
 * Suitable for API-triggered parsing in development/testing.
 *
 * @param {string} jobId
 * @param {object} [runtimeOpts]
 * @returns {Promise<object>}
 */
async function runDocumentParsing(jobId, runtimeOpts = {}) {
  return processParsingJob(jobId, runtimeOpts);
}

function getDocumentParsingJob(id) {
  return getParsingJob(id);
}

function listDocumentParsingJobs(filters = {}) {
  return listParsingJobs(filters);
}

/**
 * Apply parsing results to enrich a candidate's profile fields.
 * @param {string} candidateId
 * @param {object} fields  - structured fields from parsing result
 * @param {string} confidence
 */
function applyCandidateEnrichment(candidateId, fields = {}, confidence = 'low') {
  enrichCandidateFromFields(candidateId, fields, confidence);
  triggerGoogleSheetsSync('candidate.enriched');
  return readStore().candidates.find((c) => c.id === candidateId) || null;
}

/**
 * Toggle the archived status of a candidate.
 * @param {string} candidateId
 * @param {boolean} [archived] - if omitted, toggles current value
 * @returns {object} updated candidate
 */
function archiveCandidate(candidateId, archived) {
  let result;
  updateStore((state) => {
    const candidate = state.candidates.find((x) => x.id === candidateId);
    if (!candidate) {
      throw new Error('Candidate not found');
    }
    candidate.isArchived = archived !== undefined ? Boolean(archived) : !Boolean(candidate.isArchived);
    candidate.updatedAt = nowIso();
    addAuditLog(state, candidate.isArchived ? 'candidate.archived' : 'candidate.unarchived', candidate.id, {});
    result = candidate;
    return state;
  });
  triggerGoogleSheetsSync('candidate.archived');
  return result;
}

/**
 * Permanently delete a candidate and all in-memory references.
 * @param {string} candidateId
 * @returns {object} deleted candidate
 */
function deleteCandidate(candidateId) {
  let result;
  updateStore((state) => {
    const idx = state.candidates.findIndex((x) => x.id === candidateId);
    if (idx === -1) {
      throw new Error('Candidate not found');
    }
    const [candidate] = state.candidates.splice(idx, 1);

    // Clean up related in-memory queues
    state.emailEvents         = state.emailEvents.filter((e) => e.candidateId !== candidateId);
    state.retryQueue          = state.retryQueue.filter((r) => r.candidateId !== candidateId);
    state.extractionQueue     = state.extractionQueue.filter((q) => q.candidateId !== candidateId);
    state.verificationQueue   = state.verificationQueue.filter((q) => q.candidateId !== candidateId);

    addAuditLog(state, 'candidate.deleted', candidateId, { fullName: candidate.fullName });
    result = candidate;
    return state;
  });
  triggerGoogleSheetsSync('candidate.deleted');
  return result;
}

// ─── Position management ──────────────────────────────────────────────────────

/**
 * List all positions (built-in + custom from store).
 */
function listAllPositions() {
  const state = readStore();
  const builtIn = Object.keys(POSITION_CHECKLISTS).filter((x) => x !== 'default');
  const custom = Array.isArray((state.settings && state.settings.customPositions))
    ? state.settings.customPositions
    : [];
  const all = [...new Set([...builtIn, ...custom.map((p) => p.name)])];
  return all.map((name) => {
    const custom = (state.settings.customPositions || []).find((p) => p.name === name);
    const checklist = custom ? custom.checklist : (POSITION_CHECKLISTS[name] || DEFAULT_REQUIRED_DOCUMENTS);
    return { name, checklist, isCustom: Boolean(custom) };
  });
}

function addPosition(name, checklist) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Position name is required');
  }
  const trimmedName = name.trim();
  if (!Array.isArray(checklist) || checklist.length === 0) {
    throw new Error('Position checklist must be a non-empty array of document names');
  }
  let result;
  updateStore((state) => {
    if (!Array.isArray(state.settings.customPositions)) {
      state.settings.customPositions = [];
    }
    if (state.settings.customPositions.find((p) => p.name === trimmedName)) {
      throw new Error(`Position "${trimmedName}" already exists`);
    }
    const entry = { name: trimmedName, checklist: checklist.map(String) };
    state.settings.customPositions.push(entry);
    addAuditLog(state, 'position.created', null, { name: trimmedName });
    result = entry;
    return state;
  });
  return result;
}

function deletePosition(name) {
  if (POSITION_CHECKLISTS[name]) {
    throw new Error(`Cannot delete built-in position "${name}"`);
  }
  updateStore((state) => {
    if (!Array.isArray(state.settings.customPositions)) {
      throw new Error('Position not found');
    }
    const idx = state.settings.customPositions.findIndex((p) => p.name === name);
    if (idx === -1) {
      throw new Error('Position not found');
    }
    state.settings.customPositions.splice(idx, 1);
    addAuditLog(state, 'position.deleted', null, { name });
    return state;
  });
}

// ─── Candidate notes ──────────────────────────────────────────────────────────

function addCandidateNote(candidateId, { author, content }) {
  if (!content || typeof content !== 'string' || !content.trim()) {
    throw new Error('Note content is required');
  }
  let result;
  updateStore((state) => {
    const candidate = state.candidates.find((x) => x.id === candidateId);
    if (!candidate) {
      throw new Error('Candidate not found');
    }
    if (!Array.isArray(candidate.notes)) {
      candidate.notes = [];
    }
    const note = {
      id: crypto.randomUUID(),
      author: String(author || 'anonymous'),
      content: String(content).trim(),
      createdAt: nowIso()
    };
    candidate.notes.push(note);
    candidate.updatedAt = nowIso();
    addAuditLog(state, 'candidate.note_added', candidateId, { noteId: note.id, author: note.author });
    result = note;
    return state;
  });
  return result;
}

function getCandidateNotes(candidateId) {
  const candidate = readStore().candidates.find((x) => x.id === candidateId);
  if (!candidate) {
    throw new Error('Candidate not found');
  }
  return Array.isArray(candidate.notes) ? candidate.notes : [];
}

// ─── Bulk candidate actions ───────────────────────────────────────────────────

/**
 * Perform an action on multiple candidates.
 * @param {string[]} ids
 * @param {'shortlist'|'reject'|'followUp'} action
 * @param {object} [payload]
 * @returns {{ succeeded: string[], failed: Array<{id, error}> }}
 */
function bulkCandidateAction(ids, action, payload = {}) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('ids must be a non-empty array');
  }
  const BULK_ALLOWED = ['shortlist', 'reject', 'followUp'];
  if (!BULK_ALLOWED.includes(action)) {
    throw new Error(`Bulk action must be one of: ${BULK_ALLOWED.join(', ')}`);
  }

  const succeeded = [];
  const failed = [];

  for (const id of ids) {
    try {
      updateCandidateStatus(id, action, payload);
      succeeded.push(id);
    } catch (err) {
      failed.push({ id, error: err.message });
    }
  }

  return { succeeded, failed };
}

// ─── Webhook support ──────────────────────────────────────────────────────────

const WEBHOOK_EVENTS = [
  'candidate.created',
  'candidate.hired',
  'candidate.rejected',
  'candidate.shortlisted',
  'candidate.documents_submitted'
];

function registerWebhook({ url, events, secret }) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    throw new Error('A valid webhook URL (http/https) is required');
  }
  const subscribedEvents = Array.isArray(events) && events.length > 0
    ? events.filter((e) => WEBHOOK_EVENTS.includes(e))
    : WEBHOOK_EVENTS.slice();

  let result;
  updateStore((state) => {
    if (!Array.isArray(state.settings.webhooks)) {
      state.settings.webhooks = [];
    }
    const hook = {
      id: crypto.randomUUID(),
      url,
      events: subscribedEvents,
      secret: secret || '',
      createdAt: nowIso(),
      active: true
    };
    state.settings.webhooks.push(hook);
    addAuditLog(state, 'webhook.registered', null, { url, events: subscribedEvents });
    result = hook;
    return state;
  });
  return result;
}

function deleteWebhook(hookId) {
  updateStore((state) => {
    if (!Array.isArray(state.settings.webhooks)) {
      throw new Error('Webhook not found');
    }
    const idx = state.settings.webhooks.findIndex((h) => h.id === hookId);
    if (idx === -1) {
      throw new Error('Webhook not found');
    }
    state.settings.webhooks.splice(idx, 1);
    addAuditLog(state, 'webhook.deleted', null, { hookId });
    return state;
  });
}

function listWebhooks() {
  const state = readStore();
  return Array.isArray(state.settings.webhooks) ? state.settings.webhooks : [];
}

/**
 * Emit a webhook event to all registered hooks that subscribe to it.
 * Fires-and-forgets — errors are logged but not thrown.
 *
 * @param {string} event  - one of WEBHOOK_EVENTS
 * @param {object} data   - event payload
 */
function emitWebhook(event, data) {
  const hooks = listWebhooks().filter((h) => h.active && h.events.includes(event));
  if (hooks.length === 0) return;

  const { createHmac } = require('node:crypto');
  const { request: httpRequest } = require('node:https');
  const { request: httpReqHttp } = require('node:http');

  const body = JSON.stringify({ event, data, timestamp: nowIso() });

  for (const hook of hooks) {
    const sig = hook.secret
      ? createHmac('sha256', hook.secret).update(body).digest('hex')
      : '';

    const url = new URL(hook.url);
    const isHttps = url.protocol === 'https:';
    const reqFn = isHttps ? httpRequest : httpReqHttp;
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Hiring-Event': event,
        ...(sig ? { 'X-Hiring-Signature': `sha256=${sig}` } : {})
      }
    };

    const req = reqFn(options, (res) => {
      if (res.statusCode >= 400) {
        console.warn(`[webhook] ${hook.url} responded with ${res.statusCode} for event "${event}"`);
      }
    });
    req.on('error', (err) => {
      console.warn(`[webhook] Failed to deliver "${event}" to ${hook.url}:`, err.message);
    });
    req.write(body);
    req.end();
  }
}

// ─── Reminder automation ──────────────────────────────────────────────────────

let _reminderTimer = null;

/**
 * Send reminder emails to candidates whose documents are still pending, when
 * the hiring deadline is approaching within `reminderCadenceDays` days.
 *
 * This implements item 30 — `reminderCadenceDays` was stored in settings but
 * never used before this change.
 */
function sendDeadlineReminders() {
  const state = readStore();
  const appSettings = getStateAppSettings(state);
  const deadline = appSettings.hiringDeadline;
  const cadenceDays = Number(appSettings.reminderCadenceDays || 3);

  if (!deadline) return { sent: 0, reason: 'no_deadline_configured' };

  const deadlineDate = new Date(deadline);
  if (isNaN(deadlineDate.getTime())) return { sent: 0, reason: 'invalid_deadline' };

  const now = new Date();
  const daysUntilDeadline = (deadlineDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

  if (daysUntilDeadline < 0 || daysUntilDeadline > cadenceDays) {
    return { sent: 0, reason: 'outside_reminder_window' };
  }

  const pendingCandidates = state.candidates.filter(
    (c) =>
      !c.isArchived &&
      c.workflowState === WORKFLOW_STATES.DOCS_PENDING &&
      !c.compliance.disqualified
  );

  let sent = 0;
  for (const candidate of pendingCandidates) {
    const missing = Object.entries(candidate.documentStatus)
      .filter(([, status]) => status !== 'received')
      .map(([doc, status]) => `${doc} (${status})`);

    if (missing.length === 0) continue;

    const body = renderTemplate(
      'missingDocs',
      {
        fullName: candidate.fullName,
        deadline,
        missingList: missing.join('\n')
      },
      state.templates
    );

    updateStore((innerState) => {
      queueEmailEvent(innerState, {
        candidateId: candidate.id,
        to: candidate.email,
        subject: `Reminder: Submit Your Application Requirements Before ${deadline}`,
        body
      });
      addAuditLog(innerState, 'email.deadline_reminder_sent', candidate.id, { daysUntilDeadline: Math.round(daysUntilDeadline) });
      return innerState;
    });
    sent++;
  }

  return { sent };
}

/**
 * Start the auto-reminder scheduler. Checks once per hour whether any
 * reminders should fire. Safe to call multiple times — only one timer runs.
 */
function startReminderScheduler() {
  if (_reminderTimer) return;
  const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  _reminderTimer = setInterval(() => {
    try {
      const result = sendDeadlineReminders();
      if (result.sent > 0) {
        console.log(`[reminder] Sent ${result.sent} deadline reminder(s)`);
      }
    } catch (err) {
      console.error('[reminder] Error sending deadline reminders:', err.message);
    }
  }, CHECK_INTERVAL_MS);
  _reminderTimer.unref(); // don't block process exit
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
  getAppSettings,
  updateAppSettings,
  updateCandidateStatus,
  retryEmailEvent,
  processInboundEmail,
  mergeDuplicateCandidates,
  listCandidates,
  getCandidate,
  listPositions,
  listAllPositions,
  addPosition,
  deletePosition,
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
  addCandidateNote,
  getCandidateNotes,
  bulkCandidateAction,
  registerWebhook,
  deleteWebhook,
  listWebhooks,
  emitWebhook,
  sendDeadlineReminders,
  startReminderScheduler,
  // New: Gmail outbound dispatch
  queueOutboundDispatch,
  sendOutboundDispatch,
  getOutboundDispatch,
  listOutboundDispatches,
  // New: Document parsing
  queueDocumentParsing,
  runDocumentParsing,
  getDocumentParsingJob,
  listDocumentParsingJobs,
  applyCandidateEnrichment,
  archiveCandidate,
  deleteCandidate
};
