const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app } = require('../src/server');
const { resetStore } = require('./helpers');

test.beforeEach(() => resetStore());
test.after(() => resetStore());

test('health endpoint is reachable', async () => {
  const response = await request(app).get('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
});

test('intake endpoint creates candidate', async () => {
  const response = await request(app).post('/api/applications/intake').send({
    fullName: 'Mia Santos',
    email: 'mia@example.com',
    position: 'Administrative Assistant I (Computer Operator I)'
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.candidate.fullName, 'Mia Santos');
});
