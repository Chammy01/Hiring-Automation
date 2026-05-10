require('dotenv').config();

const DEV_DEFAULT_ENCRYPTION_KEY = 'dev-local-encryption-key-change-this-dev-local-encryption-key';
const isTest = process.env.NODE_ENV === 'test';
const isProduction = process.env.NODE_ENV === 'production';
const isLocalDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;

function parseApiKeys(raw) {
  const map = new Map();
  if (!raw) return map;
  for (const pair of String(raw).split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const [key, roleRaw] = trimmed.split(':');
    const token = String(key || '').trim();
    const role = String(roleRaw || 'hr').trim().toLowerCase();
    if (token) map.set(token, role || 'hr');
  }
  return map;
}

function parseCsv(raw) {
  return String(raw || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

const config = {
  port: Number(process.env.PORT || 3000),
  dataFile: process.env.DATA_FILE || 'data/store.json',
  defaultDeadline: process.env.DOCUMENT_DEADLINE || '',
  fromEmail: process.env.FROM_EMAIL || 'hr@company.local',
  hrApiKey: String(process.env.HR_API_KEY || '').trim(),
  hrDefaultRole: process.env.HR_DEFAULT_ROLE || 'hr',
  hrApiKeys: parseApiKeys(process.env.HR_API_KEYS || ''),
  // Comma-separated list of allowed CORS origins.
  allowedOrigins: process.env.ALLOWED_ORIGINS || '',
  allowedOriginsList: parseCsv(process.env.ALLOWED_ORIGINS || ''),
  encryptionKey:
    process.env.ENCRYPTION_KEY ||
    DEV_DEFAULT_ENCRYPTION_KEY,
  webhookAllowedDomains: parseCsv(process.env.WEBHOOK_ALLOWED_DOMAINS || '').map((d) => d.toLowerCase()),
  webhookTimeoutMs: Number(process.env.WEBHOOK_TIMEOUT_MS || 5000),
  localAuthRole: String(process.env.LOCAL_AUTH_ROLE || 'hr').toLowerCase(),
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
  postgresSslCaPath: process.env.POSTGRES_SSL_CA_PATH || '',
  postgresSslCertPath: process.env.POSTGRES_SSL_CERT_PATH || '',
  postgresSslKeyPath: process.env.POSTGRES_SSL_KEY_PATH || '',

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
  ocrWorkerPollMs: Number(process.env.OCR_WORKER_POLL_MS || 5000),

  runtime: {
    isTest,
    isProduction,
    isLocalDev
  }
};

if (config.hrApiKey && config.hrApiKeys.size === 0) {
  config.hrApiKeys.set(config.hrApiKey, String(config.hrDefaultRole || 'hr').toLowerCase());
}

if (!isTest && !config.hrApiKeys.size) {
  throw new Error(
    '[config] HR_API_KEY (or HR_API_KEYS) is required outside test environments. ' +
    'Set it in environment variables (see .env.example).'
  );
}

// Enforce strong encryption key outside local/test mode.
if (
  config.encryptionKey === DEV_DEFAULT_ENCRYPTION_KEY &&
  !isTest &&
  !isLocalDev
) {
  throw new Error(
    '[config] ENCRYPTION_KEY must be set to a strong unique value outside local/test environments.'
  );
}

if (config.encryptionKey === DEV_DEFAULT_ENCRYPTION_KEY && !isTest) {
  console.warn(
    '[config] WARNING: ENCRYPTION_KEY is using the local development fallback. ' +
    'Set a strong ENCRYPTION_KEY before deploying.'
  );
}

if (isProduction && config.allowedOriginsList.length === 0) {
  throw new Error('[config] ALLOWED_ORIGINS must be configured in production.');
}

module.exports = { config };
