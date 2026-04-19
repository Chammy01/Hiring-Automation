const fs = require('node:fs');
const path = require('node:path');

const storePath = path.resolve('data/store.json');

function resetStore() {
  fs.writeFileSync(
    storePath,
    JSON.stringify({ candidates: [], emailEvents: [], auditLogs: [] }, null, 2)
  );
}

module.exports = {
  resetStore
};
