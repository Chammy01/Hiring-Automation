'use strict';

/**
 * Shared text extraction helper used by both gmail-intake and doc-parser workers.
 *
 * Extracts plain text from PDF, DOCX/DOC, plain-text, or image buffers.
 * Returns `{ text: string, ocrUsed: boolean }`.
 *
 * Optional dependencies (gracefully absent):
 *   pdf-parse   — PDF text extraction
 *   mammoth     — DOCX/DOC text extraction
 *   tesseract.js — OCR fallback (only used when ocrEnabled = true)
 */

const path = require('node:path');

let pdfParse;
let mammoth;
let Tesseract;

try {
  const mod = require('pdf-parse');
  pdfParse = mod && (mod.default || mod);
} catch (_) { /* optional */ }

try { mammoth = require('mammoth'); } catch (_) { /* optional */ }

// Tesseract is loaded lazily on first call when ocrEnabled = true
let _tesseractLoaded = false;
function loadTesseract() {
  if (_tesseractLoaded) return;
  _tesseractLoaded = true;
  try { Tesseract = require('tesseract.js'); } catch (_) { /* optional */ }
}

/**
 * Extract raw text from a document buffer.
 *
 * @param {Buffer|null}  buffer        - file content (may be null if text already provided)
 * @param {string}       mimeType
 * @param {string}       fileName
 * @param {object}       [opts]
 * @param {string}       [opts.providedText='']  - pre-extracted text; skips extraction if non-empty
 * @param {boolean}      [opts.ocrEnabled=false] - allow Tesseract OCR fallback
 * @returns {Promise<{ text: string, ocrUsed: boolean }>}
 */
async function extractText(buffer, mimeType, fileName, opts = {}) {
  // Support both the old string API (providedText as 4th positional arg)
  // and the new object API for backward compatibility with existing tests.
  let providedText, ocrEnabled;
  if (typeof opts === 'string') {
    providedText = opts;
    ocrEnabled = false;
  } else {
    ({ providedText = '', ocrEnabled = false } = opts);
  }

  if (providedText && providedText.trim().length > 0) {
    return { text: providedText, ocrUsed: false };
  }

  const mime = String(mimeType || '').toLowerCase();
  const ext = path.extname(String(fileName || '')).toLowerCase();

  // PDF
  if ((mime === 'application/pdf' || ext === '.pdf') && buffer && pdfParse) {
    try {
      const parseFunc = typeof pdfParse === 'function' ? pdfParse : pdfParse.default;
      const data = await parseFunc(buffer);
      return { text: data.text || '', ocrUsed: false };
    } catch (err) {
      console.warn(`[extract-text] PDF extraction failed for "${fileName}":`, err.message);
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
      console.warn(`[extract-text] DOCX extraction error for "${fileName}":`, err.message);
    }
  }

  // Plain text
  if ((mime === 'text/plain' || ext === '.txt') && buffer) {
    return { text: buffer.toString('utf8'), ocrUsed: false };
  }

  // OCR fallback for images or when native extraction yielded nothing
  if (ocrEnabled && buffer) {
    loadTesseract();
    if (Tesseract) {
      const isImage =
        mime.startsWith('image/') ||
        ['.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.gif', '.webp'].includes(ext);
      const isPdf = mime === 'application/pdf' || ext === '.pdf';

      if (isImage || isPdf) {
        try {
          console.log(`[extract-text] Running OCR on "${fileName}"`);
          const { data: { text } } = await Tesseract.recognize(buffer, 'eng', {
            logger: () => {}
          });
          return { text: (text || '').trim(), ocrUsed: true };
        } catch (err) {
          console.warn(`[extract-text] OCR failed for "${fileName}":`, err.message);
        }
      }
    }
  }

  return { text: providedText || '', ocrUsed: false };
}

module.exports = { extractText };
