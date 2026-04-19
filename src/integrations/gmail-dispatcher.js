'use strict';

/**
 * Gmail outbound dispatcher.
 *
 * Sends queued outbound_dispatch jobs via the Gmail API (OAuth2).
 * Falls back to a no-op "simulated send" when GMAIL_DISPATCH_ENABLED is not true,
 * so the rest of the application continues to work without Gmail configured.
 *
 * The dispatcher:
 *  1. Creates a dispatch record in the JSON store (or PostgreSQL when enabled).
 *  2. Attempts to send via Gmail API immediately (or marks as queued for the worker).
 *  3. On transient failure, retries with exponential backoff up to maxRetries.
 *  4. Persists status transitions: queued → sending → sent | failed.
 *
 * Environment variables (documented in .env.example):
 *   GMAIL_DISPATCH_ENABLED    - "true" to use real Gmail send
 *   GMAIL_CREDENTIALS_PATH    - path to OAuth Desktop credentials.json
 *   GMAIL_TOKEN_PATH          - path to stored OAuth token
 *   GMAIL_DISPATCH_FROM       - sender address (must match authorized Gmail account)
 *   GMAIL_DISPATCH_MAX_RETRIES - max retry attempts (default: 3)
 *   GMAIL_DISPATCH_RETRY_BASE_MS - base backoff ms (default: 1000)
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const { config } = require('../config');
const { updateStore, readStore } = require('../store');

// googleapis is a prod dependency — loaded lazily to keep tests fast
let google;
try {
  google = require('googleapis').google;
} catch (_) {
  // Optional — only needed when GMAIL_DISPATCH_ENABLED=true
}

// ─── Template rendering ───────────────────────────────────────────────────────

/**
 * Replace {{varName}} placeholders in a template string.
 * @param {string} template
 * @param {Record<string,string>} vars
 * @returns {string}
 */
function renderTemplate(template, vars = {}) {
  return String(template || '').replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_match, key) => String(vars[key] != null ? vars[key] : '')
  );
}

// ─── OAuth client (reused across calls in same process) ──────────────────────

let _oAuth2Client = null;

function getOAuthClient() {
  if (_oAuth2Client) return _oAuth2Client;

  if (!google) {
    throw new Error('googleapis package is not available — install it or disable GMAIL_DISPATCH_ENABLED');
  }

  if (!fs.existsSync(config.gmailCredentialsPath)) {
    throw new Error(
      `Gmail credentials file not found at "${config.gmailCredentialsPath}". ` +
        'Set GMAIL_CREDENTIALS_PATH or place credentials.json in the project root.'
    );
  }

  const credentials = JSON.parse(fs.readFileSync(config.gmailCredentialsPath, 'utf8'));
  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (!fs.existsSync(config.gmailTokenPath)) {
    throw new Error(
      `Gmail token not found at "${config.gmailTokenPath}". ` +
        'Run the gmail-intake worker once to perform the initial OAuth authorization flow.'
    );
  }

  const token = JSON.parse(fs.readFileSync(config.gmailTokenPath, 'utf8'));
  oAuth2Client.setCredentials(token);
  _oAuth2Client = oAuth2Client;
  return oAuth2Client;
}

/** Reset cached client (e.g. after token rotation in tests). */
function resetOAuthClient() {
  _oAuth2Client = null;
}

// ─── Build RFC 2822 email and base64url-encode it ────────────────────────────

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
  // Gmail API requires base64url (no padding '+' → '-', '/' → '_', strip '=')
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── Exponential backoff helper ───────────────────────────────────────────────

function backoffDelayMs(attempt, baseMs) {
  const jitter = Math.random() * 200;
  return Math.min(baseMs * 2 ** attempt + jitter, 30_000);
}

// ─── Core send (real Gmail API) ───────────────────────────────────────────────

async function sendViaGmail(to, from, subject, bodyText) {
  const auth = getOAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = buildRawMessage(to, from, subject, bodyText);
  const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return res.data.id; // Gmail message ID
}

// ─── Store helpers ────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function getDispatch(id) {
  return readStore().outboundDispatches.find((d) => d.id === id) || null;
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

