const TITLE_PREFIX_MARK = '\u267B\uFE0F ';
/** Match ♻️ with optional VS16 and following space(s). */
const TITLE_PREFIX_RE = /^\u267B\uFE0F?\s+/;
const FILE_ORIGIN_PATTERN = 'file:///*';

/**
 * Remove End Task title marker for display / storage hygiene.
 * @param {string|undefined|null} title
 * @returns {string}
 */
function stripTitlePrefixMark(title) {
  if (typeof title !== 'string' || !title) return title || '';
  if (title.startsWith(TITLE_PREFIX_MARK)) {
    return title.slice(TITLE_PREFIX_MARK.length);
  }
  return title.replace(TITLE_PREFIX_RE, '');
}
const RESTRICTED_HOST_RULES = [
  { host: 'chromewebstore.google.com' },
  { host: 'chrome.google.com', pathPrefix: '/webstore' },
  { host: 'microsoftedge.microsoft.com', pathPrefix: '/addons' },
];

function getScriptableOriginPattern(url) {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol === 'file:') {
      return FILE_ORIGIN_PATTERN;
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) return null;
    if (isRestrictedScriptingPage(parsedUrl)) return null;
    return `${parsedUrl.protocol}//${parsedUrl.host}/*`;
  } catch {
    return null;
  }
}

function isRestrictedScriptingPage(parsedUrl) {
  return RESTRICTED_HOST_RULES.some(
    ({ host, pathPrefix }) =>
      parsedUrl.hostname === host &&
      (pathPrefix === undefined || parsedUrl.pathname.startsWith(pathPrefix))
  );
}

function isFileUrl(url) {
  return typeof url === 'string' && url.startsWith('file:');
}

async function hasHostAccess(originPattern) {
  if (!originPattern || !chrome.permissions?.contains) return true;

  try {
    return await chrome.permissions.contains({ origins: [originPattern] });
  } catch {
    return true;
  }
}

/**
 * Chromium 對 file:// 另有「允許存取檔案網址」開關；有 API 時優先查詢。
 */
async function isFileSchemeAccessAllowed() {
  if (!chrome.extension?.isAllowedFileSchemeAccess) return false;
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}

async function canScriptTab(originPattern, resolvedUrl, maybeHasActiveTabAccess) {
  if (maybeHasActiveTabAccess) return true;

  if (isFileUrl(resolvedUrl)) {
    if (await isFileSchemeAccessAllowed()) return true;
    // 部分環境仍可能以 host permission 表示 file 存取。
    return hasHostAccess(originPattern);
  }

  return hasHostAccess(originPattern);
}

function isExpectedAccessError(err) {
  const message = String(err?.message || '');
  return (
    message.includes('Cannot access contents of the page') ||
    message.includes('Missing host permission for the tab') ||
    message.includes('The extensions gallery cannot be scripted') ||
    message.includes('Cannot access contents of url "file:') ||
    message.includes('Extension manifest must request permission to access this host')
  );
}

/**
 * 在終止 process 前於分頁將 document.title 加上 ♻️ 前綴（http/https/file）。
 * 注入失敗不拋錯，不阻擋後續 terminate。
 * @param {number} tabId
 * @param {string|undefined} [url] 若已持有 tab.url 可傳入以避免多一次 tabs.get
 * @param {{ maybeHasActiveTabAccess?: boolean }} [options]
 */
async function prefixTabTitleWithMarker(tabId, url, options = {}) {
  if (!chrome.scripting) return;
  const { maybeHasActiveTabAccess = false } = options;

  let resolvedUrl = url;
  if (resolvedUrl === undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      resolvedUrl = tab.url;
    } catch {
      return;
    }
  }

  const originPattern = resolvedUrl ? getScriptableOriginPattern(resolvedUrl) : null;
  if (!originPattern) return;

  const allowed = await canScriptTab(
    originPattern,
    resolvedUrl,
    maybeHasActiveTabAccess
  );
  if (!allowed) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (prefix) => {
        const t = document.title || '';
        if (t.startsWith(prefix)) return;
        // file:// 常無 <title>，document.title 可能是檔名或空字串。
        const base = t || 'file';
        document.title = prefix + base;
      },
      args: [TITLE_PREFIX_MARK],
    });
  } catch (err) {
    if (isExpectedAccessError(err)) return;
    console.warn('prefixTabTitleWithMarker failed:', err);
  }
}

