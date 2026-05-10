'use strict';

/**
 * Gmail outbound dispatcher.
 *
 * Sends queued outbound_dispatch jobs via the Gmail API (OAuth2).
 * Falls back to a no-op "simulated send" when GMAIL_DISPATCH_ENABLED is not true.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const { config } = require('../config');
const { updateStore, readStore } = require('../store');
const { encryptText, decryptText } = require('../security');

// googleapis is a prod dependency — loaded lazily
let google;
try {
  google = require('googleapis').google;
} catch (_) {
  // Optional — only needed when GMAIL_DISPATCH_ENABLED=true
}

// ─── Template rendering ───────────────────────────────────────────────────────

function renderTemplate(template, vars = {}) {
  return String(template || '').replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_match, key) => String(vars[key] != null ? vars[key] : '')
  );
}

// ─── OAuth client ────────────────────────────────────────────────────────────

let _oAuth2Client = null;

function getOAuthClient() {
  if (_oAuth2Client) return _oAuth2Client;

  if (!google) {
    throw new Error('googleapis package is not available — install it or disable GMAIL_DISPATCH_ENABLED');
  }

  // 1. Load Credentials (check Variable, then fallback to File)
  let credentials;
  const credsVar = process.env.GMAIL_CREDENTIALS_JSON;
  if (credsVar) {
    credentials = JSON.parse(credsVar);
  } else if (fs.existsSync(config.gmailCredentialsPath)) {
    credentials = JSON.parse(fs.readFileSync(config.gmailCredentialsPath, 'utf8'));
  } else {
    throw new Error('Gmail credentials not found in variables or file system.');
  }

  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  // 2. Load Token (check Variable, then fallback to File)
  let token;
  const tokenVar = process.env.GMAIL_TOKEN_JSON;
  if (tokenVar) {
    token = JSON.parse(tokenVar);
  } else if (fs.existsSync(config.gmailTokenPath)) {
    token = JSON.parse(fs.readFileSync(config.gmailTokenPath, 'utf8'));
  } else {
    throw new Error('Gmail token not found in variables or file system.');
  }

  oAuth2Client.setCredentials(token);
  _oAuth2Client = oAuth2Client;
  return oAuth2Client;
}

function resetOAuthClient() {
  _oAuth2Client = null;
}

// ─── Build RFC 2822 email ────────────────────────────────────────────────────

function buildRawMessage(to, from, subject, bodyText) {
  const boundary = `----=_Part_${crypto.randomUUID()}`;
  const lines = [
    `To: ${to}`,
    `From: ${from}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    bodyText,
    '',
    `--${boundary}--`
  ];
  const raw = lines.join('\r\n');
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function backoffDelayMs(attempt, baseMs) {
  const jitter = Math.random() * 200;
  return Math.min(baseMs * 2 ** attempt + jitter, 30_000);
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientError(err) {
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  return (
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('rate limit') ||
    msg.includes('quota') ||
    (err.code && [429, 500, 502, 503, 504].includes(Number(err.code)))
  );
}

// ─── Core Send ────────────────────────────────────────────────────────────────

async function sendViaGmail(to, from, subject, bodyText) {
  const auth = getOAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = buildRawMessage(to, from, subject, bodyText);
  const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return res.data.id;
}

// ─── Store Actions ────────────────────────────────────────────────────────────

function sanitizeDispatch(dispatch) {
  if (!dispatch) return null;
  const { body, bodyEncrypted, ...rest } = dispatch;
  return { ...rest, hasBody: Boolean(bodyEncrypted || body) };
}

function getDispatchRaw(id) {
  return readStore().outboundDispatches.find((d) => d.id === id) || null;
}

function getDispatch(id) {
  return sanitizeDispatch(getDispatchRaw(id));
}

function updateDispatch(id, fields) {
  updateStore((state) => {
    const dispatch = (state.outboundDispatches || []).find((d) => d.id === id);
    if (dispatch) {
      Object.assign(dispatch, fields, { updatedAt: nowIso() });
    }
    return state;
  });
}

function listDispatches(filters = {}) {
  const dispatches = readStore().outboundDispatches || [];
  return dispatches.filter((d) => {
    if (filters.status && d.status !== filters.status) return false;
    if (filters.candidateId && d.candidateId !== filters.candidateId) return false;
    return true;
  }).map(sanitizeDispatch);
}

// ─── Public API ───────────────────────────────────────────────────────────────

function enqueueDispatch(opts = {}) {
  const id = crypto.randomUUID();
  const from = opts.from || config.gmailDispatchFrom;
  const vars = opts.vars || {};
  const subject = renderTemplate(opts.subject || '', vars);
  const body = renderTemplate(opts.body || '', vars);

  const dispatch = {
    id,
    candidateId: opts.candidateId || null,
    to: opts.to,
    from,
    subject,
    bodyEncrypted: encryptText(body),
    templateKey: opts.templateKey || null,
    templateVars: vars,
    status: 'queued',
    provider: 'gmail',
    providerMsgId: null,
    retryCount: 0,
    maxRetries: opts.maxRetries != null ? opts.maxRetries : config.gmailDispatchMaxRetries,
    lastError: null,
    queuedAt: nowIso(),
    sentAt: null,
    nextRetryAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  updateStore((state) => {
    if (!Array.isArray(state.outboundDispatches)) {
      state.outboundDispatches = [];
    }
    state.outboundDispatches.push(dispatch);
    return state;
  });

  return { dispatch: sanitizeDispatch(dispatch) };
}

async function sendDispatch(dispatchId) {
  const dispatch = getDispatchRaw(dispatchId);
  if (!dispatch) throw new Error(`Dispatch not found: ${dispatchId}`);
  if (dispatch.status === 'sent') return sanitizeDispatch(dispatch);

  const maxRetries = dispatch.maxRetries != null ? dispatch.maxRetries : config.gmailDispatchMaxRetries;
  const baseMs = config.gmailDispatchRetryBaseMs;

  updateDispatch(dispatchId, { status: 'sending' });

  if (!config.gmailDispatchEnabled) {
    updateDispatch(dispatchId, { status: 'sent', sentAt: nowIso(), lastError: null });
    return getDispatch(dispatchId);
  }

  let lastError;
  const bodyText = decryptText(dispatch.bodyEncrypted || dispatch.body || '');
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const providerMsgId = await sendViaGmail(dispatch.to, dispatch.from, dispatch.subject, bodyText);
      updateDispatch(dispatchId, { status: 'sent', providerMsgId, sentAt: nowIso(), retryCount: attempt, lastError: null });
      return getDispatch(dispatchId);
    } catch (err) {
      lastError = err;
      if (!isTransientError(err) || attempt >= maxRetries) break;
      await sleep(backoffDelayMs(attempt, baseMs));
    }
  }

  updateDispatch(dispatchId, {
    status: 'failed',
    lastError: lastError.message,
    retryCount: (dispatch.retryCount || 0) + 1,
    nextRetryAt: (dispatch.retryCount || 0) + 1 < maxRetries ? new Date(Date.now() + 5000).toISOString() : null
  });

  throw lastError;
}

function queueOutboundDispatch(opts = {}) {
  return enqueueDispatch(opts);
}

async function sendOutboundDispatch(dispatchId) {
  return sendDispatch(dispatchId);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  enqueueDispatch,
  sendDispatch,
  getDispatch,
  listDispatches,
  renderTemplate,
  backoffDelayMs,
  resetOAuthClient,
  buildRawMessage,
  queueOutboundDispatch,
  sendOutboundDispatch
};
