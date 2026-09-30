'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'prefix-tab-title.js'), 'utf8');
const injected = [];
let allowed = true;
const sandbox = {
  URL,
  console,
  chrome: {
    permissions: { contains: async () => allowed },
    scripting: { executeScript: async (details) => injected.push(details) },
  },
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const { prefixTabTitleWithMarker, stripTitlePrefixMark } = vm.runInContext(
  '({ prefixTabTitleWithMarker, stripTitlePrefixMark })',
  sandbox
);

function equal(actual, expected, name) {
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, got ${actual}`);
}

(async () => {
  equal(stripTitlePrefixMark('💤 Website'), 'Website', 'new prefix stripped');
  equal(stripTitlePrefixMark('♻️ Website'), 'Website', 'legacy prefix stripped');
  equal(stripTitlePrefixMark('💤 ♻️ Website'), 'Website', 'stacked prefixes stripped');
  equal(stripTitlePrefixMark('Website'), 'Website', 'plain title unchanged');

  await prefixTabTitleWithMarker(1, 'https://example.com/');
  equal(injected.length, 1, 'HTTP title injection');
  equal(injected[0].args[0], '💤 ', 'one ASCII space follows sleeping icon');
  const document = { title: 'Website' };
  // executeScript serialises the function; run it with a page-like global.
  const page = vm.createContext({ document });
  vm.runInContext(`(${injected[0].func.toString()})(${JSON.stringify(injected[0].args[0])})`, page);
  equal(document.title, '💤 Website', 'prefix before original title');
  vm.runInContext(`(${injected[0].func.toString()})(${JSON.stringify(injected[0].args[0])})`, page);
  equal(document.title, '💤 Website', 'repeat injection idempotent');
  document.title = '♻️ Website';
  vm.runInContext(`(${injected[0].func.toString()})(${JSON.stringify(injected[0].args[0])})`, page);
  equal(document.title, '💤 Website', 'legacy marker replaced');

  allowed = false;
  await prefixTabTitleWithMarker(2, 'https://example.com/');
  equal(injected.length, 1, 'missing permission skipped');
  await prefixTabTitleWithMarker(3, 'chrome://settings/');
  equal(injected.length, 1, 'built-in page skipped');
  await prefixTabTitleWithMarker(4, 'file:///tmp/example.html', { maybeHasActiveTabAccess: true });
  equal(injected.length, 2, 'active file tab accepted');
  equal(injected[1].target.tabId, 4, 'file target');

  console.log('title-prefix tests passed');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
