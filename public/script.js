/* ═══════════════════════════════════════════════════════════════
   HIREFLOW — PREMIUM DASHBOARD
   public/script.js
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ── WORKFLOW STATES ────────────────────────────────────────────
const WORKFLOW_STATES = [
  'applied', 'ackSent', 'docsPending', 'docsComplete',
  'forReview', 'shortlisted', 'interviewScheduled', 'hired', 'rejected'
];

const STATE_LABELS = {
  applied:             'Applied',
  ackSent:             'Ack Sent',
  docsPending:         'Docs Pending',
  docsComplete:        'Docs Complete',
  forReview:           'For Review',
  shortlisted:         'Shortlisted',
  interviewScheduled:  'Interview Scheduled',
  hired:               'Hired',
  rejected:            'Rejected'
};

const STATE_PILL_CLASS = {
  applied:             'pill-default',
  ackSent:             'pill-blue',
  docsPending:         'pill-amber',
  docsComplete:        'pill-blue',
  forReview:           'pill-purple',
  shortlisted:         'pill-purple',
  interviewScheduled:  'pill-green',
  hired:               'pill-green',
  rejected:            'pill-red'
};

// ── UTILITIES ──────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// ── API ────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', 'x-role': 'hr' },
    ...options
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed (${res.status})`);
  }
  return res.json();
}

// ── TOAST ──────────────────────────────────────────────────────
const toastContainer = document.getElementById('toast-container');

const TOAST_ICONS = {
  success: `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  error:   `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  info:    `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  warn:    `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
};

function toast(message, type = 'info', duration = 4000) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', 'alert');
  el.innerHTML = `
    ${TOAST_ICONS[type] || TOAST_ICONS.info}
    <div class="toast-body">
      <div class="toast-message">${esc(message)}</div>
    </div>
    <button class="toast-close" aria-label="Dismiss notification">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>`;

  const dismiss = () => {
    el.classList.add('is-removing');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  };

  el.querySelector('.toast-close').addEventListener('click', dismiss);
  toastContainer.appendChild(el);

  if (duration > 0) setTimeout(dismiss, duration);
  return dismiss;
}

// ── MODAL SYSTEM ───────────────────────────────────────────────
const openModals = new Set();
let previousFocus = null;

function openModal(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  previousFocus = document.activeElement;
  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');
  overlay.hidden = false;
  openModals.add(id);
  document.body.style.overflow = 'hidden';

  // Focus first focusable element
  requestAnimationFrame(() => {
    const focusable = overlay.querySelector(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]'
    );
    if (focusable) focusable.focus();
  });
}

function closeModal(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.classList.remove('is-open');
  overlay.setAttribute('aria-hidden', 'true');
  openModals.delete(id);
  if (openModals.size === 0) {
    document.body.style.overflow = '';
    if (previousFocus) {
      previousFocus.focus();
      previousFocus = null;
    }
  }
}

// Focus trap helper
function trapFocus(overlay, event) {
  const focusable = Array.from(overlay.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]'
  ));
  if (!focusable.length) return;
  const first = focusable[0];
  const last  = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    last.focus(); event.preventDefault();
  } else if (!event.shiftKey && document.activeElement === last) {
    first.focus(); event.preventDefault();
  }
}

// Backdrop click and ESC to close any open modal
document.addEventListener('click', (e) => {
  if (e.target.matches('.modal-overlay.is-open')) {
    closeModal(e.target.id);
  }
  const closeBtn = e.target.closest('[data-close-modal]');
  if (closeBtn) {
    closeModal(closeBtn.dataset.closeModal);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    for (const id of openModals) {
      const overlay = document.getElementById(id);
      if (overlay) trapFocus(overlay, e);
    }
  }
  if (e.key === 'Escape') {
    const last = [...openModals].pop();
    if (last) { closeModal(last); return; }
    closeCmdPalette();
  }
});

// Generic close button wiring (static [data-close-modal] handled above)
document.getElementById('modal-close').addEventListener('click', () => closeModal('candidate-modal'));
document.getElementById('modal-close-btn').addEventListener('click', () => closeModal('candidate-modal'));

// ── THEME TOGGLE ───────────────────────────────────────────────
const themeToggle = document.getElementById('theme-toggle');
const themeLabel = themeToggle.querySelector('.sidebar-label');

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeLabel.textContent = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
  localStorage.setItem('hf-theme', theme);
}

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.dataset.theme || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// Init theme
applyTheme(localStorage.getItem('hf-theme') || 'dark');

// ── SIDEBAR COLLAPSE ───────────────────────────────────────────
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');

function setSidebarCollapsed(collapsed) {
  sidebar.classList.toggle('collapsed', collapsed);
  sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  localStorage.setItem('hf-sidebar', collapsed ? '1' : '0');
}

sidebarToggle.addEventListener('click', () => {
  const isCollapsed = sidebar.classList.contains('collapsed');
  setSidebarCollapsed(!isCollapsed);
});

// Init sidebar
setSidebarCollapsed(localStorage.getItem('hf-sidebar') === '1');

// ── PAGE NAVIGATION ────────────────────────────────────────────
const pages = { dashboard: null, integrations: null, settings: null, audit: null };
const navItems = document.querySelectorAll('.sidebar-nav-item[data-page]');
const pageTitle = document.getElementById('page-title');

const PAGE_TITLES = {
  dashboard:    'Dashboard',
  integrations: 'Integrations',
  settings:     'Settings',
  audit:        'Audit Log'
};

function showPage(name) {
  navItems.forEach((item) => {
    const active = item.dataset.page === name;
    item.classList.toggle('active', active);
    item.setAttribute('aria-current', active ? 'page' : 'false');
  });

  Object.keys(pages).forEach((p) => {
    const el = document.getElementById(`page-${p}`);
    if (el) el.hidden = p !== name;
  });

  pageTitle.textContent = PAGE_TITLES[name] || name;

  if (name === 'audit') loadAuditPage();
  if (name === 'integrations') loadIntegrationsPage();
  if (name === 'settings') loadSettingsPage();
}

navItems.forEach((item) => {
  item.addEventListener('click', () => showPage(item.dataset.page));
});

// ── STATE ──────────────────────────────────────────────────────
let allCandidates = [];
let filteredCandidates = [];
let selectedIds = new Set();
let sortKey = '';
let sortDir = 'asc';
let activeCandidateId = null;
let pendingInterviewId = null;
let pendingRejectIds = [];

// Restore sort from localStorage
const savedSort = localStorage.getItem('hf-sort');
if (savedSort) {
  try {
    const s = JSON.parse(savedSort);
    sortKey = s.key || '';
    sortDir = s.dir || 'asc';
  } catch { /* ignore */ }
}

