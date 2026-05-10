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

function promptForPassword(username) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:grid;place-items:center;z-index:9999';
    overlay.innerHTML = `
      <div style="width:min(360px,90vw);background:#0f172a;border:1px solid rgba(255,255,255,.2);border-radius:12px;padding:16px;color:#fff">
        <h3 style="margin:0 0 8px;font-size:1rem">Change password: ${username}</h3>
        <input id="pw-modal-input" type="password" placeholder="New password" style="width:100%;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.05);color:#fff" />
        <div style="display:flex;gap:8px;margin-top:10px">
          <button id="pw-modal-save" type="button" style="flex:1">Save</button>
          <button id="pw-modal-cancel" type="button" style="flex:1;background:transparent;border:1px solid rgba(255,255,255,.2);color:#fff">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#pw-modal-input');
    const close = (value = null) => {
      overlay.remove();
      resolve(value);
    };
    overlay.querySelector('#pw-modal-cancel').addEventListener('click', () => close(null));
    overlay.querySelector('#pw-modal-save').addEventListener('click', () => close(input.value || null));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') close(input.value || null);
      if (event.key === 'Escape') close(null);
    });
    input.focus();
  });
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
      const password = await promptForPassword(username);
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
