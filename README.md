# Hiring Automation

Open-source hiring workflow automation with email intake, document tracking, candidate scoring, and a UI dashboard.

## Implemented Phases

### Phase 1 — Scope, Rules, and Data Model
- Workflow states implemented: `Applied → Ack Sent → Docs Pending → Docs Complete → For Review → Shortlisted → Interview Scheduled → Hired/Rejected`.
- Position-based document checklist support.
- Candidate identity deduplication (`email + full name + position`).
- Compliance checks (required email subject format, deadline disqualification).

### Phase 2 — Email Intake + Auto-Reply
- Application intake endpoint.
- Automatic acknowledgment message using the provided template.
- Email events tracking and audit logs.

### Phase 3 — Document Validation
- Required document matching via attachment names.
- Missing documents detection and follow-up event generation.
- Auto-disqualification when subject format or deadline is violated.

### Phase 4 — Structured Extraction (Rule-based)
- Text ingestion endpoint for extracted document text.
- Rule-based parsing for education, experience, trainings, awards, and CSC eligibility.
- Confidence flag (`low | medium | high`).

### Phase 5 — Candidate Scoring + Recommendation
- Transparent weighted scoring rubric.
- Recommendation labels (`Strongly Recommended`, `Recommended`, `Consider`, `Low Priority`).
- Score breakdown and explanation.

### Phase 6/7 — HR UI + Interview Scheduling
- Browser dashboard for candidate list and core actions.
- One-click scoring, shortlist, and interview scheduling actions.
- Interview email event logging and attendance confirmation endpoint.

### Phase 8 — Security + Audit
- Optional API key protection for HR-sensitive endpoints (`HR_API_KEY`).
- Immutable audit log entries for workflow actions.

## Tech Stack
- Node.js + Express
- Zod for validation
- JSON file datastore (can be replaced with PostgreSQL later)
- Vanilla HTML/CSS/JS dashboard

## Run Locally

```bash
npm install
npm run start
```

Open: `http://localhost:3000`

## Environment Variables

Create `.env` (optional):

```bash
PORT=3000
DOCUMENT_DEADLINE=2026-04-07T23:59:59+08:00
FROM_EMAIL=hr@company.local
HR_API_KEY=
```

If `HR_API_KEY` is set, protected endpoints require `x-api-key` header.

## API Summary

- `POST /api/applications/intake` - register candidate and send ack event
- `POST /api/candidates/:id/documents` - validate documents and compliance
- `POST /api/candidates/:id/extract` - parse profile fields from text
- `POST /api/candidates/:id/score` - compute recommendation score
- `POST /api/candidates/:id/shortlist` - shortlist candidate
- `POST /api/candidates/:id/interview` - schedule initial interview
- `POST /api/candidates/:id/confirm-interview` - mark attendance confirmation
- `POST /api/candidates/:id/hire` - mark as hired
- `POST /api/candidates/:id/reject` - reject candidate
- `GET /api/sheets/rows` - export sheet-ready rows

## Testing

```bash
npm test
```

Includes workflow, scoring, and API tests.

## Notes for Next Integration Steps

- Replace JSON datastore with PostgreSQL.
- Integrate Gmail API / IMAP+SMTP for real email send/receive.
- Integrate Google Sheets API for direct sheet writeback.
- Add OCR pipeline (Tesseract + PDF parser) for real attachments.
- Integrate Ollama endpoint for local summarization/rationale.