// ── URL STATE ─────────────────────────────────────────────────
function pushUrlState() {
  const params = new URLSearchParams();
  const pos = document.getElementById('filter-position').value;
  const status = document.getElementById('filter-status').value;
  const search = document.getElementById('search-input').value;
  if (pos) params.set('position', pos);
  if (status) params.set('status', status);
  if (search) params.set('search', search);
  if (sortKey) { params.set('sort', sortKey); params.set('dir', sortDir); }
  if (activeCandidateId) params.set('candidate', activeCandidateId);
  const url = params.toString() ? `?${params.toString()}` : window.location.pathname;
  history.replaceState(null, '', url);
}

function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('position')) document.getElementById('filter-position').value = params.get('position');
  if (params.has('status'))   document.getElementById('filter-status').value   = params.get('status');
  if (params.has('search'))   document.getElementById('search-input').value    = params.get('search');
  if (params.has('sort'))  { sortKey = params.get('sort'); sortDir = params.get('dir') || 'asc'; }
  return { candidateId: params.get('candidate') };
}

// ── KPI CARDS ─────────────────────────────────────────────────
document.querySelectorAll('.kpi-card').forEach((card) => {
  card.addEventListener('click', () => {
    const filterVal = card.dataset.kpiFilter;
    if (card.dataset.kpiSpecial) return; // completion rate card — no filter
    document.querySelectorAll('.kpi-card').forEach((c) => c.classList.remove('active'));
    card.classList.add('active');
    const statusSelect = document.getElementById('filter-status');
    statusSelect.value = filterVal;
    applyFilters();
    pushUrlState();
  });
});

// ── POSITION DROPDOWN ──────────────────────────────────────────
async function loadPositions() {
  try {
    const data = await api('/api/positions');
    const select = document.getElementById('filter-position');
    const datalist = document.getElementById('position-list');
    (data.positions || []).forEach((pos) => {
      const opt = document.createElement('option');
      opt.value = pos;
      opt.textContent = pos;
      select.appendChild(opt);

      const dopt = document.createElement('option');
      dopt.value = pos;
      datalist.appendChild(dopt);
    });
  } catch { /* non-critical */ }
}

// ── FILTERS + SEARCH ──────────────────────────────────────────
function applyFilters() {
  const pos    = document.getElementById('filter-position').value.trim().toLowerCase();
  const status = document.getElementById('filter-status').value.trim().toLowerCase();
  const search = document.getElementById('search-input').value.trim().toLowerCase();

  filteredCandidates = allCandidates.filter((c) => {
    if (pos    && !c.position?.toLowerCase().includes(pos))       return false;
    if (status && c.workflowState?.toLowerCase() !== status)      return false;
    if (search && !c.fullName?.toLowerCase().includes(search) &&
                  !c.email?.toLowerCase().includes(search))       return false;
    return true;
  });

  // Sort
  if (sortKey) {
    filteredCandidates.sort((a, b) => {
      let av = a[sortKey] ?? (a.recommendation?.[sortKey] ?? '');
      let bv = b[sortKey] ?? (b.recommendation?.[sortKey] ?? '');
      if (sortKey === 'score') {
        av = Number(a.recommendation?.score ?? 0);
        bv = Number(b.recommendation?.score ?? 0);
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ?  1 : -1;
      return 0;
    });
  }

  renderCandidateRows();
  updateSortHeaders();
  updateEmptyState();
  updateKpiFromFiltered();
  pushUrlState();
}

function updateSortHeaders() {
  document.querySelectorAll('th.sortable').forEach((th) => {
    if (th.dataset.sort === sortKey) {
      th.setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending');
    } else {
      th.setAttribute('aria-sort', 'none');
    }
  });
}

// ── SORT ──────────────────────────────────────────────────────
document.querySelectorAll('th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (sortKey === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = key;
      sortDir = 'asc';
    }
    localStorage.setItem('hf-sort', JSON.stringify({ key: sortKey, dir: sortDir }));
    applyFilters();
  });
  th.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); th.click(); }
  });
});

// ── CANDIDATE TABLE ────────────────────────────────────────────
const candidateRowsTbody = document.getElementById('candidate-rows');
const emptyState = document.getElementById('empty-state');

function statusPill(state) {
  const label = STATE_LABELS[state] || state || '—';
  const cls   = STATE_PILL_CLASS[state] || 'pill-default';
  return `<span class="pill ${cls}">${esc(label)}</span>`;
}

function renderCandidateRows() {
  candidateRowsTbody.innerHTML = '';

  if (!filteredCandidates.length) return;

  for (const c of filteredCandidates) {
    const score = c.recommendation?.score ?? '—';
    const rank  = c.recommendation?.rankLabel ?? '—';
    const isSelected = selectedIds.has(c.id);

    const row = document.createElement('tr');
    row.dataset.id = c.id;
    if (isSelected) row.classList.add('selected');

    row.innerHTML = `
      <td class="col-check" onclick="event.stopPropagation()">
        <input type="checkbox" class="row-check" data-id="${esc(c.id)}"
          aria-label="Select ${esc(c.fullName)}" ${isSelected ? 'checked' : ''} />
      </td>
      <td>
        <div style="font-weight:600">${esc(c.fullName)}</div>
        <div style="font-size:11px;color:var(--text-muted)">${esc(c.email || '')}</div>
      </td>
      <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.position)}">${esc(c.position)}</td>
      <td>${statusPill(c.workflowState)}</td>
      <td><span style="font-weight:700;color:var(--accent)">${esc(String(score))}</span></td>
      <td style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary);font-size:12px">${esc(rank)}</td>
      <td onclick="event.stopPropagation()">
        <div class="row-actions">
          ${rowActionBtn('view',   c.id, `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`, 'View')}
          ${rowActionBtn('copy',   c.id, `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`, 'Copy Email')}
          ${rowActionBtn('score',     c.id, `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`, 'Score')}
          ${rowActionBtn('shortlist', c.id, `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`, 'Shortlist')}
          ${rowActionBtn('followup',  c.id, `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`, 'Follow-up')}
          ${rowActionBtn('interview', c.id, `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`, 'Schedule')}
          ${rowActionBtn('hire',      c.id, `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`, 'Hire', 'btn-success-ghost')}
          ${rowActionBtn('reject',    c.id, `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`, 'Reject', 'btn-danger-ghost')}
        </div>
      </td>`;

    // Click row to open modal
    row.addEventListener('click', (e) => {
      if (e.target.closest('.col-check') || e.target.closest('.row-actions')) return;
      openCandidateModal(c.id);
    });

    candidateRowsTbody.appendChild(row);
  }
}

