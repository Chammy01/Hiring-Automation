const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const { config, validateConfig } = require('./config');
const { requirePermission, resolveRoleFromApiKey, anyApiKeyConfigured } = require('./security');
const {
  createCandidateFromApplication,
  submitCandidateDocuments,
  submitCandidateDocumentsContent,
  extractCandidateProfile,
  enqueueExtractionJob,
  processExtractionJob,
  verifyCandidateExtraction,
  calculateRecommendation,
  updateScoringWeights,
  getScoringWeights,
  getAppSettings,
  updateAppSettings,
  updateCandidateStatus,
  retryEmailEvent,
  processInboundEmail,
  mergeDuplicateCandidates,
  listCandidates,
  getCandidate,
  listPositions,
  getDashboard,
  toSheetRows,
  listAuditLogs,
  listEmailEvents,
  listRetryQueue,
  listVerificationQueue,
  listExtractionQueue,
  getTemplates,
  updateTemplate,
  acknowledgementTemplate,
  getAnalytics,
  exportBackup,
  importBackup,
  getIntegrationsStatus,
  syncGoogleSheets,
  // New modules
  queueOutboundDispatch,
  sendOutboundDispatch,
  getOutboundDispatch,
  listOutboundDispatches,
  queueDocumentParsing,
  runDocumentParsing,
  getDocumentParsingJob,
  listDocumentParsingJobs,
  applyCandidateEnrichment,
  archiveCandidate,
  deleteCandidate
} = require('./services');
const { paginate } = require('./utils');

const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Only enable CORS when CORS_ORIGIN is explicitly configured.  The default
// single-server deployment serves its own frontend from the same origin and
// does not need CORS headers.  Setting CORS_ORIGIN=* opts back into
// unrestricted cross-origin access (not recommended for production).
if (config.corsOrigin) {
  const allowedOrigins = config.corsOrigin === '*'
    ? '*'
    : config.corsOrigin.split(',').map((o) => o.trim()).filter(Boolean);
  app.use(cors({ origin: allowedOrigins }));
}

app.use(express.json({ limit: '6mb' }));
app.use(express.static('public'));

// ─── Rate limiter ─────────────────────────────────────────────────────────────
function createRateLimiter({ windowMs, max }) {
  const buckets = new Map();
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();

    // Periodically evict expired buckets to prevent unbounded memory growth.
    // Using a probabilistic cleanup (≈1 % of requests) keeps the overhead low.
    if (buckets.size > 0 && Math.random() < 0.01) {
      for (const [k, b] of buckets) {
        if (now - b.start > windowMs) {
          buckets.delete(k);
        }
      }
    }

    const bucket = buckets.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      buckets.set(key, { start: now, count: 1 });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    return next();
  };
}

// ─── Authentication middleware ────────────────────────────────────────────────
/**
 * Validate the presented API key and attach the resolved role to the request.
 *
 * Behaviour:
 *  - If at least one role-specific key is configured (API_KEY_ADMIN /
 *    API_KEY_HR / API_KEY_VIEWER / HR_API_KEY), the presented key MUST match
 *    one of them; otherwise the request is rejected with 401.
 *  - If NO keys are configured (dev / test mode), authentication is skipped
 *    and the role is read from the x-role header downstream.
 */
function requireApiKey(req, res, next) {
  if (!anyApiKeyConfigured()) {
    // Dev / test mode — no keys configured, skip auth.
    return next();
  }

  const key = req.headers['x-api-key'];
  const role = resolveRoleFromApiKey(key);

  if (!role) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Attach the server-resolved role so that resolveRole() in security.js
  // will use it instead of the (now-ignored) x-role header.
  req._resolvedRole = role;
  return next();
}

function secure(permission) {
  return [requireApiKey, requirePermission(permission)];
}

const sensitiveActionLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

function secureWrite(permission) {
  return [sensitiveActionLimiter, requireApiKey, requirePermission(permission)];
}


const intakeSchema = z.object({
  fullName: z.string().min(2),
  email: z.string().email(),
  position: z.string().min(2),
  subject: z.string().optional(),
  receivedAt: z.string().optional(),
  simulateAckFailure: z.boolean().optional()
});

const docsSchema = z.object({
  attachments: z.array(z.string()).default([]),
  invalidAttachments: z.array(z.string()).optional(),
  subject: z.string(),
  submittedAt: z.string().optional()
});

const docsContentSchema = z.object({
  submittedAt: z.string().optional(),
  subject: z.string().optional(),
  files: z.array(
    z.object({
      fileName: z.string(),
      text: z.string().optional(),
      mimeType: z.string().optional()
    })
  )
});

const extractSchema = z.object({
  documentTexts: z.array(
    z.object({
      fileName: z.string().optional(),
      text: z.string().optional()
    })
  )
});

