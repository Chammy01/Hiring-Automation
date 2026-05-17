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
- Role-based access control (`viewer`, `editor`, `hr`, `developer`, `admin`) resolved server-side from API key identity.
- Mandatory API key enforcement outside test (`HR_API_KEY` or `HR_API_KEYS`).
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

## App Settings (Role-Based Editable)

All runtime settings are stored in `data/store.json` under `settings.appSettings` and are editable without changing code.
`followUpMessage` and `scheduleInterviewMessage` are restricted to `admin`, `developer`, and `hr` roles.

### Where to edit

- **Via the UI:** Open the app at `http://localhost:3000`, click **Settings** in the sidebar, and update any field. Changes take effect immediately for all new actions (emails, deadline checks, etc.).
- **Via the API (advanced):**
  ```bash
  # Read current settings
  curl -H "x-api-key: <your-key>" http://localhost:3000/api/settings

  # Update specific fields
  curl -X PUT http://localhost:3000/api/settings \
    -H "Content-Type: application/json" \
    -H "x-api-key: <your-key>" \
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
| `followUpMessage` | string template | Message body for follow-up emails (`{{candidateName}}`, `{{position}}`, `{{deadline}}`, `{{missingDocuments}}`) | `"Dear {{candidateName}}, ..."` |
| `scheduleInterviewMessage` | string template | Message body for interview scheduling emails (`{{candidateName}}`, `{{position}}`, `{{interviewDate}}`, `{{interviewTime}}`, `{{interviewLocation}}`) | `"Hello {{candidateName}}, ..."` |
| `careerPageBanner` | string | Banner text shown on career page | `""` |
| `defaultJobVisibility` | `"public"` / `"private"` / `"draft"` | Default visibility for new job posts | `"public"` |
| `dataRetentionDays` | positive integer | Days before auto-archiving candidate records | `365` |

### Validation

The PUT endpoint validates:
- `companyEmail`, `mailboxAddress`, `replyToEmail` must be valid email format (or empty string for `replyToEmail`).
- `defaultJobVisibility` must be one of `public`, `private`, `draft`.
- Numeric fields (`maxApplicationsPerRole`, `maxUploadSizeMb`, etc.) must be positive numbers or non-negative integers as appropriate.

Invalid requests return HTTP 400 with a structured error body.
Unauthorized template updates return HTTP 403.



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
HR_API_KEY=replace-with-strong-api-key
HR_API_KEYS=
ALLOWED_ORIGINS=http://localhost:3000
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

Send API key in requests:
- `x-api-key: <your-key>`
- Role/permissions are derived server-side from `HR_API_KEYS` (or `HR_DEFAULT_ROLE` with single `HR_API_KEY`).

Example intake call:

```bash
curl -X POST http://localhost:3000/api/applications/intake \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your-key>" \
  -d '{
    "fullName":"Jane Doe",
    "email":"jane@example.com",
    "position":"Administrative Aide IV (Clerk II)"
  }'

## Authentication (JWT + Cookies)

- Public login page: `GET /login`
- Auth endpoints:
  - `POST /api/auth/login`
  - `POST /api/auth/logout`
  - `GET /api/auth/verify`
  - `POST /api/auth/register` (requires `x-developer-key`)
- JWT session token is stored in an `httpOnly` cookie (`auth_token`) with 24h expiry.
- Mutating requests authenticated by JWT must include `x-csrf-token`.
- Developer user-management page: `GET /dev/register?key=<DEVELOPER_KEY>`.
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
  - Ensure your API key is mapped to a role that has the required permission
- **401 Unauthorized**
  - Include a valid `x-api-key` header
- **Corrupt/invalid local data file**
  - Delete `data/store.json` and restart

## Production Security Checklist

- Set `HR_API_KEY` (or `HR_API_KEYS`) and require clients/workers to send `x-api-key`.
- Set a strong `ENCRYPTION_KEY` (do not use development fallback).
- Configure `ALLOWED_ORIGINS` explicitly.
- Use HTTPS-only webhook URLs; optionally set `WEBHOOK_ALLOWED_DOMAINS`.
- Restrict backup/restore access to admin credentials only.
- Enable PostgreSQL SSL with verification (`POSTGRES_SSL=true` + CA/cert/key paths where needed).
- Keep worker `API_BASE_URL` on HTTPS for non-local environments.

## Key API Endpoints

- `GET /api/settings` — read all app settings
- `PUT /api/settings` — update one or more app settings (`followUpMessage`/`scheduleInterviewMessage` require `admin|developer|hr`)
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
- `POST /api/candidates/:id/follow-up` (optional body: `{ "message": "..." }`)
- `POST /api/candidates/:id/interview` (body: `date`, `time`, `meetingLink|venue`, optional `message`; supports rescheduling)
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
     -H "x-api-key: <your-key>" \
     -d '{"to":"candidate@example.com","subject":"Test {{role}}","body":"Hello, your application for {{role}} was received.","vars":{"role":"Software Engineer"}}'

   # Note the returned dispatch id, then trigger send:
   curl -s -X POST http://localhost:3000/api/mail/dispatch/<id>/send -H "x-api-key: <your-key>"
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
   POSTGRES_SSL_CA_PATH=
   POSTGRES_SSL_CERT_PATH=
   POSTGRES_SSL_KEY_PATH=
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
- **SSL required** — set `POSTGRES_SSL=true` for hosted databases and provide CA/cert/key paths when required by your provider
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

