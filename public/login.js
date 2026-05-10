'use strict';

async function verifyExistingSession() {
  const res = await fetch('/api/auth/verify', { credentials: 'include' });
  if (res.ok) {
    window.location.href = '/';
  }
}

async function login(username, password) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username, password })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || 'Login failed');
  }
}

verifyExistingSession().catch(() => {});

document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = document.getElementById('error-msg');
  errorEl.textContent = '';
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  try {
    await login(username, password);
    window.location.href = '/';
  } catch (error) {
    errorEl.textContent = error.message;
  }
});
