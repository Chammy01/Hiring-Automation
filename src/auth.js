const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { config } = require('./config');
const { readStore, updateStore } = require('./store');
const { nowIso } = require('./utils');

const AUTH_ROLES = new Set(['admin', 'hr', 'developer']);
const PASSWORD_POLICY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{12,}$/;

function issueJwtToken(user) {
  return jwt.sign(
    {
      sub: user.username,
      role: user.role,
      typ: 'auth'
    },
    config.jwtSecret,
    { expiresIn: '24h' }
  );
}

function verifyJwtToken(token) {
  return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
}

function hashPassword(password) {
  const rounds = Number.isFinite(config.bcryptRounds) ? Math.max(10, Math.min(15, config.bcryptRounds)) : 12;
  return bcrypt.hash(String(password), rounds);
}

function verifyPassword(password, hash) {
  return bcrypt.compare(String(password), hash);
}

function sanitizeUser(user) {
  return {
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function validateRole(role) {
  const normalized = String(role || '').trim().toLowerCase();
  if (!AUTH_ROLES.has(normalized)) {
    throw new Error('Role must be one of: admin, hr, developer');
  }
  return normalized;
}

function validateUsername(username) {
  const normalized = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(normalized)) {
    throw new Error('Username must be 3-64 chars and only include letters, numbers, dot, underscore, or hyphen');
  }
  return normalized;
}

function validatePasswordStrength(password) {
  if (!PASSWORD_POLICY.test(String(password || ''))) {
    throw new Error('Password must be at least 12 chars and include uppercase, lowercase, number, and symbol');
  }
}

function logAuthEvent(state, action, metadata = {}) {
  state.auditLogs.push({
    id: crypto.randomUUID(),
    timestamp: nowIso(),
    action,
    candidateId: null,
    metadata
  });
}

async function registerUser({ username, password, role }, metadata = {}) {
  const normalizedUsername = validateUsername(username);
  const normalizedRole = validateRole(role);
  validatePasswordStrength(password);
  const passwordHash = await hashPassword(password);
  let created;
  updateStore((state) => {
    if (state.users.some((user) => user.username === normalizedUsername)) {
      throw new Error('Username already exists');
    }
    const now = nowIso();
    created = {
      username: normalizedUsername,
      role: normalizedRole,
      passwordHash,
      createdAt: now,
      updatedAt: now
    };
    state.users.push(created);
    logAuthEvent(state, 'auth.user.created', { username: normalizedUsername, role: normalizedRole, ...metadata });
    return state;
  });
  return sanitizeUser(created);
}

function listUsers() {
  const state = readStore();
  return state.users.map(sanitizeUser);
}

function deleteUser(username, metadata = {}) {
  const normalizedUsername = validateUsername(username);
  let removed = null;
  updateStore((state) => {
    const index = state.users.findIndex((user) => user.username === normalizedUsername);
    if (index < 0) {
      throw new Error('User not found');
    }
    [removed] = state.users.splice(index, 1);
    logAuthEvent(state, 'auth.user.deleted', { username: normalizedUsername, ...metadata });
    return state;
  });
  return sanitizeUser(removed);
}

async function changeUserPassword(username, password, metadata = {}) {
  const normalizedUsername = validateUsername(username);
  validatePasswordStrength(password);
  const nextHash = await hashPassword(password);
  let updated = null;
  updateStore((state) => {
    const user = state.users.find((item) => item.username === normalizedUsername);
    if (!user) {
      throw new Error('User not found');
    }
    user.passwordHash = nextHash;
    user.updatedAt = nowIso();
    updated = user;
    logAuthEvent(state, 'auth.user.password_changed', { username: normalizedUsername, ...metadata });
    return state;
  });
  return sanitizeUser(updated);
}

async function authenticateUser(username, password) {
  const normalizedUsername = validateUsername(username);
  const state = readStore();
  const user = state.users.find((item) => item.username === normalizedUsername);
  if (!user) return null;
  const matches = await verifyPassword(password, user.passwordHash);
  if (!matches) return null;
  return sanitizeUser(user);
}

function recordAuthEvent(action, metadata = {}) {
  updateStore((state) => {
    logAuthEvent(state, action, metadata);
    return state;
  });
}

function createCsrfToken() {
  return crypto.randomBytes(24).toString('base64url');
}

module.exports = {
  PASSWORD_POLICY,
  AUTH_ROLES,
  issueJwtToken,
  verifyJwtToken,
  validateRole,
  validatePasswordStrength,
  registerUser,
  listUsers,
  deleteUser,
  changeUserPassword,
  authenticateUser,
  recordAuthEvent,
  createCsrfToken
};
