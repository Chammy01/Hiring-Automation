const fs = require('node:fs');
const path = require('node:path');
const { initialState } = require('../src/store');

const storePath = path.resolve('data/store.json');

function resetStore() {
  fs.writeFileSync(storePath, JSON.stringify(initialState, null, 2));
}

module.exports = {
  resetStore
};
