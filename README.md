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

## Stack
- Backend: Node.js + Express + Zod
- Storage: JSON datastore (pilot), PostgreSQL-ready design path
- UI: Vanilla HTML/CSS/JS
- Security primitives: Node crypto (AES-256-GCM)

## Run

```bash
npm install
npm test
npm run start
```

Open: `http://localhost:3000`

## Environment Variables

```bash
PORT=3000
DATA_FILE=data/store.json
DOCUMENT_DEADLINE=2026-04-07T23:59:59+08:00
FROM_EMAIL=hr@company.local
MAILBOX_ADDRESS=applications@company.local
HR_API_KEY=
ROLE_HEADER=x-role
ENCRYPTION_KEY=dev-local-encryption-key-change-this-dev-local-encryption-key
```

## Role Usage

Set role header in requests:
- `x-role: viewer` → read-only dashboard/candidate views
- `x-role: hr` → operational actions
- `x-role: admin` → full permissions

## Key API Endpoints

- `POST /api/applications/intake`
- `POST /api/email/inbound`
- `POST /api/candidates/:id/documents`
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
- `GET /api/backup` / `POST /api/restore`

## Next Integration Upgrades
- Plug Gmail API/IMAP+SMTP transport behind queue dispatcher.
- Replace JSON store with PostgreSQL.
- Integrate Google Sheets API sync writer.
- Add OCR adapters (Tesseract + PDF parser) to extraction job workers.
- Add Ollama summary endpoint for recommendation explanation enrichment.