function rowActionBtn(action, id, iconSvg, label, extraClass = '') {
  return `<button class="action-btn ${extraClass}" data-action="${esc(action)}" data-id="${esc(id)}" aria-label="${esc(label)} candidate" title="${esc(label)}">${iconSvg}<span>${esc(label)}</span></button>`;
}

function renderSkeletonRows(n = 5) {
  candidateRowsTbody.innerHTML = Array.from({ length: n }, () => `
    <tr class="skeleton-row">
      <td class="col-check"><div class="skeleton-cell" style="width:15px;height:15px;border-radius:3px"></div></td>
      <td><div class="skeleton-cell" style="width:120px;height:13px"></div></td>
      <td><div class="skeleton-cell" style="width:140px;height:13px"></div></td>
      <td><div class="skeleton-cell" style="width:80px;height:18px;border-radius:999px"></div></td>
      <td><div class="skeleton-cell" style="width:36px;height:13px"></div></td>
      <td><div class="skeleton-cell" style="width:80px;height:13px"></div></td>
      <td><div class="skeleton-cell" style="width:200px;height:13px"></div></td>
    </tr>`).join('');
}

function updateEmptyState() {
  const hasRows = filteredCandidates.length > 0;
  emptyState.hidden = hasRows;
  document.getElementById('candidates-table').style.display = hasRows ? '' : 'none';
}

// ── BULK SELECT ────────────────────────────────────────────────
const selectAll = document.getElementById('select-all');
const bulkToolbar = document.getElementById('bulk-toolbar');
const bulkCount = document.getElementById('bulk-count');

function updateBulkUI() {
  const n = selectedIds.size;
  bulkToolbar.hidden = n === 0;
  bulkCount.textContent = `${n} selected`;
  selectAll.indeterminate = n > 0 && n < filteredCandidates.length;
  selectAll.checked = n > 0 && n === filteredCandidates.length;
}

candidateRowsTbody.addEventListener('change', (e) => {
  if (!e.target.classList.contains('row-check')) return;
  const id = e.target.dataset.id;
  if (e.target.checked) selectedIds.add(id);
  else selectedIds.delete(id);
  const row = e.target.closest('tr');
  if (row) row.classList.toggle('selected', e.target.checked);
  updateBulkUI();
});

selectAll.addEventListener('change', () => {
  filteredCandidates.forEach((c) => {
    if (selectAll.checked) selectedIds.add(c.id);
    else selectedIds.delete(c.id);
  });
  renderCandidateRows();
  updateBulkUI();
});

document.getElementById('bulk-clear').addEventListener('click', () => {
  selectedIds.clear();
  renderCandidateRows();
  updateBulkUI();
});

document.getElementById('bulk-export').addEventListener('click', () => {
  const subset = allCandidates.filter((c) => selectedIds.has(c.id));
  exportToCsv(subset);
  toast(`Exported ${subset.length} candidates`, 'success');
});

