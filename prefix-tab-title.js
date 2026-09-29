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
  zzz: { x: 0, y: 4.5, size: 7 },
  original: { x: 6, y: 3, size: 10 },
};
/** Leave headroom inside SLEEPING_ICON_TIMEOUT_MS so the plain-icon fallback still lands. */
const SLEEPING_FAVICON_FETCH_MS = 500;
const SLEEPING_FAVICON_CACHE_MAX = 64;
const SLEEPING_FAVICON_SCHEMES = ['http:', 'https:', 'data:'];

const sleepingFaviconCache = new Map();
let sleepingIconBitmapPromise = null;

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function fetchImageBitmap(url) {
  const init = {};
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    init.signal = AbortSignal.timeout(SLEEPING_FAVICON_FETCH_MS);
  }
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`favicon fetch failed: ${response.status}`);
  return createImageBitmap(await response.blob());
}

function getSleepingIconBitmap() {
  if (!sleepingIconBitmapPromise) {
    sleepingIconBitmapPromise = fetchImageBitmap(
      chrome.runtime.getURL('icons/icon16.png')
    ).catch((err) => {
      sleepingIconBitmapPromise = null;
      throw err;
    });
  }
  return sleepingIconBitmapPromise;
}

async function drawSleepingFavicon(originalUrl) {
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') {
    return null;
  }

  const [zzz, original] = await Promise.all([
    getSleepingIconBitmap(),
    fetchImageBitmap(originalUrl),
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

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:image/png;base64,${bytesToBase64(bytes)}`;
}

/**
 * Build a 16x16 favicon with the sleeping icon on the left and the tab's original
 * favicon on the right. Resolves to a PNG data URL, or null when the original
 * favicon is unavailable or cannot be decoded (e.g. SVG in a worker).
 * @param {string|undefined|null} originalUrl tab.favIconUrl
 * @returns {Promise<string|null>}
 */
function composeSleepingFavicon(originalUrl) {
  if (typeof originalUrl !== 'string' || !originalUrl) return Promise.resolve(null);

  try {
    if (!SLEEPING_FAVICON_SCHEMES.includes(new URL(originalUrl).protocol)) {
      return Promise.resolve(null);
    }
  } catch {
    return Promise.resolve(null);
  }

  const cached = sleepingFaviconCache.get(originalUrl);
  if (cached) return cached;

  const pending = drawSleepingFavicon(originalUrl).catch(() => null);
  if (sleepingFaviconCache.size >= SLEEPING_FAVICON_CACHE_MAX) {
    sleepingFaviconCache.delete(sleepingFaviconCache.keys().next().value);
  }
  sleepingFaviconCache.set(originalUrl, pending);
  pending.then((result) => {
    // Do not pin failures; a later attempt may succeed.
    if (!result && sleepingFaviconCache.get(originalUrl) === pending) {
      sleepingFaviconCache.delete(originalUrl);
    }
  });
  return pending;
}

/**
 * Set the browser tab favicon before its renderer is terminated or discarded.
 * The marker persists in the tab strip while Chromium keeps the tab discarded.
 * Shows the sleeping icon beside the original favicon (options.faviconUrl) when
 * it can be composed; otherwise falls back to the sleeping icon alone.
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

  const composedPromise = composeSleepingFavicon(faviconUrl);

  // http(s) access is declared in manifest.json; avoid a permissions API round
  // trip for every tab in a large batch. File URLs still need the special check.
  if (
    isFileUrl(resolvedUrl) &&
    !(await canScriptTab(originPattern, resolvedUrl, maybeHasActiveTabAccess))
  ) {
    return false;
  }

  try {
    const composedUrl = await composedPromise;
    const iconUrl = composedUrl || chrome.runtime.getURL('icons/icon16.png');
    const iconSize = composedUrl ? SLEEPING_FAVICON_BOX * SLEEPING_FAVICON_SCALE : 16;
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (sleepingIconUrl, sleepingIconSize) => {
        // Already marked (icon may be composite); do not compose on top of it.
        if (document.querySelector('link[data-tabnap-sleeping-icon]')) return;

        const iconLinks = [...document.querySelectorAll('link[rel~="icon"]')];
        const iconLink = document.createElement('link');
        iconLink.rel = 'icon';
        iconLink.type = 'image/png';
        iconLink.sizes = `${sleepingIconSize}x${sleepingIconSize}`;
        iconLink.href = sleepingIconUrl;
        iconLink.dataset.tabnapSleepingIcon = 'true';

        const parent = document.head || document.documentElement;
        if (parent) parent.appendChild(iconLink);

        for (const link of iconLinks) link.href = sleepingIconUrl;
      },
      args: [iconUrl, iconSize],
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
