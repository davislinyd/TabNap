const terminatedStorage = AutoEndRules.getTerminatedTabsStorage();
const protectedTabStorage = AutoEndRules.getProtectedTabsStorage();

const errorMessage = document.getElementById('error-message');
const emptyState = document.getElementById('empty-state');
const tabList = document.getElementById('tab-list');
const batchActions = document.getElementById('batch-actions');
const endTaskAllBtn = document.getElementById('end-task-all');
const restoreAllBtn = document.getElementById('restore-all');
const rulesToggleBtn = document.getElementById('rules-toggle');
const rulesContentEl = document.getElementById('rules-content');
const ruleMatchTypeEl = document.getElementById('rule-match-type');
const rulePatternEl = document.getElementById('rule-pattern');
const ruleModeEl = document.getElementById('rule-mode');
const ruleIdleGroupEl = document.getElementById('rule-idle-group');
const ruleIdleMinutesEl = document.getElementById('rule-idle-minutes');
const ruleAddBtn = document.getElementById('rule-add');
const ruleListEl = document.getElementById('rule-list');

/** Single favicon observer for the tab list (reused across re-renders). */
let faviconObserver = null;

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.remove('hidden');
  emptyState.classList.add('hidden');
  tabList.classList.add('hidden');
  batchActions?.classList.add('hidden');
}

function showEmptyState() {
  errorMessage.classList.add('hidden');
  emptyState.classList.remove('hidden');
  tabList.classList.add('hidden');
  batchActions?.classList.add('hidden');
}

function showTabList() {
  errorMessage.classList.add('hidden');
  emptyState.classList.add('hidden');
  tabList.classList.remove('hidden');
  batchActions?.classList.remove('hidden');
}

const fallbackNotice = document.getElementById('fallback-notice');

function showFallbackNotice(visible) {
  if (!fallbackNotice) return;
  fallbackNotice.classList.toggle('hidden', !visible);
}

function serializeError(errLike) {
  const err = new Error(errLike?.message || '釋放失敗');
  err.code = errLike?.code || undefined;
  return err;
}

function isPopupClosedError(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return (
    message.includes('message port closed') ||
    message.includes('asynchronous response') ||
    message.includes('receiving end does not exist')
  );
}

async function requestReleaseTab(tab, options = {}) {
  if (EndTaskCore.getReleaseBackend() === 'terminate') {
    return EndTaskCore.terminateTabProcess(tab, options);
  }
  const response = await chrome.runtime.sendMessage({
    type: 'RELEASE_TAB',
    tabId: tab.id,
  });
  if (!response?.ok) throw serializeError(response?.error);
  return response.result;
}

async function requestReleaseTabs(tabs, options = {}) {
  if (EndTaskCore.getReleaseBackend() === 'terminate') {
    return EndTaskCore.terminateTabsBatch(tabs, options);
  }
  const response = await chrome.runtime.sendMessage({
    type: 'RELEASE_TABS',
    tabIds: (tabs || []).map((item) => item.id).filter((id) => id != null),
  });
  if (!response?.ok) throw serializeError(response?.error);
  return response.result;
}

const FAVICON_PLACEHOLDER =
  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect fill="%23ccc" width="16" height="16"/></svg>';
const SLEEPING_TAB_ICON = '💤';