document.getElementById('bulk-reject').addEventListener('click', async () => {
  if (!selectedIds.size) return;
  const reason = prompt('Enter rejection reason for all selected candidates:');
  if (!reason?.trim()) return;
  const ids = [...selectedIds];
  let ok = 0; let fail = 0;
  for (const id of ids) {
    try {
      await api(`/api/candidates/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
      ok++;
    } catch { fail++; }
  }
  if (ok) toast(`Rejected ${ok} candidate(s)`, 'success');
  if (fail) toast(`Failed to reject ${fail} candidate(s)`, 'error');
  selectedIds.clear();
  await loadCandidates();
});

// ── ROW ACTION HANDLER ─────────────────────────────────────────
candidateRowsTbody.addEventListener('click', async (e) => {
  const btn = e.target.closest('.action-btn');
  if (!btn) return;

  const { action, id } = btn.dataset;

  if (action === 'view') { openCandidateModal(id); return; }

  if (action === 'copy') {
    const c = allCandidates.find((x) => x.id === id);
    if (c?.email) {
      try {
        await navigator.clipboard.writeText(c.email);
        toast(`Copied: ${c.email}`, 'success');
      } catch {
        toast(c.email, 'info');
      }
    }
    return;
  }

  btn.disabled = true;
  try {
    if (action === 'score') {
      await api(`/api/candidates/${id}/score`, { method: 'POST' });
      toast('Scored successfully', 'success');
    } else if (action === 'shortlist') {
      await api(`/api/candidates/${id}/shortlist`, { method: 'POST' });
      toast('Candidate shortlisted', 'success');
    } else if (action === 'followup') {
      await api(`/api/candidates/${id}/follow-up`, { method: 'POST' });
      toast('Follow-up sent', 'success');
    } else if (action === 'interview') {
      pendingInterviewId = id;
      const today = new Date().toISOString().slice(0, 10);
      document.getElementById('interview-date').value = today;
      document.getElementById('interview-time').value = '10:00';
      openModal('interview-modal');
      btn.disabled = false;
      return;
    } else if (action === 'hire') {
      await api(`/api/candidates/${id}/hire`, { method: 'POST' });
      toast('Candidate hired!', 'success');
    } else if (action === 'reject') {
      pendingRejectIds = [id];
      document.getElementById('reject-reason').value = '';
      openModal('reject-modal');
      btn.disabled = false;
      return;
    }
    await loadCandidates();
    if (activeCandidateId === id) refreshModalTabs(id);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ── EXPORT CSV ────────────────────────────────────────────────
function exportToCsv(candidates) {
  const headers = ['id', 'fullName', 'email', 'position', 'workflowState', 'score', 'rankLabel'];
  const rows = candidates.map((c) => [
    c.id, c.fullName, c.email, c.position, c.workflowState,
    c.recommendation?.score ?? '', c.recommendation?.rankLabel ?? ''
  ]);
  const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'candidates.csv'; a.click();
  URL.revokeObjectURL(url);
}

document.getElementById('export-csv').addEventListener('click', () => {
  exportToCsv(filteredCandidates);
  toast(`Exported ${filteredCandidates.length} candidates`, 'success');
});

document.getElementById('clear-filters').addEventListener('click', () => {
  document.getElementById('filter-position').value = '';
  document.getElementById('filter-status').value = '';
  document.getElementById('search-input').value = '';
  document.querySelectorAll('.kpi-card').forEach((c) => c.classList.remove('active'));
  applyFilters();
});

// ── LOAD CANDIDATES ────────────────────────────────────────────
async function loadCandidates() {
  renderSkeletonRows();
  emptyState.hidden = true;
  document.getElementById('candidates-table').style.display = '';

  try {
    const data = await api('/api/candidates');
    allCandidates = data.items || [];
    applyFilters();
  } catch (err) {
    candidateRowsTbody.innerHTML = `<tr><td colspan="7" style="padding:24px;text-align:center;color:var(--danger)">${esc(err.message)}</td></tr>`;
  }
}

// ── KPI FROM DATA ─────────────────────────────────────────────
function updateKpiFromFiltered() {
  const total       = allCandidates.length;
  const shortlisted = allCandidates.filter((c) => c.workflowState === 'shortlisted').length;
  const interviews  = allCandidates.filter((c) => c.workflowState === 'interviewScheduled').length;
  const hired       = allCandidates.filter((c) => c.workflowState === 'hired').length;

  ['kpi-total', 'kpi-shortlisted', 'kpi-interviews', 'kpi-hired'].forEach((id) => {
    document.getElementById(id).classList.remove('skeleton-inline');
  });

  document.getElementById('kpi-total').textContent       = total;
  document.getElementById('kpi-shortlisted').textContent  = shortlisted;
  document.getElementById('kpi-interviews').textContent   = interviews;
  document.getElementById('kpi-hired').textContent        = hired;
}

// ── OPERATIONS METRICS ─────────────────────────────────────────
const opsMetrics = document.getElementById('ops-metrics');

async function loadOps() {
  try {
    const [dashboard, analytics, retry, integrations] = await Promise.all([
      api('/api/dashboard'),
      api('/api/analytics'),
      api('/api/retry-queue'),
      api('/api/integrations')
    ]);

    const completionRate = analytics.rates?.completionRate ?? '—';
    const completionEl = document.getElementById('kpi-completion');
    completionEl.classList.remove('skeleton-inline');
    completionEl.textContent = completionRate !== '—' ? `${completionRate}%` : '—';

    opsMetrics.innerHTML = `
      <div class="metric"><div class="metric-label">Total Candidates</div><div class="metric-value">${esc(String(dashboard.totals?.candidates ?? '—'))}</div></div>
      <div class="metric"><div class="metric-label">Verification Queue</div><div class="metric-value">${esc(String(dashboard.totals?.verificationQueue ?? '—'))}</div></div>
      <div class="metric"><div class="metric-label">Pending Retries</div><div class="metric-value">${esc(String(retry.items?.filter((x) => x.status === 'pending').length ?? '—'))}</div></div>
      <div class="metric"><div class="metric-label">Avg. Processing</div><div class="metric-value">${esc(String(analytics.averageProcessingHours ?? '—'))}h</div></div>
    `;

    renderIntegrationStatus(integrations);
  } catch (err) {
    opsMetrics.innerHTML = `<div class="metric"><div class="metric-label">Error</div><div class="metric-value" style="font-size:13px;color:var(--danger)">${esc(err.message)}</div></div>`;
  }
}

// ── INTEGRATION STATUS ─────────────────────────────────────────
function renderIntegrationStatus(data) {
  const gs = data.googleSheets || {};
  const enabled = gs.enabled && gs.configured;
  const intDiv = document.getElementById('integration-status');

  intDiv.innerHTML = `
    <div class="integration-item">
      <div class="integration-info">
        <div class="integration-name">Google Sheets</div>
        <div class="integration-meta">
          ${enabled ? `<span class="pill pill-green">Connected</span>` : `<span class="pill pill-default">Disconnected</span>`}
          ${gs.spreadsheetUrl ? `<br><a href="${esc(gs.spreadsheetUrl)}" target="_blank" rel="noreferrer">Open Spreadsheet</a>` : ''}
          ${gs.lastError ? `<br><span style="color:var(--danger);font-size:11px">Error: ${esc(gs.lastError)}</span>` : ''}
        </div>
      </div>
    </div>
    ${(data.upgrades || []).map((u) => `
      <div class="integration-item">
        <div class="integration-info">
          <div class="integration-name">${esc(u.label)}</div>
          <div class="integration-meta">${u.status === 'active' ? `<span class="pill pill-green">Connected</span>` : `<span class="pill pill-default">Disconnected</span>`}</div>
        </div>
      </div>`).join('')}
  `;
}

// Sync button
document.getElementById('sync-google-sheets').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await api('/api/integrations/google-sheets/sync', { method: 'POST' });
    toast('Google Sheets synced', 'success');
    await loadOps();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ── CANDIDATE MODAL ────────────────────────────────────────────
async function openCandidateModal(id) {
  activeCandidateId = id;
  openModal('candidate-modal');
  pushUrlState();

  // Reset to overview tab
  switchTab('overview');

  // Load candidate data
  await renderModalOverview(id);
}

function refreshModalTabs(id) {
  renderModalOverview(id);
}

// Tab switching
const tabBtns = document.querySelectorAll('.modal-tab');
tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(name) {
  tabBtns.forEach((b) => {
    const active = b.dataset.tab === name;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.hidden = p.id !== `tab-${name}`;
  });

  // Lazy-load tab content
  if (activeCandidateId) {
    if (name === 'documents')  renderModalDocs(activeCandidateId);
    if (name === 'compliance') renderModalCompliance(activeCandidateId);
    if (name === 'email-log')  renderModalEmailLog(activeCandidateId);
    if (name === 'audit-log')  renderModalAuditLog(activeCandidateId);
  }
}

async function renderModalOverview(id) {
  const content = document.getElementById('modal-overview-content');
  content.innerHTML = '<div class="skeleton-block"></div>';

  try {
    const c = await api(`/api/candidates/${id}`);
    document.getElementById('modal-candidate-title').textContent = c.fullName;

    // Update modal footer actions
    const footer = document.getElementById('modal-actions');
    footer.innerHTML = `
      <button class="btn btn-ghost" id="modal-close-btn-inner">Close</button>
      <button class="btn btn-sm btn-secondary" data-action="score"     data-id="${esc(id)}" title="Score">Score</button>
      <button class="btn btn-sm btn-secondary" data-action="shortlist" data-id="${esc(id)}" title="Shortlist">Shortlist</button>
      <button class="btn btn-sm btn-secondary" data-action="followup"  data-id="${esc(id)}" title="Follow-up">Follow-up</button>
      <button class="btn btn-sm btn-secondary" data-action="interview" data-id="${esc(id)}" title="Schedule">Schedule</button>
      <button class="btn btn-sm btn-success-ghost action-btn btn-success-ghost" data-action="hire"   data-id="${esc(id)}" title="Hire" style="color:var(--success);border-color:var(--success-dim)">Hire</button>
      <button class="btn btn-sm btn-danger"   data-action="reject"   data-id="${esc(id)}" title="Reject">Reject</button>
    `;

    footer.querySelector('#modal-close-btn-inner').addEventListener('click', () => closeModal('candidate-modal'));

    footer.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.action;
        btn.disabled = true;
        try {
          if (act === 'score')     { await api(`/api/candidates/${id}/score`,     { method: 'POST' }); toast('Scored', 'success'); }
          if (act === 'shortlist') { await api(`/api/candidates/${id}/shortlist`, { method: 'POST' }); toast('Shortlisted', 'success'); }
          if (act === 'followup')  { await api(`/api/candidates/${id}/follow-up`, { method: 'POST' }); toast('Follow-up sent', 'success'); }
          if (act === 'hire')      { await api(`/api/candidates/${id}/hire`,      { method: 'POST' }); toast('Hired!', 'success'); }
          if (act === 'interview') {
            pendingInterviewId = id;
            document.getElementById('interview-date').value = new Date().toISOString().slice(0, 10);
            document.getElementById('interview-time').value = '10:00';
            openModal('interview-modal');
            btn.disabled = false; return;
          }
          if (act === 'reject') {
            pendingRejectIds = [id];
            document.getElementById('reject-reason').value = '';
            openModal('reject-modal');
            btn.disabled = false; return;
          }
          await loadCandidates();
          await renderModalOverview(id);
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });

    content.innerHTML = `
      <div class="score-display">
        <div class="score-number">${esc(String(c.recommendation?.score ?? '—'))}</div>
        <div class="score-meta">
          <div class="score-label">${esc(c.recommendation?.rankLabel || '—')}</div>
          <div class="score-reason">${esc(c.recommendation?.reason || 'Not yet scored')}</div>
        </div>
      </div>
      <div class="detail-grid">
        <div class="detail-item">
          <div class="detail-label">Full Name</div>
          <div class="detail-value">${esc(c.fullName)}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Email</div>
          <div class="detail-value"><a href="mailto:${esc(c.email)}" style="color:var(--accent)">${esc(c.email)}</a></div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Position</div>
          <div class="detail-value">${esc(c.position)}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Workflow Status</div>
          <div class="detail-value">${statusPill(c.workflowState)}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Applied At</div>
          <div class="detail-value">${esc(formatDate(c.appliedAt || c.createdAt))}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Last Updated</div>
          <div class="detail-value">${esc(formatDate(c.updatedAt))}</div>
        </div>
        ${c.interviewDetails ? `
        <div class="detail-item" style="grid-column:1/-1">
          <div class="detail-label">Interview</div>
          <div class="detail-value">${esc(c.interviewDetails.date)} at ${esc(c.interviewDetails.time)} — ${esc(c.interviewDetails.venue || 'TBD')}</div>
        </div>` : ''}
      </div>
    `;
  } catch (err) {
    content.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`;
  }
}

async function renderModalDocs(id) {
  const content = document.getElementById('modal-docs-content');
  content.innerHTML = '<div class="skeleton-block"></div>';
  try {
    const c = await api(`/api/candidates/${id}`);
    const docs = Object.entries(c.documentStatus || {});
    if (!docs.length) { content.innerHTML = '<p style="color:var(--text-muted)">No documents on record.</p>'; return; }

    const received = docs.filter(([, v]) => v === 'received').length;
    const pct = Math.round((received / docs.length) * 100);

    content.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
        <div style="flex:1;height:6px;background:var(--glass-border);border-radius:999px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:var(--success);border-radius:999px;transition:width 600ms"></div>
        </div>
        <span style="font-size:13px;font-weight:700;color:var(--success)">${pct}% received</span>
      </div>
      <div class="doc-list">
        ${docs.map(([name, status]) => {
          const barCls   = status === 'received' ? 'doc-bar-received' : status === 'missing' ? 'doc-bar-missing' : 'doc-bar-invalid';
          const pillCls  = status === 'received' ? 'pill-green'       : status === 'missing' ? 'pill-amber'      : 'pill-red';
          const tooltip  = status === 'missing' ? 'Document not yet submitted' : status === 'invalid' ? 'Document failed validation' : 'Document received';
          return `
            <div class="doc-item" title="${esc(tooltip)}">
              <div class="doc-name">${esc(name)}</div>
              <div class="doc-bar-wrap"><div class="doc-bar ${barCls}" style="width:${status === 'received' ? '100' : '0'}%"></div></div>
              <span class="pill ${pillCls}">${esc(status)}</span>
            </div>`;
        }).join('')}
      </div>
    `;
  } catch (err) {
    content.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`;
  }
}

async function renderModalCompliance(id) {
  const content = document.getElementById('modal-compliance-content');
  content.innerHTML = '<div class="skeleton-block"></div>';
  try {
    const c = await api(`/api/candidates/${id}`);
    const comp = c.compliance || {};
    content.innerHTML = `
      <div class="compliance-badge ${comp.disqualified ? 'compliance-fail' : 'compliance-ok'}">
        ${comp.disqualified
          ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> Disqualified`
          : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Compliant`}
      </div>
      ${comp.disqualified && comp.reasons?.length ? `
        <div class="detail-label" style="margin-bottom:8px">Disqualification Reasons</div>
        <ul class="compliance-reasons">
          ${comp.reasons.map((r) => `<li class="compliance-reason">${esc(r)}</li>`).join('')}
        </ul>` : ''}
    `;
  } catch (err) {
    content.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`;
  }
}

async function renderModalEmailLog(id) {
  const content = document.getElementById('modal-email-content');
  content.innerHTML = '<div class="skeleton-block"></div>';
  try {
    const [events, candidate] = await Promise.all([
      api('/api/email-events'),
      api(`/api/candidates/${id}`)
    ]);
    const filtered = (events.items || []).filter((e) =>
      e.candidateId === id || e.toEmail === candidate.email || e.fromEmail === candidate.email
    );
    if (!filtered.length) { content.innerHTML = '<p style="color:var(--text-muted)">No email events for this candidate.</p>'; return; }
    content.innerHTML = `<div class="log-list">${filtered.map((e) => `
      <div class="log-item">
        <div class="log-time">${esc(formatDate(e.sentAt || e.createdAt))}</div>
        <div class="log-text">${esc(e.type || e.event || 'Email')} — ${esc(e.subject || '')}</div>
        <div class="log-meta">${e.toEmail ? `To: ${esc(e.toEmail)}` : ''} ${e.status ? `· Status: ${esc(e.status)}` : ''}</div>
      </div>`).join('')}</div>`;
  } catch (err) {
    content.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`;
  }
}

async function renderModalAuditLog(id) {
  const content = document.getElementById('modal-audit-content');
  content.innerHTML = '<div class="skeleton-block"></div>';
  try {
    const logs = await api('/api/audit-logs');
    const filtered = (logs.items || []).filter((l) => l.candidateId === id || l.targetId === id);
    if (!filtered.length) { content.innerHTML = '<p style="color:var(--text-muted)">No audit events for this candidate.</p>'; return; }
    content.innerHTML = `<div class="log-list">${filtered.map((l) => `
      <div class="log-item">
        <div class="log-time">${esc(formatDate(l.timestamp || l.createdAt))}</div>
        <div class="log-text">${esc(l.action || l.event || '—')}</div>
        <div class="log-meta">Actor: ${esc(l.actor || l.role || '—')}</div>
      </div>`).join('')}</div>`;
  } catch (err) {
    content.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`;
  }
}

// Close modal when navigating away
document.getElementById('candidate-modal').addEventListener('transitionend', () => {
  if (!document.getElementById('candidate-modal').classList.contains('is-open')) {
    activeCandidateId = null;
    pushUrlState();
  }
});

// ── INTAKE MODAL ───────────────────────────────────────────────
document.getElementById('new-candidate-btn').addEventListener('click', () => {
  document.getElementById('intake-form').reset();
  openModal('intake-modal');
});

document.getElementById('intake-submit').addEventListener('click', async () => {
  const form = document.getElementById('intake-form');
  if (!form.reportValidity()) return;
  const btn = document.getElementById('intake-submit');
  btn.disabled = true;
  try {
    const data = new FormData(form);
    await api('/api/applications/intake', {
      method: 'POST',
      body: JSON.stringify({
        fullName: data.get('fullName'),
        email: data.get('email'),
        position: data.get('position')
      })
    });
    closeModal('intake-modal');
    toast('Candidate registered', 'success');
    await loadCandidates();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ── INTERVIEW MODAL ────────────────────────────────────────────
document.getElementById('interview-submit').addEventListener('click', async () => {
  if (!pendingInterviewId) return;
  const date  = document.getElementById('interview-date').value;
  const time  = document.getElementById('interview-time').value;
  const venue = document.getElementById('interview-venue').value || 'Main Office';
  if (!date || !time) { toast('Please set date and time', 'warn'); return; }
  const btn = document.getElementById('interview-submit');
  btn.disabled = true;
  try {
    await api(`/api/candidates/${pendingInterviewId}/interview`, {
      method: 'POST',
      body: JSON.stringify({ date, time, venue })
    });
    closeModal('interview-modal');
    toast('Interview scheduled', 'success');
    await loadCandidates();
    if (activeCandidateId === pendingInterviewId) renderModalOverview(pendingInterviewId);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    pendingInterviewId = null;
  }
});

// ── REJECT MODAL ───────────────────────────────────────────────
document.getElementById('reject-submit').addEventListener('click', async () => {
  if (!pendingRejectIds.length) return;
  const reason = document.getElementById('reject-reason').value.trim();
  if (!reason) { toast('Please enter a rejection reason', 'warn'); return; }
  const btn = document.getElementById('reject-submit');
  btn.disabled = true;
  try {
    for (const id of pendingRejectIds) {
      await api(`/api/candidates/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
    }
    closeModal('reject-modal');
    toast(`Rejected ${pendingRejectIds.length} candidate(s)`, 'success');
    if (activeCandidateId && pendingRejectIds.includes(activeCandidateId)) {
      closeModal('candidate-modal');
    }
    await loadCandidates();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    pendingRejectIds = [];
  }
});

// ── REFRESH ────────────────────────────────────────────────────
document.getElementById('refresh').addEventListener('click', async () => {
  const btn = document.getElementById('refresh');
  btn.disabled = true;
  try {
    await Promise.all([loadCandidates(), loadOps()]);
    toast('Refreshed', 'success', 2000);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// Filter event listeners
document.getElementById('filter-position').addEventListener('change', () => { applyFilters(); pushUrlState(); });
document.getElementById('filter-status').addEventListener('change', () => { applyFilters(); pushUrlState(); });
document.getElementById('search-input').addEventListener('input', () => { applyFilters(); pushUrlState(); });

// ── AUDIT PAGE ─────────────────────────────────────────────────
async function loadAuditPage() {
  const tbody = document.getElementById('audit-rows');
  const empty = document.getElementById('audit-empty');
  tbody.innerHTML = `<tr><td colspan="5" style="padding:20px;text-align:center"><div class="skeleton-cell" style="width:100%;height:13px"></div></td></tr>`;
  try {
    const data = await api('/api/audit-logs');
    const items = data.items || [];
    if (!items.length) { tbody.innerHTML = ''; empty.hidden = false; return; }
    tbody.innerHTML = items.map((l) => `
      <tr>
        <td>${esc(formatDate(l.timestamp || l.createdAt))}</td>
        <td>${esc(l.actor || l.role || '—')}</td>
        <td>${esc(l.action || l.event || '—')}</td>
        <td>${esc(l.candidateId || l.targetId || '—')}</td>
        <td style="color:var(--text-secondary)">${esc(l.details ? JSON.stringify(l.details) : '—')}</td>
      </tr>`).join('');
    empty.hidden = true;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--danger);padding:16px">${esc(err.message)}</td></tr>`;
  }
}

// ── INTEGRATIONS PAGE ──────────────────────────────────────────
async function loadIntegrationsPage() {
  const el = document.getElementById('integrations-detail');
  el.innerHTML = '<div class="skeleton-block"></div>';
  try {
    const data = await api('/api/integrations');
    el.innerHTML = '';
    const container = document.createElement('div');
    container.style.padding = '16px';
    // Reuse the same renderIntegrationStatus but put in new container
    const gs = data.googleSheets || {};
    container.innerHTML = `
      <div class="integration-item">
        <div class="integration-info">
          <div class="integration-name">Google Sheets Integration</div>
          <div class="integration-meta">
            ${gs.enabled && gs.configured ? '<span class="pill pill-green">Connected</span>' : '<span class="pill pill-default">Disconnected</span>'}
            ${gs.spreadsheetUrl ? `<br><a href="${esc(gs.spreadsheetUrl)}" target="_blank" rel="noreferrer">Open Spreadsheet</a>` : ''}
            ${gs.lastSyncedAt ? `<br><span style="font-size:11px;color:var(--text-muted)">Last sync: ${esc(gs.lastSyncedAt)}</span>` : ''}
            ${gs.lastError ? `<br><span style="color:var(--danger);font-size:11px">Error: ${esc(gs.lastError)}</span>` : ''}
          </div>
        </div>
        <button class="btn btn-sm" id="int-page-sync" ${!gs.enabled ? 'disabled title="Google Sheets is disabled"' : ''}>Sync Now</button>
      </div>
      ${(data.upgrades || []).map((u) => `
        <div class="integration-item">
          <div class="integration-info">
            <div class="integration-name">${esc(u.label)}</div>
            <div class="integration-meta">${u.status === 'active' ? `<span class="pill pill-green">Connected</span>` : `<span class="pill pill-default">Disconnected</span>`}</div>
          </div>
        </div>`).join('')}
    `;
    el.appendChild(container);

    const syncBtn = document.getElementById('int-page-sync');
    if (syncBtn && !syncBtn.disabled) {
      syncBtn.addEventListener('click', async () => {
        syncBtn.disabled = true;
        try {
          await api('/api/integrations/google-sheets/sync', { method: 'POST' });
          toast('Synced', 'success');
          loadIntegrationsPage();
        } catch (err) {
          toast(err.message, 'error');
          syncBtn.disabled = false;
        }
      });
    }
  } catch (err) {
    el.innerHTML = `<p style="color:var(--danger);padding:16px">${esc(err.message)}</p>`;
  }
}

// ── COMMAND PALETTE ────────────────────────────────────────────
const cmdPalette = document.getElementById('cmd-palette');
const cmdInput   = document.getElementById('cmd-input');
const cmdList    = document.getElementById('cmd-list');

const CMD_ACTIONS = [
  { label: 'New Candidate',    shortcut: 'N', icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,       action: () => { closeCmdPalette(); openModal('intake-modal'); } },
  { label: 'Refresh Data',     shortcut: 'R', icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.65"/></svg>`,           action: () => { closeCmdPalette(); document.getElementById('refresh').click(); } },
  { label: 'Export CSV',       shortcut: '',  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`, action: () => { closeCmdPalette(); document.getElementById('export-csv').click(); } },
  { label: 'Dashboard',        shortcut: '',  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`, action: () => { closeCmdPalette(); showPage('dashboard'); } },
  { label: 'Integrations',     shortcut: '',  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`, action: () => { closeCmdPalette(); showPage('integrations'); } },
  { label: 'Audit Log',        shortcut: '',  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`, action: () => { closeCmdPalette(); showPage('audit'); } },
  { label: 'Toggle Theme',     shortcut: '',  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/></svg>`, action: () => { closeCmdPalette(); document.getElementById('theme-toggle').click(); } },
  { label: 'Sync Google Sheets', shortcut: '', icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.65"/></svg>`, action: () => { closeCmdPalette(); document.getElementById('sync-google-sheets').click(); } }
];

let cmdFocusIndex = -1;
let filteredCmds = [...CMD_ACTIONS];

function openCmdPalette() {
  cmdPalette.removeAttribute('hidden');
  cmdPalette.setAttribute('aria-hidden', 'false');
  cmdInput.value = '';
  cmdFocusIndex = -1;
  filteredCmds = [...CMD_ACTIONS];
  renderCmdList();
  requestAnimationFrame(() => cmdInput.focus());
}

function closeCmdPalette() {
  cmdPalette.setAttribute('hidden', '');
  cmdPalette.setAttribute('aria-hidden', 'true');
}

function renderCmdList() {
  cmdList.innerHTML = filteredCmds.map((cmd, i) => `
    <li class="cmd-item${i === cmdFocusIndex ? ' focused' : ''}" data-index="${i}" role="option" aria-selected="${i === cmdFocusIndex}">
      ${cmd.icon}
      <span>${esc(cmd.label)}</span>
      ${cmd.shortcut ? `<span class="cmd-item-shortcut">${esc(cmd.shortcut)}</span>` : ''}
    </li>`).join('');

  cmdList.querySelectorAll('.cmd-item').forEach((item, i) => {
    item.addEventListener('click', () => filteredCmds[i]?.action());
    item.addEventListener('mouseover', () => { cmdFocusIndex = i; renderCmdList(); });
  });
}

cmdInput.addEventListener('input', () => {
  const q = cmdInput.value.toLowerCase();
  filteredCmds = CMD_ACTIONS.filter((c) => c.label.toLowerCase().includes(q));
  cmdFocusIndex = -1;
  renderCmdList();
});

cmdInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    cmdFocusIndex = Math.min(cmdFocusIndex + 1, filteredCmds.length - 1);
    renderCmdList();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    cmdFocusIndex = Math.max(cmdFocusIndex - 1, 0);
    renderCmdList();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (cmdFocusIndex >= 0 && filteredCmds[cmdFocusIndex]) {
      filteredCmds[cmdFocusIndex].action();
    } else if (filteredCmds.length === 1) {
      filteredCmds[0].action();
    }
  }
});

// Backdrop click closes palette
cmdPalette.addEventListener('click', (e) => {
  if (e.target === cmdPalette) closeCmdPalette();
});

document.getElementById('cmd-trigger').addEventListener('click', openCmdPalette);

// ── KEYBOARD SHORTCUTS ─────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Don't trigger if typing in an input
  const inInput = e.target.matches('input, textarea, select, [contenteditable]');

  // Ctrl+K or Cmd+K → command palette
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    if (cmdPalette.hasAttribute('hidden')) openCmdPalette();
    else closeCmdPalette();
    return;
  }

  // '/' → focus search
  if (!inInput && e.key === '/') {
    e.preventDefault();
    document.getElementById('search-input').focus();
    return;
  }

  // 'N' → new candidate
  if (!inInput && e.key.toLowerCase() === 'n' && openModals.size === 0 && cmdPalette.hasAttribute('hidden')) {
    openModal('intake-modal');
    return;
  }

  // 'R' → refresh
  if (!inInput && e.key.toLowerCase() === 'r' && openModals.size === 0 && cmdPalette.hasAttribute('hidden')) {
    document.getElementById('refresh').click();
  }
});