#### Dashboard connection states (OCR + document parsing workers)

The **Integrations** panel reports parser pipeline health with three states:

- **Connected** — parser worker heartbeat is recent; jobs can be processed now.
- **Configured** — pipeline is available but worker is not currently connected.
- **Disconnected** — parser worker heartbeat is stale while there is queue activity
  (or the worker reported an error and is no longer connected).

The card also shows lightweight diagnostics (queue counts and parser message) to
help with troubleshooting.

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
  -H "x-api-key: <your-key>" \
  -d '{"candidateId":"<uuid>","fileName":"resume.pdf","mimeType":"application/pdf","storageRef":"/uploads/resume.pdf"}'

# Enqueue AND process immediately (runNow=true — useful in development)
curl -s -X POST http://localhost:3000/api/documents/ingest \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your-key>" \
  -d '{"candidateId":"<uuid>","fileName":"cv.txt","mimeType":"text/plain","text":"Alice Smith\nalice@example.com\n5 years experience...","runNow":true}'

# Poll for result
curl -s http://localhost:3000/api/documents/<jobId>/status -H "x-api-key: <your-key>"
```

`POST /api/candidates/:id/documents/content` now also enqueues parsing jobs for
submitted files automatically, so Gmail intake + content ingestion flows feed the
same async parsing pipeline without manual parser job creation.

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
  -H "x-api-key: <your-key>" \
  -d '{"fields":{"educationalAttainment":"College Graduate","workExperience":"1-3 years"},"confidence":"medium"}'
```

#### Troubleshooting

- **OCR produces garbled text** — ensure the image is at least 150 dpi; rotate if needed
- **PDF yields empty text** — PDF may be image-only; set `OCR_ENABLED=true`
- **Job stuck in `processing`** — worker may have crashed; restart it — the job
  will retry up to `maxRetries` attempts


---

## Gmail OAuth Intake Inbox (Railway + Local Auth)

The worker in `src/workers/gmail-intake.js` supports a **single connected Gmail inbox** for intake.  
The public inbound mailbox (`settings.mailboxAddress`) remains HR-editable, while Gmail ingestion is tied to `GMAIL_INBOX_USER`.

### Required environment variables

```env
# Single Gmail inbox used for intake (example test inbox)
GMAIL_INBOX_USER=samrichardjomento@gmail.com

# OAuth Web App credentials (Google Cloud Console)
GMAIL_OAUTH_CLIENT_ID=
GMAIL_OAUTH_CLIENT_SECRET=
GMAIL_OAUTH_REDIRECT_URI=https://<your-domain>/api/gmail/oauth/callback

# Token storage (Railway volume recommended)
GMAIL_TOKEN_PATH=/app/data/gmail-token.json

# Optional fallback token sources
GMAIL_OAUTH_REFRESH_TOKEN=
GMAIL_TOKEN_JSON=

# Polling + idempotency
GMAIL_POLL_QUERY=subject:(Application for) has:attachment
GMAIL_POLL_INTERVAL_MS=60000
GMAIL_POLL_MAX_RESULTS=50
GMAIL_PROCESSED_LABEL=HireFlow/Processed
GMAIL_SYNC_STATE_PATH=/app/data/gmail-intake-state.json

# API connectivity for worker → app
API_BASE_URL=https://<your-domain>
API_KEY=<HR_API_KEY>
```

### Step-by-step setup (specific)

1. In Google Cloud Console, enable **Gmail API** and create **OAuth Client ID (Web application)**.
2. Set the redirect URI to:
   - `https://<your-domain>/api/gmail/oauth/callback`
3. In Railway, set the env vars above on:
   - Main API service
   - Gmail intake worker service
4. In the app, log in as **admin** or **developer**.
5. Open **Settings → Company & Contact → Gmail Intake Connection**.
6. Click **Connect Gmail** and authorize the target inbox (for example `samrichardjomento@gmail.com`).
7. Confirm status shows:
   - configured Gmail inbox (`GMAIL_INBOX_USER`)
   - connected Gmail account
   - last sync / error state
8. Start worker service with:
   - `npm run worker:gmail:watch`

### Railway service commands

- Main API service: `npm start`
- Gmail intake worker service: `npm run worker:gmail:watch`

### End-to-end test instructions

1. Ensure `GMAIL_POLL_QUERY` matches your test subject (default expects `Application for` + attachment).
2. Send an email **from another account** to `GMAIL_INBOX_USER` with:
   - Subject: `Application for Administrative Aide IV (Clerk II)`
   - A PDF/DOC attachment
3. Check worker logs for:
   - message discovery
   - attachment processing
   - candidate update
4. Open dashboard and confirm candidate/documents were updated/created.

### Notes

- Idempotency uses both local processed message IDs and optional Gmail processed label (`GMAIL_PROCESSED_LABEL`).
- If HR changes the public inbound mailbox in settings, Gmail intake still follows `GMAIL_INBOX_USER` and status UI shows both values.
