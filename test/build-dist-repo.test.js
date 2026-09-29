'use strict';

const fs = require('fs');
const path = require('path');
const { collectExtensionFiles } = require('../scripts/build-dist');

// build-dist.test.js uses a fixture; this runs the scanner on the real sources so
// a string in our JS mistaken for a local asset (e.g. toDataURL('image/png')) fails here.
const root = path.resolve(__dirname, '..');
const files = collectExtensionFiles(root);

const missing = files.filter((rel) => !fs.existsSync(path.join(root, rel)));
if (missing.length > 0) {
  throw new Error(`build-dist would copy files that do not exist: ${missing.join(', ')}`);
}

for (const required of ['manifest.json', 'background.js', 'prefix-tab-title.js', 'icons/icon16.png']) {
  if (!files.includes(required)) {
    throw new Error(`build-dist is missing ${required}`);
  }
}

console.log('build-dist repo tests passed');
