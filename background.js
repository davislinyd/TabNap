importScripts('auto-end-rules.js', 'prefix-tab-title.js', 'end-task-core.js');

const terminatedStorage = AutoEndRules.getTerminatedTabsStorage();
const protectedTabStorage = AutoEndRules.getProtectedTabsStorage();
const AUTO_END_ALARM = 'auto-end-task';

/** In-memory cache of auto-end rules; refreshed on storage changes / startup. */
let cachedAutoEndRules = null;

function canAutoTerminateTab(tab) {
  return (
    tab.id &&
    !tab.active &&
    !tab.discarded &&
    tab.lastAccessed != null &&
    !EndTaskCore.isBuiltInPage(tab.url)
  );
}

async function cleanupStaleProtectedTabs(tabs) {
  const protectedTabs = await protectedTabStorage.getAll();
  const validTabIds = new Set((tabs || []).map((tab) => String(tab.id)));
  let changed = false;

  for (const tabId of Object.keys(protectedTabs)) {
    if (!validTabIds.has(tabId)) {
      delete protectedTabs[tabId];
      changed = true;
    }
  }

  if (changed) {
    await protectedTabStorage.setAll(protectedTabs);
  }

  return protectedTabs;
}

async function loadRulesIntoCache() {
  cachedAutoEndRules = await AutoEndRules.ensureAutoEndRulesMigrated();
  return cachedAutoEndRules;
}

async function getCachedRules() {
  if (cachedAutoEndRules) return cachedAutoEndRules;
  return loadRulesIntoCache();
}

async function ensureAlarm() {
  const alarm = await chrome.alarms.get(AUTO_END_ALARM);
  if (!alarm) {
    await chrome.alarms.create(AUTO_END_ALARM, { periodInMinutes: 1 });
  }
}

async function clearAlarm() {
  await chrome.alarms.clear(AUTO_END_ALARM);
}

async function syncAlarmWithSettings() {
  const { autoEndTask } = await chrome.storage.local.get('autoEndTask');
  const enabled = !!autoEndTask?.enabled;
  if (enabled) {
    await ensureAlarm();
  } else {
    await clearAlarm();
  }
  return enabled;
}

async function runAutoEndTask() {
  const { autoEndTask } = await chrome.storage.local.get('autoEndTask');
  const { enabled = false, idleMinutes = AutoEndRules.DEFAULT_IDLE_MINUTES } =
    autoEndTask || {};
  if (!enabled) {
    await clearAlarm();
    return;
  }

  const rules = await getCachedRules();
  const now = Date.now();
  const terminatedTabs = await terminatedStorage.getAll();
  const tabs = await chrome.tabs.query({});
  const protectedTabs = await cleanupStaleProtectedTabs(tabs);
  const toTerminate = [];

  for (const tab of tabs) {
    if (!canAutoTerminateTab(tab)) continue;
    if (terminatedTabs[String(tab.id)]) continue;

    const policy = AutoEndRules.resolveAutoEndPolicy(
      tab,
      rules,
      idleMinutes,
      protectedTabs
    );

    if (!policy || policy.mode === AutoEndRules.RULE_MODE_NEVER) continue;
    if (now - tab.lastAccessed <= policy.idleMinutes * 60 * 1000) continue;

    toTerminate.push(tab);
  }

  if (toTerminate.length === 0) return;

  try {
    await EndTaskCore.releaseTabsBatch(toTerminate, {
      prefixTitle: false,
      concurrency: EndTaskCore.DEFAULT_CONCURRENCY,
      allTabs: tabs,
      terminatedStorage,
    });
  } catch (err) {
    console.error('Auto end task batch failed:', err);
  }
}

if (!AutoEndRules.hasSessionStorageSupport()) {
  chrome.runtime.onStartup.addListener(() => {
    chrome.storage.local.remove(AutoEndRules.PROTECTED_TABS_KEY);
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  protectedTabStorage.removeEntry(tabId).catch(() => {});
  terminatedStorage.removeEntry(tabId).catch(() => {});
});

// Note: do NOT auto-clear terminated markers when a process becomes "alive".
// After End Task, Chromium/Edge often shows an error/crash interstitial that still
// has a renderer process; clearing on alive/complete wiped storage and broke Restore All.
// Markers are sticky until explicit Restore / Restore All / tab closed.

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  if (changes[AutoEndRules.AUTO_END_RULES_KEY]) {
    const next = changes[AutoEndRules.AUTO_END_RULES_KEY].newValue;
    cachedAutoEndRules = AutoEndRules.normalizeRules(next);
  }

  if (changes.autoEndTask) {
    const enabled = !!changes.autoEndTask.newValue?.enabled;
    if (enabled) {
      ensureAlarm().catch((err) => console.error('Failed to ensure alarm:', err));
    } else {
      clearAlarm().catch((err) => console.error('Failed to clear alarm:', err));
    }
  }
});

chrome.runtime.onInstalled.addListener(() => {
  loadRulesIntoCache().catch((err) => {
    console.error('Failed to initialize auto end rules:', err);
  });
  syncAlarmWithSettings().catch((err) => {
    console.error('Failed to sync auto end alarm:', err);
  });
});

loadRulesIntoCache().catch((err) => {
  console.error('Failed to initialize auto end rules:', err);
});

syncAlarmWithSettings().catch((err) => {
  console.error('Failed to sync auto end alarm:', err);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_END_ALARM) {
    runAutoEndTask().catch((err) => {
      console.error('Auto end task run failed:', err);
    });
  }
});

function serializeReleaseError(err) {
  return {
    message: String(err?.message || err || 'Release failed'),
    code: err?.code || null,
  };
}

async function releaseTabById(tabId, options = {}) {
  const tab = await chrome.tabs.get(tabId);
  return EndTaskCore.releaseTab(tab, {
    prefixTitle: EndTaskCore.getReleaseBackend() === 'terminate',
    maybeHasActiveTabAccess: !!tab.active,
    terminatedStorage,
    ...options,
  });
}

async function releaseTabsByIds(tabIds, options = {}) {
  const tabs = [];
  for (const tabId of tabIds || []) {
    try {
      tabs.push(await chrome.tabs.get(tabId));
    } catch {
      // Tab closed before release.
    }
  }
  return EndTaskCore.releaseTabsBatch(tabs, {
    prefixTitle: EndTaskCore.getReleaseBackend() === 'terminate',
    concurrency: EndTaskCore.DEFAULT_CONCURRENCY,
    terminatedStorage,
    ...options,
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;
  if (type !== 'RELEASE_TAB' && type !== 'RELEASE_TABS') return;

  const run =
    type === 'RELEASE_TAB'
      ? releaseTabById(message.tabId)
      : releaseTabsByIds(message.tabIds);

  run
    .then((result) => {
      try {
        sendResponse({ ok: true, result });
      } catch {
        // Popup may have closed after a focus switch.
      }
    })
    .catch((err) => {
      console.error('Release message failed:', err);
      try {
        sendResponse({ ok: false, error: serializeReleaseError(err) });
      } catch {
        // Popup may have closed.
      }
    });
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'end-current-tab') return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    if (EndTaskCore.isBuiltInPage(tab.url)) {
      console.warn('Cannot release built-in pages');
      return;
    }

    await EndTaskCore.releaseTab(tab, {
      prefixTitle: EndTaskCore.getReleaseBackend() === 'terminate',
      maybeHasActiveTabAccess: true,
      terminatedStorage,
    });
  } catch (err) {
    console.error('Failed to release tab:', err);
  }
});
