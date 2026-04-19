const fs = require('node:fs');
const path = require('node:path');
const { config } = require('./config');

const initialState = {
  candidates: [],
  emailEvents: [],
  auditLogs: []
};

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
  return JSON.parse(data);
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
  updateStore
};
