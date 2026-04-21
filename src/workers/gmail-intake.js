#!/usr/bin/env node
'use strict';

/**
 * Gmail OAuth intake worker
 *
 * Usage:
 *   node src/workers/gmail-intake.js            # single run
 *   node src/workers/gmail-intake.js --watch    # poll on interval
 *
 * Required env vars (set in .env or shell):
 *   GMAIL_CREDENTIALS_PATH  path to OAuth Desktop credentials.json
 *   GMAIL_TOKEN_PATH        path to store the OAuth token (e.g. data/gmail-token.json)
 *   GMAIL_POLL_QUERY        Gmail search query (default: subject:(Application for) has:attachment)
 *   GMAIL_POLL_INTERVAL_MS  poll interval in ms when --watch is used (default: 60000)
 *   API_BASE_URL            base URL of the hiring-automation server (default: http://localhost:3000)
 *   API_KEY                 value for x-api-key header (optional, matches HR_API_KEY)
 *
 * See README for full OAuth Desktop App setup instructions.
 */

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const readline = require('node:readline');
const { google } = require('googleapis');

// Optional text-extraction libs — imported lazily to avoid hard crash if missing
let pdfParse;
let mammoth;
try {
  const mod = require('pdf-parse');
  pdfParse = mod && (mod.default || mod);
} catch (_) { /* optional */ }
try { mammoth = require('mammoth'); } catch (_) { /* optional */ }

const { classifyDocument } = require('../docClassifier');

// ─── Config ──────────────────────────────────────────────────────────────────

const CREDENTIALS_PATH = process.env.GMAIL_CREDENTIALS_PATH || 'credentials.json';
const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH || 'data/gmail-token.json';
const POLL_QUERY = process.env.GMAIL_POLL_QUERY || 'subject:(Application for) has:attachment';
const POLL_INTERVAL_MS = Number(process.env.GMAIL_POLL_INTERVAL_MS) || 60_000;
const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const API_KEY = process.env.API_KEY || process.env.HR_API_KEY || '';

const WATCH_MODE = process.argv.includes('--watch');

// Processed message IDs stored locally to avoid reprocessing
const PROCESSED_IDS_PATH = process.env.GMAIL_PROCESSED_IDS_PATH || 'data/gmail-processed-ids.json';