/** Composite favicon is laid out in a 16x16 DIP box and rendered at 2x for hi-DPI. */
const SLEEPING_FAVICON_BOX = 16;
const SLEEPING_FAVICON_SCALE = 2;
const SLEEPING_FAVICON_LAYOUT = {
  zzz: { x: 0, y: 4, size: 8 },
  original: { x: 8, y: 4, size: 8 },
};
const SLEEPING_BADGE_PIXELS = [
  '.....###',
  '......#.',
  '...#####',
  '....#...',
  '.#####..',
  '..#.....',
  '.###....',
  '........',
];
/** Leave headroom inside SLEEPING_ICON_TIMEOUT_MS for the page injection that follows. */
const SLEEPING_FAVICON_FETCH_MS = 1500;
const SLEEPING_FAVICON_MAX_BYTES = 256 * 1024;
const SLEEPING_FAVICON_CACHE_MAX = 64;
const SLEEPING_FAVICON_SCHEMES = ['http:', 'https:', 'data:'];

const sleepingFaviconCache = new Map();
let sleepingIconAssetPromise = null;

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function blobToDataUrl(blob, mimeType) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

async function fetchFaviconBlob(url) {
  // Extension fetches with host permission skip CORS; include cookies for
  // intranet favicons that sit behind a login.
  const init = { credentials: 'include' };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    init.signal = AbortSignal.timeout(SLEEPING_FAVICON_FETCH_MS);
  }
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`favicon fetch failed: ${response.status}`);
  const blob = await response.blob();
  if (blob.size > SLEEPING_FAVICON_MAX_BYTES) throw new Error('favicon too large');
  return blob;
}

function cachedFaviconUrl(pageUrl) {
  const url = new URL(chrome.runtime.getURL('_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', '32');
  return url.href;
}

/** Workers cannot decode SVG, so it is rasterised inside the page instead. */
async function looksLikeSvg(blob) {
  const type = String(blob.type || '');
  if (/svg/i.test(type)) return true;
  // Servers often label SVG as text/plain or octet-stream; sniff those.
  if (type && !/^(text\/|application\/(octet-stream|xml))/i.test(type)) return false;
  return /<svg[\s>]/i.test(await blob.slice(0, 1024).text());
}

function getSleepingIconAsset() {
  if (!sleepingIconAssetPromise) {
    sleepingIconAssetPromise = (async () => {
      const scale = SLEEPING_FAVICON_SCALE;
      const size = SLEEPING_FAVICON_LAYOUT.zzz.size * scale;
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0a54b9';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#fff';
      SLEEPING_BADGE_PIXELS.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
          if (row[x] === '#') ctx.fillRect(x * scale, y * scale, scale, scale);
        }
      });
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      return { blob, dataUrl: await blobToDataUrl(blob, 'image/png') };
    })()
      .catch((err) => {
        sleepingIconAssetPromise = null;
        throw err;
      });
  }
  return sleepingIconAssetPromise;
}

async function drawSleepingFavicon(originalUrl) {
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') {
    return null;
  }

  const [zzzAsset, originalBlob] = await Promise.all([
    getSleepingIconAsset(),
    fetchFaviconBlob(originalUrl),
  ]);

  if (await looksLikeSvg(originalBlob)) {
    return {
      composite: null,
      svg: {
        original: await blobToDataUrl(originalBlob, 'image/svg+xml'),
        zzz: zzzAsset.dataUrl,
      },
    };
  }

  const [zzz, original] = await Promise.all([
    createImageBitmap(zzzAsset.blob),
    createImageBitmap(originalBlob),
  ]);

  const scale = SLEEPING_FAVICON_SCALE;
  const canvas = new OffscreenCanvas(
    SLEEPING_FAVICON_BOX * scale,
    SLEEPING_FAVICON_BOX * scale
  );
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const { original: o, zzz: z } = SLEEPING_FAVICON_LAYOUT;
  ctx.drawImage(original, o.x * scale, o.y * scale, o.size * scale, o.size * scale);
  ctx.drawImage(zzz, z.x * scale, z.y * scale, z.size * scale, z.size * scale);
  original.close?.();
  zzz.close?.();

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { composite: await blobToDataUrl(blob, 'image/png'), svg: null };
}

/**
 * Prepare a 16x16 favicon with the sleeping icon on the left and the tab's
 * original favicon on the right. Resolves to:
 * - `{ composite }`: a ready PNG data URL (raster favicons, composed here);
 * - `{ svg: { original, zzz } }`: SVG data URLs for the page to compose;
 * - `null`: the original favicon is unavailable or undecodable.
 * @param {string|undefined|null} originalUrl tab.favIconUrl
 * @returns {Promise<{ composite: string|null, svg: { original: string, zzz: string }|null }|null>}
 */
