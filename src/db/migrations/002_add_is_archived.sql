-- Migration: 002_add_is_archived
-- Adds is_archived flag to candidates to support soft-archiving.

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_candidates_is_archived ON candidates (is_archived);
