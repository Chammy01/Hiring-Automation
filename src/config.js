require('dotenv').config();

const config = {
  port: Number(process.env.PORT || 3000),
  dataFile: process.env.DATA_FILE || 'data/store.json',
  defaultDeadline: process.env.DOCUMENT_DEADLINE || '',
  fromEmail: process.env.FROM_EMAIL || 'hr@company.local',
  hrApiKey: process.env.HR_API_KEY || '',
  roleHeader: process.env.ROLE_HEADER || 'x-role',
  encryptionKey:
    process.env.ENCRYPTION_KEY ||
    'dev-local-encryption-key-change-this-dev-local-encryption-key',
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

module.exports = { config };
