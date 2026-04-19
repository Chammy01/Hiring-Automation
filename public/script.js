const candidateRows = document.getElementById('candidate-rows');
const details = document.getElementById('details');
const interviewDateInput = document.getElementById('interview-date');
const interviewTimeInput = document.getElementById('interview-time');
const interviewVenueInput = document.getElementById('interview-venue');

const today = new Date().toISOString().slice(0, 10);
if (!interviewDateInput.value) interviewDateInput.value = today;
if (!interviewTimeInput.value) interviewTimeInput.value = '10:00';

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return response.json();
}

async function loadCandidates() {
  const data = await api('/api/candidates');
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
          <button data-action="score" data-id="${candidate.id}">Score</button>
          <button data-action="shortlist" data-id="${candidate.id}">Shortlist</button>
          <button data-action="interview" data-id="${candidate.id}">Interview</button>
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
    <p><b>Compliance:</b> ${candidate.compliance.disqualified ? `Disqualified (${candidate.compliance.reasons.join('; ')})` : 'Compliant'}</p>
    <p><b>Recommendation:</b> ${candidate.recommendation.reason}</p>
  `;
}

document.getElementById('refresh').addEventListener('click', () => {
  loadCandidates().catch((error) => alert(error.message));
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
    await loadCandidates();
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
      await loadCandidates();
      await loadDetails(id);
    } else if (action === 'shortlist') {
      await api(`/api/candidates/${id}/shortlist`, { method: 'POST' });
      await loadCandidates();
      await loadDetails(id);
    } else if (action === 'interview') {
      const date = interviewDateInput.value;
      const time = interviewTimeInput.value;
      const venue = interviewVenueInput.value || 'Main Office';
      if (!date || !time) return;
      await api(`/api/candidates/${id}/interview`, {
        method: 'POST',
        body: JSON.stringify({ date, time, venue })
      });
      await loadCandidates();
      await loadDetails(id);
    }
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

loadCandidates().catch((error) => {
  details.innerHTML = `<p>${error.message}</p>`;
});
