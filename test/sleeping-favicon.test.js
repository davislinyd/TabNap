'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(
  path.join(__dirname, '..', 'prefix-tab-title.js'),
  'utf8'
);

const ZZZ_URL = 'chrome-extension://test/icons/icon16.png';
const B64 = 'AQID'; // base64 of the 3 bytes every fake blob yields
const PNG_URL = `data:image/png;base64,${B64}`;

const fetched = [];
const canvases = [];
const bitmapCalls = [];
let closedBitmaps = 0;
const failDecodeFor = new Set();
const blobs = new Map(); // url -> { type, text, size, ok }
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
    return makeBlob('canvas');
  }
}

function makeBlob(source, { type = 'image/png', text = '', size = 3 } = {}) {
  return {
    source,
    type,
    size,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    slice: () => ({ text: async () => text }),
  };
}

const sandbox = {
  URL,
  btoa,
  setTimeout,
  console: { warn() {} },
  OffscreenCanvas: FakeOffscreenCanvas,
  fetch: async (url, init) => {
    fetched.push({ url, init });
    const meta = blobs.get(url) || {};
    if (meta.ok === false) return { ok: false, status: 404 };
    return { ok: true, blob: async () => makeBlob(url, meta) };
  },
  createImageBitmap: async (blob) => {
    bitmapCalls.push(blob.source);
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

const fetchCount = (url) => fetched.filter((f) => f.url === url).length;

(async () => {
  // Unsupported / missing favicon URLs never touch the network.
  for (const url of [undefined, null, '', 'not a url', 'chrome://favicon/x', 'edge://x', 'chrome-extension://abc/i.png']) {
    assertEqual(await composeSleepingFavicon(url), null, `skip ${url}`);
  }
  assertEqual(fetched.length, 0, 'skipped urls do not fetch');

  // Raster: original on the right (10px @2x), zzz on the left (7px @2x, centered).
  const okUrl = 'https://example.com/favicon.png';
  const composed = await composeSleepingFavicon(okUrl);
  assertEqual(composed.composite, PNG_URL, 'composite data url');
  assertEqual(composed.svg, null, 'raster has no svg payload');
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
  assertEqual(closedBitmaps, 2, 'bitmaps closed');
  assertEqual(fetched.find((f) => f.url === okUrl).init.credentials, 'include', 'favicon fetch sends cookies');

  // Same URL is composed once; the sleeping icon itself is fetched once overall.
  assertEqual(await composeSleepingFavicon(okUrl), composed, 'cached result');
  assertEqual(fetchCount(okUrl), 1, 'favicon fetched once');
  assertEqual(fetchCount(ZZZ_URL), 1, 'sleeping icon fetched once');

  // SVG (by content type) is handed to the page as data URLs, never decoded in the worker.
  const svgUrl = 'https://example.com/favicon.svg';
  blobs.set(svgUrl, { type: 'image/svg+xml' });
  const bitmapsBeforeSvg = bitmapCalls.length;
  const svg = await composeSleepingFavicon(svgUrl);
  assertEqual(svg.composite, null, 'svg has no worker composite');
  assertJson(
    svg.svg,
    { original: `data:image/svg+xml;base64,${B64}`, zzz: PNG_URL },
    'svg payload'
  );
  assertEqual(bitmapCalls.length, bitmapsBeforeSvg, 'svg not decoded in worker');

  // SVG mislabelled as text/plain is sniffed; plain text is not.
  const sniffUrl = 'https://example.com/mislabelled';
  blobs.set(sniffUrl, { type: 'text/plain', text: '<?xml version="1.0"?><svg xmlns="x"/>' });
  assertEqual((await composeSleepingFavicon(sniffUrl)).svg.original, `data:image/svg+xml;base64,${B64}`, 'sniffed svg');

  const notSvgUrl = 'https://example.com/not-svg';
  blobs.set(notSvgUrl, { type: 'text/plain', text: 'hello' });
  failDecodeFor.add(notSvgUrl);
  assertEqual(await composeSleepingFavicon(notSvgUrl), null, 'non-svg text fails decode');
  failDecodeFor.delete(notSvgUrl);

  // Decode failure -> null, and failures are not cached.
  const badUrl = 'https://example.com/bad.ico';
  failDecodeFor.add(badUrl);
  assertEqual(await composeSleepingFavicon(badUrl), null, 'decode failure');
  failDecodeFor.clear();
  assertEqual((await composeSleepingFavicon(badUrl)).composite, PNG_URL, 'retry after failure');

  // HTTP errors and oversized favicons fall back.
  const missingUrl = 'https://example.com/missing.png';
  blobs.set(missingUrl, { ok: false });
  assertEqual(await composeSleepingFavicon(missingUrl), null, 'fetch !ok');
  const hugeUrl = 'https://example.com/huge.png';
  blobs.set(hugeUrl, { size: 512 * 1024 });
  assertEqual(await composeSleepingFavicon(hugeUrl), null, 'oversized favicon');

  // setTabSleepingIcon: composite, svg hand-off, or the plain sleeping icon.
  const spec = {
    box: 16,
    scale: 2,
    layout: { zzz: { x: 0, y: 4.5, size: 7 }, original: { x: 6, y: 3, size: 10 } },
  };
  injected.length = 0;
  assertEqual(
    await setTabSleepingIcon(1, 'https://example.com/', { faviconUrl: okUrl }),
    true,
    'inject composite'
  );
  assertJson(injected[0].args, [PNG_URL, 32, null, spec], 'composite args');

  await setTabSleepingIcon(2, 'https://example.com/', { faviconUrl: svgUrl });
  assertJson(
    injected[1].args,
    [ZZZ_URL, 16, { original: `data:image/svg+xml;base64,${B64}`, zzz: PNG_URL }, spec],
    'svg args'
  );

  await setTabSleepingIcon(3, 'https://example.com/', { faviconUrl: 'chrome://favicon/x' });
  assertJson(injected[2].args, [ZZZ_URL, 16, null, spec], 'fallback args (unsupported scheme)');

  await setTabSleepingIcon(4, 'https://example.com/', {});
  assertJson(injected[3].args, [ZZZ_URL, 16, null, spec], 'fallback args (no favicon)');

  // Injected function: idempotent when already marked, otherwise marks and rewrites links.
  const func = injected[0].func;
  const runInPage = async ({ existingMarker = null, existingLinks = [], args, imageFails = false }) => {
    const created = [];
    const appended = [];
    const draws = [];
    class FakeImage {
      set src(value) {
        this._src = value;
        setTimeout(() => (imageFails ? this.onerror?.() : this.onload?.()), 0);
      }
    }
    const doc = {
      head: { appendChild: (el) => appended.push(el) },
      querySelector: (sel) => (sel === 'link[data-tabnap-sleeping-icon]' ? existingMarker : null),
      querySelectorAll: () => existingLinks,
      createElement: (tag) => {
        const el = { tag, dataset: {} };
        if (tag === 'canvas') {
          el.getContext = () => ({
            drawImage: (img, ...rect) => draws.push({ src: img._src, rect }),
          });
          el.toDataURL = () => 'data:image/png;base64,PAGE';
        }
        created.push(el);
        return el;
      },
    };
    await vm.runInNewContext('(' + func.toString() + ')(...args)', {
      document: doc,
      Image: FakeImage,
      setTimeout,
      args,
    });
    return { created, appended, draws };
  };

  const marked = await runInPage({ existingMarker: {}, args: ['data:x', 32, null, spec] });
  assertEqual(marked.created.length, 0, 'already marked: no new link');

  const page = { href: 'https://example.com/favicon.png' };
  const fresh = await runInPage({ existingLinks: [page], args: ['data:x', 32, null, spec] });
  assertEqual(fresh.created.length, 1, 'fresh: one marker link');
  assertEqual(fresh.appended[0].href, 'data:x', 'fresh: marker href');
  assertEqual(fresh.appended[0].sizes, '32x32', 'fresh: marker sizes');
  assertEqual(fresh.appended[0].dataset.tabnapSleepingIcon, 'true', 'fresh: marker flag');
  assertEqual(page.href, 'data:x', 'fresh: existing icon links rewritten');

  // SVG payload: page rasterises both images onto a 32x32 canvas in the same layout.
  const svgPayload = { original: 'data:image/svg+xml;base64,ORIG', zzz: 'data:image/png;base64,ZZZ' };
  const svgLink = { href: 'https://example.com/favicon.svg' };
  const drawn = await runInPage({ existingLinks: [svgLink], args: [ZZZ_URL, 16, svgPayload, spec] });
  assertEqual(drawn.appended[0].href, 'data:image/png;base64,PAGE', 'svg: composite href');
  assertEqual(drawn.appended[0].sizes, '32x32', 'svg: composite sizes');
  assertEqual(svgLink.href, 'data:image/png;base64,PAGE', 'svg: existing links rewritten');
  assertJson(
    drawn.draws,
    [
      { src: svgPayload.original, rect: [12, 6, 20, 20] },
      { src: svgPayload.zzz, rect: [0, 9, 14, 14] },
    ],
    'svg: draw layout'
  );

  // SVG that fails to load in the page keeps the plain sleeping icon.
  const failed = await runInPage({ args: [ZZZ_URL, 16, svgPayload, spec], imageFails: true });
  assertEqual(failed.appended[0].href, ZZZ_URL, 'svg failure: plain href');
  assertEqual(failed.appended[0].sizes, '16x16', 'svg failure: plain sizes');

  console.log('sleeping-favicon tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