// ─── Enqueue ─────────────────────────────────────────────────────────────────

/**
 * Create a new outbound dispatch job.
 *
 * @param {object} opts
 * @param {string}  opts.to            - Recipient email address
 * @param {string}  [opts.from]        - Sender (defaults to GMAIL_DISPATCH_FROM / FROM_EMAIL)
 * @param {string}  opts.subject       - Email subject (may contain {{vars}})
 * @param {string}  opts.body          - Email body text (may contain {{vars}})
 * @param {object}  [opts.vars]        - Template variables for subject and body
 * @param {string}  [opts.templateKey] - Optional reference key for record keeping
 * @param {string}  [opts.candidateId] - Linked candidate ID
 * @param {number}  [opts.maxRetries]
 * @returns {{ dispatch: object }}
 */
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
    body,
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

  return { dispatch };
}

// ─── Send (with retry logic) ──────────────────────────────────────────────────

/**
 * Attempt to send a queued dispatch.
 * Handles retry with exponential backoff internally.
 *
 * @param {string} dispatchId
 * @returns {Promise<object>} The updated dispatch record
 */
async function sendDispatch(dispatchId) {
  const dispatch = getDispatch(dispatchId);
  if (!dispatch) {
    throw new Error(`Dispatch not found: ${dispatchId}`);
  }

  if (dispatch.status === 'sent') {
    return dispatch;
  }

  const maxRetries = dispatch.maxRetries != null ? dispatch.maxRetries : config.gmailDispatchMaxRetries;
  const baseMs = config.gmailDispatchRetryBaseMs;

  updateDispatch(dispatchId, { status: 'sending' });

  // If Gmail dispatch is not enabled, simulate a successful send
  if (!config.gmailDispatchEnabled) {
    updateDispatch(dispatchId, {
      status: 'sent',
      sentAt: nowIso(),
      lastError: null
    });
    console.log(`[gmail-dispatcher] Simulated send to "${dispatch.to}" (GMAIL_DISPATCH_ENABLED=false)`);
    return getDispatch(dispatchId);
  }

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const providerMsgId = await sendViaGmail(dispatch.to, dispatch.from, dispatch.subject, dispatch.body);
      updateDispatch(dispatchId, {
        status: 'sent',
        providerMsgId,
        sentAt: nowIso(),
        retryCount: attempt,
        lastError: null
      });
      console.log(`[gmail-dispatcher] Sent message to "${dispatch.to}" (provider id: ${providerMsgId})`);
      return getDispatch(dispatchId);
    } catch (err) {
      lastError = err;
      const isTransient = isTransientError(err);
      console.warn(
        `[gmail-dispatcher] Send attempt ${attempt + 1}/${maxRetries + 1} failed for dispatch ${dispatchId}: ${err.message}`
      );

      if (!isTransient || attempt >= maxRetries) {
        break;
      }

      const delay = backoffDelayMs(attempt, baseMs);
      console.log(`[gmail-dispatcher] Retrying in ${Math.round(delay)}ms…`);
      await sleep(delay);
    }
  }

  // All attempts failed
  const nextRetryAt = new Date(Date.now() + backoffDelayMs(dispatch.retryCount + 1, baseMs)).toISOString();
  updateDispatch(dispatchId, {
    status: 'failed',
    lastError: lastError ? lastError.message : 'Unknown error',
    retryCount: (dispatch.retryCount || 0) + 1,
    nextRetryAt: (dispatch.retryCount || 0) + 1 < maxRetries ? nextRetryAt : null
  });

  throw lastError || new Error('Send failed after retries');
}

function isTransientError(err) {
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  // Network errors, rate limits, and 5xx are transient
  return (
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('rate limit') ||
    msg.includes('quota') ||
    (err.code && [429, 500, 502, 503, 504].includes(Number(err.code)))
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── List helpers ─────────────────────────────────────────────────────────────

function listDispatches(filters = {}) {
  const dispatches = readStore().outboundDispatches || [];
  return dispatches.filter((d) => {
    if (filters.status && d.status !== filters.status) return false;
    if (filters.candidateId && d.candidateId !== filters.candidateId) return false;
    return true;
  });
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
  buildRawMessage
};
