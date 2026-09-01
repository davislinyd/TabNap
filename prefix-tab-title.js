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

/**
 * Set the browser tab favicon before its renderer is terminated or discarded.
 * The marker persists in the tab strip while Chromium keeps the tab discarded.
 */
async function setTabSleepingIcon(tabId, url, options = {}) {
  if (!chrome.scripting || !chrome.runtime?.getURL) return false;
  const { maybeHasActiveTabAccess = false } = options;

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

  // http(s) access is declared in manifest.json; avoid a permissions API round
  // trip for every tab in a large batch. File URLs still need the special check.
  if (
    isFileUrl(resolvedUrl) &&
    !(await canScriptTab(originPattern, resolvedUrl, maybeHasActiveTabAccess))
  ) {
    return false;
  }

  try {
    const iconUrl = chrome.runtime.getURL('icons/icon16.png');
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (sleepingIconUrl) => {
        const iconLinks = [...document.querySelectorAll('link[rel~="icon"]')];
        const marker = document.querySelector('link[data-tabnap-sleeping-icon]');
        const iconLink = marker || document.createElement('link');
        iconLink.rel = 'icon';
        iconLink.type = 'image/png';
        iconLink.sizes = '16x16';
        iconLink.href = sleepingIconUrl;
        iconLink.dataset.tabnapSleepingIcon = 'true';

        if (!iconLink.isConnected) {
          const parent = document.head || document.documentElement;
          if (parent) parent.appendChild(iconLink);
        }

        for (const link of iconLinks) {
          if (link !== iconLink) link.href = sleepingIconUrl;
        }
      },
      args: [iconUrl],
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
