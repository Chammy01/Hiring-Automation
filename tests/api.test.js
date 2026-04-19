const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { app } = require('../src/server');

const storePath = path.resolve('data/store.json');

function resetStore() {
  fs.writeFileSync(
    storePath,
    JSON.stringify({ candidates: [], emailEvents: [], auditLogs: [] }, null, 2)
  );
}

test('health endpoint is reachable', async () => {
  const response = await request(app).get('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
});

test('intake endpoint creates candidate', async () => {
  resetStore();
  const response = await request(app).post('/api/applications/intake').send({
    fullName: 'Mia Santos',
    email: 'mia@example.com',
    position: 'Administrative Assistant I (Computer Operator I)'
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.candidate.fullName, 'Mia Santos');
});
