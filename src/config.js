require('dotenv').config();

const _DEFAULT_ENCRYPTION_KEY = 'dev-local-encryption-key-change-this-dev-local-encryption-key';

const config = {
  port: Number(process.env.PORT || 3000),
  dataFile: process.env.DATA_FILE || 'data/store.json',
  defaultDeadline: process.env.DOCUMENT_DEADLINE || '',
  fromEmail: process.env.FROM_EMAIL || 'hr@company.local',
  // Legacy single-key auth (still supported; maps to 'hr' role).
  hrApiKey: process.env.HR_API_KEY || '',
  // Per-role API keys. When any of these is set, the role is resolved
  // server-side from the presented key rather than from the x-role header.
  apiKeyAdmin: process.env.API_KEY_ADMIN || '',
  apiKeyHr: process.env.API_KEY_HR || process.env.HR_API_KEY || '',
  apiKeyViewer: process.env.API_KEY_VIEWER || '',
  roleHeader: process.env.ROLE_HEADER || 'x-role',
  // CORS allowed origin(s). Comma-separated list of origins, or '*' to allow
  // all origins (not recommended in production).  Leave blank to serve
  // same-origin only (recommended for the default single-server deployment).
  corsOrigin: process.env.CORS_ORIGIN || '',
  encryptionKey:
    process.env.ENCRYPTION_KEY || _DEFAULT_ENCRYPTION_KEY,
  mailboxAddress: process.env.MAILBOX_ADDRESS || 'applications@company.local',
  googleSheetsEnabled: String(process.env.GOOGLE_SHEETS_ENABLED || '').toLowerCase() === 'true',
  googleSheetsCredentialsJson: process.env.GOOGLE_SHEETS_CREDENTIALS_JSON || '',
  googleSheetsSpreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '',
  googleSheetsTitle: process.env.GOOGLE_SHEETS_TITLE || 'Hiring Automation Candidates',

  // PostgreSQL persistence (optional — falls back to JSON store when disabled)
  postgresEnabled: String(process.env.POSTGRES_ENABLED || '').toLowerCase() === 'true',
  postgresUrl: process.env.POSTGRES_URL || '',
  postgresHost: process.env.POSTGRES_HOST || 'localhost',
  postgresPort: Number(process.env.POSTGRES_PORT || 5432),
  postgresDb: process.env.POSTGRES_DB || 'hiring_automation',
  postgresUser: process.env.POSTGRES_USER || 'postgres',
  postgresPassword: process.env.POSTGRES_PASSWORD || '',
  postgresSsl: String(process.env.POSTGRES_SSL || '').toLowerCase() === 'true',

  // Gmail outbound dispatcher (optional — skips send when not configured)
  gmailDispatchEnabled: String(process.env.GMAIL_DISPATCH_ENABLED || '').toLowerCase() === 'true',
  gmailCredentialsPath: process.env.GMAIL_CREDENTIALS_PATH || 'credentials.json',
  gmailTokenPath: process.env.GMAIL_TOKEN_PATH || 'data/gmail-token.json',
  gmailDispatchFrom: process.env.GMAIL_DISPATCH_FROM || process.env.FROM_EMAIL || 'hr@company.local',
  gmailDispatchMaxRetries: Number(process.env.GMAIL_DISPATCH_MAX_RETRIES || 3),
  gmailDispatchRetryBaseMs: Number(process.env.GMAIL_DISPATCH_RETRY_BASE_MS || 1000),

  // OCR / document parsing worker
  ocrEnabled: String(process.env.OCR_ENABLED || '').toLowerCase() === 'true',
  ocrWorkerConcurrency: Number(process.env.OCR_WORKER_CONCURRENCY || 2),
  ocrWorkerPollMs: Number(process.env.OCR_WORKER_POLL_MS || 5000)
};

/**
 * Validate security-critical configuration and emit warnings (or throw in
 * production) when dangerous defaults are detected.
 *
 * Call this once at server startup before handling any requests.
 */
function validateConfig() {
  const isProd = process.env.NODE_ENV === 'production';

  // Encryption key
  if (!config.encryptionKey || config.encryptionKey === _DEFAULT_ENCRYPTION_KEY) {
    const msg =
      '[config] SECURITY WARNING: ENCRYPTION_KEY is using the insecure default value. ' +
      'Generate a strong random secret and set it via the ENCRYPTION_KEY environment variable.';
    if (isProd) {
      throw new Error(msg);
    }
    console.warn(msg);
  }

  // API keys / auth
  const anyKeyConfigured = config.apiKeyAdmin || config.apiKeyHr || config.apiKeyViewer;
  if (!anyKeyConfigured) {
    const msg =
      '[config] SECURITY WARNING: No API keys are configured (API_KEY_ADMIN / API_KEY_HR / ' +
      'API_KEY_VIEWER / HR_API_KEY). All endpoints are publicly accessible. ' +
      'Set at least one key in production.';
    // Warn in all environments; do not throw (operator may rely on a reverse-proxy for auth).
    console.warn(msg);
  }
}

module.exports = { config, validateConfig };