const extractionJobSchema = z.object({
  files: z.array(z.string()).default([]),
  documentTexts: z.array(
    z.object({
      fileName: z.string().optional(),
      text: z.string().optional()
    })
  ).optional()
});

const interviewSchema = z.object({
  date: z.string().min(1),
  time: z.string().min(1),
  meetingLink: z.string().optional(),
  venue: z.string().optional()
});

const rejectSchema = z.object({
  reason: z.string().min(1)
});

const templateSchema = z.object({
  content: z.string().min(1)
});

const scoringSchema = z.object({
  docsComplete: z.number().nonnegative().optional(),
  eligibility: z.number().nonnegative().optional(),
  experience: z.number().nonnegative().optional(),
  education: z.number().nonnegative().optional(),
  trainings: z.number().nonnegative().optional(),
  awards: z.number().nonnegative().optional()
});

const inboundEmailSchema = z.object({
  fromEmail: z.string().email(),
  fromName: z.string().optional(),
  subject: z.string(),
  body: z.string().optional(),
  attachments: z.array(z.string()).optional(),
  receivedAt: z.string().optional()
});

const mergeSchema = z.object({
  primaryId: z.string().min(1),
  duplicateId: z.string().min(1)
});

const appSettingsSchema = z.object({
  hiringDeadline: z.string().min(1).optional(),
  companyEmail: z.string().email().optional(),
  mailboxAddress: z.string().email().optional(),
  companyName: z.string().optional(),
  replyToEmail: z.union([z.string().email(), z.literal('')]).optional(),
  hiringManagerName: z.string().optional(),
  applicationOpenDate: z.string().optional(),
  timezone: z.string().optional(),
  autoResponseSubject: z.string().optional(),
  interviewWindowStart: z.string().optional(),
  interviewWindowEnd: z.string().optional(),
  maxApplicationsPerRole: z.number().int().nonnegative().optional(),
  allowedFileTypes: z.string().optional(),
  maxUploadSizeMb: z.number().positive().optional(),
  notifyNewApplication: z.boolean().optional(),
  reminderCadenceDays: z.number().int().positive().optional(),
  careerPageBanner: z.string().optional(),
  defaultJobVisibility: z.enum(['public', 'private', 'draft']).optional(),
  dataRetentionDays: z.number().int().positive().optional()
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'hiring-automation' });
});

app.get('/api/config/ack-template', (_req, res) => {
  const settings = getAppSettings();
  res.json({ template: acknowledgementTemplate(settings.hiringDeadline, getTemplates()) });
});

app.get('/api/positions', (_req, res) => {
  res.json({ positions: listPositions() });
});

app.get('/api/candidates', secure('read:candidates'), (req, res) => {
  const filters = {
    position: req.query.position,
    status: req.query.status,
    archived: req.query.archived
  };
  const page = req.query.page ? parseInt(req.query.page, 10) : null;
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;
  const all = listCandidates(filters);
  const result = paginate(all, page, limit);
  res.json(result.limit ? result : { items: result.items });
});

app.get('/api/candidates/:id', secure('read:candidates'), (req, res) => {
  const candidate = getCandidate(req.params.id);
  if (!candidate) {
    return res.status(404).json({ error: 'Candidate not found' });
  }
  return res.json(candidate);
});

app.patch('/api/candidates/:id/archive', secureWrite('write:candidates'), (req, res) => {
  try {
    const archived = req.body && Object.prototype.hasOwnProperty.call(req.body, 'archived')
      ? Boolean(req.body.archived)
      : undefined;
    const candidate = archiveCandidate(req.params.id, archived);
    return res.json(candidate);
  } catch (error) {
    const status = error.message === 'Candidate not found' ? 404 : 400;
    return res.status(status).json({ error: error.message });
  }
});

app.delete('/api/candidates/:id', secureWrite('write:candidates'), (req, res) => {
  try {
    const candidate = deleteCandidate(req.params.id);
    return res.json({ deleted: true, candidate });
  } catch (error) {
    const status = error.message === 'Candidate not found' ? 404 : 400;
    return res.status(status).json({ error: error.message });
  }
});

app.post('/api/applications/intake', secureWrite('write:candidates'), (req, res) => {
  const parsed = intakeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const result = createCandidateFromApplication(parsed.data);
  if (result.duplicate) {
    return res.status(200).json({ message: 'Duplicate candidate skipped', candidate: result.candidate });
  }
  return res.status(201).json({ message: 'Candidate registered and acknowledgment queued', ...result });
});

app.post('/api/email/inbound', secureWrite('write:candidates'), (req, res) => {
  const parsed = inboundEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const result = processInboundEmail(parsed.data);
  return res.json(result);
});