// ── SETTINGS PAGE ─────────────────────────────────────────────
let currentSettings = null;

function isoToDatetimeLocal(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '';
  }
}

function datetimeLocalToIso(local) {
  if (!local) return '';
  try {
    return new Date(local).toISOString();
  } catch {
    return local;
  }
}

function applySettingsToForm(s) {
  const get = (id) => document.getElementById(id);
  get('s-hiringDeadline').value = isoToDatetimeLocal(s.hiringDeadline);
  get('s-applicationOpenDate').value = isoToDatetimeLocal(s.applicationOpenDate);
  get('s-maxApplicationsPerRole').value = s.maxApplicationsPerRole ?? 0;
  get('s-defaultJobVisibility').value = s.defaultJobVisibility || 'public';
  get('s-companyName').value = s.companyName || '';
  get('s-companyEmail').value = s.companyEmail || '';
  get('s-replyToEmail').value = s.replyToEmail || '';
  get('s-mailboxAddress').value = s.mailboxAddress || '';
  get('s-hiringManagerName').value = s.hiringManagerName || '';
  get('s-timezone').value = s.timezone || '';
  get('s-autoResponseSubject').value = s.autoResponseSubject || '';
  get('s-reminderCadenceDays').value = s.reminderCadenceDays ?? 3;
  get('s-notifyNewApplication').checked = Boolean(s.notifyNewApplication);
  get('s-interviewWindowStart').value = s.interviewWindowStart || '';
  get('s-interviewWindowEnd').value = s.interviewWindowEnd || '';
  get('s-allowedFileTypes').value = s.allowedFileTypes || '';
  get('s-maxUploadSizeMb').value = s.maxUploadSizeMb ?? 10;
  get('s-careerPageBanner').value = s.careerPageBanner || '';
  get('s-dataRetentionDays').value = s.dataRetentionDays ?? 365;
}

