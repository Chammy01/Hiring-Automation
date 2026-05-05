const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const { config } = require('./config');
const { requirePermission } = require('./security');
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
  listAllPositions,
  addPosition,
  deletePosition,
  getDashboard,
  toSheetRows,
  listAuditLogs,
  listEmailEvents,
  listRetryQueue,
  getTemplates,
  updateTemplate,
  acknowledgementTemplate,
  getAnalytics,
  exportBackup,
  importBackup,
  getIntegrationsStatus,
  syncGoogleSheets,
  addCandidateNote,
  getCandidateNotes,
  bulkCandidateAction,
  registerWebhook,
  deleteWebhook,
  listWebhooks,
  sendDeadlineReminders,
  startReminderScheduler,
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

const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Restrict to configured origins in production; fall back to permissive in dev.
const allowedOriginsRaw = config.allowedOrigins || '';
const allowedOrigins = allowedOriginsRaw
  ? allowedOriginsRaw.split(',').map((o) => o.trim()).filter(Boolean)
  : [];

app.use(cors(
  allowedOrigins.length > 0
    ? {
        origin: (origin, callback) => {
          // Allow same-origin / non-browser requests (no Origin header)
          if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
          }
          return callback(new Error(`CORS: origin "${origin}" is not allowed`));
        },
        credentials: true
      }
    : undefined // permissive (dev/test)
));

// ─── Body size limits ─────────────────────────────────────────────────────────
// Large bodies are only accepted on document-upload routes (item 18).
const DEFAULT_JSON_LIMIT = '64kb';
const UPLOAD_JSON_LIMIT = '6mb';

app.use((req, res, next) => {
  // Document content upload endpoints accept larger bodies.
  const isUploadRoute =
    req.path.includes('/documents/content') ||
    req.path.includes('/documents/ingest') ||
    req.path.includes('/email/inbound');
  return express.json({ limit: isUploadRoute ? UPLOAD_JSON_LIMIT : DEFAULT_JSON_LIMIT })(req, res, next);
});

app.use(express.static('public'));

function createRateLimiter({ windowMs, max }) {
  const buckets = new Map();
  // Periodically evict expired buckets to prevent unbounded map growth.
  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now - bucket.start > windowMs) buckets.delete(key);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
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

function requireApiKey(req, res, next) {
  if (!config.hrApiKey) {
    return next();
  }
  if (req.headers['x-api-key'] !== config.hrApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
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
  res.json({ positions: listAllPositions() });
});

const positionSchema = z.object({
  name: z.string().min(2),
  checklist: z.array(z.string().min(1)).min(1)
});

