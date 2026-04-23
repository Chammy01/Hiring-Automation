const crypto = require('node:crypto');
const { config } = require('./config');
const { ROLE_PERMISSIONS } = require('./constants');

// ─── Key derivation ───────────────────────────────────────────────────────────

// Fixed application-specific salt for scrypt.
// Using a fixed salt is acceptable here because the ENCRYPTION_KEY is expected
// to be a high-entropy random secret (not a user password).  The salt still
// prevents precomputation attacks tied to other applications that happen to use
// the same raw key material.
const SCRYPT_SALT = Buffer.from('hiring-automation-aes-gcm-v2', 'utf8');

// Cache the derived key so scrypt only runs once per process (it is deliberately slow).
let _scryptKey = null;
let _scryptKeySource = null;

function deriveKeyScrypt() {
  if (_scryptKey && _scryptKeySource === config.encryptionKey) {
    return _scryptKey;
  }
  _scryptKey = crypto.scryptSync(String(config.encryptionKey), SCRYPT_SALT, 32, {
    N: 16384,
    r: 8,
    p: 1
  });
  _scryptKeySource = config.encryptionKey;
  return _scryptKey;
}

// Legacy SHA-256 key derivation — only used to decrypt pre-existing data.
function deriveKeySha256() {
  return crypto.createHash('sha256').update(String(config.encryptionKey)).digest();
}

// ─── Encrypt / decrypt ────────────────────────────────────────────────────────

/**
 * Encrypt plain text with AES-256-GCM.
 * Output format: "v2:" + base64(iv[12] + authTag[16] + ciphertext)
 * Legacy decryptable output (no prefix) used SHA-256; new output uses scrypt.
 */
function encryptText(plainText) {
  const key = deriveKeyScrypt();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return 'v2:' + Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

/**
 * Decrypt text produced by encryptText.
 * Handles both the new "v2:" scrypt format and the legacy SHA-256 format
 * so that data encrypted before the upgrade continues to be readable.
 */
function decryptText(cipherText) {
  const s = String(cipherText || '');

  // Detect format version.
  let raw;
  let key;
  if (s.startsWith('v2:')) {
    raw = Buffer.from(s.slice(3), 'base64');
    key = deriveKeyScrypt();
  } else {
    // Legacy format — try SHA-256 key first; fall back to scrypt for any future
    // re-encryption race during rolling upgrades.
    raw = Buffer.from(s, 'base64');
    key = deriveKeySha256();
  }

  try {
    const iv = raw.subarray(0, 12);
    const authTag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return plain.toString('utf8');
  } catch (_err) {
    // If the legacy path failed, try the scrypt key as a last resort
    // (handles the case where data was re-encrypted before this branch ran).
    if (!s.startsWith('v2:')) {
      try {
        const scryptKey = deriveKeyScrypt();
        const iv = raw.subarray(0, 12);
        const authTag = raw.subarray(12, 28);
        const encrypted = raw.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', scryptKey, iv);
        decipher.setAuthTag(authTag);
        const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        return plain.toString('utf8');
      } catch (_err2) {
        // Irrecoverably corrupted — return placeholder
        return '[encrypted body — unreadable]';
      }
    }
    return '[encrypted body — unreadable]';
  }
}

// ─── Multi-key role resolution ────────────────────────────────────────────────

/**
 * Resolve the role that corresponds to the presented API key.
 * Returns the role string ('admin' | 'hr' | 'viewer') or null if the key is
 * not recognised.  Returns null when called with no key.
 */
function resolveRoleFromApiKey(apiKey) {
  if (!apiKey) return null;
  if (config.apiKeyAdmin && apiKey === config.apiKeyAdmin) return 'admin';
  if (config.apiKeyHr && apiKey === config.apiKeyHr) return 'hr';
  if (config.apiKeyViewer && apiKey === config.apiKeyViewer) return 'viewer';
  return null; // key provided but not recognised
}

/**
 * Determine whether any role-specific API key has been configured.
 * When no keys are configured the application is running in dev/open mode and
 * the role header is trusted directly.
 */
function anyApiKeyConfigured() {
  return Boolean(config.apiKeyAdmin || config.apiKeyHr || config.apiKeyViewer);
}

/**
 * Resolve the effective role for the incoming request.
 *
 * Resolution order:
 *  1. req._resolvedRole — set by requireApiKey middleware when a valid key was
 *     presented (authoritative).
 *  2. x-role header — only trusted when NO API keys are configured (dev mode).
 *     Ignored in production to prevent role-spoofing.
 *  3. Fallback: 'viewer'
 */
function resolveRole(req) {
  if (req._resolvedRole) {
    return req._resolvedRole;
  }
  if (!anyApiKeyConfigured()) {
    // Dev / test mode — no keys configured, trust the header.
    return String(req.headers[config.roleHeader] || 'viewer').toLowerCase();
  }
  return 'viewer';
}

function hasPermission(role, permission) {
  const allowed = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.viewer;
  return allowed.includes('*') || allowed.includes(permission);
}

function requirePermission(permission) {
  return (req, res, next) => {
    const role = resolveRole(req);
    if (!hasPermission(role, permission)) {
      return res.status(403).json({ error: 'Forbidden', requiredPermission: permission, role });
    }
    return next();
  };
}

module.exports = {
  encryptText,
  decryptText,
  requirePermission,
  resolveRole,
  resolveRoleFromApiKey,
  anyApiKeyConfigured,
  hasPermission
};

