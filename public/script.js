const candidateRows = document.getElementById('candidate-rows');
const details = document.getElementById('details');
const opsMetrics = document.getElementById('ops-metrics');
const interviewDateInput = document.getElementById('interview-date');
const interviewTimeInput = document.getElementById('interview-time');
const interviewVenueInput = document.getElementById('interview-venue');
const filterPositionInput = document.getElementById('filter-position');
const filterStatusInput = document.getElementById('filter-status');

const today = new Date().toISOString().slice(0, 10);
if (!interviewDateInput.value) interviewDateInput.value = today;
if (!interviewTimeInput.value) interviewTimeInput.value = '10:00';

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      'x-role': 'hr'
    },
    ...options
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return response.json();
}

async function loadOps() {
  const [dashboard, analytics, retry] = await Promise.all([
    api('/api/dashboard'),
    api('/api/analytics'),
    api('/api/retry-queue')
  ]);

  opsMetrics.innerHTML = `
    <p><b>Total candidates:</b> ${dashboard.totals.candidates}</p>
    <p><b>Retry queue:</b> ${dashboard.totals.retryQueue} (${retry.items.filter((x) => x.status === 'pending').length} pending)</p>
    <p><b>Verification queue:</b> ${dashboard.totals.verificationQueue}</p>
    <p><b>Completion rate:</b> ${analytics.rates.completionRate}%</p>
    <p><b>Average processing time:</b> ${analytics.averageProcessingHours} hours</p>
  `;
}

function createActionButton(action, id, label) {
  return `<button data-action="${action}" data-id="${id}">${label}</button>`;
}

async function loadCandidates() {
  const params = new URLSearchParams();
  if (filterPositionInput.value.trim()) params.set('position', filterPositionInput.value.trim());
  if (filterStatusInput.value.trim()) params.set('status', filterStatusInput.value.trim());

  const data = await api(`/api/candidates?${params.toString()}`);
  candidateRows.innerHTML = '';

  for (const candidate of data.items) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${candidate.fullName}</td>
      <td>${candidate.position}</td>
      <td>${candidate.workflowState}</td>
      <td>${candidate.recommendation.score}</td>
      <td>${candidate.recommendation.rankLabel}</td>
      <td>
        <div class="actions">
          ${createActionButton('score', candidate.id, 'Score')}
          ${createActionButton('shortlist', candidate.id, 'Shortlist')}
          ${createActionButton('followup', candidate.id, 'Follow-up')}
          ${createActionButton('interview', candidate.id, 'Interview')}
        </div>
      </td>
    `;
    candidateRows.appendChild(row);
  }
}

async function loadDetails(id) {
  const candidate = await api(`/api/candidates/${id}`);
  details.innerHTML = `
    <h2>${candidate.fullName}</h2>
    <p><b>Email:</b> ${candidate.email}</p>
    <p><b>Status:</b> ${candidate.workflowState}</p>
    <p><b>Documents:</b> ${Object.entries(candidate.documentStatus)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' | ')}</p>
    <p><b>Compliance:</b> ${candidate.compliance.disqualified ? `Disqualified (${candidate.compliance.reasons.join('; ')})` : 'Compliant'}</p>
    <p><b>Recommendation:</b> ${candidate.recommendation.reason}</p>
  `;
}

async function reloadAll() {
  await Promise.all([loadCandidates(), loadOps()]);
}

document.getElementById('refresh').addEventListener('click', () => {
  reloadAll().catch((error) => alert(error.message));
});

filterPositionInput.addEventListener('input', () => {
  loadCandidates().catch(() => {});
});

filterStatusInput.addEventListener('input', () => {
  loadCandidates().catch(() => {});
});

document.getElementById('intake-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    await api('/api/applications/intake', {
      method: 'POST',
      body: JSON.stringify({
        fullName: form.get('fullName'),
        email: form.get('email'),
        position: form.get('position')
      })
    });
    event.target.reset();
    await reloadAll();
  } catch (error) {
    alert(error.message);
  }
});

candidateRows.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;

  const id = button.dataset.id;
  const action = button.dataset.action;

  try {
    if (action === 'score') {
      await api(`/api/candidates/${id}/score`, { method: 'POST' });
    } else if (action === 'shortlist') {
      await api(`/api/candidates/${id}/shortlist`, { method: 'POST' });
    } else if (action === 'followup') {
      await api(`/api/candidates/${id}/follow-up`, { method: 'POST' });
    } else if (action === 'interview') {
      const date = interviewDateInput.value;
      const time = interviewTimeInput.value;
      const venue = interviewVenueInput.value || 'Main Office';
      if (!date || !time) return;
      await api(`/api/candidates/${id}/interview`, {
        method: 'POST',
        body: JSON.stringify({ date, time, venue })
      });
    }
    await reloadAll();
    await loadDetails(id);
  } catch (error) {
    alert(error.message);
  }
});

candidateRows.addEventListener('mouseover', (event) => {
  const row = event.target.closest('tr');
  if (!row) return;
  const button = row.querySelector('button[data-id]');
  if (button) {
    loadDetails(button.dataset.id).catch(() => {});
  }
});

reloadAll().catch((error) => {
  details.innerHTML = `<p>${error.message}</p>`;
});
