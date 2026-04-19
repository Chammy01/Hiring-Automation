const crypto = require('node:crypto');
const { config } = require('./config');
const { ROLE_PERMISSIONS } = require('./constants');

function deriveKey() {
  return crypto.createHash('sha256').update(String(config.encryptionKey)).digest();
}

function encryptText(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decryptText(cipherText) {
  const raw = Buffer.from(String(cipherText), 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return plain.toString('utf8');
}

function resolveRole(req) {
  return String(req.headers[config.roleHeader] || 'viewer').toLowerCase();
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
  hasPermission
};
