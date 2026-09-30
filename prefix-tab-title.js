const TITLE_PREFIX_MARK = '\uD83D\uDCA4 ';
const TITLE_PREFIX_RE = /^(?:(?:\uD83D\uDCA4|\u267B\uFE0F?)\s+)+/;
const FILE_ORIGIN_PATTERN = 'file:///*';

/** Remove current and legacy release markers for display / storage hygiene. */
function stripTitlePrefixMark(title) {
  if (typeof title !== 'string' || !title) return title || '';
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
 * 釋放前於分頁的 document.title 加上 💤 前綴（http/https/file）。
 * 注入失敗不拋錯，不阻擋後續釋放。
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
        const title = document.title || 'file';
        if (title.startsWith(prefix)) return;
        document.title = prefix + title.replace(/^\u267B\uFE0F?\s+/, '');
      },
      args: [TITLE_PREFIX_MARK],
    });
  } catch (err) {
    if (isExpectedAccessError(err)) return;
    console.warn('prefixTabTitleWithMarker failed:', err);
  }
}
