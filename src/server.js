const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('node:path');
const crypto = require('node:crypto');
const { z } = require('zod');
const { config } = require('./config');
const { requirePermission } = require('./security');
const {
  issueJwtToken,
  verifyJwtToken,
  registerUser,
  listUsers,
  deleteUser,
  changeUserPassword,
  authenticateUser,
  recordAuthEvent,
  createCsrfToken
} = require('./auth');
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

function setSecurityHeaders(req, res, next) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; " +
    "base-uri 'self'; form-action 'self'"
  );
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (config.runtime.isProduction && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  return next();
}

app.use(setSecurityHeaders);

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(x => x.trim())
  : ['https://hiring-automation-production.up.railway.app'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    console.error('[CORS] Blocked request from:', origin);
    return callback(new Error('CORS origin is not allowed'));
  },
  credentials: true
}));

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

app.use(cookieParser());
app.use(express.static('public', { index: false }));

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

function buildAuthCookieOptions() {
  const shouldSecure = config.cookieSecure && !config.runtime.isTest && !config.runtime.isLocalDev;
  return {
    httpOnly: true,
    secure: shouldSecure,
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/'
  };
}

function setAuthCookies(res, token, csrfToken) {
  res.cookie('auth_token', token, buildAuthCookieOptions());
  res.cookie('csrf_token', csrfToken, {
    secure: buildAuthCookieOptions().secure,
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/'
  });
}

function clearAuthCookies(res) {
  const cookieOpts = {
    secure: buildAuthCookieOptions().secure,
    sameSite: 'strict',
    path: '/'
  };
  res.clearCookie('auth_token', { ...cookieOpts, httpOnly: true });
  res.clearCookie('csrf_token', cookieOpts);
}

function resolveJwtAuth(req) {
  const token = req.cookies && req.cookies.auth_token;
  if (!token) return null;
  try {
    const payload = verifyJwtToken(token);
    return {
      role: String(payload.role || 'viewer').toLowerCase(),
      actor: `user:${payload.sub}`,
      username: String(payload.sub || ''),
      method: 'jwt'
    };
  } catch (_error) {
    return null;
  }
}

function requireCsrfForJwt(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  if (!req.auth || req.auth.method !== 'jwt') {
    return next();
  }
  const cookieToken = req.cookies && req.cookies.csrf_token;
  const headerToken = String(req.headers['x-csrf-token'] || '');
  const cookieBuffer = cookieToken ? Buffer.from(cookieToken) : null;
  const headerBuffer = headerToken ? Buffer.from(headerToken) : null;
  const matches = cookieBuffer &&
    headerBuffer &&
    cookieBuffer.length === headerBuffer.length &&
    crypto.timingSafeEqual(cookieBuffer, headerBuffer);
  if (!matches) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  return next();
}

const loginFailures = new Map();
const MAX_LOGIN_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function getIpLoginBucket(ip) {
  const now = Date.now();
  for (const [key, bucket] of loginFailures.entries()) {
    if (now - bucket.start > LOGIN_WINDOW_MS) {
      loginFailures.delete(key);
    }
  }
  const bucket = loginFailures.get(ip);
  if (!bucket || now - bucket.start > LOGIN_WINDOW_MS) {
    const fresh = { start: now, failed: 0 };
    loginFailures.set(ip, fresh);
    return fresh;
  }
  return bucket;
}

function requireApiKey(req, res, next) {
  const jwtAuth = resolveJwtAuth(req);
  if (jwtAuth) {
    req.auth = jwtAuth;
    return next();
  }

  const provided = String(req.headers['x-api-key'] || '').trim();
  const role = config.hrApiKeys.get(provided);

  if (role) {
    req.auth = { role, actor: `apiKey:${role}` };
    return next();
  }

  if (config.runtime.isTest && !provided) {
    req.auth = { role: config.localAuthRole || 'hr', actor: 'local:test' };
    return next();
  }

  if (config.runtime.isLocalDev && !config.hrApiKeys.size) {
    req.auth = { role: config.localAuthRole || 'hr', actor: 'local:dev' };
    return next();
  }

  if (!provided) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

function secure(permission) {
  return [requireApiKey, requireCsrfForJwt, requirePermission(permission)];
}

const sensitiveActionLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

function secureWrite(permission) {
  return [sensitiveActionLimiter, requireApiKey, requireCsrfForJwt, requirePermission(permission)];
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
      mimeType: z.string().optional(),
      sizeBytes: z.number().int().nonnegative().optional()
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

const loginSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(1)
});

const registerSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(12),
  role: z.enum(['admin', 'hr', 'developer'])
});

const changePasswordSchema = z.object({
  password: z.string().min(12)
});

