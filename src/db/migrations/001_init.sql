-- Migration: 001_init
-- Core schema for Hiring Automation PostgreSQL persistence layer.
-- Run with: node src/db/migrate.js
--
-- Tables created:
--   candidates, jobs, applications,
--   email_threads, email_messages, outbound_dispatches,
--   documents, parsing_results, worker_jobs

-- ─── Candidates ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS candidates (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name            TEXT        NOT NULL,
  email                TEXT        NOT NULL,
  phone                TEXT,
  position             TEXT        NOT NULL,
  workflow_state       TEXT        NOT NULL DEFAULT 'Applied',
  status_of_application TEXT       NOT NULL DEFAULT 'Hiring',
  educational_attainment TEXT      NOT NULL DEFAULT 'Unknown',
  work_experience      TEXT        NOT NULL DEFAULT 'Unknown',
  awards               TEXT        NOT NULL DEFAULT 'None submitted',
  trainings            TEXT        NOT NULL DEFAULT 'None submitted',
  csc_eligibility      TEXT        NOT NULL DEFAULT 'Unknown',
  special_note         TEXT        NOT NULL DEFAULT '',
  link                 TEXT        NOT NULL DEFAULT '',
  email_sent           BOOLEAN     NOT NULL DEFAULT FALSE,
  confirmed_attendance BOOLEAN     NOT NULL DEFAULT FALSE,
  extraction_confidence TEXT       NOT NULL DEFAULT 'low',
  document_status      JSONB       NOT NULL DEFAULT '{}',
  required_documents   JSONB       NOT NULL DEFAULT '[]',
  compliance           JSONB       NOT NULL DEFAULT '{"subjectFormatValid":true,"submittedBeforeDeadline":true,"disqualified":false,"reasons":[]}',
  recommendation       JSONB       NOT NULL DEFAULT '{"score":0,"reason":"Not scored yet","rankLabel":"Unranked","breakdown":{}}',
  interview_schedule   JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_candidates_email        ON candidates (lower(email));
CREATE INDEX IF NOT EXISTS idx_candidates_position     ON candidates (lower(position));
CREATE INDEX IF NOT EXISTS idx_candidates_workflow     ON candidates (workflow_state);
CREATE INDEX IF NOT EXISTS idx_candidates_created_at   ON candidates (created_at DESC);

-- ─── Jobs (open positions) ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jobs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT        NOT NULL,
  department  TEXT,
  description TEXT,
  visibility  TEXT        NOT NULL DEFAULT 'public',
  open_date   TIMESTAMPTZ,
  close_date  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jobs_title      ON jobs (lower(title));
CREATE INDEX IF NOT EXISTS idx_jobs_visibility ON jobs (visibility);

-- ─── Applications ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS applications (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id UUID        NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  job_id       UUID        REFERENCES jobs(id) ON DELETE SET NULL,
  status       TEXT        NOT NULL DEFAULT 'applied',
  source       TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_applications_candidate  ON applications (candidate_id);
CREATE INDEX IF NOT EXISTS idx_applications_job        ON applications (job_id);
CREATE INDEX IF NOT EXISTS idx_applications_status     ON applications (status);
CREATE INDEX IF NOT EXISTS idx_applications_created_at ON applications (created_at DESC);

-- ─── Email Threads ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_threads (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_thread_id  TEXT        UNIQUE,
  candidate_id        UUID        REFERENCES candidates(id) ON DELETE SET NULL,
  subject             TEXT,
  last_message_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_threads_provider   ON email_threads (provider_thread_id);
CREATE INDEX IF NOT EXISTS idx_email_threads_candidate  ON email_threads (candidate_id);

-- ─── Email Messages ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_messages (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_message_id TEXT        UNIQUE NOT NULL,
  thread_id           UUID        REFERENCES email_threads(id) ON DELETE CASCADE,
  candidate_id        UUID        REFERENCES candidates(id) ON DELETE SET NULL,
  direction           TEXT        NOT NULL DEFAULT 'inbound',  -- inbound | outbound
  sender_email        TEXT        NOT NULL,
  sender_name         TEXT,
  recipient_emails    JSONB       NOT NULL DEFAULT '[]',
  subject             TEXT,
  body_text           TEXT,
  body_html           TEXT,
  attachment_meta     JSONB       NOT NULL DEFAULT '[]',
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_messages_provider   ON email_messages (provider_message_id);
CREATE INDEX IF NOT EXISTS idx_email_messages_candidate         ON email_messages (candidate_id);
CREATE INDEX IF NOT EXISTS idx_email_messages_thread            ON email_messages (thread_id);
CREATE INDEX IF NOT EXISTS idx_email_messages_direction         ON email_messages (direction);
CREATE INDEX IF NOT EXISTS idx_email_messages_received_at       ON email_messages (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_sender            ON email_messages (lower(sender_email));

-- ─── Outbound Dispatches ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outbound_dispatches (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id    UUID        REFERENCES candidates(id) ON DELETE SET NULL,
  to_email        TEXT        NOT NULL,
  from_email      TEXT        NOT NULL,
  subject         TEXT        NOT NULL,
  body            TEXT        NOT NULL,
  template_key    TEXT,
  template_vars   JSONB       NOT NULL DEFAULT '{}',
  status          TEXT        NOT NULL DEFAULT 'queued',  -- queued | sending | sent | failed
  provider        TEXT        NOT NULL DEFAULT 'gmail',
  provider_msg_id TEXT,
  retry_count     INT         NOT NULL DEFAULT 0,
  max_retries     INT         NOT NULL DEFAULT 3,
  last_error      TEXT,
  queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  next_retry_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbound_dispatches_status        ON outbound_dispatches (status);
CREATE INDEX IF NOT EXISTS idx_outbound_dispatches_candidate     ON outbound_dispatches (candidate_id);
CREATE INDEX IF NOT EXISTS idx_outbound_dispatches_queued_at     ON outbound_dispatches (queued_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbound_dispatches_next_retry    ON outbound_dispatches (next_retry_at) WHERE status = 'failed';

-- ─── Documents ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS documents (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id   UUID        REFERENCES candidates(id) ON DELETE CASCADE,
  file_name      TEXT        NOT NULL,
  mime_type      TEXT,
  file_size      INT,
  storage_ref    TEXT,
  doc_type       TEXT,
  status         TEXT        NOT NULL DEFAULT 'uploaded',  -- uploaded | parsed | failed
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_candidate  ON documents (candidate_id);
CREATE INDEX IF NOT EXISTS idx_documents_status     ON documents (status);
CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents (created_at DESC);

-- ─── Parsing Results ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS parsing_results (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id        UUID        REFERENCES documents(id) ON DELETE CASCADE,
  candidate_id       UUID        REFERENCES candidates(id) ON DELETE CASCADE,
  raw_text           TEXT,
  structured_fields  JSONB       NOT NULL DEFAULT '{}',
  confidence         TEXT        NOT NULL DEFAULT 'low',
  notes              TEXT,
  ocr_used           BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_parsing_results_document   ON parsing_results (document_id);
CREATE INDEX IF NOT EXISTS idx_parsing_results_candidate  ON parsing_results (candidate_id);

-- ─── Worker Jobs ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS worker_jobs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type      TEXT        NOT NULL,  -- parse_document | dispatch_email | gmail_sync
  payload       JSONB       NOT NULL DEFAULT '{}',
  status        TEXT        NOT NULL DEFAULT 'queued',  -- queued | processing | succeeded | failed
  priority      INT         NOT NULL DEFAULT 0,
  retry_count   INT         NOT NULL DEFAULT 0,
  max_retries   INT         NOT NULL DEFAULT 3,
  last_error    TEXT,
  worker_id     TEXT,
  queued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_worker_jobs_status       ON worker_jobs (status);
CREATE INDEX IF NOT EXISTS idx_worker_jobs_type_status  ON worker_jobs (job_type, status);
CREATE INDEX IF NOT EXISTS idx_worker_jobs_queued_at    ON worker_jobs (queued_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_worker_jobs_retry        ON worker_jobs (next_retry_at) WHERE status = 'failed';

-- ─── Migrations tracking ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT        PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
