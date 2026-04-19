const WORKFLOW_STATES = {
  APPLIED: 'Applied',
  ACK_SENT: 'Ack Sent',
  DOCS_PENDING: 'Docs Pending',
  DOCS_COMPLETE: 'Docs Complete',
  FOR_REVIEW: 'For Review',
  SHORTLISTED: 'Shortlisted',
  INTERVIEW_SCHEDULED: 'Interview Scheduled',
  HIRED: 'Hired',
  REJECTED: 'Rejected'
};

const TRANSITIONS = {
  [WORKFLOW_STATES.APPLIED]: [WORKFLOW_STATES.ACK_SENT, WORKFLOW_STATES.REJECTED],
  [WORKFLOW_STATES.ACK_SENT]: [WORKFLOW_STATES.DOCS_PENDING, WORKFLOW_STATES.REJECTED],
  [WORKFLOW_STATES.DOCS_PENDING]: [WORKFLOW_STATES.DOCS_COMPLETE, WORKFLOW_STATES.REJECTED],
  [WORKFLOW_STATES.DOCS_COMPLETE]: [WORKFLOW_STATES.FOR_REVIEW, WORKFLOW_STATES.REJECTED],
  [WORKFLOW_STATES.FOR_REVIEW]: [WORKFLOW_STATES.SHORTLISTED, WORKFLOW_STATES.REJECTED],
  [WORKFLOW_STATES.SHORTLISTED]: [WORKFLOW_STATES.INTERVIEW_SCHEDULED, WORKFLOW_STATES.REJECTED],
  [WORKFLOW_STATES.INTERVIEW_SCHEDULED]: [WORKFLOW_STATES.HIRED, WORKFLOW_STATES.REJECTED],
  [WORKFLOW_STATES.HIRED]: [],
  [WORKFLOW_STATES.REJECTED]: []
};

const DEFAULT_REQUIRED_DOCUMENTS = [
  'Letter of Intent',
  'PDS',
  'WES',
  'Training/Seminar Certificates',
  'Awards from Last Promotion',
  'Latest IPCR',
  'Proof of CSC Eligibility'
];

const POSITION_CHECKLISTS = {
  default: DEFAULT_REQUIRED_DOCUMENTS,
  'Administrative Assistant I (Computer Operator I)': [
    ...DEFAULT_REQUIRED_DOCUMENTS,
    'Computer Skill Evidence'
  ]
};

const SCORING_WEIGHTS = {
  docsComplete: 30,
  eligibility: 20,
  experience: 20,
  education: 15,
  trainings: 10,
  awards: 5
};

const SCORING_MULTIPLIERS = {
  TRAININGS_PARTIAL_CREDIT: 0.2
};

const EMAIL_STATUSES = {
  QUEUED: 'queued',
  SENT: 'sent',
  FAILED: 'failed'
};

const DEFAULT_TEMPLATES = {
  acknowledgement:
    'Dear Applicant,\n\nThank you for your interest in applying to our Office.\n\nIn view that the position you are applying for is a regular position, you are hereby requested to submit the following documentary requirements on or before {{deadline}}:\n\n• Letter of Intent\n• One (1) copy of a fully accomplished Personal Data Sheet (PDS) and Work Experience Sheet (WES) (CSC Form No. 212, s. 2025)\n(Forms may be downloaded from the Civil Service Commission website)\n• One (1) copy of relevant training/seminar certificates (if applicable)\n• One (1) copy of awards received from your last promotion (if applicable)\n• One (1) copy of your latest Individual Performance Commitment and Review (IPCR) (if applicable)\n• One (1) copy of proof of CSC Eligibility\n \nKindly submit the above documents through email using the prescribed subject format:\n\nApplication for (Position and Title)\n(ex: Application for Administrative Assistant I (Computer Operator I))\n\nPlease be advised that non-compliance with the required documents, failure to follow the prescribed subject format, or submission beyond the stated deadline shall result in automatic disqualification from the selection process.\n\nThis is an automated reminder. If this has already been taken care of, please disregard. We kindly ask that you reply to acknowledge receipt of this message.\n\nThank you.\nVery truly yours,',
  missingDocs:
    'Dear {{fullName}},\n\nPlease submit the following missing requirements before {{deadline}}:\n{{missingList}}\n\nThank you.',
  interviewInvite:
    'Hello {{fullName}},\n\nYour interview is scheduled on {{date}} at {{time}}.\nVenue/Link: {{location}}\n\nPlease reply to acknowledge this schedule.'
};

const ROLE_PERMISSIONS = {
  viewer: ['read:candidates', 'read:dashboard'],
  hr: [
    'read:candidates',
    'read:dashboard',
    'write:candidates',
    'write:templates',
    'read:audit',
    'read:email',
    'write:backup'
  ],
  admin: ['*']
};

module.exports = {
  WORKFLOW_STATES,
  TRANSITIONS,
  POSITION_CHECKLISTS,
  DEFAULT_REQUIRED_DOCUMENTS,
  SCORING_WEIGHTS,
  SCORING_MULTIPLIERS,
  EMAIL_STATUSES,
  DEFAULT_TEMPLATES,
  ROLE_PERMISSIONS
};
