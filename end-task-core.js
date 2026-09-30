/**
 * Shared tab release helpers for popup and service worker.
 * Depends on: AutoEndRules and prefixTabTitleWithMarker.
 * Backend: terminate via chrome.processes when present, otherwise tabs.discard.
 */
(function () {
  const DEFAULT_CONCURRENCY = 4;
  /** Bound slow / hung Edge processes APIs so batch End Task cannot stall forever. */
  const PROCESS_API_TIMEOUT_MS = 2500;
  const RESOLVE_AFFECTED_TIMEOUT_MS = 400;
  const PREFIX_SINGLE_MS = 1000;
  const PREFIX_BATCH_PER_TAB_MS = 350;
  const PREFIX_BATCH_GROUP_MS = 700;
  const PROBE_STATE_ALIVE = 'alive';
  const PROBE_STATE_DEAD = 'dead';
  const PROBE_STATE_UNKNOWN = 'unknown';

  function isBuiltInPage(url) {
    return (
      url?.startsWith('chrome://') ||
      url?.startsWith('brave://') ||
      url?.startsWith('edge://')
    );
  }

  /**
   * Tabs to release from a tab-strip context menu click.
   * A highlighted set is used only when the clicked tab is part of it.
   */
  function tabsForContextMenuRelease(clickedTab, highlightedTabs) {
    if (clickedTab?.id == null) return [];
    const highlighted = Array.isArray(highlightedTabs) ? highlightedTabs : [];
    const inSelection = highlighted.some((tab) => tab?.id === clickedTab.id);
    const source = inSelection ? highlighted : [clickedTab];
    const seen = new Set();
    const targets = [];
    for (const tab of source) {
      if (tab?.id == null || seen.has(tab.id) || isBuiltInPage(tab.url)) continue;
      if (
        clickedTab.windowId != null &&
        tab.windowId != null &&
        tab.windowId !== clickedTab.windowId
      ) {
        continue;
      }
      seen.add(tab.id);
      targets.push(tab);
    }
    return targets;
  }

  function hasProcessesApi() {
    return typeof chrome !== 'undefined' && !!chrome.processes;
  }

  function getReleaseBackend() {
    return hasProcessesApi() ? 'terminate' : 'discard';
  }

  /**
   * Pick a same-window tab to receive focus before discarding an active tab.
   * Prefers the next live tab, then the previous live tab. Returns null when
   * there is no non-discarded sibling (caller should open a parking tab).
   */
  function pickFocusSuccessor(tab, windowTabs) {
    const tabId = tab?.id;
    const tabIndex = tab?.index ?? 0;
    const others = (windowTabs || [])
      .filter((item) => item?.id != null && item.id !== tabId)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const live = others.filter((item) => !item.discarded);
    if (live.length === 0) return null;

    const next = live.find((item) => (item.index ?? 0) > tabIndex);
    if (next) return next;
    const prev = [...live].reverse().find((item) => (item.index ?? 0) < tabIndex);
    return prev || live[0];
  }

  function wrapDiscardError(err, fallbackMessage) {
    const wrapped = err instanceof Error ? err : new Error(String(err || fallbackMessage));
    if (!wrapped.code) wrapped.code = 'DISCARD_FAILED';
    return wrapped;
  }

  function isProcessNotFoundError(err) {
    const message = String(err?.message || err || '').toLowerCase();
    return (
      message.includes('process not found') ||
      message.includes('no process') ||
      message.includes('invalid process') ||
      message.includes('could not find')
    );
  }

  function storedInfoFromTab(tab) {
    return {
      url: tab?.url,
      title: tab?.title,
    };
  }

  function normalizeProcessId(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function withTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`${label || 'Operation'} timed out`);
        err.code = 'TIMEOUT';
        reject(err);
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer != null) clearTimeout(timer);
    });
  }

  /**
   * Call chrome.processes methods with Promise + callback fallback (Edge Dev).
   * Some builds only settle via callback when a completion arg is provided.
   */
  function callProcessesMethod(methodName, args = []) {
    const fn = chrome.processes?.[methodName];
    if (typeof fn !== 'function') {
      return Promise.reject(new Error(`chrome.processes.${methodName} is not available`));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve(value);
      };

      let ret;
      try {
        ret = fn.call(chrome.processes, ...args, (value) => {
          const lastError = chrome.runtime?.lastError;
          if (lastError) {
            finish(new Error(lastError.message));
          } else {
            finish(null, value);
          }
        });
      } catch (err) {
        // Method may reject a trailing callback argument — retry without it.
        try {
          ret = fn.call(chrome.processes, ...args);
        } catch (err2) {
          finish(err2);
          return;
        }
      }

      if (ret != null && typeof ret.then === 'function') {
        ret.then(
          (value) => finish(null, value),
          (err) => finish(err)
        );
      }
    });
  }

  async function getProcessIdForTab(tabId) {
    const raw = await withTimeout(
      callProcessesMethod('getProcessIdForTab', [tabId]),
      PROCESS_API_TIMEOUT_MS,
      'getProcessIdForTab'
    );
    return normalizeProcessId(raw);
  }

  async function terminateProcess(processId) {
    const id = normalizeProcessId(processId);
    if (id == null) {
      const err = new Error('Invalid process id');
      err.code = 'TERMINATE_FAILED';
      throw err;
    }
    return withTimeout(
      callProcessesMethod('terminate', [id]),
      PROCESS_API_TIMEOUT_MS,
      'terminate'
    );
  }

  /**
   * Run async work over items with a concurrency limit.
   * @template T, R
   * @param {T[]} items
   * @param {number} limit
   * @param {(item: T, index: number) => Promise<R>} worker
   * @returns {Promise<R[]>}
   */
  async function runWithConcurrency(items, limit, worker) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return [];

    const concurrency = Math.max(1, Math.min(limit || DEFAULT_CONCURRENCY, list.length));
    const results = new Array(list.length);
    let nextIndex = 0;

    async function workerLoop() {
      while (nextIndex < list.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(list[index], index);
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => workerLoop()));
    return results;
  }

  async function getTabIdsForProcess(processId) {
    const id = normalizeProcessId(processId);
    if (id == null || typeof chrome.processes?.getProcessInfo !== 'function') {
      return null;
    }

    try {
      const info = await withTimeout(
        callProcessesMethod('getProcessInfo', [id, false]),
        RESOLVE_AFFECTED_TIMEOUT_MS,
        'getProcessInfo'
      );
      const processInfo = info?.[id] ?? info?.[String(id)];
      if (processInfo && Array.isArray(processInfo.tabs)) {
        return processInfo.tabs.map((tabId) => Number(tabId)).filter((n) => Number.isFinite(n));
      }
    } catch {
      // Fall through — caller uses known tabs.
    }
    return null;
  }

  function mergeTabsById(...tabLists) {
    const map = new Map();
    for (const list of tabLists) {
      for (const tab of list || []) {
        if (tab?.id != null) map.set(tab.id, tab);
      }
    }
    return Array.from(map.values());
  }

  async function resolveAffectedTabs(primaryTab, processId, allTabs, knownTabs = null) {
    const base =
      knownTabs && knownTabs.length > 0
        ? mergeTabsById(knownTabs, primaryTab ? [primaryTab] : [])
        : primaryTab
          ? [primaryTab]
          : [];

    const tabsById = new Map();
    for (const tab of allTabs || []) {
      if (tab?.id != null) tabsById.set(tab.id, tab);
    }
    for (const tab of base) {
      if (tab?.id != null) tabsById.set(tab.id, tab);
    }

    try {
      const fromProcessInfo = await getTabIdsForProcess(processId);
      if (fromProcessInfo && fromProcessInfo.length > 0) {
        const affected = [];
        for (const tabId of fromProcessInfo) {
          const tab = tabsById.get(tabId);
          if (tab) {
            affected.push(tab);
          } else {
            try {
              affected.push(await chrome.tabs.get(tabId));
            } catch {
              affected.push({ id: tabId, url: undefined, title: undefined });
            }
          }
        }
        return mergeTabsById(base, affected);
      }
    } catch {
      // Use base / scan fallback.
    }

    // Fallback: scan known tabs for the same process id (bounded).
    const affected = [...base];
    const seen = new Set(base.map((tab) => tab.id).filter((id) => id != null));
    const normalizedTarget = normalizeProcessId(processId);
    const scanTargets = (allTabs || []).filter(
      (tab) => tab?.id && !seen.has(tab.id) && !isBuiltInPage(tab.url)
    );

    await runWithConcurrency(scanTargets, DEFAULT_CONCURRENCY, async (tab) => {
      try {
        const pid = await getProcessIdForTab(tab.id);
        if (pid != null && pid === normalizedTarget) {
          seen.add(tab.id);
          affected.push(tab);
        }
      } catch {
        // Ignore tabs that cannot be inspected.
      }
    });
    return affected;
  }

  /**
   * Resolve co-process tabs without blocking terminate on a hung processes API.
   */
  async function resolveAffectedTabsBounded(primaryTab, processId, allTabs, knownTabs) {
    try {
      const resolved = await Promise.race([
        resolveAffectedTabs(primaryTab, processId, allTabs, knownTabs),
        new Promise((resolve) => {
          setTimeout(() => resolve(null), RESOLVE_AFFECTED_TIMEOUT_MS);
        }),
      ]);
      if (resolved && resolved.length > 0) {
        return mergeTabsById(knownTabs || [], primaryTab ? [primaryTab] : [], resolved);
      }
    } catch {
      // fall through
    }
    return mergeTabsById(knownTabs || [], primaryTab ? [primaryTab] : []);
  }

  function buildStoredEntries(tabs) {
    const entries = {};
    for (const tab of tabs || []) {
      if (tab?.id == null) continue;
      entries[String(tab.id)] = storedInfoFromTab(tab);
    }
    return entries;
  }

  async function ensureTerminated(processId, probeTabId) {
    const success = await terminateProcess(processId);
    if (success) return;

    // false may mean protected process, or process already exiting.
    const state = await probeTabProcess(probeTabId);
    if (state === PROBE_STATE_DEAD || state === PROBE_STATE_UNKNOWN) {
      // Gone or ambiguous after false — treat as terminated.
      return;
    }
    const err = new Error('Unable to terminate process');
    err.code = 'TERMINATE_FAILED';
    throw err;
  }

  /**
   * Best-effort title prefix before kill. Never throws; bounded wait.
   * @param {chrome.tabs.Tab[]} tabs
   * @param {{ perTabMs?: number, totalMs?: number }} [options]
   */
  async function prefixTabsBestEffort(tabs, options = {}) {
    if (typeof prefixTabTitleWithMarker !== 'function') return;
    const list = (tabs || []).filter((tab) => tab?.id && !isBuiltInPage(tab.url));
    if (list.length === 0) return;

    const perTabMs = options.perTabMs ?? PREFIX_BATCH_PER_TAB_MS;
    const totalMs = options.totalMs ?? PREFIX_BATCH_GROUP_MS;

    const work = Promise.all(
      list.map((tab) =>
        Promise.race([
          prefixTabTitleWithMarker(tab.id, tab.url, {
            maybeHasActiveTabAccess: !!tab.active,
          }),
          sleep(perTabMs),
        ]).catch(() => {})
      )
    );

    await Promise.race([work, sleep(totalMs)]).catch(() => {});
  }

  /**
   * Terminate a tab's renderer process and mark all tabs sharing that process.
   * @param {chrome.tabs.Tab} tab
   * @param {{
   *   maybeHasActiveTabAccess?: boolean,
   *   allTabs?: chrome.tabs.Tab[],
   *   terminatedStorage?: ReturnType<typeof AutoEndRules.getTerminatedTabsStorage>,
   * }} [options]
   */
  async function terminateTabProcess(tab, options = {}) {
    const {
      maybeHasActiveTabAccess = false,
      allTabs = null,
      terminatedStorage = AutoEndRules.getTerminatedTabsStorage(),
    } = options;

    if (!chrome.processes) {
      const err = new Error('chrome.processes API is not available');
      err.code = 'PROCESSES_UNAVAILABLE';
      throw err;
    }
    if (!tab?.id) {
      throw new Error('Invalid tab');
    }
    if (isBuiltInPage(tab.url)) {
      const err = new Error('Cannot terminate built-in pages');
      err.code = 'BUILT_IN_PAGE';
      throw err;
    }

    const targetTab = { ...tab, active: maybeHasActiveTabAccess || !!tab.active };
    await prefixTabsBestEffort([targetTab], {
      perTabMs: PREFIX_SINGLE_MS,
      totalMs: PREFIX_SINGLE_MS,
    });

    const tabsSnapshot = allTabs || (await chrome.tabs.query({}));
    let processId = null;
    let processAlreadyGone = false;

    try {
      processId = await getProcessIdForTab(tab.id);
      if (processId == null) {
        const err = new Error('No process id for tab');
        err.code = 'TERMINATE_FAILED';
        throw err;
      }
    } catch (err) {
      if (isProcessNotFoundError(err)) {
        processAlreadyGone = true;
      } else if (err?.code === 'TIMEOUT') {
        const err2 = new Error('Unable to resolve process for tab');
        err2.code = 'TERMINATE_FAILED';
        throw err2;
      } else {
        throw err;
      }
    }

    let affectedTabs;
    if (processAlreadyGone) {
      affectedTabs = [tab];
    } else {
      // Terminate first; resolve sibling tabs after so hung processInfo cannot block kill.
      await ensureTerminated(processId, tab.id);
      affectedTabs = await resolveAffectedTabsBounded(tab, processId, tabsSnapshot, [tab]);
    }

    /**
     * After a successful kill, always mark the primary tab terminated.
     * Edge often still returns a process id briefly (or an error-page renderer),
     * so filtering on "alive" right after terminate left the popup stuck on
     * "End Task" until a second click saw Process-not-found.
     * Markers stay until explicit Restore / Restore All (error-page processes
     * still look "alive" and must not auto-clear the terminated flag).
     */
    const storedEntries = buildStoredEntries(affectedTabs);
    storedEntries[String(tab.id)] = storedInfoFromTab(tab);

    // Co-process siblings only: drop confirmed-alive (primary always kept above).
    for (const sibling of affectedTabs || []) {
      if (!sibling?.id || sibling.id === tab.id) continue;
      const state = await probeTabProcess(sibling.id);
      if (state === PROBE_STATE_ALIVE) {
        delete storedEntries[String(sibling.id)];
      }
    }

    const deadIds = Object.keys(storedEntries).map((id) => Number(id));
    const deadTabs = (affectedTabs || [tab]).filter((t) => deadIds.includes(t.id));
    if (deadIds.includes(tab.id) && !deadTabs.some((t) => t.id === tab.id)) {
      deadTabs.push(tab);
    }

    if (Object.keys(storedEntries).length > 0) {
      await terminatedStorage.setEntries(storedEntries);
    }

    return {
      ok: true,
      processId,
      processAlreadyGone,
      terminatedTabIds: deadIds,
      affectedTabs: deadTabs,
      storedEntries,
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Probe whether a tab's renderer process is alive.
   * @param {number} tabId
   * @returns {Promise<'alive'|'dead'|'unknown'>}
   */
  async function probeTabProcess(tabId) {
    if (!chrome.processes || tabId == null) return PROBE_STATE_UNKNOWN;
    try {
      const processId = await getProcessIdForTab(tabId);
      return processId != null ? PROBE_STATE_ALIVE : PROBE_STATE_DEAD;
    } catch (err) {
      if (isProcessNotFoundError(err)) return PROBE_STATE_DEAD;
      return PROBE_STATE_UNKNOWN;
    }
  }

  /**
   * @param {number} tabId
   * @returns {Promise<boolean>} true only when process is confirmed alive
   */
  async function isTabProcessAlive(tabId) {
    return (await probeTabProcess(tabId)) === PROBE_STATE_ALIVE;
  }

  /**
   * Keep entries that are dead or unknown. Drop only confirmed-alive tabs
   * (failed kill or instant browser revive).
   */
  async function retainDeadTabEntries(entries) {
    const source =
      entries && typeof entries === 'object' && !Array.isArray(entries) ? entries : {};
    const ids = Object.keys(source);
    if (ids.length === 0) return {};

    const kept = {};
    await runWithConcurrency(ids, DEFAULT_CONCURRENCY, async (id) => {
      const state = await probeTabProcess(Number(id));
      if (state !== PROBE_STATE_ALIVE) kept[id] = source[id];
    });
    return kept;
  }

  /**
   * Classify tabs by process state after batch operations.
   * @param {chrome.tabs.Tab[]|number[]} tabsOrIds
   */
  async function verifyTabProcessStates(tabsOrIds) {
    const ids = [];
    for (const item of tabsOrIds || []) {
      const id = typeof item === 'number' ? item : item?.id;
      if (id != null && Number.isFinite(Number(id))) ids.push(Number(id));
    }
    const deadIds = [];
    const aliveIds = [];
    const unknownIds = [];
    await runWithConcurrency(ids, DEFAULT_CONCURRENCY, async (tabId) => {
      const state = await probeTabProcess(tabId);
      if (state === PROBE_STATE_ALIVE) aliveIds.push(tabId);
      else if (state === PROBE_STATE_DEAD) deadIds.push(tabId);
      else unknownIds.push(tabId);
    });
    return { deadIds, aliveIds, unknownIds };
  }

  /**
   * Detect tabs whose process is already gone and batch-mark them terminated.
   * @param {chrome.tabs.Tab[]} tabs
   * @param {Record<string, unknown>} alreadyTerminated
   * @param {ReturnType<typeof AutoEndRules.getTerminatedTabsStorage>} [terminatedStorage]
   */
  async function reconcileDeadTabs(tabs, alreadyTerminated = {}, terminatedStorage) {
    const storage = terminatedStorage || AutoEndRules.getTerminatedTabsStorage();
    if (!chrome.processes) {
      return { ...alreadyTerminated };
    }

    const liveCandidates = (tabs || []).filter(
      (tab) =>
        tab?.id &&
        !alreadyTerminated[String(tab.id)] &&
        !isBuiltInPage(tab.url)
    );

    const newlyDead = {};
    await runWithConcurrency(liveCandidates, DEFAULT_CONCURRENCY, async (tab) => {
      try {
        const processId = await getProcessIdForTab(tab.id);
        if (processId == null) {
          newlyDead[String(tab.id)] = storedInfoFromTab(tab);
        }
      } catch (err) {
        if (isProcessNotFoundError(err)) {
          newlyDead[String(tab.id)] = storedInfoFromTab(tab);
        }
      }
    });

    if (Object.keys(newlyDead).length > 0) {
      await storage.setEntries(newlyDead);
    }

    return { ...alreadyTerminated, ...newlyDead };
  }

  /**
   * Clear terminated markers for tabs whose renderer process is alive again
   * (user clicked tab / browser auto-reloaded after End Task).
   * @param {chrome.tabs.Tab[] | number[]} tabsOrIds
   * @param {Record<string, unknown>} alreadyTerminated
   * @param {ReturnType<typeof AutoEndRules.getTerminatedTabsStorage>} [terminatedStorage]
   * @returns {Promise<Record<string, unknown>>} remaining terminated map
   */
  async function reconcileRevivedTabs(
    tabsOrIds,
    alreadyTerminated = {},
    terminatedStorage
  ) {
    const storage = terminatedStorage || AutoEndRules.getTerminatedTabsStorage();
    const current =
      alreadyTerminated && typeof alreadyTerminated === 'object'
        ? { ...alreadyTerminated }
        : {};

    const candidateIds = [];
    if (Array.isArray(tabsOrIds)) {
      for (const item of tabsOrIds) {
        const id = typeof item === 'number' ? item : item?.id;
        if (id == null) continue;
        if (current[String(id)]) candidateIds.push(Number(id));
      }
    }

    // Also probe every id still marked terminated if list was empty of matches.
    if (candidateIds.length === 0) {
      for (const id of Object.keys(current)) {
        const n = Number(id);
        if (Number.isFinite(n)) candidateIds.push(n);
      }
    }

    if (candidateIds.length === 0 || !chrome.processes) {
      return current;
    }

    const revivedIds = [];
    await runWithConcurrency(candidateIds, DEFAULT_CONCURRENCY, async (tabId) => {
      if (!current[String(tabId)]) return;
      if (await isTabProcessAlive(tabId)) {
        revivedIds.push(tabId);
      }
    });

    if (revivedIds.length > 0) {
      await storage.removeEntries(revivedIds);
      for (const tabId of revivedIds) {
        delete current[String(tabId)];
      }
    }

    return current;
  }

  /**
   * If this tab is marked terminated but its process is live, clear the marker.
   * @returns {Promise<boolean>} true if cleared
   */
  async function clearTerminatedIfAlive(tabId, terminatedStorage) {
    if (tabId == null) return false;
    const storage = terminatedStorage || AutoEndRules.getTerminatedTabsStorage();
    const all = await storage.getAll();
    if (!all[String(tabId)]) return false;
    // Only clear on confirmed alive — unknown keeps the marker.
    if ((await probeTabProcess(tabId)) !== PROBE_STATE_ALIVE) return false;
    await storage.removeEntry(tabId);
    return true;
  }

  /**
   * Terminate many tabs; dedupes by process id and writes storage once per batch group.
   * @param {chrome.tabs.Tab[]} tabs
   * @param {{
   *   concurrency?: number,
   *   allTabs?: chrome.tabs.Tab[],
   *   terminatedStorage?: ReturnType<typeof AutoEndRules.getTerminatedTabsStorage>,
   *   onItemDone?: (result: object) => void,
   * }} [options]
   */
  async function terminateTabsBatch(tabs, options = {}) {
    const {
      concurrency = DEFAULT_CONCURRENCY,
      allTabs = null,
      terminatedStorage = AutoEndRules.getTerminatedTabsStorage(),
      onItemDone = null,
    } = options;

    if (!chrome.processes) {
      const err = new Error('chrome.processes API is not available');
      err.code = 'PROCESSES_UNAVAILABLE';
      throw err;
    }

    const tabsSnapshot = allTabs || (await chrome.tabs.query({}));
    const candidates = (tabs || []).filter((tab) => tab?.id && !isBuiltInPage(tab.url));
    if (candidates.length === 0) {
      return { terminatedTabIds: [], storedEntries: {}, results: [] };
    }

    // Resolve process ids first (limited concurrency).
    const tabMeta = await runWithConcurrency(candidates, concurrency, async (tab) => {
      try {
        const processId = await getProcessIdForTab(tab.id);
        if (processId == null) {
          return {
            tab,
            processId: null,
            dead: false,
            error: Object.assign(new Error('No process id for tab'), {
              code: 'TERMINATE_FAILED',
            }),
          };
        }
        return { tab, processId, dead: false };
      } catch (err) {
        if (isProcessNotFoundError(err)) {
          return { tab, processId: null, dead: true };
        }
        return { tab, processId: null, dead: false, error: err };
      }
    });

    const storedEntries = {};
    const terminatedTabIds = [];
    const results = [];

    // Already-dead tabs: mark without terminate.
    for (const meta of tabMeta) {
      if (!meta || meta.error) {
        if (meta?.error) {
          results.push({ tab: meta.tab, ok: false, error: meta.error });
        }
        continue;
      }
      if (meta.dead) {
        const entry = storedInfoFromTab(meta.tab);
        storedEntries[String(meta.tab.id)] = entry;
        terminatedTabIds.push(meta.tab.id);
        results.push({
          tab: meta.tab,
          ok: true,
          processAlreadyGone: true,
          terminatedTabIds: [meta.tab.id],
          storedEntries: { [String(meta.tab.id)]: entry },
        });
      }
    }

    // Group live tabs by process id (normalized number key).
    const byProcess = new Map();
    for (const meta of tabMeta) {
      if (!meta || meta.dead || meta.error || meta.processId == null) continue;
      const processId = normalizeProcessId(meta.processId);
      if (processId == null) continue;
      if (!byProcess.has(processId)) byProcess.set(processId, []);
      byProcess.get(processId).push(meta.tab);
    }

    // Terminate sequentially per process. Concurrent terminate + processInfo has hung on Edge Dev.
    const processGroups = Array.from(byProcess.entries());
    for (const [processId, groupTabs] of processGroups) {
      const primary = groupTabs[0];
      try {
        // Prefix before kill; the renderer cannot be scripted afterward.
        await prefixTabsBestEffort(groupTabs, {
          perTabMs: PREFIX_BATCH_PER_TAB_MS,
          totalMs: PREFIX_BATCH_GROUP_MS,
        });

        await ensureTerminated(processId, primary.id);

        const affectedTabs = await resolveAffectedTabsBounded(
          primary,
          processId,
          tabsSnapshot,
          groupTabs
        );

        // Always mark the whole group after successful terminate (same as single-tab).
        // Edge often still reports a process id / error-page renderer immediately after
        // kill — filtering those as "alive" caused empty terminatedTabIds, false
        // failure alerts, and Restore All finding nothing.
        const entries = buildStoredEntries(
          affectedTabs?.length ? affectedTabs : groupTabs
        );
        for (const t of groupTabs) {
          if (t?.id != null) entries[String(t.id)] = storedInfoFromTab(t);
        }

        Object.assign(storedEntries, entries);
        for (const id of Object.keys(entries)) {
          terminatedTabIds.push(Number(id));
        }

        if (globalThis.DebugLog) {
          globalThis.DebugLog.info('terminateTabsBatch group ok', {
            processId,
            tabIds: Object.keys(entries),
          });
        }

        const result = {
          tab: primary,
          ok: true,
          processId,
          terminatedTabIds: Object.keys(entries).map((id) => Number(id)),
          storedEntries: entries,
          affectedTabs,
        };
        results.push(result);
        if (onItemDone) onItemDone(result);
      } catch (err) {
        if (isProcessNotFoundError(err)) {
          const entries = buildStoredEntries(groupTabs);
          Object.assign(storedEntries, entries);
          for (const tab of groupTabs) terminatedTabIds.push(tab.id);
          const result = {
            tab: primary,
            ok: true,
            processAlreadyGone: true,
            terminatedTabIds: groupTabs.map((t) => t.id),
            storedEntries: entries,
          };
          results.push(result);
          if (onItemDone) onItemDone(result);
        } else {
          if (globalThis.DebugLog) {
            globalThis.DebugLog.error('terminateTabsBatch group fail', {
              processId,
              message: String(err?.message || err),
              code: err?.code,
            });
          }
          results.push({ tab: primary, ok: false, error: err });
          if (onItemDone) onItemDone({ tab: primary, ok: false, error: err });
        }
      }
    }

    const finalTerminatedIds = [...new Set(terminatedTabIds.filter((id) => id != null))];
    const finalEntries = {};
    for (const id of finalTerminatedIds) {
      const key = String(id);
      if (storedEntries[key]) finalEntries[key] = storedEntries[key];
    }

    if (Object.keys(finalEntries).length > 0) {
      await terminatedStorage.setEntries(finalEntries);
    }

    if (globalThis.DebugLog) {
      globalThis.DebugLog.info('terminateTabsBatch done', {
        terminatedCount: finalTerminatedIds.length,
        ok: results.filter((r) => r?.ok).length,
        fail: results.filter((r) => r && !r.ok).length,
      });
    }

    return {
      terminatedTabIds: finalTerminatedIds,
      storedEntries: finalEntries,
      results,
    };
  }

  async function markDiscardedTab(tab, terminatedStorage) {
    const storedEntries = buildStoredEntries([tab]);
    if (tab?.id != null) {
      storedEntries[String(tab.id)] = storedInfoFromTab(tab);
      await terminatedStorage.setEntries(storedEntries);
    }
    return storedEntries;
  }

  async function ensureTabNotActive(tab) {
    let current = tab;
    try {
      current = await chrome.tabs.get(tab.id);
    } catch {
      current = tab;
    }
    if (!current?.active) {
      return { tab: current, parkingTabId: null, focusedTabId: null };
    }

    const windowTabs = await chrome.tabs.query({ windowId: current.windowId });
    const successor = pickFocusSuccessor(current, windowTabs);
    if (successor?.id) {
      await chrome.tabs.update(successor.id, { active: true });
      return { tab: current, parkingTabId: null, focusedTabId: successor.id };
    }

    const parking = await chrome.tabs.create({
      windowId: current.windowId,
      active: true,
    });
    return {
      tab: current,
      parkingTabId: parking?.id ?? null,
      focusedTabId: parking?.id ?? null,
    };
  }

  /**
   * Unload a tab via chrome.tabs.discard. Switches focus first when needed.
   */
  async function discardTab(tab, options = {}) {
    const {
      terminatedStorage = AutoEndRules.getTerminatedTabsStorage(),
    } = options;

    if (!tab?.id) {
      throw new Error('Invalid tab');
    }
    if (isBuiltInPage(tab.url)) {
      const err = new Error('Cannot discard built-in pages');
      err.code = 'BUILT_IN_PAGE';
      throw err;
    }

    let current = tab;
    try {
      current = await chrome.tabs.get(tab.id);
    } catch (err) {
      throw wrapDiscardError(err, 'Tab not found');
    }

    if (current.discarded) {
      const storedEntries = await markDiscardedTab(current, terminatedStorage);
      return {
        ok: true,
        backend: 'discard',
        alreadyDiscarded: true,
        terminatedTabIds: [current.id],
        affectedTabs: [current],
        storedEntries,
      };
    }

    if (!options.skipTitlePrefix) {
      await prefixTabsBestEffort([current]);
    }
    await ensureTabNotActive(current);

    let latest = await chrome.tabs.get(current.id).catch(() => current);
    if (latest.active) {
      await sleep(50);
      latest = await chrome.tabs.get(current.id).catch(() => latest);
    }
    if (latest.active) {
      const err = new Error('Unable to discard the active tab');
      err.code = 'DISCARD_FAILED';
      throw err;
    }

    let discardedTab = null;
    try {
      discardedTab = await chrome.tabs.discard(current.id);
    } catch (err) {
      throw wrapDiscardError(err, 'Unable to discard tab');
    }

    const finalTab =
      discardedTab || (await chrome.tabs.get(current.id).catch(() => latest));
    if (!finalTab?.discarded) {
      const err = new Error('Unable to discard tab');
      err.code = 'DISCARD_FAILED';
      throw err;
    }

    const storedSource = {
      ...current,
      ...finalTab,
      url: current.url || finalTab.url,
      title: current.title || finalTab.title,
    };
    const storedEntries = await markDiscardedTab(storedSource, terminatedStorage);

    if (globalThis.DebugLog) {
      globalThis.DebugLog.info('discardTab ok', { tabId: current.id });
    }

    return {
      ok: true,
      backend: 'discard',
      terminatedTabIds: [current.id],
      affectedTabs: [finalTab],
      storedEntries,
    };
  }

  /**
   * Discard many tabs. Inactive tabs first so a later active-tab focus switch
   * does not wake a tab we just discarded.
   */
  async function discardTabsBatch(tabs, options = {}) {
    const {
      concurrency = DEFAULT_CONCURRENCY,
      terminatedStorage = AutoEndRules.getTerminatedTabsStorage(),
      onItemDone = null,
    } = options;

    const candidates = (tabs || []).filter((tab) => tab?.id && !isBuiltInPage(tab.url));
    if (candidates.length === 0) {
      return { terminatedTabIds: [], storedEntries: {}, results: [] };
    }

    const freshList = await runWithConcurrency(candidates, concurrency, async (tab) => {
      try {
        return await chrome.tabs.get(tab.id);
      } catch {
        return tab;
      }
    });

    // Prefix all titles once, before discarding the renderers.
    await prefixTabsBestEffort(freshList);

    const inactive = [];
    const active = [];
    for (const item of freshList.filter(Boolean)) {
      if (item.active && !item.discarded) active.push(item);
      else inactive.push(item);
    }

    const storedEntries = {};
    const terminatedTabIds = [];
    const results = [];

    async function discardOne(item) {
      try {
        const result = await discardTab(item, {
          terminatedStorage,
          skipTitlePrefix: true,
        });
        Object.assign(storedEntries, result.storedEntries);
        for (const id of result.terminatedTabIds || []) terminatedTabIds.push(id);
        results.push(result);
        if (onItemDone) onItemDone(result);
        return result;
      } catch (err) {
        if (globalThis.DebugLog) {
          globalThis.DebugLog.error('discardTabsBatch item fail', {
            tabId: item?.id,
            message: String(err?.message || err),
            code: err?.code,
          });
        }
        const fail = { tab: item, ok: false, error: err };
        results.push(fail);
        if (onItemDone) onItemDone(fail);
        return fail;
      }
    }

    await runWithConcurrency(inactive, concurrency, discardOne);
    for (const item of active) {
      await discardOne(item);
    }

    const finalTerminatedIds = [...new Set(terminatedTabIds.filter((id) => id != null))];
    const finalEntries = {};
    for (const id of finalTerminatedIds) {
      const key = String(id);
      if (storedEntries[key]) finalEntries[key] = storedEntries[key];
    }

    if (globalThis.DebugLog) {
      globalThis.DebugLog.info('discardTabsBatch done', {
        terminatedCount: finalTerminatedIds.length,
        ok: results.filter((item) => item?.ok).length,
        fail: results.filter((item) => item && !item.ok).length,
      });
    }

    return {
      terminatedTabIds: finalTerminatedIds,
      storedEntries: finalEntries,
      results,
    };
  }

  async function releaseTab(tab, options = {}) {
    if (getReleaseBackend() === 'discard') {
      return discardTab(tab, options);
    }
    return terminateTabProcess(tab, options);
  }

  async function releaseTabsBatch(tabs, options = {}) {
    if (getReleaseBackend() === 'discard') {
      return discardTabsBatch(tabs, options);
    }
    return terminateTabsBatch(tabs, options);
  }

  /**
   * Discard-mode only: drop markers for tabs the user already woke in the tab strip.
   */
  async function reconcileDiscardedTabs(
    tabs,
    alreadyTerminated = {},
    terminatedStorage
  ) {
    const storage = terminatedStorage || AutoEndRules.getTerminatedTabsStorage();
    const current =
      alreadyTerminated && typeof alreadyTerminated === 'object'
        ? { ...alreadyTerminated }
        : {};
    const tabById = new Map((tabs || []).map((item) => [String(item.id), item]));
    const revivedIds = [];

    for (const id of Object.keys(current)) {
      const item = tabById.get(id);
      if (!item) continue;
      if (!item.discarded) {
        revivedIds.push(Number(id));
        delete current[id];
      }
    }

    if (revivedIds.length > 0) {
      await storage.removeEntries(revivedIds);
    }
    return current;
  }

  globalThis.EndTaskCore = {
    DEFAULT_CONCURRENCY,
    PROBE_STATE_ALIVE,
    PROBE_STATE_DEAD,
    PROBE_STATE_UNKNOWN,
    buildStoredEntries,
    clearTerminatedIfAlive,
    discardTab,
    discardTabsBatch,
    getReleaseBackend,
    hasProcessesApi,
    isBuiltInPage,
    isProcessNotFoundError,
    isTabProcessAlive,
    pickFocusSuccessor,
    prefixTabsBestEffort,
    probeTabProcess,
    reconcileDiscardedTabs,
    reconcileDeadTabs,
    reconcileRevivedTabs,
    releaseTab,
    releaseTabsBatch,
    retainDeadTabEntries,
    runWithConcurrency,
    storedInfoFromTab,
    tabsForContextMenuRelease,
    terminateTabProcess,
    terminateTabsBatch,
    verifyTabProcessStates,
  };
})();
