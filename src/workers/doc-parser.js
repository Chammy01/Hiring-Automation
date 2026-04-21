#!/usr/bin/env node
'use strict';

/**
 * Asynchronous document parsing worker.
 *
 * Processes parsingJobs from the JSON store (or PostgreSQL when enabled):
 *  1. Extracts raw text from PDF or DOCX.
 *  2. If native extraction yields no text and OCR_ENABLED=true, falls back to Tesseract OCR.
 *  3. Parses extracted text into structured fields using deterministic heuristics.
 *  4. Persists raw text + structured result + confidence score.
 *  5. Optionally enriches the linked candidate record.
 *
 * Supported input formats (via content buffer or text already provided):
 *  - PDF  (uses pdf-parse)
 *  - DOCX / DOC (uses mammoth)
 *  - PNG / JPG / TIFF images (OCR via tesseract.js — requires OCR_ENABLED=true)
 *  - Plain text
 *
 * Usage (standalone):
 *   node src/workers/doc-parser.js            # single pass
 *   node src/workers/doc-parser.js --watch    # poll on interval
 *
 * Environment variables (see .env.example):
 *   OCR_ENABLED              - "true" to enable Tesseract OCR fallback
 *   OCR_WORKER_CONCURRENCY   - parallel jobs (default: 2)
 *   OCR_WORKER_POLL_MS       - poll interval in watch mode (default: 5000)
 */

require('dotenv').config();

const crypto = require('node:crypto');
const path = require('node:path');
const { readStore, updateStore } = require('../store');
const { config } = require('../config');

// ─── Optional text extraction libs ───────────────────────────────────────────

let pdfParse;
let mammoth;
let Tesseract;

try { pdfParse = require('pdf-parse'); } catch (_) { /* optional */ }
try { mammoth = require('mammoth'); } catch (_) { /* optional */ }
if (config.ocrEnabled) {
  try { Tesseract = require('tesseract.js'); } catch (_) {
    console.warn('[doc-parser] tesseract.js not available — OCR disabled');
  }
}

// ─── Text extraction ──────────────────────────────────────────────────────────

/**
 * Extract raw text from a document buffer.
 *
 * @param {Buffer|null} buffer  - file content (may be null if only text provided)
 * @param {string}      mimeType
 * @param {string}      fileName
 * @param {string}      [providedText] - pre-extracted text (skips extraction if non-empty)
 * @returns {Promise<{ text: string, ocrUsed: boolean }>}
 */
async function extractText(buffer, mimeType, fileName, providedText = '') {
  if (providedText && providedText.trim().length > 20) {
    return { text: providedText, ocrUsed: false };
  }

  const mime = String(mimeType || '').toLowerCase();
  const ext = path.extname(String(fileName || '')).toLowerCase();

  // PDF
  if ((mime === 'application/pdf' || ext === '.pdf') && buffer && pdfParse) {
    try {
      const parseFunc = typeof pdfParse === 'function' ? pdfParse : pdfParse.default;
      const data = await pdfParse(buffer);
      const text = (data.text || '').trim();
      if (text.length > 0) {
        return { text, ocrUsed: false };
      }
      // Fall through to OCR if no text in PDF (image-only PDF)
    } catch (err) {
      console.warn(`[doc-parser] PDF extraction error for "${fileName}":`, err.message);
    }
  }

  // DOCX / DOC
  if (
    (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mime === 'application/msword' ||
      ext === '.docx' ||
      ext === '.doc') &&
    buffer &&
    mammoth
  ) {
    try {
      const result = await mammoth.extractRawText({ buffer });
      const text = (result.value || '').trim();
      if (text.length > 0) {
        return { text, ocrUsed: false };
      }
    } catch (err) {
      console.warn(`[doc-parser] DOCX extraction error for "${fileName}":`, err.message);
    }
  }

  // Plain text
  if ((mime === 'text/plain' || ext === '.txt') && buffer) {
    return { text: buffer.toString('utf8'), ocrUsed: false };
  }

  // OCR fallback for images or when native extraction yielded nothing
  if (config.ocrEnabled && Tesseract && buffer) {
    const isImage =
      mime.startsWith('image/') ||
      ['.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.gif', '.webp'].includes(ext);
    const isPdf = mime === 'application/pdf' || ext === '.pdf';

    if (isImage || isPdf) {
      try {
        console.log(`[doc-parser] Running OCR on "${fileName}"`);
        const { data: { text } } = await Tesseract.recognize(buffer, 'eng', {
          logger: () => {} // suppress progress logs
        });
        return { text: (text || '').trim(), ocrUsed: true };
      } catch (err) {
        console.warn(`[doc-parser] OCR failed for "${fileName}":`, err.message);
      }
    }
  }

  return { text: providedText || '', ocrUsed: false };
}