function readSettingsFromForm() {
  const get = (id) => document.getElementById(id);
  return {
    hiringDeadline: datetimeLocalToIso(get('s-hiringDeadline').value),
    applicationOpenDate: datetimeLocalToIso(get('s-applicationOpenDate').value),
    maxApplicationsPerRole: Number(get('s-maxApplicationsPerRole').value) || 0,
    defaultJobVisibility: get('s-defaultJobVisibility').value,
    companyName: get('s-companyName').value.trim(),
    companyEmail: get('s-companyEmail').value.trim(),
    replyToEmail: get('s-replyToEmail').value.trim(),
    mailboxAddress: get('s-mailboxAddress').value.trim(),
    hiringManagerName: get('s-hiringManagerName').value.trim(),
    timezone: get('s-timezone').value.trim(),
    autoResponseSubject: get('s-autoResponseSubject').value.trim(),
    reminderCadenceDays: Number(get('s-reminderCadenceDays').value) || 3,
    notifyNewApplication: get('s-notifyNewApplication').checked,
    interviewWindowStart: get('s-interviewWindowStart').value,
    interviewWindowEnd: get('s-interviewWindowEnd').value,
    allowedFileTypes: get('s-allowedFileTypes').value.trim(),
    maxUploadSizeMb: Number(get('s-maxUploadSizeMb').value) || 10,
    careerPageBanner: get('s-careerPageBanner').value,
    dataRetentionDays: Number(get('s-dataRetentionDays').value) || 365
  };
}

