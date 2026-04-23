'use strict';

/**
 * Shared low-level utility functions used across services, workers, and
 * integrations. Centralising them here removes the duplicate definitions
 * that previously existed in services.js, gmail-intake.js and
 * gmail-dispatcher.js.
 */

/**
 * Lowercase-trim a value for case-insensitive comparisons.
 * @param {*} value
 * @returns {string}
 */
function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Return the current time as an ISO-8601 string.
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Paginate a pre-filtered array.
 *
 * @param {Array}  items
 * @param {number|null} page  1-based page number; null = no pagination
 * @param {number|null} limit items per page; null = no pagination
 * @returns {{ items: Array, total: number, page: number|null, limit: number|null, totalPages: number|null }}
 */
function paginate(items, page, limit) {
  const total = items.length;

  if (!page || !limit || page < 1 || limit < 1) {
    return { items, total, page: null, limit: null, totalPages: null };
  }

  const totalPages = Math.ceil(total / limit);
  const start = (page - 1) * limit;
  return {
    items: items.slice(start, start + limit),
    total,
    page,
    limit,
    totalPages
  };
}

module.exports = { normalize, nowIso, paginate };
