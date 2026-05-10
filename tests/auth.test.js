const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, resetAuthRuntimeState } = require('../src/server');
const { config } = require('../src/config');
const { resetStore } = require('./helpers');
const { readStore } = require('../src/store');

test.beforeEach(() => {
  resetStore();
  resetAuthRuntimeState();
  config.hrApiKeys = new Map([['test-hr-key', 'hr'], ['test-admin-key', 'admin']]);
  config.developerKey = 'dev-secret';
  config.jwtSecret = 'test-jwt-secret';
  config.cookieSecure = false;
});

test.after(() => resetStore());

test('root redirects to login when unauthenticated', async () => {
  const res = await request(app).get('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('developer registration creates hashed users and login issues auth cookie', async () => {
  const registerRes = await request(app)
    .post('/api/auth/register')
    .set('x-developer-key', 'dev-secret')
    .send({ username: 'hruser', password: 'StrongPass!123', role: 'hr' });
  assert.equal(registerRes.status, 201);
  assert.equal(registerRes.body.user.username, 'hruser');
  assert.equal(registerRes.body.user.role, 'hr');

  const usersState = readStore();
  const saved = usersState.users.find((x) => x.username === 'hruser');
  assert.ok(saved);
  assert.notEqual(saved.passwordHash, 'StrongPass!123');

  const agent = request.agent(app);
  const loginRes = await agent.post('/api/auth/login').send({ username: 'hruser', password: 'StrongPass!123' });
  assert.equal(loginRes.status, 200);
  assert.match(loginRes.headers['set-cookie'].join(';'), /auth_token=/);
  assert.ok(loginRes.body.csrfToken);

  const verifyRes = await agent.get('/api/auth/verify');
  assert.equal(verifyRes.status, 200);
  assert.equal(verifyRes.body.valid, true);
  assert.equal(verifyRes.body.user.role, 'hr');
});

test('jwt-protected write routes require csrf token', async () => {
  await request(app)
    .post('/api/auth/register')
    .set('x-developer-key', 'dev-secret')
    .send({ username: 'writer', password: 'StrongPass!123', role: 'hr' });

  const agent = request.agent(app);
  const loginRes = await agent.post('/api/auth/login').send({ username: 'writer', password: 'StrongPass!123' });
  const csrfToken = loginRes.body.csrfToken;

  const blocked = await agent.post('/api/reminders/send');
  assert.equal(blocked.status, 403);

  const allowed = await agent.post('/api/reminders/send').set('x-csrf-token', csrfToken);
  assert.equal(allowed.status, 200);
});

test('logout clears auth session', async () => {
  await request(app)
    .post('/api/auth/register')
    .set('x-developer-key', 'dev-secret')
    .send({ username: 'logout-user', password: 'StrongPass!123', role: 'hr' });
  const agent = request.agent(app);
  const loginRes = await agent.post('/api/auth/login').send({ username: 'logout-user', password: 'StrongPass!123' });
  const csrfToken = loginRes.body.csrfToken;
  const logoutRes = await agent.post('/api/auth/logout').set('x-csrf-token', csrfToken);
  assert.equal(logoutRes.status, 200);
  const verifyRes = await agent.get('/api/auth/verify');
  assert.equal(verifyRes.status, 401);
});

test('login rate limiting blocks after 5 failed attempts per ip', async () => {
  await request(app)
    .post('/api/auth/register')
    .set('x-developer-key', 'dev-secret')
    .send({ username: 'limit-user', password: 'StrongPass!123', role: 'hr' });
  for (let i = 0; i < 5; i += 1) {
    const fail = await request(app).post('/api/auth/login').send({ username: 'limit-user', password: 'bad-password' });
    assert.equal(fail.status, 401);
  }
  const blocked = await request(app).post('/api/auth/login').send({ username: 'limit-user', password: 'bad-password' });
  assert.equal(blocked.status, 429);
});

test('developer management endpoints list, change password, and delete users', async () => {
  await request(app)
    .post('/api/auth/register')
    .set('x-developer-key', 'dev-secret')
    .send({ username: 'manager-user', password: 'StrongPass!123', role: 'hr' });

  const listRes = await request(app).get('/api/auth/users').set('x-developer-key', 'dev-secret');
  assert.equal(listRes.status, 200);
  assert.ok(listRes.body.items.some((x) => x.username === 'manager-user'));

  const changeRes = await request(app)
    .put('/api/auth/users/manager-user/password')
    .set('x-developer-key', 'dev-secret')
    .send({ password: 'UpdatedPass!123' });
  assert.equal(changeRes.status, 200);

  const loginWithOld = await request(app).post('/api/auth/login').send({ username: 'manager-user', password: 'StrongPass!123' });
  assert.equal(loginWithOld.status, 401);
  const loginWithNew = await request(app).post('/api/auth/login').send({ username: 'manager-user', password: 'UpdatedPass!123' });
  assert.equal(loginWithNew.status, 200);

  const deleteRes = await request(app).delete('/api/auth/users/manager-user').set('x-developer-key', 'dev-secret');
  assert.equal(deleteRes.status, 200);
});
