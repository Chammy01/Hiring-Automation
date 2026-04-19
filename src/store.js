const fs = require('node:fs');
const path = require('node:path');
const { config } = require('./config');
const { DEFAULT_TEMPLATES, SCORING_WEIGHTS } = require('./constants');

const initialState = {
  candidates: [],
  emailEvents: [],
  auditLogs: [],
  retryQueue: [],
  extractionQueue: [],
  verificationQueue: [],
  templates: { ...DEFAULT_TEMPLATES },
  settings: {
    scoringWeights: { ...SCORING_WEIGHTS },
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
  return {
    candidates: Array.isArray(state.candidates) ? state.candidates : [],
    emailEvents: Array.isArray(state.emailEvents) ? state.emailEvents : [],
    auditLogs: Array.isArray(state.auditLogs) ? state.auditLogs : [],
    retryQueue: Array.isArray(state.retryQueue) ? state.retryQueue : [],
    extractionQueue: Array.isArray(state.extractionQueue) ? state.extractionQueue : [],
    verificationQueue: Array.isArray(state.verificationQueue) ? state.verificationQueue : [],
    templates: {
      ...DEFAULT_TEMPLATES,
      ...(state.templates || {})
    },
    settings: {
      scoringWeights: {
        ...SCORING_WEIGHTS,
        ...((state.settings && state.settings.scoringWeights) || {})
      },
      integrations: {
        googleSheets: {
          spreadsheetId:
            (((state.settings || {}).integrations || {}).googleSheets || {}).spreadsheetId || '',
          spreadsheetUrl:
            (((state.settings || {}).integrations || {}).googleSheets || {}).spreadsheetUrl || '',
          lastSyncedAt:
            (((state.settings || {}).integrations || {}).googleSheets || {}).lastSyncedAt || '',
          lastError:
            (((state.settings || {}).integrations || {}).googleSheets || {}).lastError || ''
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
  return normalizeState(JSON.parse(data));
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
  normalizeState
};