app.post('/api/positions', secureWrite('write:candidates'), (req, res) => {
  const parsed = positionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const position = addPosition(parsed.data.name, parsed.data.checklist);
    return res.status(201).json(position);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete('/api/positions/:name', secureWrite('write:candidates'), (req, res) => {
  try {
    deletePosition(decodeURIComponent(req.params.name));
    return res.json({ deleted: true });
  } catch (error) {
    const status = error.message === 'Position not found' ? 404 : 400;
    return res.status(status).json({ error: error.message });
  }
});

app.get('/api/candidates', secure('read:candidates'), (req, res) => {
  const filters = {
    position: req.query.position,
    status: req.query.status,
    archived: req.query.archived
  };
  const allItems = listCandidates(filters);

  // Pagination — only applied when the `limit` query param is provided.
  // When omitted, the full list is returned for backward compatibility.
  const limitParam = parseInt(req.query.limit, 10);
  if (!limitParam || limitParam <= 0) {
    return res.json({ items: allItems, total: allItems.length });
  }
  const limit = Math.min(limitParam, 200);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const total = allItems.length;
  const totalPages = Math.ceil(total / limit);
  const start = (page - 1) * limit;
  const items = allItems.slice(start, start + limit);
  return res.json({ items, total, page, limit, totalPages });
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

const verifyExtractionSchema = z.object({
  educationalAttainment: z.string().optional(),
  workExperience: z.string().optional(),
  awards: z.string().optional(),
  trainings: z.string().optional(),
  cscEligibility: z.string().optional(),
  extractionConfidence: z.enum(['low', 'medium', 'high']).optional()
});

app.post('/api/candidates/:id/verify-extraction', secureWrite('write:candidates'), (req, res) => {
  const parsed = verifyExtractionSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const candidate = verifyCandidateExtraction(req.params.id, parsed.data);
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

app.post('/api/email-events/:id/retry', secureWrite('write:candidates'), (req, res) => {
  try {
    const event = retryEmailEvent(req.params.id);
    return res.json(event);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// Audit-log endpoint with optional search/filter + pagination (items 19 & 29).
app.get('/api/audit-logs', secure('read:audit'), (req, res) => {
  let items = listAuditLogs();

  // Filtering
  if (req.query.action) {
    items = items.filter((x) => x.action === req.query.action);
  }
  if (req.query.candidateId) {
    items = items.filter((x) => x.candidateId === req.query.candidateId);
  }
  if (req.query.since) {
    const since = new Date(req.query.since);
    if (!isNaN(since)) {
      items = items.filter((x) => new Date(x.timestamp) >= since);
    }
  }

  const total = items.length;
  const limitParam = parseInt(req.query.limit, 10);
  if (limitParam > 0) {
    const limit = Math.min(limitParam, 500);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const start = (page - 1) * limit;
    return res.json({ items: items.slice(start, start + limit), total, page, limit, totalPages: Math.ceil(total / limit) });
  }
  return res.json({ items, total });
});

// Email-events endpoint with pagination to avoid O(n) decrypt on every call (items 19 & 29).
app.get('/api/email-events', secure('read:email'), (req, res) => {
  let items = listEmailEvents();

  // Filtering
  if (req.query.status) {
    items = items.filter((x) => x.status === req.query.status);
  }
  if (req.query.candidateId) {
    items = items.filter((x) => x.candidateId === req.query.candidateId);
  }
  if (req.query.direction) {
    items = items.filter((x) => x.direction === req.query.direction);
  }

  const total = items.length;
  const limitParam = parseInt(req.query.limit, 10);
  if (limitParam > 0) {
    const limit = Math.min(limitParam, 200);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const start = (page - 1) * limit;
    return res.json({ items: items.slice(start, start + limit), total, page, limit, totalPages: Math.ceil(total / limit) });
  }
  return res.json({ items, total });
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

// ─── Candidate notes ──────────────────────────────────────────────────────────

const noteSchema = z.object({
  author: z.string().min(1).optional(),
  content: z.string().min(1)
});

app.post('/api/candidates/:id/notes', secureWrite('write:candidates'), (req, res) => {
  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const note = addCandidateNote(req.params.id, parsed.data);
    return res.status(201).json(note);
  } catch (error) {
    const status = error.message === 'Candidate not found' ? 404 : 400;
    return res.status(status).json({ error: error.message });
  }
});

app.get('/api/candidates/:id/notes', secure('read:candidates'), (req, res) => {
  try {
    const notes = getCandidateNotes(req.params.id);
    return res.json({ items: notes });
  } catch (error) {
    const status = error.message === 'Candidate not found' ? 404 : 400;
    return res.status(status).json({ error: error.message });
  }
});

// ─── Bulk candidate actions ───────────────────────────────────────────────────

const bulkActionSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
  action: z.enum(['shortlist', 'reject', 'followUp']),
  reason: z.string().optional()
});

app.post('/api/candidates/bulk', secureWrite('write:candidates'), (req, res) => {
  const parsed = bulkActionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const result = bulkCandidateAction(
      parsed.data.ids,
      parsed.data.action,
      parsed.data.reason ? { reason: parsed.data.reason } : {}
    );
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// ─── Webhook management ───────────────────────────────────────────────────────

const webhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string()).optional(),
  secret: z.string().optional()
});

app.get('/api/webhooks', secure('read:dashboard'), (_req, res) => {
  res.json({ items: listWebhooks() });
});

app.post('/api/webhooks', secureWrite('write:candidates'), (req, res) => {
  const parsed = webhookSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const hook = registerWebhook(parsed.data);
    return res.status(201).json(hook);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete('/api/webhooks/:id', secureWrite('write:candidates'), (req, res) => {
  try {
    deleteWebhook(req.params.id);
    return res.json({ deleted: true });
  } catch (error) {
    const status = error.message === 'Webhook not found' ? 404 : 400;
    return res.status(status).json({ error: error.message });
  }
});

// ─── Reminder trigger ─────────────────────────────────────────────────────────

app.post('/api/reminders/send', secureWrite('write:candidates'), (req, res) => {
  try {
    const result = sendDeadlineReminders();
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

function createServer() {
  return app;
}

// Global error handler — must be the last middleware registered.
// Catches errors thrown/passed from async route handlers.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[server] Unhandled error:', err.message || err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

if (require.main === module) {
  // Start reminder scheduler when running as the main process.
  startReminderScheduler();
  app.listen(config.port, () => {
    console.log(`Hiring automation API listening on http://localhost:${config.port}`);
  });
}

module.exports = {
  app,
  createServer
};