// ─── OAuth helpers ────────────────────────────────────────────────────────────

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Gmail credentials file not found at "${CREDENTIALS_PATH}". ` +
        'Set GMAIL_CREDENTIALS_PATH or place credentials.json in the project root.'
    );
  }
  return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
}

function buildOAuthClient(credentials) {
  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

async function getAuthenticatedClient() {
  const credentials = loadCredentials();
  const oAuth2Client = buildOAuthClient(credentials);

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oAuth2Client.setCredentials(token);

    // Refresh token proactively if it will expire within 5 minutes
    const expiryDate = token.expiry_date || 0;
    if (Date.now() > expiryDate - 5 * 60 * 1000) {
      try {
        const { credentials: refreshed } = await oAuth2Client.refreshAccessToken();
        oAuth2Client.setCredentials(refreshed);
        saveToken(refreshed);
      } catch (err) {
        console.warn('[gmail-intake] Token refresh failed, re-authenticating:', err.message);
        return interactiveAuth(oAuth2Client);
      }
    }

    return oAuth2Client;
  }

  return interactiveAuth(oAuth2Client);
}

function saveToken(token) {
  const dir = path.dirname(TOKEN_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
  console.log(`[gmail-intake] Token saved to ${TOKEN_PATH}`);
}

async function interactiveAuth(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  console.log('\n[gmail-intake] Authorize this app by visiting:\n', authUrl, '\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise((resolve) => {
    rl.question('Enter the authorization code from the page: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  saveToken(tokens);
  return oAuth2Client;
}

// ─── Processed IDs persistence ────────────────────────────────────────────────

function loadProcessedIds() {
  if (!fs.existsSync(PROCESSED_IDS_PATH)) return new Set();
  try {
    return new Set(JSON.parse(fs.readFileSync(PROCESSED_IDS_PATH, 'utf8')));
  } catch (_) {
    return new Set();
  }
}

function saveProcessedIds(ids) {
  const dir = path.dirname(PROCESSED_IDS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROCESSED_IDS_PATH, JSON.stringify([...ids]));
}

// ─── Text extraction ──────────────────────────────────────────────────────────

async function extractText(buffer, mimeType, fileName) {
  const mime = String(mimeType || '').toLowerCase();
  const ext = path.extname(String(fileName || '')).toLowerCase();

  if ((mime === 'application/pdf' || ext === '.pdf') && pdfParse) {
    try {
      const parseFunc = typeof pdfParse === 'function' ? pdfParse : pdfParse.default;
      const data = await parseFunc(buffer);
      return data.text || '';
    } catch (err) {
      console.warn(`[gmail-intake] PDF extraction failed for "${fileName}":`, err.message);
      return '';
    }
  }

  if (
    (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mime === 'application/msword' ||
      ext === '.docx' ||
      ext === '.doc') &&
    mammoth
  ) {
    try {
      const result = await mammoth.extractRawText({ buffer });
      return result.value || '';
    } catch (err) {
      console.warn(`[gmail-intake] DOCX extraction failed for "${fileName}":`, err.message);
      return '';
    }
  }

  return '';
}

// ─── Candidate matching strategy (C) ─────────────────────────────────────────

/**
 * Parse position from subject: "Application for <position>" (case-insensitive).
 */
function parsePositionFromSubject(subject) {
  const m = String(subject || '').match(/application\s+for\s+(.+)/i);
  return m ? m[1].trim() : null;
}

/**
 * Parse candidate ID token from subject.
 * Accepts: CandidateID:<id>  or  [HA:<id>]
 */
function parseTokenFromSubject(subject) {
  const s = String(subject || '');
  const m1 = s.match(/CandidateID:\s*([a-zA-Z0-9_-]+)/i);
  if (m1) return m1[1].trim();
  const m2 = s.match(/\[HA:\s*([a-zA-Z0-9_-]+)\]/i);
  if (m2) return m2[1].trim();
  return null;
}

function normalize(v) {
  return String(v || '').trim().toLowerCase();
}

/**
 * Extract a display name from a "From" header value.
 * "Jane Doe <jane@example.com>" → "Jane Doe"
 * "<jane@example.com>" or "jane@example.com" → "jane" (local-part)
 * Anything else → "Email Applicant"
 */
function parseFullNameFromFrom(from) {
  const nameMatch = String(from || '').match(/^"?([^"<]+?)"?\s*<[^>]+>/);
  if (nameMatch) {
    const name = nameMatch[1].trim();
    if (name) return name;
  }
  const emailMatch = String(from || '').match(/<([^>]+)>/) || String(from || '').match(/([^\s]+@[^\s]+)/);
  if (emailMatch) {
    const localPart = emailMatch[1].trim().split('@')[0];
    if (localPart) return localPart;
  }
  return 'Email Applicant';
}

/**
 * Strategy (C): match by sender email + position from subject.
 * Falls back to token if ambiguous or no match.
 */
function resolveCandidate(candidates, fromEmail, subject) {
  const position = parsePositionFromSubject(subject);
  const token = parseTokenFromSubject(subject);

  let matched = [];

  if (fromEmail && position) {
    matched = candidates.filter(
      (c) =>
        normalize(c.email) === normalize(fromEmail) &&
        normalize(c.position) === normalize(position)
    );
  } else if (fromEmail) {
    matched = candidates.filter((c) => normalize(c.email) === normalize(fromEmail));
  }

  if (matched.length === 1) {
    console.log(
      `[gmail-intake] Matched candidate "${matched[0].fullName}" (${matched[0].id}) by email+position`
    );
    return { candidate: matched[0], reason: 'email+position' };
  }

  if (matched.length > 1 || matched.length === 0) {
    const reason = matched.length > 1 ? 'ambiguous (multiple matches)' : 'no email+position match';

    if (token) {
      const byToken = candidates.find((c) => c.id === token);
      if (byToken) {
        console.log(
          `[gmail-intake] Matched candidate "${byToken.fullName}" (${byToken.id}) by subject token (${reason})`
        );
        return { candidate: byToken, reason: 'subject-token' };
      }
      console.warn(
        `[gmail-intake] Token "${token}" found in subject but no candidate with that ID exists. Skipping.`
      );
      return null;
    }

    if (matched.length > 1) {
      console.warn(
        `[gmail-intake] Ambiguous match: ${matched.length} candidates match email "${fromEmail}" + position "${position}". ` +
          'Ask sender to include "CandidateID:<id>" or "[HA:<id>]" in the subject line. Skipping.'
      );
      return null;
    } else {
      console.log(
        `[gmail-intake] No existing candidate found for email "${fromEmail}" and position "${position}". Will auto-create.`
      );
      return { candidate: null, reason: 'no-match' };
    }
  }

  return null;
}

// ─── API client ───────────────────────────────────────────────────────────────

function apiRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const fullUrl = `${API_BASE_URL}${urlPath}`;
    const parsedUrl = new URL(fullUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Content-Type': 'application/json',
      'x-role': 'hr'
    };
    if (API_KEY) headers['x-api-key'] = API_KEY;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: method.toUpperCase(),
      headers
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function fetchCandidates() {
  const res = await apiRequest('GET', '/api/candidates');
  if (res.status !== 200) throw new Error(`Failed to fetch candidates: ${res.status}`);
  return res.body.items || [];
}

async function postDocumentsContent(candidateId, payload) {
  const res = await apiRequest('POST', `/api/candidates/${candidateId}/documents/content`, payload);
  if (res.status !== 200) {
    throw new Error(`documents/content API returned ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function createCandidate(data) {
  const res = await apiRequest('POST', '/api/applications/intake', data);
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Failed to create candidate: ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body.candidate;
}

