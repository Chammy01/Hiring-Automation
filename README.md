# Hiring Automation

Open-source hiring workflow automation with intake, compliance validation, extraction support, scoring, HR workflow UI, security controls, and operational analytics.

## Phase Coverage

### Phase 1 — Scope, Rules, and Data Model
- Workflow states and transitions implemented:
  `Applied → Ack Sent → Docs Pending → Docs Complete → For Review → Shortlisted → Interview Scheduled → Hired/Rejected`
- Position-specific checklist support.
- Candidate identity dedupe rule (`fullName + email + position`).
- Spreadsheet-ready schema export (`GET /api/sheets/rows`).
- Compliance rules for subject format + deadline disqualification.

### Phase 2 — Email Intake + Auto-Reply
- Intake endpoint + inbound mailbox simulation endpoint.
- Auto-ack template engine with configurable templates.
- Inbound/outbound email event logging.
- Retry queue for failed sends + retry endpoint.

### Phase 3 — Document Collection + Validation
- Attachment-to-requirement matching.
- Per-document status: `received | missing | invalid`.
- Missing/invalid follow-up notifications.
- Auto-disqualification when deadline/format rules fail.

### Phase 4 — Document Reading + Structured Extraction
- Structured extraction endpoint from parsed text payload.
- Extraction job queue endpoint.
- Low-confidence verification queue for human review.

### Phase 5 — Candidate Scoring + Recommendation
- Transparent weighted rubric with score breakdown.
- Configurable scoring weights endpoint.
- Recommendation labels + rationale text.

### Phase 6 — HR Interface
- Web dashboard with candidate intake/list/details.
- Filters by position and status.
- One-click actions: score, shortlist, follow-up, schedule interview.

### Phase 7 — Interview + Final Workflow
- Interview scheduling email event generation.
- Candidate interview acknowledgment tracking.
- Status updates reflected in workflow + sheet export.

### Phase 8 — Security, Audit, Reliability
- Role-based access control (`viewer`, `hr`, `admin`) via request header.
- Optional API key enforcement (`HR_API_KEY`).
- Encrypted email body storage (AES-256-GCM).
- Full audit trail for workflow and configuration actions.
- Backup/restore endpoints for datastore state.

### Phase 9 — Pilot + Calibration Support
- Analytics endpoint (completion rates, processing averages, queue visibility).
- Adjustable rubric weights for calibration.
- Duplicate merge support for repeated applicants.

### Phase 10 — Integration Upgrades + UI Modernization
- Optional Google Sheets auto-create + sync for candidate organization.
- Upgrade integration visibility for rollout planning.
- Responsive modernized HR dashboard interface.

## Stack
- Backend: Node.js + Express + Zod
- Storage: JSON datastore (pilot), PostgreSQL-ready design path
- UI: Vanilla HTML/CSS/JS
- Security primitives: Node crypto (AES-256-GCM)

## App Settings (Admin-Editable)

All runtime settings are stored in `data/store.json` under `settings.appSettings` and are fully editable without changing code.

### Where to edit

- **Via the UI:** Open the app at `http://localhost:3000`, click **Settings** in the sidebar, and update any field. Changes take effect immediately for all new actions (emails, deadline checks, etc.).
- **Via the API (advanced):**
  ```bash
  # Read current settings
  curl -H "x-role: hr" http://localhost:3000/api/settings

  # Update specific fields
  curl -X PUT http://localhost:3000/api/settings \
    -H "Content-Type: application/json" \
    -H "x-role: hr" \
    -d '{"hiringDeadline":"2027-03-31T23:59:59.000Z","companyEmail":"hr@myoffice.gov.ph"}'
  ```
- **Seed defaults:** On first boot (or after deleting `data/store.json`), all fields are seeded from environment variables or safe built-in defaults (see the `.env` section above). No migration steps are required.

### Settings reference

