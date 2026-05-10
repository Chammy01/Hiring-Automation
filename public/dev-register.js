'use strict';

const query = new URLSearchParams(window.location.search);
const developerKey = query.get('key') || '';

function devHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-developer-key': developerKey
  };
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...devHeaders(), ...(options.headers || {}) },
    credentials: 'include'
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return body;
}

async function loadUsers() {
  const data = await fetchJson('/api/auth/users');
  const root = document.getElementById('users-list');
  root.innerHTML = '';
  for (const user of data.items || []) {
    const item = document.createElement('li');
    item.innerHTML = `
      <span><strong>${user.username}</strong> <em>(${user.role})</em></span>
      <div class="list-actions">
        <button type="button" data-action="password" data-username="${user.username}">Change password</button>
        <button type="button" data-action="delete" data-username="${user.username}">Delete</button>
      </div>
    `;
    root.appendChild(item);
  }
}

document.getElementById('create-user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = document.getElementById('create-error');
  errorEl.textContent = '';
  try {
    await fetchJson('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('new-username').value.trim(),
        password: document.getElementById('new-password').value,
        role: document.getElementById('new-role').value
      })
    });
    document.getElementById('create-user-form').reset();
    await loadUsers();
  } catch (error) {
    errorEl.textContent = error.message;
  }
});

document.getElementById('users-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const username = button.dataset.username;
  const action = button.dataset.action;
  try {
    if (action === 'delete') {
      await fetchJson(`/api/auth/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
    } else if (action === 'password') {
      const password = window.prompt(`New password for ${username}`);
      if (!password) return;
      await fetchJson(`/api/auth/users/${encodeURIComponent(username)}/password`, {
        method: 'PUT',
        body: JSON.stringify({ password })
      });
    }
    await loadUsers();
  } catch (error) {
    document.getElementById('create-error').textContent = error.message;
  }
});

document.getElementById('refresh-users').addEventListener('click', () => {
  loadUsers().catch((error) => {
    document.getElementById('create-error').textContent = error.message;
  });
});

loadUsers().catch((error) => {
  document.getElementById('create-error').textContent = error.message;
});