// ─── Gmail processing ─────────────────────────────────────────────────────────

async function processEmail(gmail, message, processedIds) {
  const msgId = message.id;
  if (processedIds.has(msgId)) return;

  const full = await gmail.users.messages.get({ userId: 'me', id: msgId, format: 'full' });
  const headers = full.data.payload.headers || [];
  const subject = (headers.find((h) => h.name.toLowerCase() === 'subject') || {}).value || '';
  const from = (headers.find((h) => h.name.toLowerCase() === 'from') || {}).value || '';

  // Use the email's actual received timestamp from Gmail metadata
  const internalDate = full.data.internalDate
    ? new Date(Number(full.data.internalDate)).toISOString()
    : new Date().toISOString();

  // Extract sender email address
  const fromEmailMatch = from.match(/<([^>]+)>/) || from.match(/([^\s]+@[^\s]+)/);
  const fromEmail = fromEmailMatch ? fromEmailMatch[1].trim() : from.trim();

  console.log(`[gmail-intake] Processing message ${msgId}: From="${from}" Subject="${subject}"`);

  // Fetch candidates and resolve
  const candidates = await fetchCandidates();
  const resolution = resolveCandidate(candidates, fromEmail, subject);

  if (!resolution) {
    // Ambiguous or unresolvable — already logged in resolveCandidate
    processedIds.add(msgId);
    saveProcessedIds(processedIds);
    return;
  }

  let candidate;
  if (resolution.candidate === null && resolution.reason === 'no-match') {
    // No existing candidate — auto-create from email metadata
    const position = parsePositionFromSubject(subject) || 'Unknown Position';
    const fullName = parseFullNameFromFrom(from);
    console.log(
      `[gmail-intake] Auto-creating candidate "${fullName}" <${fromEmail}> for position "${position}"`
    );
    try {
      candidate = await createCandidate({ fullName, email: fromEmail, position });
      console.log(`[gmail-intake] Auto-created candidate "${candidate.fullName}" (${candidate.id})`);
    } catch (err) {
      console.error('[gmail-intake] Failed to auto-create candidate:', err.message);
      // Don't mark as processed so it retries
      return;
    }
  } else {
    candidate = resolution.candidate;
  }

  // Process attachments
  const parts = flattenParts(full.data.payload);
  const attachmentParts = parts.filter((p) => p.filename && p.body && (p.body.attachmentId || p.body.data));

  if (attachmentParts.length === 0) {
    console.log(`[gmail-intake] No attachments in message ${msgId}. Skipping document update.`);
    processedIds.add(msgId);
    saveProcessedIds(processedIds);
    return;
  }

  console.log(`[gmail-intake] Found ${attachmentParts.length} attachment(s) in message ${msgId}`);

  const files = [];

  for (const part of attachmentParts) {
    const fileName = part.filename;
    const mimeType = part.mimeType || '';
    let buffer;

    try {
      if (part.body.attachmentId) {
        const att = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: msgId,
          id: part.body.attachmentId
        });
        buffer = Buffer.from(att.data.data, 'base64');
      } else if (part.body.data) {
        buffer = Buffer.from(part.body.data, 'base64');
      }
    } catch (err) {
      console.warn(`[gmail-intake] Failed to download attachment "${fileName}":`, err.message);
      continue;
    }

    let text = '';
    try {
      text = await extractText(buffer, mimeType, fileName);
    } catch (err) {
      console.warn(`[gmail-intake] Extraction error for "${fileName}":`, err.message);
    }

    const classification = classifyDocument(fileName, text);
    if (classification) {
      console.log(
        `[gmail-intake]   "${fileName}" → "${classification.docName}" (score=${classification.score}, matchedBy=${classification.matchedBy})`
      );
    } else {
      console.log(`[gmail-intake]   "${fileName}" → unclassified (size=${buffer ? buffer.length : 0} bytes)`);
    }

    // Do NOT log text content — log only metadata
    files.push({ fileName, mimeType, text });
  }

  // Submit to API
  try {
    await postDocumentsContent(candidate.id, {
      submittedAt: internalDate,
      subject,
      files
    });
    console.log(
      `[gmail-intake] Updated candidate "${candidate.fullName}" (${candidate.id}) with ${files.length} file(s)`
    );
  } catch (err) {
    console.error(`[gmail-intake] Failed to update candidate "${candidate.id}":`, err.message);
    // Don't mark as processed so it retries
    return;
  }

  processedIds.add(msgId);
  saveProcessedIds(processedIds);
}