function getFaviconUrl(url) {
  try {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.host}/favicon.ico`;
  } catch {
    return '';
  }
}

function createTabItem(tab, options = {}) {
  const {
    isTerminated = false,
    storedInfo = null,
    tabPolicy = null,
  } = options;

  const policy = AutoEndRules.normalizeTabPolicy(tabPolicy);
  const isNeverClose = policy?.mode === AutoEndRules.RULE_MODE_NEVER;
  const isCustomIdle = policy?.mode === AutoEndRules.RULE_MODE_IDLE;

  const item = document.createElement('div');
  item.className = 'tab-item';
  if (isNeverClose && !isTerminated) {
    item.classList.add('tab-item-protected');
  } else if (isCustomIdle && !isTerminated) {
    item.classList.add('tab-item-custom-idle');
  }
  item.dataset.tabId = String(tab.id);

  const displayUrl = storedInfo?.url ?? tab.url ?? '';
  // Live tabs must not show release markers: chrome.tabs.title can lag after revive
  // while the browser tab strip already shows a clean title.
  let displayTitle = storedInfo?.title ?? tab.title ?? '(無標題)';
  if (!isTerminated && typeof stripTitlePrefixMark === 'function') {
    displayTitle = stripTitlePrefixMark(displayTitle) || '(無標題)';
  }

  const favicon = isTerminated
    ? document.createElement('span')
    : document.createElement('img');
  favicon.className = 'tab-favicon';
  if (isTerminated) {
    favicon.classList.add('tab-sleeping-icon');
    favicon.textContent = SLEEPING_TAB_ICON;
    favicon.setAttribute('role', 'img');
    favicon.setAttribute('aria-label', '睡眠中');
  } else {
    favicon.loading = 'lazy';
    favicon.src = FAVICON_PLACEHOLDER;
    const faviconUrl = tab.favIconUrl || getFaviconUrl(displayUrl) || '';
    if (faviconUrl) favicon.dataset.faviconUrl = faviconUrl;
    favicon.alt = '';
    favicon.onerror = () => {
      favicon.src = FAVICON_PLACEHOLDER;
      delete favicon.dataset.faviconUrl;
    };
  }

  const info = document.createElement('div');
  info.className = 'tab-info';

  const titleRow = document.createElement('div');
  titleRow.className = 'tab-title-row';

  const title = document.createElement('div');
  title.className = 'tab-title';
  title.textContent = displayTitle;
  titleRow.appendChild(title);

  if (policy && !isTerminated) {
    const badge = document.createElement('span');
    badge.className = isNeverClose
      ? 'tab-status-badge tab-status-badge-never'
      : 'tab-status-badge tab-status-badge-idle';
    badge.textContent = AutoEndRules.getTabPolicyLabel(policy);
    titleRow.appendChild(badge);
  }

  const urlEl = document.createElement('div');
  urlEl.className = 'tab-url';
  urlEl.textContent = displayUrl;

  info.appendChild(titleRow);
  info.appendChild(urlEl);

  const actions = document.createElement('div');
  actions.className = 'tab-actions';

  if (!isTerminated) {
    const policyControls = document.createElement('div');
    policyControls.className = 'tab-policy-controls';

    const policySelect = document.createElement('select');
    policySelect.className = 'tab-policy-select';
    policySelect.dataset.role = 'tab-policy-mode';
    policySelect.setAttribute('aria-label', '自動釋放分頁政策');

    const optionDefault = document.createElement('option');
    optionDefault.value = 'default';
    optionDefault.textContent = '預設';
    const optionNever = document.createElement('option');
    optionNever.value = AutoEndRules.RULE_MODE_NEVER;
    optionNever.textContent = 'Never Close';
    const optionIdle = document.createElement('option');
    optionIdle.value = AutoEndRules.RULE_MODE_IDLE;
    optionIdle.textContent = '自訂閒置';

    policySelect.appendChild(optionDefault);
    policySelect.appendChild(optionNever);
    policySelect.appendChild(optionIdle);
    policySelect.value = policy?.mode || 'default';

    const idleInput = document.createElement('input');
    idleInput.type = 'number';
    idleInput.className = 'tab-idle-minutes';
    idleInput.dataset.role = 'tab-policy-idle';
    idleInput.min = '1';
    idleInput.max = '120';
    idleInput.value = String(
      isCustomIdle
        ? policy.idleMinutes
        : AutoEndRules.DEFAULT_IDLE_MINUTES
    );
    idleInput.setAttribute('aria-label', '自訂閒置分鐘');
    idleInput.title = '分鐘';
    if (!isCustomIdle) {
      idleInput.classList.add('hidden');
    }

    policyControls.appendChild(policySelect);
    policyControls.appendChild(idleInput);
    actions.appendChild(policyControls);
  }

  const primaryBtn = document.createElement('button');
  primaryBtn.type = 'button';
  primaryBtn.className = isTerminated ? 'restore-btn' : 'end-task-btn';
  primaryBtn.dataset.action = isTerminated ? 'restore' : 'end-task';
  primaryBtn.textContent = isTerminated ? '喚醒' : '釋放';
  actions.appendChild(primaryBtn);

  item.appendChild(favicon);
  item.appendChild(info);
  item.appendChild(actions);

  return item;
}

function replaceTabItem(itemEl, tab, options) {
  const nextItem = createTabItem(tab, options);
  itemEl.replaceWith(nextItem);
  observeFavicons(tabList);
  return nextItem;
}

function markItemsTerminated(tabIds, storedEntries, tabPolicies) {
  const idSet = new Set((tabIds || []).map(String));
  const policies = AutoEndRules.normalizeTabPolicies(tabPolicies);
  for (const item of tabList.querySelectorAll('.tab-item')) {
    const tabId = item.dataset.tabId;
    if (!idSet.has(tabId)) continue;
    const storedInfo = storedEntries?.[tabId] || {
      url: item.querySelector('.tab-url')?.textContent,
      title: item.querySelector('.tab-title')?.textContent,
    };
    const tab = {
      id: Number(tabId),
      url: storedInfo.url,
      title: storedInfo.title,
    };
    replaceTabItem(item, tab, {
      isTerminated: true,
      storedInfo,
      tabPolicy: policies[tabId] || null,
    });
  }
}

async function restoreTab(tabId, itemEl) {
  const btn = itemEl.querySelector('.restore-btn');
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = '喚醒中...';

  try {
    const terminatedMap = await terminatedStorage.getAll();
    await reloadTerminatedTab(tabId, terminatedMap[String(tabId)]);
    await terminatedStorage.removeEntry(tabId);
    const tab = await chrome.tabs.get(tabId);
    const tabPolicies = AutoEndRules.normalizeTabPolicies(
      await protectedTabStorage.getAll()
    );
    const row =
      tabList.querySelector(`.tab-item[data-tab-id="${tabId}"]`) || itemEl;
    replaceTabItem(row, tab, {
      tabPolicy: tabPolicies[String(tabId)] || null,
    });
  } catch (err) {
    const row =
      tabList.querySelector(`.tab-item[data-tab-id="${tabId}"]`) || itemEl;
    const liveBtn = row.querySelector('.restore-btn');
    if (liveBtn) {
      liveBtn.disabled = false;
      liveBtn.textContent = '喚醒';
    }
    alert(`喚醒失敗：${err.message}`);
  }
}

async function endTask(tabId, itemEl, tab) {
  const btn = itemEl.querySelector('.end-task-btn');
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = '釋放中...';

  try {
    const [tabPoliciesRaw, allTabs] = await Promise.all([
      protectedTabStorage.getAll(),
      chrome.tabs.query({}),
    ]);
    const tabPolicies = AutoEndRules.normalizeTabPolicies(tabPoliciesRaw);

    const result = await requestReleaseTab(tab, {
      maybeHasActiveTabAccess: !!tab.active,
      allTabs,
      terminatedStorage,
    });

    const terminatedIds = result.terminatedTabIds || [];
    const idKey = String(tabId);

    if (terminatedIds.length > 0) {
      markItemsTerminated(terminatedIds, result.storedEntries, tabPolicies);
    }

    // Always sync the clicked row: markItemsTerminated may miss a stale node, and
    // primary is always written to storage on successful terminate.
    const storedFromResult = result.storedEntries?.[idKey];
    const storedFromDb = (await terminatedStorage.getAll())[idKey];
    const storedInfo =
      storedFromResult || storedFromDb || EndTaskCore.storedInfoFromTab(tab);

    if (storedFromResult || storedFromDb || terminatedIds.map(String).includes(idKey)) {
      const row =
        tabList.querySelector(`.tab-item[data-tab-id="${idKey}"]`) || itemEl;
      replaceTabItem(row, tab, {
        isTerminated: true,
        storedInfo,
        tabPolicy: tabPolicies[idKey] || null,
      });
    } else {
      // Terminate reported no durable kill — restore End Task control.
      const liveTab = await chrome.tabs.get(tabId).catch(() => tab);
      const row =
        tabList.querySelector(`.tab-item[data-tab-id="${idKey}"]`) || itemEl;
      replaceTabItem(row, liveTab, {
        tabPolicy: tabPolicies[idKey] || null,
      });
    }
  } catch (err) {
    if (isPopupClosedError(err)) return;
    if (EndTaskCore.isProcessNotFoundError(err)) {
      const policies = AutoEndRules.normalizeTabPolicies(
        await protectedTabStorage.getAll()
      );
      const storedInfo = EndTaskCore.storedInfoFromTab(tab);
      await terminatedStorage.setEntry(tabId, storedInfo);
      const row =
        tabList.querySelector(`.tab-item[data-tab-id="${tabId}"]`) || itemEl;
      replaceTabItem(row, tab, {
        isTerminated: true,
        storedInfo,
        tabPolicy: policies[String(tabId)] || null,
      });
      return;
    }

    const row =
      tabList.querySelector(`.tab-item[data-tab-id="${tabId}"]`) || itemEl;
    const liveBtn = row.querySelector('.end-task-btn');
    if (liveBtn) {
      liveBtn.disabled = false;
      liveBtn.textContent = '釋放';
    }
    if (
      err?.code === 'TERMINATE_FAILED' ||
      err?.code === 'BUILT_IN_PAGE' ||
      err?.code === 'DISCARD_FAILED'
    ) {
      alert('無法釋放此分頁，可能是內建頁面或受保護的分頁。');
    } else {
      alert(`釋放失敗：${err.message}`);
    }
  }
}

async function setTabPolicy(tabId, itemEl, policy) {
  const select = itemEl.querySelector('[data-role="tab-policy-mode"]');
  const idleInput = itemEl.querySelector('[data-role="tab-policy-idle"]');
  if (select) select.disabled = true;
  if (idleInput) idleInput.disabled = true;

  try {
    const normalized = AutoEndRules.normalizeTabPolicy(policy);
    if (normalized) {
      await protectedTabStorage.setEntry(tabId, normalized);
    } else {
      await protectedTabStorage.removeEntry(tabId);
    }

    const tab = await chrome.tabs.get(tabId);
    replaceTabItem(itemEl, tab, { tabPolicy: normalized });
  } catch (err) {
    if (select) select.disabled = false;
    if (idleInput) idleInput.disabled = false;
    alert(`更新分頁政策失敗：${err.message}`);
  }
}

function readTabPolicyFromItem(itemEl) {
  const select = itemEl.querySelector('[data-role="tab-policy-mode"]');
  const idleInput = itemEl.querySelector('[data-role="tab-policy-idle"]');
  if (!select) return null;

  const mode = select.value;
  if (mode === AutoEndRules.RULE_MODE_NEVER) {
    return { mode: AutoEndRules.RULE_MODE_NEVER };
  }
  if (mode === AutoEndRules.RULE_MODE_IDLE) {
    return {
      mode: AutoEndRules.RULE_MODE_IDLE,
      idleMinutes: AutoEndRules.clampIdleMinutes(
        idleInput?.value ?? AutoEndRules.DEFAULT_IDLE_MINUTES
      ),
    };
  }
  return null;
}

/**
 * Tabs protected from End Task All (tab Never Close or matching site never rule).
 * Single-tab End Task still force-kills.
 */
async function filterTabsForEndTaskAll(tabs) {
  const [tabPoliciesRaw, rules, { autoEndTask }] = await Promise.all([
    protectedTabStorage.getAll(),
    AutoEndRules.ensureAutoEndRulesMigrated(),
    chrome.storage.local.get('autoEndTask'),
  ]);
  const tabPolicies = AutoEndRules.normalizeTabPolicies(tabPoliciesRaw);
  const defaultIdle =
    autoEndTask?.idleMinutes ?? AutoEndRules.DEFAULT_IDLE_MINUTES;
  const allowed = [];
  const skipped = [];

  for (const tab of tabs || []) {
    const policy = AutoEndRules.resolveAutoEndPolicy(
      tab,
      rules,
      defaultIdle,
      tabPolicies
    );
    if (policy?.mode === AutoEndRules.RULE_MODE_NEVER) {
      skipped.push({
        id: tab.id,
        source: policy.source,
        title: tab.title,
      });
      continue;
    }
    allowed.push(tab);
  }

  return { allowed, skipped, tabPolicies };
}

async function endTaskAll() {
  const items = [...tabList.querySelectorAll('.tab-item')].filter((item) =>
    item.querySelector('.end-task-btn')
  );
  if (items.length === 0) return;

  endTaskAllBtn.disabled = true;
  endTaskAllBtn.textContent = '釋放中...';
  DebugLog?.info('endTaskAll start', { uiCount: items.length });

  try {
    const tabIds = items.map((item) => parseInt(item.dataset.tabId, 10));
    const tabs = await EndTaskCore.runWithConcurrency(
      tabIds,
      EndTaskCore.DEFAULT_CONCURRENCY,
      async (tabId) => {
        try {
          return await chrome.tabs.get(tabId);
        } catch {
          return null;
        }
      }
    );
    const validTabs = tabs.filter(Boolean);
    if (validTabs.length === 0) {
      DebugLog?.warn('endTaskAll no valid tabs');
      return;
    }

    const { allowed, skipped } = await filterTabsForEndTaskAll(validTabs);
    DebugLog?.info('endTaskAll filter', {
      valid: validTabs.length,
      allowed: allowed.length,
      skippedNeverClose: skipped,
    });

    if (allowed.length === 0) {
      alert(
        skipped.length > 0
          ? `沒有可釋放的分頁（${skipped.length} 個為 Never Close，已略過）。`
          : '沒有可釋放的分頁。'
      );
      return;
    }

    const allTabs = await chrome.tabs.query({});

    const result = await requestReleaseTabs(allowed, {
      concurrency: EndTaskCore.DEFAULT_CONCURRENCY,
      allTabs,
      terminatedStorage,
    });

    const results = result.results || [];
    const okCount = results.filter((item) => item?.ok).length;
    const failCount = results.filter((item) => item && !item.ok).length;
    const terminatedCount = (result.terminatedTabIds || []).length;
    const storedAfter = await terminatedStorage.getAll();
    const storedCount = Object.keys(storedAfter || {}).length;

    DebugLog?.info('endTaskAll result', {
      okCount,
      failCount,
      terminatedCount,
      storedCount,
      terminatedTabIds: result.terminatedTabIds,
      errors: results
        .filter((r) => r?.error)
        .map((r) => ({
          tabId: r.tab?.id,
          message: String(r.error?.message || r.error),
          code: r.error?.code,
        })),
    });

    await loadTabs();

    // Success if any group ok OR any terminated ids written OR storage has entries.
    const hadSuccess = okCount > 0 || terminatedCount > 0 || storedCount > 0;
    if (!hadSuccess) {
      const firstErr = results.find((item) => item?.error)?.error;
      alert(
        firstErr
          ? `批次釋放失敗：${firstErr.message || firstErr}`
          : '未能釋放任何分頁。可按「複製 Log」回報。'
      );
    }
  } catch (err) {
    if (isPopupClosedError(err)) {
      try {
        await loadTabs();
      } catch {
        // Popup is likely closing.
      }
      return;
    }
    DebugLog?.error('endTaskAll exception', { message: String(err?.message || err) });
    alert(`批次釋放失敗：${err.message}`);
  } finally {
    endTaskAllBtn.disabled = false;
    endTaskAllBtn.textContent = '全部釋放';
  }
}

/**
 * Reload a tab that was End Task'd. Prefer reload; fall back to navigating
 * to the stored URL when the renderer is gone and reload fails (Edge).
 */
async function reloadTerminatedTab(tabId, storedInfo) {
  try {
    await chrome.tabs.reload(tabId);
    return true;
  } catch (err) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const url = storedInfo?.url || tab?.url;
    if (!url || EndTaskCore.isBuiltInPage(url)) {
      throw err;
    }
    await chrome.tabs.update(tabId, { url });
    return true;
  }
}

async function restoreAll() {
  const uiRestoreItems = [...tabList.querySelectorAll('.tab-item')].filter((item) =>
    item.querySelector('.restore-btn')
  );

  const [terminatedMap, currentTabs] = await Promise.all([
    terminatedStorage.getAll(),
    chrome.tabs.query({ currentWindow: true }),
  ]);
  const currentIds = new Set(currentTabs.map((tab) => tab.id));

  const idSet = new Set();
  for (const item of uiRestoreItems) {
    const id = parseInt(item.dataset.tabId, 10);
    if (Number.isFinite(id) && currentIds.has(id)) idSet.add(id);
  }
  for (const idStr of Object.keys(terminatedMap || {})) {
    const id = Number(idStr);
    if (Number.isFinite(id) && currentIds.has(id)) idSet.add(id);
  }

  // Fallback: process-dead tabs not marked terminated (stale state after false batch UI).
  if (idSet.size === 0 && chrome.processes) {
    for (const tab of currentTabs) {
      if (!tab?.id || EndTaskCore.isBuiltInPage(tab.url)) continue;
      try {
        const state = await EndTaskCore.probeTabProcess(tab.id);
        if (state === EndTaskCore.PROBE_STATE_DEAD) {
          idSet.add(tab.id);
          if (!terminatedMap[String(tab.id)]) {
            terminatedMap[String(tab.id)] = EndTaskCore.storedInfoFromTab(tab);
          }
        }
      } catch {
        // ignore probe errors
      }
    }
    DebugLog?.info('restoreAll dead-process fallback', { count: idSet.size });
  }

  const tabIds = [...idSet];
  DebugLog?.info('restoreAll start', {
    uiRestore: uiRestoreItems.length,
    storageKeys: Object.keys(terminatedMap || {}).length,
    tabIds,
  });

  if (tabIds.length === 0) {
    alert('沒有可喚醒的分頁（列表中無喚醒按鈕，storage 亦無 terminated 記錄）。');
    return;
  }

  if (restoreAllBtn) {
    restoreAllBtn.disabled = true;
    restoreAllBtn.textContent = '喚醒中...';
  }
  for (const item of uiRestoreItems) {
    const btn = item.querySelector('.restore-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '喚醒中...';
    }
  }

  const succeededIds = [];
  const failedIds = [];

  try {
    for (const tabId of tabIds) {
      try {
        await reloadTerminatedTab(tabId, terminatedMap[String(tabId)]);
        await terminatedStorage.removeEntry(tabId);
        succeededIds.push(tabId);
        DebugLog?.info('restoreAll tab ok', { tabId });
      } catch (err) {
        failedIds.push(tabId);
        DebugLog?.error('restoreAll tab fail', {
          tabId,
          message: String(err?.message || err),
        });
      }
    }

    await loadTabs();

    DebugLog?.info('restoreAll done', {
      succeeded: succeededIds.length,
      failed: failedIds.length,
    });

    if (succeededIds.length === 0 && failedIds.length > 0) {
      alert('全部喚醒失敗：無法重新載入分頁。可按「複製 Log」回報。');
    } else if (failedIds.length > 0) {
      alert(`部分分頁喚醒失敗（${failedIds.length}/${tabIds.length}）。`);
    }
  } catch (err) {
    DebugLog?.error('restoreAll exception', { message: String(err?.message || err) });
    alert(`全部喚醒失敗：${err.message}`);
    try {
      await loadTabs();
    } catch {
      // ignore
    }
  } finally {
    if (restoreAllBtn) {
      restoreAllBtn.disabled = false;
      restoreAllBtn.textContent = '全部喚醒';
    }
  }
}

async function loadTabs() {
  tabList.innerHTML = '<div class="loading-state">載入中...</div>';
  tabList.classList.remove('hidden');
  errorMessage.classList.add('hidden');
  emptyState.classList.add('hidden');
  showFallbackNotice(EndTaskCore.getReleaseBackend() === 'discard');

  try {
    const [tabs, terminatedDataRaw, protectedDataRaw, { autoEndTask }] =
      await Promise.all([
        chrome.tabs.query({ currentWindow: true }),
        terminatedStorage.getAll(),
        protectedTabStorage.getAll(),
        chrome.storage.local.get('autoEndTask'),
      ]);

    const terminatedTabs =
      terminatedDataRaw && typeof terminatedDataRaw === 'object'
        ? terminatedDataRaw
        : {};
    const tabPolicies = AutoEndRules.normalizeTabPolicies(protectedDataRaw);
    const tabIds = new Set(tabs.map((tab) => String(tab.id)));
    let validTerminated = Object.fromEntries(
      Object.entries(terminatedTabs).filter(([id]) => tabIds.has(id))
    );

    // Drop stale terminated entries for closed tabs (session store hygiene).
    const staleIds = Object.keys(terminatedTabs).filter((id) => !tabIds.has(id));
    if (staleIds.length > 0) {
      terminatedStorage.removeEntries(staleIds).catch(() => {});
    }

    const isCrashed = (tab) =>
      tab.url?.startsWith('chrome://crash') ||
      tab.url?.startsWith('chrome-error://');
    const isNormal = (tab) =>
      tab.id &&
      !tab.url?.startsWith('chrome://') &&
      !tab.url?.startsWith('brave://') &&
      !tab.url?.startsWith('edge://');

    const filteredTabs = tabs.filter((tab) => tab.id && (isCrashed(tab) || isNormal(tab)));

    if (filteredTabs.length === 0) {
      showEmptyState();
      return;
    }

    if (EndTaskCore.getReleaseBackend() === 'discard') {
      validTerminated = await EndTaskCore.reconcileDiscardedTabs(
        filteredTabs,
        validTerminated,
        terminatedStorage
      );
    } else {
      // Mark tabs whose process is already gone but not in storage.
      validTerminated = await EndTaskCore.reconcileDeadTabs(
        filteredTabs,
        validTerminated,
        terminatedStorage
      );
      // Do NOT reconcileRevivedTabs here: error-page processes after End Task look
      // "alive" and would wipe terminated markers, leaving 喚醒 with nothing.
    }

    DebugLog?.info('loadTabs', {
      tabCount: filteredTabs.length,
      terminatedCount: Object.keys(validTerminated).length,
      terminatedIds: Object.keys(validTerminated),
    });

    filteredTabs.sort((a, b) => (a.active ? 0 : 1) - (b.active ? 0 : 1));

    const fragment = document.createDocumentFragment();
    for (const tab of filteredTabs) {
      const storedInfo = validTerminated[String(tab.id)];
      fragment.appendChild(
        createTabItem(tab, {
          isTerminated: !!storedInfo,
          storedInfo,
          tabPolicy: tabPolicies[String(tab.id)] || null,
        })
      );
    }
    tabList.innerHTML = '';
    tabList.appendChild(fragment);
    showTabList();

    resetFaviconObserver(tabList);
    observeFavicons(tabList);
    scheduleDeferredInit(autoEndTask);
  } catch (err) {
    showError(`載入分頁失敗：${err.message}`);
  }
}

function resetFaviconObserver(container) {
  if (faviconObserver) {
    faviconObserver.disconnect();
    faviconObserver = null;
  }
  faviconObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        const url = img.dataset.faviconUrl;
        if (url) {
          img.src = url;
          delete img.dataset.faviconUrl;
          faviconObserver.unobserve(img);
        }
      }
    },
    { root: container, rootMargin: '50px', threshold: 0 }
  );
  return faviconObserver;
}

function observeFavicons(container) {
  if (!faviconObserver) {
    resetFaviconObserver(container);
  }
  for (const el of container.querySelectorAll('.tab-favicon')) {
    if (el.dataset.faviconUrl) {
      faviconObserver.observe(el);
    }
  }
}

async function loadAutoEndRules() {
  const rules = await AutoEndRules.ensureAutoEndRulesMigrated();
  renderRuleList(rules);
}

function renderRuleList(rules) {
  if (!ruleListEl) return;

  const normalizedRules = AutoEndRules.normalizeRules(rules);
  ruleListEl.innerHTML = '';

  if (normalizedRules.length === 0) {
    const emptyItem = document.createElement('li');
    emptyItem.className = 'rule-empty';
    emptyItem.textContent = '尚未設定站點規則';
    ruleListEl.appendChild(emptyItem);
    return;
  }

  for (const rule of normalizedRules) {
    const item = document.createElement('li');
    item.className = 'rule-item';

    const main = document.createElement('div');
    main.className = 'rule-item-main';

    const title = document.createElement('span');
    title.className = 'rule-item-title';
    title.textContent = `${AutoEndRules.getRuleMatchLabel(rule.matchType)} · ${rule.pattern}`;

    const detail = document.createElement('span');
    detail.className = 'rule-item-detail';
    detail.textContent = AutoEndRules.getRuleModeLabel(rule);

    main.appendChild(title);
    main.appendChild(detail);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'rule-remove-btn';
    removeBtn.dataset.ruleId = rule.id;
    removeBtn.textContent = '刪除';

    item.appendChild(main);
    item.appendChild(removeBtn);
    ruleListEl.appendChild(item);
  }
}

function syncRuleModeUi() {
  if (!ruleModeEl || !ruleIdleGroupEl) return;
  ruleIdleGroupEl.classList.toggle(
    'hidden',
    ruleModeEl.value !== AutoEndRules.RULE_MODE_IDLE
  );
}

function getRuleValidationMessage(matchType, pattern, mode, idleMinutes) {
  if (!pattern.trim()) return '請輸入規則內容。';

  if (!AutoEndRules.normalizePattern(matchType, pattern)) {
    if (matchType === AutoEndRules.MATCH_TYPE_URL) {
      return 'URL 規則需輸入完整的 http/https URL。';
    }
    return 'Domain / FQDN 規則只接受 host 名稱，請不要包含協定、路徑或查詢字串。';
  }

  if (mode === AutoEndRules.RULE_MODE_IDLE) {
    const parsed = Number.parseInt(idleMinutes, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 120) {
      return '自動關閉分鐘數需介於 1 到 120。';
    }
  }

  return '';
}

async function upsertAutoEndRule() {
  if (!ruleMatchTypeEl || !rulePatternEl || !ruleModeEl || !ruleIdleMinutesEl) return;

  const matchType = ruleMatchTypeEl.value;
  const pattern = rulePatternEl.value;
  const mode = ruleModeEl.value;
  const idleMinutes = ruleIdleMinutesEl.value;
  const validationMessage = getRuleValidationMessage(
    matchType,
    pattern,
    mode,
    idleMinutes
  );

  if (validationMessage) {
    alert(validationMessage);
    return;
  }

  const nextRule = AutoEndRules.createRule({
    matchType,
    pattern,
    mode,
    idleMinutes,
  });

  if (!nextRule) {
    alert('規則格式不正確，請重新確認。');
    return;
  }

  const currentRules = await AutoEndRules.ensureAutoEndRulesMigrated();
  const nextRules = currentRules.filter((rule) => rule.id !== nextRule.id);
  nextRules.push(nextRule);
  const normalizedRules = AutoEndRules.normalizeRules(nextRules);

  await chrome.storage.local.set({
    [AutoEndRules.AUTO_END_RULES_KEY]: normalizedRules,
  });

  renderRuleList(normalizedRules);
  rulePatternEl.value = '';
  if (nextRule.mode === AutoEndRules.RULE_MODE_IDLE) {
    ruleIdleMinutesEl.value = String(nextRule.idleMinutes);
  }
}

async function removeAutoEndRule(ruleId) {
  const currentRules = await AutoEndRules.ensureAutoEndRulesMigrated();
  const nextRules = currentRules.filter((rule) => rule.id !== ruleId);
  await chrome.storage.local.set({
    [AutoEndRules.AUTO_END_RULES_KEY]: nextRules,
  });
  renderRuleList(nextRules);
}

function setupRulesUI() {
  if (rulesToggleBtn && rulesContentEl) {
    rulesToggleBtn.addEventListener('click', () => {
      const isHidden = rulesContentEl.classList.toggle('hidden');
      rulesToggleBtn.textContent = isHidden ? '展開' : '收合';
      rulesToggleBtn.setAttribute('aria-expanded', String(!isHidden));
    });
  }

  ruleModeEl?.addEventListener('change', syncRuleModeUi);
  ruleAddBtn?.addEventListener('click', upsertAutoEndRule);
}

function showExtensionVersion() {
  const versionEl = document.getElementById('extension-version');
  if (!versionEl) return;
  try {
    const version = chrome.runtime.getManifest()?.version;
    versionEl.textContent = version ? `v${version}` : '';
  } catch {
    versionEl.textContent = '';
  }
}

function scheduleDeferredInit(autoEndTask) {
  const run = () => {
    loadShortcutInfo();
    applyAutoEndSettings(autoEndTask);
    syncRuleModeUi();
  };
  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(run, { timeout: 100 });
  } else {
    setTimeout(run, 0);
  }
}

function applyAutoEndSettings(autoEndTask) {
  const enabledEl = document.getElementById('auto-end-enabled');
  const minutesEl = document.getElementById('auto-end-minutes');
  if (!enabledEl || !minutesEl) return;
  const { enabled = false, idleMinutes = AutoEndRules.DEFAULT_IDLE_MINUTES } =
    autoEndTask || {};
  enabledEl.checked = enabled;
  minutesEl.value = AutoEndRules.clampIdleMinutes(idleMinutes);
}

function saveAutoEndSettings() {
  const enabledEl = document.getElementById('auto-end-enabled');
  const minutesEl = document.getElementById('auto-end-minutes');
  if (!enabledEl || !minutesEl) return;

  const idleMinutes = AutoEndRules.clampIdleMinutes(minutesEl.value);
  chrome.storage.local.set({
    autoEndTask: {
      enabled: enabledEl.checked,
      idleMinutes,
    },
  });

  if (enabledEl.checked && idleMinutes < 5) {
    alert('閒置分鐘數低於 5 分鐘可能導致分頁頻繁被釋放，請謹慎使用。');
  }
}

async function loadShortcutInfo() {
  const shortcutDisplay = document.getElementById('shortcut-display');
  if (!shortcutDisplay) return;
  try {
    const commands = await chrome.commands.getAll();
    const endTaskCmd = commands.find((command) => command.name === 'end-current-tab');
    shortcutDisplay.textContent = endTaskCmd?.shortcut
      ? `快捷鍵：${endTaskCmd.shortcut}`
      : '快捷鍵：未設定';
  } catch {
    shortcutDisplay.textContent = '快捷鍵：Ctrl+E (Cmd+E)';
  }
}

function openShortcutSettings() {
  const isEdge = navigator.userAgent.includes('Edg');
  const url = isEdge ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts';
  chrome.tabs.create({ url });
}

function handleTabListClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn || btn.disabled) return;

  const item = e.target.closest('.tab-item');
  if (!item) return;

  const tabId = parseInt(item.dataset.tabId, 10);
  switch (btn.dataset.action) {
    case 'restore':
      restoreTab(tabId, item);
      break;
    case 'end-task':
      chrome.tabs
        .get(tabId)
        .then((tab) => endTask(tabId, item, tab))
        .catch(() => {});
      break;
    default:
      break;
  }
}

function handleTabListChange(e) {
  const target = e.target;
  if (
    !target?.matches?.('[data-role="tab-policy-mode"], [data-role="tab-policy-idle"]')
  ) {
    return;
  }

  const item = target.closest('.tab-item');
  if (!item) return;

  const tabId = parseInt(item.dataset.tabId, 10);
  if (!Number.isFinite(tabId)) return;

  // When switching to custom idle, show input with current/default value before save.
  if (target.dataset.role === 'tab-policy-mode') {
    const idleInput = item.querySelector('[data-role="tab-policy-idle"]');
    if (idleInput) {
      const showIdle = target.value === AutoEndRules.RULE_MODE_IDLE;
      idleInput.classList.toggle('hidden', !showIdle);
      if (showIdle && !idleInput.value) {
        idleInput.value = String(AutoEndRules.DEFAULT_IDLE_MINUTES);
      }
    }
  }

  const policy = readTabPolicyFromItem(item);
  setTabPolicy(tabId, item, policy);
}

async function markItemsRevived(tabIds) {
  const idList = (tabIds || []).map(String).filter(Boolean);
  if (idList.length === 0) return;

  const tabPolicies = AutoEndRules.normalizeTabPolicies(
    await protectedTabStorage.getAll()
  );

  for (const id of idList) {
    const item = tabList.querySelector(`.tab-item[data-tab-id="${id}"]`);
    if (!item?.querySelector('.restore-btn')) continue;
    try {
      const tab = await chrome.tabs.get(Number(id));
      replaceTabItem(item, tab, {
        tabPolicy: tabPolicies[id] || null,
      });
    } catch {
      // Tab closed; ignore.
    }
  }
}

function setupTerminatedSyncListeners() {
  // Only react to our own storage removals (Restore); never auto-clear on process alive.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'session' && areaName !== 'local') return;
    const change = changes[AutoEndRules.TERMINATED_TABS_KEY];
    if (!change) return;

    const oldValue =
      change.oldValue && typeof change.oldValue === 'object' ? change.oldValue : {};
    const newValue =
      change.newValue && typeof change.newValue === 'object' ? change.newValue : {};
    const revivedIds = Object.keys(oldValue).filter((id) => !newValue[id]);
    if (revivedIds.length > 0) {
      DebugLog?.info('terminated storage removed', { revivedIds });
      markItemsRevived(revivedIds).catch(() => {});
    }
  });
}

function setupLogViewer() {
  const toggleBtn = document.getElementById('log-toggle');
  const panelEl = document.getElementById('log-panel');
  const viewerEl = document.getElementById('log-viewer');
  const countEl = document.getElementById('log-count');
  const copyBtn = document.getElementById('copy-debug-log');
  const clearBtn = document.getElementById('clear-debug-log');

  if (!toggleBtn || !panelEl || !viewerEl) return;

  let expanded = false;

  function renderLogLines(lineList) {
    const list = Array.isArray(lineList) ? lineList : [];
    if (countEl) countEl.textContent = String(list.length);
    if (!expanded) return;

    const wasNearBottom =
      viewerEl.scrollHeight - viewerEl.scrollTop - viewerEl.clientHeight < 40;
    viewerEl.textContent = list.length > 0 ? list.join('\n') : '';
    if (wasNearBottom || list.length === 0) {
      viewerEl.scrollTop = viewerEl.scrollHeight;
    }
  }

  toggleBtn.addEventListener('click', () => {
    expanded = !expanded;
    panelEl.classList.toggle('hidden', !expanded);
    toggleBtn.textContent = expanded ? '收合' : '展開';
    toggleBtn.setAttribute('aria-expanded', String(expanded));
    if (expanded) {
      renderLogLines(DebugLog?.getLines?.() || []);
    }
  });

  copyBtn?.addEventListener('click', async () => {
    try {
      await DebugLog.copy();
      const prev = copyBtn.textContent;
      copyBtn.textContent = '已複製';
      setTimeout(() => {
        copyBtn.textContent = prev || '複製';
      }, 1500);
    } catch (err) {
      alert(`複製 Log 失敗：${err.message}`);
    }
  });

  clearBtn?.addEventListener('click', () => {
    DebugLog?.clear();
    if (expanded) renderLogLines([]);
  });

  DebugLog?.subscribe?.((lineList) => {
    renderLogLines(lineList);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  showExtensionVersion();
  setupLogViewer();
  DebugLog?.info('popup open', {
    version: chrome.runtime.getManifest()?.version,
    hasProcesses: !!chrome.processes,
    backend: EndTaskCore.getReleaseBackend(),
  });

  AutoEndRules.ensureAutoEndRulesMigrated()
    .then(() => Promise.all([loadTabs(), loadAutoEndRules()]))
    .catch((err) => {
      DebugLog?.error('init failed', { message: String(err?.message || err) });
      showError(`初始化設定失敗：${err.message}`);
    });

  setupRulesUI();
  setupTerminatedSyncListeners();
  tabList.addEventListener('click', handleTabListClick);
  tabList.addEventListener('change', handleTabListChange);
  ruleListEl?.addEventListener('click', (e) => {
    const btn = e.target.closest('.rule-remove-btn');
    if (!btn?.dataset.ruleId) return;
    removeAutoEndRule(btn.dataset.ruleId);
  });
  document
    .getElementById('open-shortcut-settings')
    ?.addEventListener('click', openShortcutSettings);
  document.getElementById('auto-end-enabled')?.addEventListener('change', saveAutoEndSettings);
  document.getElementById('auto-end-minutes')?.addEventListener('change', saveAutoEndSettings);
  endTaskAllBtn?.addEventListener('click', endTaskAll);
  restoreAllBtn?.addEventListener('click', restoreAll);
});