// ─── Structured field parsing ─────────────────────────────────────────────────

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(?:\+?63|0)[\s\-]?[0-9]{3}[\s\-]?[0-9]{3}[\s\-]?[0-9]{4}|(?:\+?[0-9]{1,3}[\s\-]?)?(?:\([0-9]{1,4}\)[\s\-]?)?[0-9]{6,}/;

const SKILLS_KEYWORDS = [
  'microsoft office', 'excel', 'word', 'powerpoint', 'outlook', 'google workspace',
  'data entry', 'typing', 'filing', 'records management', 'customer service',
  'communication', 'teamwork', 'leadership', 'problem solving', 'time management',
  'java', 'python', 'javascript', 'html', 'css', 'sql', 'php', 'c++', 'c#',
  'project management', 'budgeting', 'accounting', 'bookkeeping', 'auditing',
  'nursing', 'patient care', 'medical', 'teaching', 'curriculum', 'research'
];

/**
 * Parse structured fields from extracted text using deterministic heuristics.
 *
 * @param {string} text - Raw extracted text
 * @param {string} [fileName] - Original file name (used as hint)
 * @returns {{ fields: object, confidence: string, notes: string[] }}
 */
function parseStructuredFields(text, fileName = '') {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  const notes = [];
  const fields = {};
  let confidenceScore = 0;

  // ── Email ──────────────────────────────────────────────────────────────────
  const emailMatch = raw.match(EMAIL_RE);
  if (emailMatch) {
    fields.email = emailMatch[0];
    confidenceScore += 20;
  } else {
    notes.push('No email address found');
  }

  // ── Phone ──────────────────────────────────────────────────────────────────
  const phoneMatch = raw.match(PHONE_RE);
  if (phoneMatch) {
    fields.phone = phoneMatch[0].replace(/\s+/g, ' ').trim();
    confidenceScore += 10;
  }

  // ── Name — try to extract from first non-empty line or "Name:" label ───────
  const nameLabel = raw.match(/(?:name|full\s*name|applicant)\s*[:\-]\s*(.+)/i);
  if (nameLabel && nameLabel[1].trim().length > 1) {
    fields.name = nameLabel[1].trim().replace(/\s+/g, ' ');
    confidenceScore += 20;
  } else {
    // Heuristic: first line that looks like a name (2+ words, no digits)
    const firstLines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 5);
    for (const line of firstLines) {
      if (/^[A-ZÑ][a-záéíóúñ]+ [A-ZÑ]/.test(line) && !/\d/.test(line)) {
        fields.name = line.replace(/\s+/g, ' ');
        confidenceScore += 10;
        notes.push('Name extracted heuristically from first lines');
        break;
      }
    }
  }

  // ── Education ─────────────────────────────────────────────────────────────
  if (lower.includes('doctor') || lower.includes('ph.d') || lower.includes('phd')) {
    fields.educationalAttainment = 'Doctorate';
    confidenceScore += 15;
  } else if (lower.includes('master') || lower.includes('m.a.') || lower.includes('m.s.') || lower.includes('mba')) {
    fields.educationalAttainment = 'Graduate School';
    confidenceScore += 15;
  } else if (lower.includes('bachelor') || lower.includes('b.s.') || lower.includes('b.a.') || lower.includes('college')) {
    fields.educationalAttainment = 'College Graduate';
    confidenceScore += 15;
  } else if (lower.includes('senior high') || lower.includes('grade 12')) {
    fields.educationalAttainment = 'Senior High School';
    confidenceScore += 10;
  } else if (lower.includes('high school') || lower.includes('secondary')) {
    fields.educationalAttainment = 'High School';
    confidenceScore += 8;
  } else {
    notes.push('Education level not detected');
  }

  // ── Experience ────────────────────────────────────────────────────────────
  const expMatch = lower.match(/(\d+)\s*(?:\+)?\s*years?\s*(?:of\s+)?(?:work\s+)?experience/);
  const expMonths = lower.match(/(\d+)\s*months?\s*(?:of\s+)?(?:work\s+)?experience/);
  if (expMatch) {
    const years = Number(expMatch[1]);
    fields.experienceYears = years;
    fields.workExperience =
      years >= 4 ? 'More than 3 years' : years >= 1 ? '1-3 years' : 'Less than 1 year';
    confidenceScore += 15;
  } else if (expMonths) {
    const months = Number(expMonths[1]);
    fields.experienceMonths = months;
    fields.workExperience = months < 12 ? 'Less than 1 year' : '1-3 years';
    confidenceScore += 8;
  } else {
    notes.push('Work experience duration not detected');
  }

  // ── CSC Eligibility ───────────────────────────────────────────────────────
  if (lower.includes('professional') && (lower.includes('civil service') || lower.includes('csc'))) {
    fields.cscEligibility = 'Professional';
    confidenceScore += 15;
  } else if (lower.includes('sub-prof') || lower.includes('subprof') || lower.includes('sub professional')) {
    fields.cscEligibility = 'Sub-Professional';
    confidenceScore += 15;
  } else if (lower.includes('honor graduate') || lower.includes('cum laude')) {
    fields.cscEligibility = 'Honor Graduate Eligibility';
    confidenceScore += 10;
  } else if (lower.includes('prc') || lower.includes('professional regulation')) {
    fields.cscEligibility = 'PRC';
    confidenceScore += 10;
  }

  // ── Awards / Trainings ────────────────────────────────────────────────────
  if (lower.includes('cum laude') || lower.includes('award') || lower.includes('honor')) {
    fields.awards = 'With awards';
    confidenceScore += 5;
  }
  if (lower.includes('training') || lower.includes('seminar') || lower.includes('workshop')) {
    fields.trainings = 'With trainings';
    confidenceScore += 5;
  }

  // ── Skills list ───────────────────────────────────────────────────────────
  const matchedSkills = SKILLS_KEYWORDS.filter((skill) => lower.includes(skill));
  if (matchedSkills.length > 0) {
    fields.skills = matchedSkills;
    confidenceScore += Math.min(matchedSkills.length * 2, 10);
  }

  // ── Compute confidence label ──────────────────────────────────────────────
  const confidence =
    confidenceScore >= 70
      ? 'high'
      : confidenceScore >= 40
        ? 'medium'
        : 'low';

  return { fields, confidence, notes };
}

