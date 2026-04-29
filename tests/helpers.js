const fs = require('node:fs');
const path = require('node:path');
const { initialState } = require('../src/store');

const storePath = path.resolve('data/store.json');

function resetStore() {
  const dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(storePath, JSON.stringify(initialState, null, 2));
}

module.exports = {
  resetStore
};