| Field | Type | Description | Default / Example |
|---|---|---|---|
| `hiringDeadline` | ISO-8601 datetime string | Deadline for all compliance checks and acknowledgement emails | `DOCUMENT_DEADLINE` env var |
| `companyEmail` | email string | From-address for all outbound emails | `FROM_EMAIL` env var |
| `mailboxAddress` | email string | Inbound mailbox where applications arrive | `MAILBOX_ADDRESS` env var |
| `companyName` | string | Your office/company name | `"Our Office"` |
| `replyToEmail` | email string or `""` | Reply-To address for outbound emails | `""` |
| `hiringManagerName` | string | Hiring manager name shown in emails | `""` |
| `applicationOpenDate` | ISO-8601 datetime or `""` | When applications start being accepted | `""` |
| `timezone` | IANA TZ identifier | Used for deadline display/calculations | `"Asia/Manila"` |
| `autoResponseSubject` | string | Subject template for auto-reply (`{{position}}` supported) | `"Application Received: {{position}}"` |
| `interviewWindowStart` | `HH:MM` time | Earliest time slots for interviews | `"08:00"` |
| `interviewWindowEnd` | `HH:MM` time | Latest time slots for interviews | `"17:00"` |
| `maxApplicationsPerRole` | integer ≥ 0 | Cap per position (0 = unlimited) | `0` |
| `allowedFileTypes` | comma-separated extensions | Allowed resume/document extensions | `"pdf,doc,docx"` |
| `maxUploadSizeMb` | positive number | Max file size per attachment (MB) | `10` |
| `notifyNewApplication` | boolean | Send internal alert on new candidate | `true` |
| `reminderCadenceDays` | positive integer | Days between follow-up reminders | `3` |
| `careerPageBanner` | string | Banner text shown on career page | `""` |
| `defaultJobVisibility` | `"public"` / `"private"` / `"draft"` | Default visibility for new job posts | `"public"` |
| `dataRetentionDays` | positive integer | Days before auto-archiving candidate records | `365` |

### Validation

The PUT endpoint validates:
- `companyEmail`, `mailboxAddress`, `replyToEmail` must be valid email format (or empty string for `replyToEmail`).
- `defaultJobVisibility` must be one of `public`, `private`, `draft`.
- Numeric fields (`maxApplicationsPerRole`, `maxUploadSizeMb`, etc.) must be positive numbers or non-negative integers as appropriate.

Invalid requests return HTTP 400 with a structured error body.



Follow these steps to run the full system on your own computer.

### 1) Install prerequisites

- **Git** (latest stable)
- **Node.js 20+** (Node 22+ recommended)
- **npm** (comes with Node.js)

Check versions:

```bash
git --version
node --version
npm --version
```

### 2) Clone the repository

```bash
git clone https://github.com/Chammy01/Hiring-Automation.git
cd Hiring-Automation
```

### 3) Install project dependencies

```bash
npm install
```

### 4) Create your `.env` file

Create a file named `.env` in the project root:

```bash
PORT=3000
DATA_FILE=data/store.json
DOCUMENT_DEADLINE=2026-04-07T23:59:59+08:00
FROM_EMAIL=hr@company.local
MAILBOX_ADDRESS=applications@company.local
HR_API_KEY=
ROLE_HEADER=x-role
ENCRYPTION_KEY=replace-with-your-own-long-random-secret
GOOGLE_SHEETS_ENABLED=false
GOOGLE_SHEETS_CREDENTIALS_JSON=
GOOGLE_SHEETS_SPREADSHEET_ID=
GOOGLE_SHEETS_TITLE=Hiring Automation Candidates
```

Recommended: use a unique `ENCRYPTION_KEY` per machine/environment.

### 5) Run tests (sanity check)

```bash
npm test
```

### 6) Start the server

```bash
npm run start
```

For live reload during development:

```bash
npm run dev
```

### 7) Verify the app is running

- Open the dashboard: `http://localhost:3000`
- Health endpoint:

```bash
curl http://localhost:3000/api/health
```

Expected response:

```json
{"status":"ok","service":"hiring-automation"}
```

### 8) Use the app from UI