function requireDeveloperKey(req, res, next) {
  if (!config.developerKey) {
    return res.status(503).json({ error: 'Developer registration is not configured' });
  }
  const provided = String(req.headers['x-developer-key'] || req.query.key || '').trim();
  if (provided !== config.developerKey) {
    recordAuthEvent('auth.developer_key.denied', { ip: req.ip, path: req.path });
    return res.status(403).json({ error: 'Invalid developer key' });
  }
  return next();
}

app.get('/', (req, res) => {
  if (resolveJwtAuth(req)) {
    return res.sendFile(path.resolve('public/index.html'));
  }
  return res.redirect('/login');
});

app.get('/login', (_req, res) => {
  res.sendFile(path.resolve('public/login.html'));
});

app.get('/dev/register', requireDeveloperKey, (_req, res) => {
  res.sendFile(path.resolve('public/dev-register.html'));
});

app.post('/api/auth/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const ip = req.ip || 'unknown';
  const bucket = getIpLoginBucket(ip);
  if (bucket.failed >= MAX_LOGIN_FAILURES) {
    return res.status(429).json({ error: 'Too many failed login attempts. Try again later.' });
  }

  const user = await authenticateUser(parsed.data.username, parsed.data.password);
  if (!user) {
    bucket.failed += 1;
    recordAuthEvent('auth.login.failed', { ip, username: parsed.data.username });
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  bucket.failed = 0;
  bucket.start = Date.now();
  const token = issueJwtToken(user);
  const csrfToken = createCsrfToken();
  setAuthCookies(res, token, csrfToken);
  recordAuthEvent('auth.login.success', { ip, username: user.username, role: user.role });
  return res.json({ user, csrfToken });
});

app.post('/api/auth/logout', requireApiKey, requireCsrfForJwt, (req, res) => {
  clearAuthCookies(res);
  recordAuthEvent('auth.logout', { actor: req.auth && req.auth.actor, ip: req.ip });
  return res.json({ success: true });
});

app.get('/api/auth/verify', (req, res) => {
  const auth = resolveJwtAuth(req);
  if (!auth) {
    clearAuthCookies(res);
    return res.status(401).json({ valid: false });
  }
  const csrfToken = req.cookies && req.cookies.csrf_token ? req.cookies.csrf_token : createCsrfToken();
  if (!(req.cookies && req.cookies.csrf_token)) {
    res.cookie('csrf_token', csrfToken, {
      secure: buildAuthCookieOptions().secure,
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
      path: '/'
    });
  }
  return res.json({
    valid: true,
    user: { username: auth.username, role: auth.role },
    csrfToken
  });
});

app.post('/api/auth/register', requireDeveloperKey, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const user = await registerUser(parsed.data, {
      actor: req.auth && req.auth.actor ? req.auth.actor : 'developer-key',
      ip: req.ip
    });
    return res.status(201).json({ user });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get('/api/auth/users', requireDeveloperKey, (_req, res) => {
  return res.json({ items: listUsers() });
});

app.delete('/api/auth/users/:username', requireDeveloperKey, (req, res) => {
  try {
    const user = deleteUser(req.params.username, { ip: req.ip });
    return res.json({ deleted: true, user });
  } catch (error) {
    const status = error.message === 'User not found' ? 404 : 400;
    return res.status(status).json({ error: error.message });
  }
});

app.put('/api/auth/users/:username/password', requireDeveloperKey, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  try {
    const user = await changeUserPassword(req.params.username, parsed.data.password, { ip: req.ip });
    return res.json({ updated: true, user });
  } catch (error) {
    const status = error.message === 'User not found' ? 404 : 400;
    return res.status(status).json({ error: error.message });
  }
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

app.get('/api/backup', secure('write:backup'), (req, res) => {
  res.json(exportBackup({ actor: req.auth && req.auth.actor, role: req.auth && req.auth.role }));
});

app.post('/api/restore', secureWrite('write:backup'), (req, res) => {
  try {
    const restored = importBackup(req.body || {}, { actor: req.auth && req.auth.actor, role: req.auth && req.auth.role });
    return res.json({ restored });
  } catch (error) {
    console.error('[server] restore failed:', error.message);
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
  sizeBytes: z.number().int().nonnegative().optional(),
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

app.get('/api/webhooks', secure('manage:webhooks'), (_req, res) => {
  res.json({ items: listWebhooks() });
});

app.post('/api/webhooks', secureWrite('manage:webhooks'), (req, res) => {
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

app.delete('/api/webhooks/:id', secureWrite('manage:webhooks'), (req, res) => {
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

function resetAuthRuntimeState() {
  loginFailures.clear();
}

// Global error handler — must be the last middleware registered.
// Catches errors thrown/passed from async route handlers.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[server] Unhandled error:', err && err.stack ? err.stack : (err.message || err));
  const status = err.status || err.statusCode || 500;
  const isClientError = status >= 400 && status < 500;
  res.status(status).json({ error: isClientError ? (err.message || 'Request failed') : 'Internal server error' });
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
  createServer,
  resetAuthRuntimeState
};
