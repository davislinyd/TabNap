'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(
  path.join(__dirname, '..', 'end-task-core.js'),
  'utf8'
);
const sandbox = { chrome: {}, console };
sandbox.globalThis = sandbox;
vm.runInNewContext(code, sandbox);

const { tabsForContextMenuRelease } = sandbox.EndTaskCore;
if (typeof tabsForContextMenuRelease !== 'function') {
  throw new Error('tabsForContextMenuRelease is not exported');
}

function assertEqual(actual, expected, name) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(`${name}: expected ${right}, got ${left}`);
  }
}

const clicked = { id: 2, windowId: 1, url: 'https://example.com/a' };
const sibling = { id: 3, windowId: 1, url: 'https://example.com/b' };
const otherWindow = { id: 9, windowId: 2, url: 'https://example.com/c' };
const builtIn = { id: 4, windowId: 1, url: 'chrome://settings' };

assertEqual(
  tabsForContextMenuRelease(clicked, [clicked]).map((tab) => tab.id),
  [2],
  'single highlighted tab'
);

assertEqual(
  tabsForContextMenuRelease(clicked, [clicked, sibling]).map((tab) => tab.id),
  [2, 3],
  'multi-select releases the highlighted set'
);

assertEqual(
  tabsForContextMenuRelease(clicked, [sibling]).map((tab) => tab.id),
  [2],
  'click outside the highlight releases only the clicked tab'
);

assertEqual(
  tabsForContextMenuRelease(clicked, [clicked, builtIn, sibling, otherWindow]).map(
    (tab) => tab.id
  ),
  [2, 3],
  'skips built-in pages and other windows'
);

assertEqual(
  tabsForContextMenuRelease(clicked, [clicked, clicked, sibling]).map((tab) => tab.id),
  [2, 3],
  'dedupes highlighted ids'
);

assertEqual(tabsForContextMenuRelease(null, [clicked]), [], 'missing click releases nothing');
assertEqual(
  tabsForContextMenuRelease({ id: 4, windowId: 1, url: 'edge://newtab' }, []),
  [],
  'built-in click releases nothing'
);