1. Open dashboard at `http://localhost:3000`
2. Click **New Candidate** (or press `N`) to open the intake form
3. In the **Candidate Pipeline** table, click any row to open the **Candidate Details** modal
4. Use row action buttons: **Score**, **Shortlist**, **Follow-up**, **Schedule** (interview), **Hire**, **Reject**
5. Use the **bulk select** checkboxes to select multiple candidates → bulk export CSV or bulk reject
6. Click **KPI cards** to instantly filter the table by that status
7. Use the **position** and **status** dropdowns to filter; type in the **search** box to find by name/email
8. Click table column headers to **sort** (state persists in URL + localStorage)
9. Open the **Settings** page from the sidebar to view and update all editable configuration (deadline, company email, and more)
10. Open the **Integrations** page from the sidebar to view and sync Google Sheets
11. Open the **Audit Log** page from the sidebar to review all action history
12. Press `⌘K` (or `Ctrl+K`) to open the **command palette** for quick navigation

## UI Keyboard Shortcuts

| Shortcut       | Action                        |
|----------------|-------------------------------|
| `N`            | Open New Candidate form       |
| `R`            | Refresh data                  |
| `/`            | Focus candidate search        |
| `Ctrl+K` / `⌘K`| Open command palette          |
| `Esc`          | Close open modal or palette   |

### Candidate Details Modal Tabs

| Tab         | Content                                                |
|-------------|--------------------------------------------------------|
| Overview    | Name, email, position, status, score, interview info   |
| Documents   | Per-document status with progress bars                 |
| Compliance  | Compliance badge + disqualification reasons            |
| Email Log   | Inbound/outbound email events for this candidate       |
| Audit Log   | Workflow change history for this candidate             |

### 9) Use secured APIs (when testing with curl/Postman)

Set role header in requests:
- `x-role: viewer` → read-only dashboard/candidate views
- `x-role: hr` → operational actions
- `x-role: admin` → full permissions

If `HR_API_KEY` is set, also send:
- `x-api-key: <your-key>`

Example intake call:

```bash
curl -X POST http://localhost:3000/api/applications/intake \
  -H "Content-Type: application/json" \
  -H "x-role: hr" \
  -d '{
    "fullName":"Jane Doe",
    "email":"jane@example.com",
    "position":"Administrative Aide IV (Clerk II)"
  }'
```

### 10) Reset local data (fresh start)

Stop the server, then clear datastore:

```bash
rm -f data/store.json
```

Restart the app and it will regenerate `data/store.json` automatically.

### 11) Troubleshooting

- **Port already in use**
  - Change `PORT` in `.env` (for example `PORT=3001`) and restart
- **Module not found**
  - Run `npm install` again
- **403 Forbidden**
  - Check `x-role` value; use `hr` or `admin` for write operations
- **401 Unauthorized**
  - If `HR_API_KEY` is configured, include correct `x-api-key`
- **Corrupt/invalid local data file**
  - Delete `data/store.json` and restart

## Key API Endpoints

- `GET /api/settings` — read all app settings
- `PUT /api/settings` — update one or more app settings
- `POST /api/applications/intake`
- `POST /api/email/inbound`
- `POST /api/candidates/:id/documents`
- `POST /api/candidates/:id/documents/content`
- `POST /api/candidates/:id/extract`
- `POST /api/candidates/:id/extraction-jobs`
- `GET /api/extraction-queue`
- `GET /api/verification-queue`
- `POST /api/candidates/:id/verify-extraction`
- `POST /api/candidates/:id/score`
- `GET/POST /api/scoring/weights`
- `POST /api/candidates/:id/shortlist`
- `POST /api/candidates/:id/follow-up`
- `POST /api/candidates/:id/interview`
- `POST /api/candidates/:id/confirm-interview`
- `POST /api/candidates/:id/hire`
- `POST /api/candidates/:id/reject`
- `POST /api/candidates/merge`
- `GET /api/retry-queue`
- `POST /api/email-events/:id/retry`
- `GET /api/templates` / `PUT /api/templates/:key`
- `GET /api/analytics`
- `GET /api/integrations`
- `POST /api/integrations/google-sheets/sync`
- `GET /api/backup` / `POST /api/restore`
- **Gmail outbound dispatcher (new)**
  - `POST /api/mail/sync` — trigger inbox sync info (runs via worker)
  - `POST /api/mail/dispatch` — queue an outbound email
  - `POST /api/mail/dispatch/:id/send` — trigger send for a queued dispatch
  - `GET /api/mail/dispatch/:id` — check dispatch status
  - `GET /api/mail/dispatches` — list all dispatches (`?status=queued|sent|failed&candidateId=`)
