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

const { pickFocusSuccessor } = sandbox.EndTaskCore;
if (typeof pickFocusSuccessor !== 'function') {
  throw new Error('pickFocusSuccessor is not exported');
}

function assertEqual(actual, expected, name) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${expected}, got ${actual}`);
  }
}

const tabs = [
  { id: 1, index: 0, discarded: false },
  { id: 2, index: 1, discarded: false },
  { id: 3, index: 2, discarded: false },
];

assertEqual(pickFocusSuccessor(tabs[1], tabs)?.id, 3, 'middle prefers next');
assertEqual(pickFocusSuccessor(tabs[2], tabs)?.id, 2, 'last prefers previous');
assertEqual(pickFocusSuccessor(tabs[0], tabs)?.id, 2, 'first prefers next');
assertEqual(pickFocusSuccessor(tabs[0], [tabs[0]]), null, 'only tab returns null');

const discardedNext = [
  { id: 1, index: 0, discarded: false },
  { id: 2, index: 1, discarded: true },
  { id: 3, index: 2, discarded: false },
];
assertEqual(
  pickFocusSuccessor(discardedNext[0], discardedNext)?.id,
  3,
  'skips discarded next'
);

const allOthersDiscarded = [
  { id: 1, index: 0, discarded: false },
  { id: 2, index: 1, discarded: true },
];
assertEqual(
  pickFocusSuccessor(allOthersDiscarded[0], allOthersDiscarded),
  null,
  'all siblings discarded returns null'
);

console.log('pickFocusSuccessor tests passed');