function composeSleepingFavicon(originalUrl, pageUrl) {
  if (typeof originalUrl !== 'string' || !originalUrl) return Promise.resolve(null);

  let supported = false;
  try {
    supported = SLEEPING_FAVICON_SCHEMES.includes(new URL(originalUrl).protocol);
  } catch {}
  if (!supported && !pageUrl) return Promise.resolve(null);

  const cacheKey = `${originalUrl}\n${pageUrl || ''}`;
  const cached = sleepingFaviconCache.get(cacheKey);
  if (cached) return cached;

  const pending = (supported ? drawSleepingFavicon(originalUrl) : Promise.reject(new Error('unsupported favicon URL')))
    .catch((err) => {
      if (!pageUrl) throw err;
      return drawSleepingFavicon(cachedFaviconUrl(pageUrl));
    }).catch((err) => {
      console.warn('composeSleepingFavicon failed:', originalUrl.slice(0, 200), err);
      return null;
    });
  if (sleepingFaviconCache.size >= SLEEPING_FAVICON_CACHE_MAX) {
    sleepingFaviconCache.delete(sleepingFaviconCache.keys().next().value);
  }
  sleepingFaviconCache.set(cacheKey, pending);
  pending.then((result) => {
    // Do not pin failures; a later attempt may succeed.
    if (!result && sleepingFaviconCache.get(cacheKey) === pending) {
      sleepingFaviconCache.delete(cacheKey);
    }
  });
  return pending;
}

/**
 * Set the browser tab favicon before its renderer is terminated or discarded.
 * The marker persists in the tab strip while Chromium keeps the tab discarded.
 * Shows the sleeping icon beside the original favicon (options.faviconUrl). When
 * the tab has a favicon that cannot be composed, it is left untouched (resolves
 * false) so the tab stays recognisable; the sleeping icon alone is used only for
 * tabs without a favicon.
 */
async function setTabSleepingIcon(tabId, url, options = {}) {
  if (!chrome.scripting || !chrome.runtime?.getURL) return false;
  const { maybeHasActiveTabAccess = false, faviconUrl } = options;

  let resolvedUrl = url;
  if (resolvedUrl === undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      resolvedUrl = tab.url;
    } catch {
      return false;
    }
  }

  const originPattern = resolvedUrl ? getScriptableOriginPattern(resolvedUrl) : null;
  if (!originPattern) return false;

  const composedPromise = composeSleepingFavicon(faviconUrl, resolvedUrl);

  // http(s) access is declared in manifest.json; avoid a permissions API round
  // trip for every tab in a large batch. File URLs still need the special check.
  if (
    isFileUrl(resolvedUrl) &&
    !(await canScriptTab(originPattern, resolvedUrl, maybeHasActiveTabAccess))
  ) {
    return false;
  }

  try {
    const composed = await composedPromise;
    const compositeUrl = composed?.composite || null;
    if (faviconUrl && !compositeUrl && !composed?.svg) return false;
    const iconUrl = compositeUrl || chrome.runtime.getURL('icons/icon128.png');
    const iconSize = compositeUrl ? SLEEPING_FAVICON_BOX * SLEEPING_FAVICON_SCALE : 128;
    const spec = {
      box: SLEEPING_FAVICON_BOX,
      scale: SLEEPING_FAVICON_SCALE,
      layout: SLEEPING_FAVICON_LAYOUT,
    };
    await chrome.scripting.executeScript({
      target: { tabId },
      func: async (sleepingIconUrl, sleepingIconSize, svg, faviconSpec) => {
        // Already marked (icon may be composite); do not compose on top of it.
        if (document.querySelector('link[data-tabnap-sleeping-icon]')) return;

        let href = sleepingIconUrl;
        let size = sleepingIconSize;
        if (svg) {
          // Rasterise the SVG favicon here; workers cannot decode it. Data URLs
          // keep the canvas untainted. On failure the original favicon is kept.
          try {
            const load = (src) =>
              new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error('image load failed'));
                img.src = src;
              });
            const [original, zzz] = await Promise.all([load(svg.original), load(svg.zzz)]);
            const { box, scale, layout } = faviconSpec;
            const canvas = document.createElement('canvas');
            canvas.width = box * scale;
            canvas.height = box * scale;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            const o = layout.original;
            const z = layout.zzz;
            ctx.drawImage(original, o.x * scale, o.y * scale, o.size * scale, o.size * scale);
            ctx.drawImage(zzz, z.x * scale, z.y * scale, z.size * scale, z.size * scale);
            // Default type is PNG. Keep this call free of a quoted argument:
            // scripts/build-dist.js would read it as a CSS asset reference.
            href = canvas.toDataURL();
            size = box * scale;
          } catch {
            return;
          }
        }

        const iconLink = document.createElement('link');
        iconLink.rel = 'icon';
        iconLink.type = 'image/png';
        iconLink.sizes = `${size}x${size}`;
        iconLink.href = href;
        iconLink.dataset.tabnapSleepingIcon = 'true';

        const parent = document.head || document.documentElement;
        if (parent) parent.appendChild(iconLink);
      },
      args: [iconUrl, iconSize, compositeUrl ? null : composed?.svg || null, spec],
    });
    // Give Chromium a brief chance to receive the favicon update before discard.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return true;
  } catch (err) {
    if (isExpectedAccessError(err)) return false;
    console.warn('setTabSleepingIcon failed:', err);
    return false;
  }
}