- **Document parsing / OCR (new)**
  - `POST /api/documents/ingest` — enqueue (or immediately run) a parsing job
  - `GET /api/documents/:jobId/status` — get parsing job status and extracted fields
  - `GET /api/documents/parsing-jobs` — list jobs (`?status=queued|succeeded|failed&candidateId=`)
  - `PATCH /api/candidates/:id/enrich` — apply parsed fields to a candidate record

---

## New Modules — Local Setup

### Module A: Gmail outbound dispatcher

The dispatcher sends emails via the Gmail API using the same OAuth token as the
intake worker. It is **disabled by default** so the rest of the app works without
any Gmail configuration.

#### Enable

1. Complete the Gmail OAuth setup described in [Gmail OAuth Ingestion Worker](#gmail-oauth-ingestion-worker-local).
2. Add to `.env`:

   ```env
   GMAIL_DISPATCH_ENABLED=true
   GMAIL_CREDENTIALS_PATH=credentials.json   # same file as intake worker
   GMAIL_TOKEN_PATH=data/gmail-token.json
   GMAIL_DISPATCH_FROM=hr@your-domain.com
   GMAIL_DISPATCH_MAX_RETRIES=3
   GMAIL_DISPATCH_RETRY_BASE_MS=1000
   ```

3. Queue and send a test dispatch:

   ```bash
   curl -s -X POST http://localhost:3000/api/mail/dispatch \
     -H "Content-Type: application/json" \
     -H "x-role: hr" \
     -d '{"to":"candidate@example.com","subject":"Test {{role}}","body":"Hello, your application for {{role}} was received.","vars":{"role":"Software Engineer"}}'

   # Note the returned dispatch id, then trigger send:
   curl -s -X POST http://localhost:3000/api/mail/dispatch/<id>/send -H "x-role: hr"
   ```

#### How dispatches work

1. `POST /api/mail/dispatch` creates a record with `status: queued`.
2. `POST /api/mail/dispatch/:id/send` attempts delivery via Gmail API.
3. On transient failure (network, rate-limit, 5xx), it retries with exponential
   back-off up to `GMAIL_DISPATCH_MAX_RETRIES` attempts.
4. Final status is `sent` (with `sentAt`) or `failed` (with `lastError`).
5. When `GMAIL_DISPATCH_ENABLED=false`, sends are **simulated** — status moves to
   `sent` immediately with no real email sent.

---

### Module B: PostgreSQL persistence

The app defaults to a local JSON file store (`data/store.json`) with zero setup.
PostgreSQL is an **opt-in upgrade** controlled by `POSTGRES_ENABLED=true`.

#### Prerequisites

- PostgreSQL 14+ (local, Docker, or a hosted service such as Render, Neon, Supabase, or Railway)

#### Enable

1. Create a database:

   ```sql
   CREATE DATABASE hiring_automation;
   ```

2. Add connection details to `.env`:

   ```env
   POSTGRES_ENABLED=true
   POSTGRES_URL=postgres://user:password@localhost:5432/hiring_automation
   # Or individual fields:
   # POSTGRES_HOST=localhost
   # POSTGRES_PORT=5432
   # POSTGRES_DB=hiring_automation
   # POSTGRES_USER=postgres
   # POSTGRES_PASSWORD=your_password
   POSTGRES_SSL=false   # set true for hosted DBs (Neon, RDS, etc.)
   ```

3. Run migrations:

   ```bash
   npm run db:migrate
   ```

   Check status at any time:

   ```bash
   npm run db:migrate:status
   ```

4. (Optional) Load dev seed data:

   ```bash
   npm run db:seed
   ```

#### Schema overview

| Table | Purpose |
|---|---|
| `candidates` | Candidate profiles and workflow state |
| `jobs` | Open positions |
| `applications` | Candidate–job linkage |
| `email_threads` | Gmail thread metadata |
| `email_messages` | Normalized inbound/outbound messages (deduplicated by provider_message_id) |
| `outbound_dispatches` | Outbound send queue and delivery tracking |
| `documents` | Uploaded/stored document references |
| `parsing_results` | Extracted raw text + structured fields per document |
| `worker_jobs` | General-purpose async job queue |
| `schema_migrations` | Applied migration tracking |

Indexes are included for the most common access patterns: email lookup,
candidate position/workflow filtering, queue processing by status, and
`created_at` ordering.

#### Troubleshooting

- **`POSTGRES_ENABLED is not true`** — set `POSTGRES_ENABLED=true` in `.env`
- **Connection refused** — check host, port, and that PostgreSQL is running
- **SSL required** — set `POSTGRES_SSL=true` for hosted databases
- **Permission denied** — ensure the user has `CREATE TABLE` permissions on the database

---

### Module C: OCR + document parsing workers

The async worker parses uploaded/stored documents into structured candidate fields.
It works **without OCR** out of the box (PDF text extraction and DOCX parsing).
Tesseract OCR is an optional upgrade for image-only PDFs and image files.

#### Enable

```env
OCR_ENABLED=true           # enables Tesseract OCR fallback
OCR_WORKER_CONCURRENCY=2   # parallel jobs
OCR_WORKER_POLL_MS=5000    # polling interval in watch mode
```

No extra Tesseract binary is required — the `tesseract.js` package uses a
JavaScript WASM build that works on any Node.js platform.

#### Run the parser worker

```bash
# Single pass (process all queued jobs and exit)
npm run worker:parser

# Watch mode (poll continuously)
npm run worker:parser:watch
```

#### Ingest a document via API

```bash
# Enqueue a parsing job (worker processes it asynchronously)
curl -s -X POST http://localhost:3000/api/documents/ingest \
  -H "Content-Type: application/json" \
  -H "x-role: hr" \
  -d '{"candidateId":"<uuid>","fileName":"resume.pdf","mimeType":"application/pdf","storageRef":"/uploads/resume.pdf"}'

# Enqueue AND process immediately (runNow=true — useful in development)
curl -s -X POST http://localhost:3000/api/documents/ingest \
  -H "Content-Type: application/json" \
  -H "x-role: hr" \
  -d '{"candidateId":"<uuid>","fileName":"cv.txt","mimeType":"text/plain","text":"Alice Smith\nalice@example.com\n5 years experience...","runNow":true}'

# Poll for result
curl -s http://localhost:3000/api/documents/<jobId>/status -H "x-role: viewer"
```

#### Parsed fields

| Field | Source |
|---|---|
| `name` | "Name:" label or first plausible line |
| `email` | Regex match |
| `phone` | Philippine / international number pattern |
| `educationalAttainment` | Keyword matching (Doctorate / Graduate School / College / Senior High / High School) |
| `workExperience` | `N years experience` pattern |
| `cscEligibility` | Civil Service exam / PRC keywords |
| `awards` | `cum laude`, `award`, `honor` keywords |
| `trainings` | `training`, `seminar`, `workshop` keywords |
| `skills` | Curated keyword list (MS Office, data entry, leadership, etc.) |

Confidence is rated `low / medium / high` based on how many fields are found.
Candidates with `medium` or `low` confidence are added to the verification queue
for human review.

#### Apply parsing results to a candidate

```bash
curl -s -X PATCH http://localhost:3000/api/candidates/<id>/enrich \
  -H "Content-Type: application/json" \
  -H "x-role: hr" \
  -d '{"fields":{"educationalAttainment":"College Graduate","workExperience":"1-3 years"},"confidence":"medium"}'
```

#### Troubleshooting

- **OCR produces garbled text** — ensure the image is at least 150 dpi; rotate if needed
- **PDF yields empty text** — PDF may be image-only; set `OCR_ENABLED=true`
- **Job stuck in `processing`** — worker may have crashed; restart it — the job
  will retry up to `maxRetries` attempts


---

## Gmail OAuth Ingestion Worker (Local)

The worker in `src/workers/gmail-intake.js` reads real Gmail attachments and updates candidate document status automatically.

### Setup (one-time)

#### 1) Enable Gmail API and create OAuth Desktop credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or select an existing one).
3. Enable **Gmail API**: APIs & Services → Library → search "Gmail API" → Enable.
4. Create OAuth credentials:
   - APIs & Services → Credentials → **Create Credentials** → **OAuth client ID**
   - Application type: **Desktop app**
   - Click **Download JSON** — this is your `credentials.json`
5. Configure the OAuth consent screen if prompted (External app, add your Gmail as test user).

#### 2) Place credentials securely

Put the downloaded file at the path specified by `GMAIL_CREDENTIALS_PATH` (default: `credentials.json` in project root).

> ⚠️ **Never commit `credentials.json` or token files** — they are in `.gitignore`.

#### 3) First-time authorization

Run the worker once. It will print an authorization URL:

```bash
node src/workers/gmail-intake.js
```

Visit the URL, authorize the app, copy the authorization code, and paste it back into the terminal.
The token is saved to `GMAIL_TOKEN_PATH` (default: `data/gmail-token.json`).

### New environment variables

Add these to your `.env`:

```env
# Path to your OAuth Desktop credentials JSON downloaded from Google Cloud Console
GMAIL_CREDENTIALS_PATH=credentials.json

# Where the OAuth token will be stored after first authorization
GMAIL_TOKEN_PATH=data/gmail-token.json

# Gmail search query used to find application emails
GMAIL_POLL_QUERY=subject:(Application for) has:attachment

# Polling interval in milliseconds for --watch mode (default: 60000 = 1 minute)
GMAIL_POLL_INTERVAL_MS=60000

# Base URL of the hiring-automation API server
API_BASE_URL=http://localhost:3000

# API key (optional; must match HR_API_KEY in server .env if set)
API_KEY=
```

### Running the worker

**Single run** (processes matching emails once, then exits):
```bash
node src/workers/gmail-intake.js
```

**Watch mode** (polls continuously on the configured interval):
```bash
node src/workers/gmail-intake.js --watch
```

### How it works

1. The worker searches Gmail using `GMAIL_POLL_QUERY`.
2. For each unprocessed email it:
   - Extracts sender email and parses position from subject (`Application for <position>`).
   - Matches candidate using **Strategy (C)**:
     - Find candidate with matching sender email + position → update that candidate.
     - If ambiguous or no match, look for `CandidateID:<id>` or `[HA:<id>]` token in subject.
     - If still unresolved, log a message and skip (the email stays processable on retry).
   - Downloads all attachments.
   - Extracts text from PDF (via `pdf-parse`) and DOCX (via `mammoth`).
   - Classifies each attachment by filename hints + content keywords.
   - Posts to `POST /api/candidates/:id/documents/content`.
3. Processed message IDs are stored in `data/gmail-processed-ids.json` to avoid reprocessing.

### Applicant subject format

Applicants should email with subject:
```
Application for <Position Title>
```
Example:
```
Application for Administrative Aide IV (Clerk II)
```

If multiple candidates share the same email+position (rare), include a token:
```
Application for Administrative Aide IV (Clerk II) CandidateID:<uuid>
```
or:
```
Application for Administrative Aide IV (Clerk II) [HA:<uuid>]
```

### Security notes

- `credentials.json` and `data/gmail-token.json` are in `.gitignore` — never commit them.
- The worker does **not** log extracted document contents — only file metadata and classification results.
- Use a dedicated Google account/project for the integration in production.
- Revoke app access via Google Account → Security → Third-party apps if needed.

