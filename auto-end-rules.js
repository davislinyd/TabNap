(function () {
  const AUTO_END_RULES_KEY = 'autoEndRules';
  const LEGACY_WHITELIST_KEY = 'whitelist';
  const PROTECTED_TABS_KEY = 'protectedTabs';
  const TERMINATED_TABS_KEY = 'terminatedTabs';
  const DEFAULT_IDLE_MINUTES = 15;
  const RULE_MODE_NEVER = 'never';
  const RULE_MODE_IDLE = 'idle';
  const MATCH_TYPE_DOMAIN = 'domain';
  const MATCH_TYPE_FQDN = 'fqdn';
  const MATCH_TYPE_URL = 'url';
  const inMemoryStore = {};

  function hasSessionStorageSupport() {
    return !!chrome?.storage?.session;
  }

  function getEphemeralArea() {
    return chrome?.storage?.session || chrome?.storage?.local || null;
  }

  function createFallbackArea() {
    return {
      async get(key) {
        return { [key]: inMemoryStore[key] };
      },
      async set(entries) {
        Object.assign(inMemoryStore, entries);
      },
      async remove(key) {
        delete inMemoryStore[key];
      },
    };
  }

  /** Serializes async work in one JS context to avoid read-modify-write races. */
  function createMutex() {
    let chain = Promise.resolve();
    return function runExclusive(fn) {
      const run = chain.then(() => fn());
      chain = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    };
  }

  function createObjectStorage(area, key) {
    const targetArea = area || createFallbackArea();
    const runExclusive = createMutex();

    async function readAllUnlocked() {
      const result = await targetArea.get(key);
      const value = result?.[key];
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    async function writeAllUnlocked(data) {
      const nextData =
        data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      await targetArea.set({ [key]: nextData });
    }

    return {
      getAll() {
        return runExclusive(() => readAllUnlocked());
      },
      setAll(data) {
        return runExclusive(() => writeAllUnlocked(data));
      },
      setEntry(id, value) {
        return runExclusive(async () => {
          const current = await readAllUnlocked();
          current[String(id)] = value;
          await writeAllUnlocked(current);
        });
      },
      setEntries(entries) {
        return runExclusive(async () => {
          const current = await readAllUnlocked();
          if (entries && typeof entries === 'object') {
            for (const [id, value] of Object.entries(entries)) {
              current[String(id)] = value;
            }
          }
          await writeAllUnlocked(current);
        });
      },
      removeEntry(id) {
        return runExclusive(async () => {
          const current = await readAllUnlocked();
          delete current[String(id)];
          await writeAllUnlocked(current);
        });
      },
      removeEntries(ids) {
        return runExclusive(async () => {
          const current = await readAllUnlocked();
          for (const id of ids || []) {
            delete current[String(id)];
          }
          await writeAllUnlocked(current);
        });
      },
    };
  }

  function getTerminatedTabsStorage() {
    return createObjectStorage(getEphemeralArea(), TERMINATED_TABS_KEY);
  }

  function getProtectedTabsStorage() {
    return createObjectStorage(getEphemeralArea(), PROTECTED_TABS_KEY);
  }

  function clampIdleMinutes(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_IDLE_MINUTES;
    return Math.min(120, Math.max(1, parsed));
  }

  function parseMatchType(value) {
    if (
      value === MATCH_TYPE_DOMAIN ||
      value === MATCH_TYPE_FQDN ||
      value === MATCH_TYPE_URL
    ) {
      return value;
    }
    return null;
  }

  function parseRuleMode(value) {
    if (value === RULE_MODE_NEVER || value === RULE_MODE_IDLE) return value;
    return null;
  }

  function normalizePattern(matchType, pattern) {
    const parsedMatchType = parseMatchType(matchType);
    if (!parsedMatchType || typeof pattern !== 'string') return null;

    const trimmed = pattern.trim();
    if (!trimmed) return null;

    if (parsedMatchType === MATCH_TYPE_URL) {
      if (!/^https?:\/\//i.test(trimmed)) return null;
      try {
        const parsedUrl = new URL(trimmed);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) return null;
        return parsedUrl.toString();
      } catch {
        return null;
      }
    }

    const lowered = trimmed.toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
    if (
      !lowered ||
      lowered.includes('://') ||
      lowered.includes('/') ||
      lowered.includes('?') ||
      lowered.includes('#') ||
      /\s/.test(lowered)
    ) {
      return null;
    }

    return lowered;
  }

  function createRule(rawRule) {
    const matchType = parseMatchType(rawRule?.matchType);
    const mode = parseRuleMode(rawRule?.mode);
    const pattern = normalizePattern(matchType, rawRule?.pattern ?? '');
    if (!matchType || !mode || !pattern) return null;

    const rule = {
      id: `${matchType}:${pattern}`,
      matchType,
      pattern,
      mode,
    };

    if (mode === RULE_MODE_IDLE) {
      rule.idleMinutes = clampIdleMinutes(rawRule?.idleMinutes);
    }

    return rule;
  }

  function normalizeRules(rules) {
    const map = new Map();

    for (const rawRule of Array.isArray(rules) ? rules : []) {
      const rule = createRule(rawRule);
      if (!rule) continue;
      if (map.has(rule.id)) map.delete(rule.id);
      map.set(rule.id, rule);
    }

    return Array.from(map.values());
  }

  function isLegacyUrlPattern(pattern) {
    return typeof pattern === 'string' && /^https?:\/\//i.test(pattern.trim());
  }

  function migrateLegacyWhitelist(whitelist) {
    return normalizeRules(
      (Array.isArray(whitelist) ? whitelist : []).map((pattern) => ({
        matchType: isLegacyUrlPattern(pattern) ? MATCH_TYPE_URL : MATCH_TYPE_DOMAIN,
        pattern,
        mode: RULE_MODE_NEVER,
      }))
    );
  }

  function serializeRules(rules) {
    return JSON.stringify(normalizeRules(rules));
  }

  async function ensureAutoEndRulesMigrated() {
    const result = await chrome.storage.local.get([
      AUTO_END_RULES_KEY,
      LEGACY_WHITELIST_KEY,
    ]);

    const existingRules = normalizeRules(result?.[AUTO_END_RULES_KEY]);
    const legacyWhitelist = Array.isArray(result?.[LEGACY_WHITELIST_KEY])
      ? result[LEGACY_WHITELIST_KEY]
      : [];

    if (existingRules.length === 0 && legacyWhitelist.length > 0) {
      const migratedRules = migrateLegacyWhitelist(legacyWhitelist);
      await chrome.storage.local.set({ [AUTO_END_RULES_KEY]: migratedRules });
      await chrome.storage.local.remove(LEGACY_WHITELIST_KEY);
      return migratedRules;
    }

    const rawExistingRules = Array.isArray(result?.[AUTO_END_RULES_KEY])
      ? result[AUTO_END_RULES_KEY]
      : [];

    if (serializeRules(existingRules) !== JSON.stringify(rawExistingRules)) {
      await chrome.storage.local.set({ [AUTO_END_RULES_KEY]: existingRules });
    }

    if (legacyWhitelist.length > 0) {
      await chrome.storage.local.remove(LEGACY_WHITELIST_KEY);
    }

    return existingRules;
  }

  function parseHttpUrl(url) {
    try {
      const parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) return null;
      return parsedUrl;
    } catch {
      return null;
    }
  }

  function findMatchingRule(url, rules) {
    const parsedUrl = parseHttpUrl(url);
    if (!parsedUrl) return null;

    const normalizedRules = normalizeRules(rules);
    const href = parsedUrl.toString();
    const host = parsedUrl.hostname.toLowerCase();

    const urlMatches = normalizedRules
      .filter((rule) => rule.matchType === MATCH_TYPE_URL && href.startsWith(rule.pattern))
      .sort((a, b) => b.pattern.length - a.pattern.length);
    if (urlMatches.length > 0) return urlMatches[0];

    const fqdnMatches = normalizedRules.filter(
      (rule) => rule.matchType === MATCH_TYPE_FQDN && host === rule.pattern
    );
    if (fqdnMatches.length > 0) return fqdnMatches[0];

    const domainMatches = normalizedRules
      .filter(
        (rule) =>
          rule.matchType === MATCH_TYPE_DOMAIN &&
          (host === rule.pattern || host.endsWith(`.${rule.pattern}`))
      )
      .sort((a, b) => b.pattern.length - a.pattern.length);
    if (domainMatches.length > 0) return domainMatches[0];

    return null;
  }

  /**
   * Normalize a per-tab auto-end override.
   * Legacy: true → never. Structured: { mode: 'never' | 'idle', idleMinutes? }.
   * @returns {{ mode: 'never' } | { mode: 'idle', idleMinutes: number } | null}
   */
  function normalizeTabPolicy(value) {
    if (value === true) {
      return { mode: RULE_MODE_NEVER };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const mode = parseRuleMode(value.mode);
    if (mode === RULE_MODE_NEVER) {
      return { mode: RULE_MODE_NEVER };
    }
    if (mode === RULE_MODE_IDLE) {
      return {
        mode: RULE_MODE_IDLE,
        idleMinutes: clampIdleMinutes(value.idleMinutes),
      };
    }
    return null;
  }

  function normalizeTabPolicies(map) {
    const source =
      map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    const result = {};
    for (const [id, value] of Object.entries(source)) {
      const policy = normalizeTabPolicy(value);
      if (policy) result[String(id)] = policy;
    }
    return result;
  }

  function getTabPolicyLabel(policy) {
    const normalized = normalizeTabPolicy(policy);
    if (!normalized) return '';
    if (normalized.mode === RULE_MODE_NEVER) return 'Never Close';
    return `${normalized.idleMinutes} 分鐘`;
  }

  function resolveAutoEndPolicy(tab, rules, defaultIdleMinutes, protectedTabs) {
    const tabPolicy = normalizeTabPolicy(protectedTabs?.[String(tab?.id)]);
    if (tabPolicy?.mode === RULE_MODE_NEVER) {
      return { mode: RULE_MODE_NEVER, source: 'tab' };
    }
    if (tabPolicy?.mode === RULE_MODE_IDLE) {
      return {
        mode: RULE_MODE_IDLE,
        idleMinutes: clampIdleMinutes(tabPolicy.idleMinutes),
        source: 'tab',
      };
    }

    const matchedRule = findMatchingRule(tab?.url, rules);
    if (!matchedRule) {
      return {
        mode: RULE_MODE_IDLE,
        idleMinutes: clampIdleMinutes(defaultIdleMinutes),
        source: 'default',
      };
    }

    if (matchedRule.mode === RULE_MODE_NEVER) {
      return {
        mode: RULE_MODE_NEVER,
        source: 'rule',
        rule: matchedRule,
      };
    }

    return {
      mode: RULE_MODE_IDLE,
      idleMinutes: clampIdleMinutes(matchedRule.idleMinutes),
      source: 'rule',
      rule: matchedRule,
    };
  }

  function getRuleMatchLabel(matchType) {
    switch (matchType) {
      case MATCH_TYPE_DOMAIN:
        return 'Domain';
      case MATCH_TYPE_FQDN:
        return 'FQDN';
      case MATCH_TYPE_URL:
        return 'URL';
      default:
        return 'Rule';
    }
  }

  function getRuleModeLabel(rule) {
    if (rule?.mode === RULE_MODE_NEVER) return 'Never Close';
    return `${clampIdleMinutes(rule?.idleMinutes)} 分鐘後自動釋放`;
  }

  globalThis.AutoEndRules = {
    AUTO_END_RULES_KEY,
    DEFAULT_IDLE_MINUTES,
    LEGACY_WHITELIST_KEY,
    MATCH_TYPE_DOMAIN,
    MATCH_TYPE_FQDN,
    MATCH_TYPE_URL,
    PROTECTED_TABS_KEY,
    RULE_MODE_IDLE,
    RULE_MODE_NEVER,
    TERMINATED_TABS_KEY,
    clampIdleMinutes,
    createRule,
    ensureAutoEndRulesMigrated,
    findMatchingRule,
    getProtectedTabsStorage,
    getRuleMatchLabel,
    getRuleModeLabel,
    getTabPolicyLabel,
    getTerminatedTabsStorage,
    hasSessionStorageSupport,
    migrateLegacyWhitelist,
    normalizePattern,
    normalizeRules,
    normalizeTabPolicies,
    normalizeTabPolicy,
    resolveAutoEndPolicy,
  };
})();
