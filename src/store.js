const fs = require('node:fs');
const path = require('node:path');
const { config } = require('./config');
const { DEFAULT_TEMPLATES, SCORING_WEIGHTS } = require('./constants');

function makeDefaultAppSettings() {
  return {
    hiringDeadline: '',
    companyEmail: config.fromEmail,
    mailboxAddress: config.mailboxAddress,
    companyName: '',
    replyToEmail: '',
    hiringManagerName: '',
    applicationOpenDate: '',
    timezone: 'Asia/Manila',
    autoResponseSubject: 'Application Received: {{position}}',
    interviewWindowStart: '08:00',
    interviewWindowEnd: '17:00',
    maxApplicationsPerRole: 0,
    allowedFileTypes: 'pdf,doc,docx',
    maxUploadSizeMb: 10,
    notifyNewApplication: true,
    reminderCadenceDays: 3,
    careerPageBanner: '',
    defaultJobVisibility: 'public',
    dataRetentionDays: 365
  };
}

const initialState = {
  candidates: [],
  emailEvents: [],
  auditLogs: [],
  retryQueue: [],
  extractionQueue: [],
  verificationQueue: [],
  outboundDispatches: [],
  parsingJobs: [],
  templates: { ...DEFAULT_TEMPLATES },
  settings: {
    scoringWeights: { ...SCORING_WEIGHTS },
    appSettings: makeDefaultAppSettings(),
    integrations: {
      googleSheets: {
        spreadsheetId: '',
        spreadsheetUrl: '',
        lastSyncedAt: '',
        lastError: ''
      }
    }
  }
};

function normalizeState(state = {}) {
  const googleSheetsState = (((state.settings || {}).integrations || {}).googleSheets || {});
  const storedAppSettings = (state.settings && state.settings.appSettings) || {};
  const defaults = makeDefaultAppSettings();
  return {
    candidates: Array.isArray(state.candidates) ? state.candidates : [],
    emailEvents: Array.isArray(state.emailEvents) ? state.emailEvents : [],
    auditLogs: Array.isArray(state.auditLogs) ? state.auditLogs : [],
    retryQueue: Array.isArray(state.retryQueue) ? state.retryQueue : [],
    extractionQueue: Array.isArray(state.extractionQueue) ? state.extractionQueue : [],
    verificationQueue: Array.isArray(state.verificationQueue) ? state.verificationQueue : [],
    outboundDispatches: Array.isArray(state.outboundDispatches) ? state.outboundDispatches : [],
    parsingJobs: Array.isArray(state.parsingJobs) ? state.parsingJobs : [],
    templates: {
      ...DEFAULT_TEMPLATES,
      ...(state.templates || {})
    },
    settings: {
      scoringWeights: {
        ...SCORING_WEIGHTS,
        ...((state.settings && state.settings.scoringWeights) || {})
      },
      appSettings: {
        ...defaults,
        ...storedAppSettings
      },
      integrations: {
        googleSheets: {
          spreadsheetId: googleSheetsState.spreadsheetId || '',
          spreadsheetUrl: googleSheetsState.spreadsheetUrl || '',
          lastSyncedAt: googleSheetsState.lastSyncedAt || '',
          lastError: googleSheetsState.lastError || ''
        }
      }
    }
  };
}

function ensureStore() {
  const absPath = path.resolve(config.dataFile);
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(absPath)) {
    fs.writeFileSync(absPath, JSON.stringify(initialState, null, 2));
  }
  return absPath;
}

function readStore() {
  const absPath = ensureStore();
  const data = fs.readFileSync(absPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch (_err) {
    console.error('[store] store.json is corrupted — resetting to initial state');
    return normalizeState({});
  }
  return normalizeState(parsed);
}

function writeStore(state) {
  const absPath = ensureStore();
  fs.writeFileSync(absPath, JSON.stringify(state, null, 2));
}

function updateStore(updater) {
  const state = readStore();
  const next = updater(state) || state;
  const result = next.__result;
  if (Object.prototype.hasOwnProperty.call(next, '__result')) {
    delete next.__result;
  }
  writeStore(next);
  if (result !== undefined) {
    next.__result = result;
  }
  return next;
}

module.exports = {
  readStore,
  writeStore,
  updateStore,
  initialState,
  normalizeState,
  makeDefaultAppSettings
};
