'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(
  path.join(__dirname, '..', 'prefix-tab-title.js'),
  'utf8'
);

const ZZZ_URL = 'chrome-extension://test/icons/icon16.png';

const fetched = [];
const canvases = [];
let closedBitmaps = 0;
let failDecodeFor = new Set();
const injected = [];

class FakeOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.draws = [];
    canvases.push(this);
  }

  getContext() {
    return {
      drawImage: (bitmap, ...rect) => this.draws.push({ source: bitmap.source, rect }),
    };
  }

  async convertToBlob() {
    return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  }
}

const sandbox = {
  URL,
  btoa,
  setTimeout,
  console: { warn() {} },
  OffscreenCanvas: FakeOffscreenCanvas,
  fetch: async (url) => {
    fetched.push(url);
    return { ok: true, blob: async () => ({ source: url }) };
  },
  createImageBitmap: async (blob) => {
    if (failDecodeFor.has(blob.source)) throw new Error('decode failed');
    return {
      source: blob.source,
      close() {
        closedBitmaps += 1;
      },
    };
  },
  chrome: {
    runtime: { getURL: (rel) => `chrome-extension://test/${rel}` },
    scripting: {
      executeScript: async (details) => {
        injected.push(details);
      },
    },
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const { composeSleepingFavicon, setTabSleepingIcon } = vm.runInContext(
  '({ composeSleepingFavicon, setTabSleepingIcon })',
  sandbox
);

function assertEqual(actual, expected, name) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${expected}, got ${actual}`);
  }
}

function assertJson(actual, expected, name) {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), name);
}

(async () => {
  // Unsupported / missing favicon URLs never touch the network.
  for (const url of [undefined, null, '', 'not a url', 'chrome://favicon/x', 'edge://x', 'chrome-extension://abc/i.png']) {
    assertEqual(await composeSleepingFavicon(url), null, `skip ${url}`);
  }
  assertEqual(fetched.length, 0, 'skipped urls do not fetch');

  // Success: original on the right (10px @2x), zzz on the left (7px @2x, centered).
  const okUrl = 'https://example.com/favicon.png';
  const composed = await composeSleepingFavicon(okUrl);
  assertEqual(composed, 'data:image/png;base64,AQID', 'composed data url');
  assertEqual(canvases[0].width, 32, 'canvas width');
  assertEqual(canvases[0].height, 32, 'canvas height');
  assertJson(
    canvases[0].draws,
    [
      { source: okUrl, rect: [12, 6, 20, 20] },
      { source: ZZZ_URL, rect: [0, 9, 14, 14] },
    ],
    'draw layout'
  );
  assertEqual(closedBitmaps, 1, 'original bitmap closed');

  // Same URL is composed once; the sleeping icon itself is fetched once overall.
  assertEqual(await composeSleepingFavicon(okUrl), composed, 'cached result');
  assertEqual(fetched.filter((u) => u === okUrl).length, 1, 'favicon fetched once');
  assertEqual(fetched.filter((u) => u === ZZZ_URL).length, 1, 'sleeping icon fetched once');

  // Decode failure -> null, and failures are not cached.
  const svgUrl = 'https://example.com/favicon.svg';
  failDecodeFor.add(svgUrl);
  assertEqual(await composeSleepingFavicon(svgUrl), null, 'decode failure');
  failDecodeFor.clear();
  assertEqual(await composeSleepingFavicon(svgUrl), 'data:image/png;base64,AQID', 'retry after failure');

  // setTabSleepingIcon injects the composite, or falls back to the plain sleeping icon.
  injected.length = 0;
  assertEqual(
    await setTabSleepingIcon(1, 'https://example.com/', { faviconUrl: okUrl }),
    true,
    'inject composite'
  );
  assertJson(injected[0].args, [composed, 32], 'composite args');

  await setTabSleepingIcon(2, 'https://example.com/', { faviconUrl: 'chrome://favicon/x' });
  assertJson(injected[1].args, [ZZZ_URL, 16], 'fallback args (unsupported scheme)');

  await setTabSleepingIcon(3, 'https://example.com/', {});
  assertJson(injected[2].args, [ZZZ_URL, 16], 'fallback args (no favicon)');

  // Injected function: idempotent when already marked, otherwise marks and rewrites links.
  const func = injected[0].func;
  const runInPage = (existingMarker, existingLinks) => {
    const created = [];
    const appended = [];
    const doc = {
      head: { appendChild: (el) => appended.push(el) },
      querySelector: (sel) => (sel === 'link[data-tabnap-sleeping-icon]' ? existingMarker : null),
      querySelectorAll: () => existingLinks,
      createElement: () => {
        const el = { dataset: {} };
        created.push(el);
        return el;
      },
    };
    vm.runInNewContext('(' + func.toString() + ')(a, b)', {
      document: doc,
      a: 'data:x',
      b: 32,
    });
    return { created, appended };
  };

  const marked = runInPage({}, []);
  assertEqual(marked.created.length, 0, 'already marked: no new link');

  const page = { href: 'https://example.com/favicon.png' };
  const fresh = runInPage(null, [page]);
  assertEqual(fresh.created.length, 1, 'fresh: one marker link');
  assertEqual(fresh.appended[0].href, 'data:x', 'fresh: marker href');
  assertEqual(fresh.appended[0].sizes, '32x32', 'fresh: marker sizes');
  assertEqual(fresh.appended[0].dataset.tabnapSleepingIcon, 'true', 'fresh: marker flag');
  assertEqual(page.href, 'data:x', 'fresh: existing icon links rewritten');

  console.log('sleeping-favicon tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
