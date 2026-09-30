'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { STAMP_NAME, buildExtension, collectExtensionFiles } = require('../scripts/build-dist');

const repoRoot = path.resolve(__dirname, '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabnap-build-'));
  const outDir = path.join(root, 'dist');
  fs.mkdirSync(path.join(root, 'icons'), { recursive: true });
  fs.writeFileSync(path.join(root, 'icons', 'icon16.png'), 'png');
  fs.writeFileSync(path.join(root, 'popup.css'), 'body{}\n');
  fs.writeFileSync(
    path.join(root, 'popup.html'),
    '<link rel="stylesheet" href="popup.css">\n<script src="popup.js"></script>\n'
  );
  fs.writeFileSync(path.join(root, 'popup.js'), '/* popup */\n');
  fs.writeFileSync(
    path.join(root, 'background.js'),
    "importScripts('helper.js');\nchrome.runtime.getURL('icons/icon16.png');\nchrome.runtime.getURL('_favicon/');\n"
  );
  fs.writeFileSync(path.join(root, 'helper.js'), '/* helper */\n');
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Fixture',
    version: '0.0.1',
    icons: { '16': 'icons/icon16.png' },
    action: { default_popup: 'popup.html', default_icon: { '16': 'icons/icon16.png' } },
    background: { service_worker: 'background.js' },
    web_accessible_resources: [{ resources: ['icons/icon16.png'], matches: ['https://*/*'] }]
  }));
  fs.writeFileSync(path.join(root, 'README.md'), 'source only\n');
  return { root, outDir };
}

function removeFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

const fixture = makeFixture();
try {
  fs.mkdirSync(fixture.outDir, { recursive: true });
  fs.writeFileSync(path.join(fixture.outDir, 'listing.md'), 'keep me\n');
  fs.writeFileSync(path.join(fixture.outDir, 'stale.js'), 'old\n');
  fs.writeFileSync(
    path.join(fixture.outDir, STAMP_NAME),
    JSON.stringify({ files: ['stale.js', STAMP_NAME] })
  );

  const built = buildExtension(fixture);
  assert(built.includes('helper.js'), 'importScripts target is part of the build');
  assert(built.includes('popup.css'), 'popup stylesheet is part of the build');
  assert(!built.includes('_favicon/'), 'browser favicon endpoint is not a project asset');
  assert(!built.includes('README.md'), 'unreferenced source stays out of the build');
  assert(fs.existsSync(path.join(fixture.outDir, 'manifest.json')), 'manifest copied');
  assert(
    fs.readFileSync(path.join(fixture.outDir, 'helper.js'), 'utf8') === '/* helper */\n',
    'copied file matches source'
  );
  assert(fs.existsSync(path.join(fixture.outDir, 'listing.md')), 'unrelated output is preserved');
  assert(!fs.existsSync(path.join(fixture.outDir, 'stale.js')), 'previous owned file is removed');
  assert(fs.existsSync(path.join(fixture.root, 'README.md')), 'source file remains');

  let refused = false;
  try {
    buildExtension({ root: fixture.root, outDir: fixture.root });
  } catch (error) {
    refused = /source directory|under/.test(error.message);
  }
  assert(refused, 'build into the source directory is refused');
} finally {
  removeFixture(fixture.root);
}

const projectFiles = collectExtensionFiles(repoRoot);
for (const rel of [
  'manifest.json',
  'background.js',
  'popup.html',
  'popup.js',
  'popup.css',
  'auto-end-rules.js',
  'end-task-core.js',
  'debug-log.js',
  'prefix-tab-title.js',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png'
]) {
  assert(projectFiles.includes(rel), `project build missing ${rel}`);
}
assert(!projectFiles.includes('icons/icon32.png'), 'unreferenced icon32 stays in source only');

process.stdout.write('build-dist tests passed\n');
