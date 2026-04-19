const { google } = require('googleapis');
const { config } = require('../config');

const SHEET_TAB_TITLE = 'Candidates';

function getCredentials() {
  if (!config.googleSheetsCredentialsJson) {
    return null;
  }
  try {
    return JSON.parse(config.googleSheetsCredentialsJson);
  } catch (_error) {
    throw new Error('Invalid GOOGLE_SHEETS_CREDENTIALS_JSON');
  }
}

async function getSheetsClient() {
  const credentials = getCredentials();
  if (!credentials) {
    throw new Error('Missing GOOGLE_SHEETS_CREDENTIALS_JSON');
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

function toSheetValues(rows) {
  if (!rows.length) {
    return [['No candidate records yet']];
  }
  const headers = Object.keys(rows[0]);
  const values = rows.map((row) => headers.map((key) => row[key]));
  return [headers, ...values];
}

async function createSpreadsheet(sheetsClient, title) {
  const response = await sheetsClient.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: [{ properties: { title: SHEET_TAB_TITLE } }]
    }
  });
  const spreadsheetId = response.data.spreadsheetId;
  if (!spreadsheetId) {
    throw new Error('Failed to create Google Spreadsheet');
  }
  return {
    spreadsheetId,
    spreadsheetUrl: response.data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
  };
}

async function ensureCandidatesTab(sheetsClient, spreadsheetId) {
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId });
  const hasCandidatesTab = (meta.data.sheets || []).some(
    (sheet) => (sheet.properties || {}).title === SHEET_TAB_TITLE
  );
  if (hasCandidatesTab) {
    return;
  }
  await sheetsClient.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: SHEET_TAB_TITLE } } }]
    }
  });
}

async function upsertCandidateSheetRows({ rows, spreadsheetId, spreadsheetTitle }) {
  const sheetsClient = await getSheetsClient();
  const created = spreadsheetId ? null : await createSpreadsheet(sheetsClient, spreadsheetTitle);
  const targetSpreadsheetId = spreadsheetId || created.spreadsheetId;
  await ensureCandidatesTab(sheetsClient, targetSpreadsheetId);
  const values = toSheetValues(rows);

  await sheetsClient.spreadsheets.values.clear({
    spreadsheetId: targetSpreadsheetId,
    range: `${SHEET_TAB_TITLE}!A:ZZ`
  });

  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: targetSpreadsheetId,
    range: `${SHEET_TAB_TITLE}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values }
  });

  return {
    spreadsheetId: targetSpreadsheetId,
    spreadsheetUrl:
      (created && created.spreadsheetUrl) || `https://docs.google.com/spreadsheets/d/${targetSpreadsheetId}`
  };
}

module.exports = {
  upsertCandidateSheetRows
};