async function loadSettingsPage() {
  try {
    currentSettings = await api('/api/settings');
    applySettingsToForm(currentSettings);
  } catch (err) {
    toast(`Failed to load settings: ${err.message}`, 'error', 0);
  }
}

const settingsForm = document.getElementById('settings-form');
settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const saveBtn = document.getElementById('settings-save');
  saveBtn.disabled = true;
  try {
    const updates = readSettingsFromForm();
    currentSettings = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
    applySettingsToForm(currentSettings);
    toast('Settings saved successfully', 'success');
  } catch (err) {
    toast(`Failed to save settings: ${err.message}`, 'error', 0);
  } finally {
    saveBtn.disabled = false;
  }
});

document.getElementById('settings-reset').addEventListener('click', () => {
  if (currentSettings) {
    applySettingsToForm(currentSettings);
    toast('Reset to last saved values', 'info');
  }
});

// ── INIT ──────────────────────────────────────────────────────
async function init() {
  // Populate status dropdown from WORKFLOW_STATES constant
  const statusSelect = document.getElementById('filter-status');
  WORKFLOW_STATES.forEach((state) => {
    const opt = document.createElement('option');
    opt.value = state;
    opt.textContent = STATE_LABELS[state] || state;
    statusSelect.appendChild(opt);
  });
  const { candidateId } = readUrlState();

  // Load positions for dropdown
  loadPositions();

  // Load candidates and ops in parallel
  try {
    await Promise.all([loadCandidates(), loadOps()]);
  } catch (err) {
    toast(`Failed to load data: ${err.message}`, 'error', 0);
  }

  // If URL had a candidate, open modal
  if (candidateId) {
    openCandidateModal(candidateId);
  }
}

init();
