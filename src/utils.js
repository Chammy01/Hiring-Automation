'use strict';

/**
 * Shared utility helpers used across services, workers, and integrations.
 */

function nowIso() {
  return new Date().toISOString();
}

module.exports = { nowIso };
