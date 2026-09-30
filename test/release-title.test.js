'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'end-task-core.js'), 'utf8');
const events = [];
const tabs = new Map([
  [1, { id: 1, url: 'https://example.com/a', title: 'Alpha', favIconUrl: 'https://example.com/a.png', active: false, discarded: false }],
  [2, { id: 2, url: 'https://example.com/b', title: 'Beta', favIconUrl: 'https://example.com/b.png', active: false, discarded: false }],
]);
const storage = {
  setEntries: async () => {},
};
const sandbox = {
  setTimeout,
  console,
  prefixTabTitleWithMarker: async (id) => {
    events.push(`prefix:${id}`);
    const tab = tabs.get(id);
    tab.title = `💤 ${tab.title}`;
  },
  AutoEndRules: { getTerminatedTabsStorage: () => storage },
  chrome: {
    tabs: {
      get: async (id) => ({ ...tabs.get(id) }),
      discard: async (id) => {
        events.push(`discard:${id}`);
        const tab = tabs.get(id);
        tab.discarded = true;
        return { ...tab };
      },
    },
  },
};
sandbox.globalThis = sandbox;
vm.runInNewContext(code, sandbox);

function equal(actual, expected, name) {
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, got ${actual}`);
}

(async () => {
  await sandbox.EndTaskCore.discardTab(tabs.get(1), { terminatedStorage: storage });
  equal(events.join(','), 'prefix:1,discard:1', 'single discard prefixes before unloading');
  equal(tabs.get(1).favIconUrl, 'https://example.com/a.png', 'single favicon unchanged');

  events.length = 0;
  await sandbox.EndTaskCore.discardTabsBatch([tabs.get(2)], { terminatedStorage: storage });
  equal(events.join(','), 'prefix:2,discard:2', 'batch discard prefixes once before unloading');
  equal(tabs.get(2).favIconUrl, 'https://example.com/b.png', 'batch favicon unchanged');

  console.log('release-title tests passed');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
