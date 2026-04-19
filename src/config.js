require('dotenv').config();

const config = {
  port: Number(process.env.PORT || 3000),
  dataFile: process.env.DATA_FILE || 'data/store.json',
  defaultDeadline: process.env.DOCUMENT_DEADLINE || '2026-04-07T23:59:59+08:00',
  fromEmail: process.env.FROM_EMAIL || 'hr@company.local',
  hrApiKey: process.env.HR_API_KEY || '',
  roleHeader: process.env.ROLE_HEADER || 'x-role',
  encryptionKey:
    process.env.ENCRYPTION_KEY ||
    'dev-local-encryption-key-change-this-dev-local-encryption-key',
  mailboxAddress: process.env.MAILBOX_ADDRESS || 'applications@company.local'
};

module.exports = { config };