// ─── Job lifecycle (JSON store) ───────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

/**
 * Enqueue a document parsing job.
 *
 * @param {object} opts
 * @param {string}  opts.candidateId
 * @param {string}  opts.fileName
 * @param {string}  [opts.mimeType]
 * @param {string}  [opts.text]        - Pre-extracted text (skips extraction step)
 * @param {string}  [opts.storageRef]  - Path or URL to file (for future retrieval)
 * @param {number}  [opts.maxRetries]
 * @returns {object} The created job record
 */
function enqueueParsingJob(opts = {}) {
  const job = {
    id: crypto.randomUUID(),
    candidateId: opts.candidateId || null,
    fileName: opts.fileName || 'unknown',
    mimeType: opts.mimeType || '',
    text: opts.text || null,
    storageRef: opts.storageRef || null,
    status: 'queued',
    retryCount: 0,
    maxRetries: opts.maxRetries != null ? opts.maxRetries : 3,
    lastError: null,
    rawText: null,
    structuredFields: null,
    confidence: null,
    ocrUsed: false,
    queuedAt: nowIso(),
    startedAt: null,
    completedAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  updateStore((state) => {
    if (!Array.isArray(state.parsingJobs)) {
      state.parsingJobs = [];
    }
    state.parsingJobs.push(job);
    return state;
  });

  return job;
}

function getParsingJob(id) {
  return readStore().parsingJobs.find((j) => j.id === id) || null;
}

function updateParsingJob(id, fields) {
  updateStore((state) => {
    const job = (state.parsingJobs || []).find((j) => j.id === id);
    if (job) {
      Object.assign(job, fields, { updatedAt: nowIso() });
    }
    return state;
  });
}

function listParsingJobs(filters = {}) {
  const jobs = readStore().parsingJobs || [];
  return jobs.filter((j) => {
    if (filters.status && j.status !== filters.status) return false;
    if (filters.candidateId && j.candidateId !== filters.candidateId) return false;
    return true;
  });
}

// ─── Process a single job ─────────────────────────────────────────────────────

/**
 * Process a parsing job end-to-end.
 * Updates job status (queued → processing → succeeded | failed) in the store.
 *
 * @param {string} jobId
 * @param {object} [runtimeOpts]
 * @param {Buffer|null} [runtimeOpts.buffer] - file buffer (if available in memory)
 * @returns {Promise<object>} Completed job record
 */
async function processParsingJob(jobId, runtimeOpts = {}) {
  const job = getParsingJob(jobId);
  if (!job) throw new Error(`Parsing job not found: ${jobId}`);

  if (job.status === 'succeeded') {
    return job;
  }

  updateParsingJob(jobId, { status: 'processing', startedAt: nowIso() });

  try {
    const buffer = runtimeOpts.buffer || null;
    const { text: rawText, ocrUsed } = await extractText(
      buffer,
      job.mimeType,
      job.fileName,
      job.text || ''
    );

    const { fields, confidence, notes } = parseStructuredFields(rawText, job.fileName);

    updateParsingJob(jobId, {
      status: 'succeeded',
      rawText,
      structuredFields: fields,
      confidence,
      ocrUsed,
      notes: notes.join('; '),
      completedAt: nowIso()
    });

    // Optionally enrich candidate record
    if (job.candidateId) {
      enrichCandidateFromFields(job.candidateId, fields, confidence);
    }

    console.log(
      `[doc-parser] Job ${jobId} succeeded — confidence=${confidence}, ocrUsed=${ocrUsed}, fields=${Object.keys(fields).join(',')}`
    );

    return getParsingJob(jobId);
  } catch (err) {
    const retryCount = (job.retryCount || 0) + 1;
    const failed = retryCount > job.maxRetries;

    updateParsingJob(jobId, {
      status: failed ? 'failed' : 'queued',
      retryCount,
      lastError: err.message,
      startedAt: failed ? job.startedAt : null
    });

    console.error(`[doc-parser] Job ${jobId} ${failed ? 'failed' : 'will retry'}: ${err.message}`);

    if (failed) throw err;
    return getParsingJob(jobId);
  }
}

// ─── Candidate enrichment ─────────────────────────────────────────────────────

function enrichCandidateFromFields(candidateId, fields, confidence) {
  updateStore((state) => {
    const candidate = (state.candidates || []).find((c) => c.id === candidateId);
    if (!candidate) return state;

    if (fields.educationalAttainment) {
      candidate.educationalAttainment = fields.educationalAttainment;
    }
    if (fields.workExperience) {
      candidate.workExperience = fields.workExperience;
    }
    if (fields.awards) {
      candidate.awards = fields.awards;
    }
    if (fields.trainings) {
      candidate.trainings = fields.trainings;
    }
    if (fields.cscEligibility) {
      candidate.cscEligibility = fields.cscEligibility;
    }

    // Only upgrade extraction confidence — never downgrade
    const rank = { low: 0, medium: 1, high: 2 };
    if ((rank[confidence] || 0) > (rank[candidate.extractionConfidence] || 0)) {
      candidate.extractionConfidence = confidence;
    }

    if (confidence !== 'high' && !state.verificationQueue.find(
      (v) => v.candidateId === candidateId && v.status === 'pending'
    )) {
      state.verificationQueue.push({
        id: crypto.randomUUID(),
        candidateId,
        createdAt: nowIso(),
        status: 'pending',
        reason: `Parsing confidence is ${confidence}`
      });
    }

    candidate.updatedAt = nowIso();
    return state;
  });
}

// ─── Worker loop ──────────────────────────────────────────────────────────────

async function runOnce(concurrency = config.ocrWorkerConcurrency) {
  const pending = listParsingJobs({ status: 'queued' });
  if (pending.length === 0) {
    return 0;
  }

  console.log(`[doc-parser] Processing ${pending.length} queued job(s) (concurrency=${concurrency})`);

  let processed = 0;
  for (let i = 0; i < pending.length; i += concurrency) {
    const batch = pending.slice(i, i + concurrency);
    await Promise.allSettled(
      batch.map(async (job) => {
        try {
          await processParsingJob(job.id);
          processed++;
        } catch (err) {
          console.error(`[doc-parser] Worker error for job ${job.id}:`, err.message);
        }
      })
    );
  }

  return processed;
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

if (require.main === module) {
  const WATCH_MODE = process.argv.includes('--watch');
  const POLL_MS = config.ocrWorkerPollMs;

  if (WATCH_MODE) {
    console.log(`[doc-parser] Watch mode: polling every ${POLL_MS}ms`);
    const tick = async () => {
      const count = await runOnce().catch((err) => {
        console.error('[doc-parser] Run error:', err.message);
        return 0;
      });
      if (count > 0) console.log(`[doc-parser] Processed ${count} job(s)`);
    };
    tick();
    setInterval(tick, POLL_MS);
  } else {
    runOnce()
      .then((n) => {
        console.log(`[doc-parser] Done — processed ${n} job(s)`);
      })
      .catch((err) => {
        console.error('[doc-parser] Fatal error:', err.message);
        process.exit(1);
      });
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  enqueueParsingJob,
  processParsingJob,
  getParsingJob,
  listParsingJobs,
  parseStructuredFields,
  extractText,
  enrichCandidateFromFields,
  runOnce
};