function flattenParts(payload) {
  if (!payload) return [];
  const parts = [];
  if (payload.parts) {
    for (const part of payload.parts) {
      parts.push(...flattenParts(part));
    }
  } else {
    parts.push(payload);
  }
  return parts;
}

// ─── Main poll loop ───────────────────────────────────────────────────────────

async function run() {
  console.log('[gmail-intake] Starting Gmail OAuth intake worker');
  console.log(`[gmail-intake] Query: "${POLL_QUERY}"`);

  const auth = await getAuthenticatedClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const processedIds = loadProcessedIds();

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: POLL_QUERY,
    maxResults: 50
  });

  const messages = (listRes.data.messages || []);
  const unprocessed = messages.filter((m) => !processedIds.has(m.id));

  console.log(
    `[gmail-intake] Found ${messages.length} message(s) matching query, ${unprocessed.length} unprocessed`
  );

  for (const message of unprocessed) {
    try {
      await processEmail(gmail, message, processedIds);
    } catch (err) {
      console.error(`[gmail-intake] Error processing message ${message.id}:`, err.message);
    }
  }

  console.log('[gmail-intake] Run complete');
}

async function main() {
  if (WATCH_MODE) {
    console.log(`[gmail-intake] Watch mode: polling every ${POLL_INTERVAL_MS}ms`);
    // Run immediately, then on interval
    await run().catch((err) => console.error('[gmail-intake] Run error:', err.message));
    setInterval(async () => {
      await run().catch((err) => console.error('[gmail-intake] Run error:', err.message));
    }, POLL_INTERVAL_MS);
  } else {
    await run();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[gmail-intake] Fatal error:', err.message);
    process.exit(1);
  });
}

// Export pure helpers for testing
module.exports = {
  parsePositionFromSubject,
  parseTokenFromSubject,
  parseFullNameFromFrom,
  resolveCandidate
};
