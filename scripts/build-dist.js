'use strict';

const fs = require('fs');
const path = require('path');

const STAMP_NAME = '.tabnap-build.json';

function isLocalRef(value) {
  return typeof value === 'string'
    && value.length > 0
    && !/^[a-z][a-z0-9+.-]*:/i.test(value)
    && !value.startsWith('#')
    && !value.startsWith('//')
    && !path.isAbsolute(value);
}

function normalizeRel(value) {
  const rel = path.normalize(value).replace(/\\/g, '/').replace(/^\.\//, '');
  if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
    throw new Error(`Refusing path outside the extension: ${value}`);
  }
  return rel;
}

function resolveInside(dir, rel) {
  const target = path.resolve(dir, rel);
  const relative = path.relative(path.resolve(dir), target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to touch path outside output: ${rel}`);
  }
  return target;
}

function collectFromText(text) {
  const found = [];
  const patterns = [
    /(?:src|href)\s*=\s*["']([^"']+)["']/gi,
    /chrome\.runtime\.getURL\(\s*["']([^"']+)["']\s*\)/g,
    /url\(\s*["']([^"']+)["']\s*\)/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      const ref = match[1].split(/[?#]/, 1)[0];
      if (isLocalRef(ref)) found.push(ref);
    }
  }
  const imports = /importScripts\s*\(([^)]*)\)/g;
  let match;
  while ((match = imports.exec(text))) {
    const args = match[1].match(/["']([^"']+)["']/g) || [];
    for (const quoted of args) {
      const ref = quoted.slice(1, -1);
      if (isLocalRef(ref)) found.push(ref);
    }
  }
  return found;
}

function addRef(files, value) {
  if (!isLocalRef(value)) return;
  files.add(normalizeRel(value));
}

function collectExtensionFiles(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const files = new Set(['manifest.json']);

  if (manifest.icons) Object.values(manifest.icons).forEach((value) => addRef(files, value));
  if (manifest.action) {
    addRef(files, manifest.action.default_popup);
    const icon = manifest.action.default_icon;
    if (icon && typeof icon === 'object') {
      Object.values(icon).forEach((value) => addRef(files, value));
    } else {
      addRef(files, icon);
    }
  }
  if (manifest.background) addRef(files, manifest.background.service_worker);
  for (const block of manifest.web_accessible_resources || []) {
    for (const resource of block.resources || []) addRef(files, resource);
  }
  for (const block of manifest.content_scripts || []) {
    for (const resource of [...(block.js || []), ...(block.css || [])]) addRef(files, resource);
  }

  const pending = [...files];
  const expanded = new Set();
  while (pending.length) {
    const rel = pending.pop();
    if (expanded.has(rel)) continue;
    expanded.add(rel);
    if (!/\.(html|js|css)$/.test(rel)) continue;
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const ref of collectFromText(text)) {
      const next = normalizeRel(path.posix.join(path.posix.dirname(rel), ref));
      if (!files.has(next)) {
        files.add(next);
        pending.push(next);
      }
    }
  }

  return [...files].sort();
}

function readOwnedFiles(outDir) {
  const stampPath = path.join(outDir, STAMP_NAME);
  if (!fs.existsSync(stampPath)) return [];
  const data = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  if (!data || !Array.isArray(data.files)) return [];
  return data.files.filter((rel) => typeof rel === 'string');
}

function assertSafeOutDir(root, outDir) {
  const rootResolved = path.resolve(root);
  const distRoot = path.resolve(root, 'dist');
  const outResolved = path.resolve(outDir);
  const underDist = path.relative(distRoot, outResolved);
  if (underDist.startsWith('..') || path.isAbsolute(underDist)) {
    throw new Error(`Build output must stay under ${distRoot}`);
  }
  if (outResolved === rootResolved) {
    throw new Error('Refusing to build into the source directory');
  }
  if (!fs.existsSync(outResolved)) return;
  const outReal = fs.realpathSync(outResolved);
  const rootReal = fs.realpathSync(rootResolved);
  if (outReal === rootReal || rootReal.startsWith(outReal + path.sep)) {
    throw new Error('Refusing to build into the source directory');
  }
}

function buildExtension({ root, outDir }) {
  assertSafeOutDir(root, outDir);
  const files = collectExtensionFiles(root);
  fs.mkdirSync(outDir, { recursive: true });

  const previous = new Set(readOwnedFiles(outDir));
  const next = new Set([...files, STAMP_NAME]);
  for (const rel of previous) {
    if (next.has(rel)) continue;
    const target = resolveInside(outDir, rel);
    if (!fs.existsSync(target)) continue;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to remove symlink ${rel}`);
    }
    if (stat.isFile()) fs.unlinkSync(target);
  }

  for (const rel of files) {
    const from = path.join(root, rel);
    const to = resolveInside(outDir, rel);
    if (!fs.existsSync(from) || !fs.statSync(from).isFile()) {
      throw new Error(`Missing extension file: ${rel}`);
    }
    if (fs.existsSync(to) && fs.lstatSync(to).isSymbolicLink()) {
      throw new Error(`Refusing to write through symlink ${rel}`);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }

  const stampPath = resolveInside(outDir, STAMP_NAME);
  fs.writeFileSync(
    stampPath,
    JSON.stringify({ files: [...next].sort() }, null, 2) + '\n'
  );
  return files;
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const files = buildExtension({ root, outDir: path.join(root, 'dist') });
  process.stdout.write(`Built ${files.length} files into ${path.join(root, 'dist')}\n`);
}

module.exports = {
  STAMP_NAME,
  buildExtension,
  collectExtensionFiles
};