app.post('/api/candidates/:id/documents', secureWrite('write:candidates'), (req, res) => {
  const parsed = docsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const candidate = submitCandidateDocuments(req.params.id, parsed.data);
    return res.json(candidate);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/candidates/:id/documents/content', secureWrite('write:candidates'), (req, res) => {
  const parsed = docsContentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const result = submitCandidateDocumentsContent(req.params.id, parsed.data);
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/candidates/:id/extract', secureWrite('write:candidates'), (req, res) => {
  const parsed = extractSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const candidate = extractCandidateProfile(req.params.id, parsed.data);
    return res.json(candidate);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/candidates/:id/extraction-jobs', secureWrite('write:candidates'), (req, res) => {
  const parsed = extractionJobSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const job = enqueueExtractionJob(req.params.id, parsed.data.files);
    if (parsed.data.documentTexts) {
      const result = processExtractionJob(job.id, { documentTexts: parsed.data.documentTexts });
      return res.status(201).json({ job, result });
    }
    return res.status(201).json({ job });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get('/api/extraction-queue', secure('read:candidates'), (_req, res) => {
  res.json({ items: listExtractionQueue() });
});

app.get('/api/verification-queue', secure('read:candidates'), (_req, res) => {
  res.json({ items: listVerificationQueue() });
});

app.post('/api/candidates/:id/verify-extraction', secureWrite('write:candidates'), (req, res) => {
  try {
    const candidate = verifyCandidateExtraction(req.params.id, req.body || {});
    return res.json(candidate);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/candidates/:id/score', secureWrite('write:candidates'), (req, res) => {
  try {
    const recommendation = calculateRecommendation(req.params.id);
    return res.json(recommendation);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get('/api/scoring/weights', secure('read:candidates'), (_req, res) => {
  res.json(getScoringWeights());
});

app.post('/api/scoring/weights', secureWrite('write:candidates'), (req, res) => {
  const parsed = scoringSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  res.json(updateScoringWeights(parsed.data));
});

app.post('/api/candidates/:id/shortlist', secureWrite('write:candidates'), (req, res) => {
  try {
    const candidate = updateCandidateStatus(req.params.id, 'shortlist');
    return res.json(candidate);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/candidates/:id/interview', secureWrite('write:candidates'), (req, res) => {
  const parsed = interviewSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const candidate = updateCandidateStatus(req.params.id, 'scheduleInterview', parsed.data);
    return res.json(candidate);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/candidates/:id/follow-up', secureWrite('write:candidates'), (req, res) => {
  try {
    const candidate = updateCandidateStatus(req.params.id, 'followUp');
    return res.json(candidate);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/candidates/:id/confirm-interview', secureWrite('write:candidates'), (req, res) => {
  try {
    const candidate = updateCandidateStatus(req.params.id, 'confirmInterview');
    return res.json(candidate);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/candidates/:id/hire', secureWrite('write:candidates'), (req, res) => {
  try {
    const candidate = updateCandidateStatus(req.params.id, 'hire');
    return res.json(candidate);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/candidates/:id/reject', secureWrite('write:candidates'), (req, res) => {
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const candidate = updateCandidateStatus(req.params.id, 'reject', parsed.data);
    return res.json(candidate);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/candidates/merge', secureWrite('write:candidates'), (req, res) => {
  const parsed = mergeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const candidate = mergeDuplicateCandidates(parsed.data.primaryId, parsed.data.duplicateId);
    return res.json(candidate);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get('/api/dashboard', secure('read:dashboard'), (_req, res) => {
  res.json(getDashboard());
});

app.get('/api/analytics', secure('read:dashboard'), (_req, res) => {
  res.json(getAnalytics());
});

app.get('/api/integrations', secure('read:dashboard'), (_req, res) => {
  res.json(getIntegrationsStatus());
});

app.post('/api/integrations/google-sheets/sync', secureWrite('write:candidates'), async (_req, res) => {
  const result = await syncGoogleSheets('manual_sync');
  return res.json(result);
});

app.get('/api/sheets/rows', secure('read:candidates'), (_req, res) => {
  res.json({ rows: toSheetRows() });
});

app.get('/api/templates', secure('read:candidates'), (_req, res) => {
  res.json(getTemplates());
});

app.put('/api/templates/:key', secureWrite('write:templates'), (req, res) => {
  const parsed = templateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const templates = updateTemplate(req.params.key, parsed.data.content);
    return res.json(templates);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get('/api/retry-queue', secure('read:email'), (_req, res) => {
  res.json({ items: listRetryQueue() });
});

app.post('/api/email-events/:id/retry', secureWrite('write:candidates'), async (req, res) => {
  try {
    const event = await retryEmailEvent(req.params.id);
    return res.json(event);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get('/api/audit-logs', secure('read:audit'), (req, res) => {
  const page = req.query.page ? parseInt(req.query.page, 10) : null;
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;
  const all = listAuditLogs();
  const result = paginate(all, page, limit);
  res.json(result.limit ? result : { items: result.items });
});

app.get('/api/email-events', secure('read:email'), (req, res) => {
  const page = req.query.page ? parseInt(req.query.page, 10) : null;
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;
  const all = listEmailEvents();
  const result = paginate(all, page, limit);
  res.json(result.limit ? result : { items: result.items });
});

app.get('/api/backup', secureWrite('write:backup'), (_req, res) => {
  res.json(exportBackup());
});

app.post('/api/restore', secureWrite('write:backup'), (req, res) => {
  try {
    const restored = importBackup(req.body || {});
    return res.json({ restored });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get('/api/settings', secure('read:dashboard'), (_req, res) => {
  res.json(getAppSettings());
});

app.put('/api/settings', secureWrite('write:candidates'), (req, res) => {
  const parsed = appSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const updated = updateAppSettings(parsed.data);
    return res.json(updated);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// ─── Gmail outbound dispatch endpoints ───────────────────────────────────────

const dispatchSchema = z.object({
  to: z.string().email(),
  from: z.string().email().optional(),
  subject: z.string().min(1),
  body: z.string().min(1),
  vars: z.record(z.string()).optional(),
  templateKey: z.string().optional(),
  candidateId: z.string().optional(),
  maxRetries: z.number().int().nonnegative().optional()
});

// Trigger Gmail inbox sync (delegates to the gmail-intake worker)
app.post('/api/mail/sync', secureWrite('write:candidates'), (_req, res) => {
  res.json({
    queued: true,
    message: 'Gmail inbox sync is handled by the gmail-intake worker. ' +
      'Run: node src/workers/gmail-intake.js (or pass --watch for continuous polling).',
    gmailDispatchEnabled: config.gmailDispatchEnabled
  });
});

// Queue an outbound email dispatch
app.post('/api/mail/dispatch', secureWrite('write:candidates'), (req, res) => {
  const parsed = dispatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const result = queueOutboundDispatch(parsed.data);
    return res.status(201).json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// Trigger send attempt for a queued dispatch
app.post('/api/mail/dispatch/:id/send', secureWrite('write:candidates'), async (req, res) => {
  try {
    const dispatch = await sendOutboundDispatch(req.params.id);
    return res.json(dispatch);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// Check outbound dispatch status
app.get('/api/mail/dispatch/:id', secure('read:candidates'), (req, res) => {
  const dispatch = getOutboundDispatch(req.params.id);
  if (!dispatch) {
    return res.status(404).json({ error: 'Dispatch not found' });
  }
  return res.json(dispatch);
});

// List dispatches (with optional status filter)
app.get('/api/mail/dispatches', secure('read:candidates'), (req, res) => {
  const dispatches = listOutboundDispatches({
    status: req.query.status,
    candidateId: req.query.candidateId
  });
  return res.json({ items: dispatches });
});

// ─── Document parsing endpoints ───────────────────────────────────────────────

const ingestDocSchema = z.object({
  candidateId: z.string().min(1).optional(),
  fileName: z.string().min(1),
  mimeType: z.string().optional(),
  text: z.string().optional(),
  storageRef: z.string().optional(),
  runNow: z.boolean().optional()
});

const enrichSchema = z.object({
  fields: z.record(z.string()),
  confidence: z.enum(['low', 'medium', 'high']).optional()
});

// Enqueue (or immediately run) a document parsing job
app.post('/api/documents/ingest', secureWrite('write:candidates'), async (req, res) => {
  const parsed = ingestDocSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const job = queueDocumentParsing(parsed.data);
    if (parsed.data.runNow) {
      const result = await runDocumentParsing(job.id);
      return res.status(201).json({ job: result });
    }
    return res.status(201).json({ job });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// Get parsing job status
app.get('/api/documents/:jobId/status', secure('read:candidates'), (req, res) => {
  const job = getDocumentParsingJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Parsing job not found' });
  }
  return res.json(job);
});

// List parsing jobs (filter by status or candidateId)
app.get('/api/documents/parsing-jobs', secure('read:candidates'), (req, res) => {
  const jobs = listDocumentParsingJobs({
    status: req.query.status,
    candidateId: req.query.candidateId
  });
  return res.json({ items: jobs });
});

// Enrich candidate from parsing result fields
app.patch('/api/candidates/:id/enrich', secureWrite('write:candidates'), (req, res) => {
  const parsed = enrichSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const candidate = applyCandidateEnrichment(
      req.params.id,
      parsed.data.fields,
      parsed.data.confidence || 'low'
    );
    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found' });
    }
    return res.json(candidate);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

function createServer() {
  return app;
}

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`Hiring automation API listening on http://localhost:${config.port}`);
  });
}

module.exports = {
  app,
  createServer
};
