// Service worker: keeps network rules in step with the tab groups.
//
// How it works
// 1. Every time a tab joins/leaves a group, a group is renamed, or the user
//    changes a setting, `syncRules()` rebuilds declarativeNetRequest session
//    rules whose `tabIds` list only the tabs inside optimized groups.
//    Tabs outside groups never appear in a rule, so they load normally.
// 2. Collapsing a group (or leaving a grouped tab unused) puts its tabs to
//    sleep with chrome.tabs.discard(), which closes all their connections.
// 3. A passive webRequest observer counts requests/bytes/blocked per group
//    for the popup.

import { TRACKER_DOMAINS } from './trackers.js';
import {
  TAB_GROUP_ID_NONE,
  buildRules,
  buildTabMap,
  emptyStats,
  groupKey,
  isDiscardable,
  mergeStats,
  normalizeSettings,
  pickIdleTabs,
  resolveProfile,
} from './rules.js';

const SYNC_DEBOUNCE_MS = 50;
const COLLAPSE_DISCARD_DELAY_MS = 400;
const STATS_FLUSH_MS = 1000;
const IDLE_ALARM = 'idle-discard';

// ---------------------------------------------------------------- settings

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return normalizeSettings(settings);
}

/** All groups (every window) with their tabs and effective profile. */
async function collectGroups(settings) {
  const [groups, tabs] = await Promise.all([chrome.tabGroups.query({}), chrome.tabs.query({})]);
  const tabsByGroup = new Map();
  for (const tab of tabs) {
    if (tab.groupId === TAB_GROUP_ID_NONE) continue;
    if (!tabsByGroup.has(tab.groupId)) tabsByGroup.set(tab.groupId, []);
    tabsByGroup.get(tab.groupId).push(tab);
  }
  return groups.map((group) => {
    const key = groupKey(group);
    const groupTabs = tabsByGroup.get(group.id) || [];
    return {
      id: group.id,
      key,
      group,
      tabs: groupTabs,
      tabIds: groupTabs.map((t) => t.id),
      profile: resolveProfile(settings, key),
    };
  });
}

// ------------------------------------------------------------- rule sync

let syncTimer = null;
let syncChain = Promise.resolve();
let tabMapCache = null;

async function syncRules() {
  const settings = await getSettings();
  const groups = await collectGroups(settings);
  const addRules = buildRules(groups, TRACKER_DOMAINS);
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules,
  });
  tabMapCache = buildTabMap(groups);
  await chrome.storage.session.set({ tabMap: tabMapCache });
  return addRules;
}

/** Run a sync now, after any sync already in flight. */
function syncNow() {
  clearTimeout(syncTimer);
  syncTimer = null;
  const run = syncChain.then(syncRules);
  syncChain = run.catch((err) => console.error('[TGNO] sync failed', err));
  return run;
}

/** Coalesce bursts of tab events into one sync. */
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, SYNC_DEBOUNCE_MS);
}

// ------------------------------------------------------------ discarding

async function discardTabs(tabs) {
  let count = 0;
  for (const tab of tabs) {
    if (!isDiscardable(tab)) continue;
    try {
      await chrome.tabs.discard(tab.id);
      count++;
    } catch {
      // Tab closed or not discardable right now; skip it.
    }
  }
  return count;
}

async function discardGroup(groupId) {
  const tabs = await chrome.tabs.query({ groupId });
  return discardTabs(tabs);
}

async function onGroupCollapsed(groupId) {
  // Wait for Chrome to move focus out of the collapsed group first.
  await new Promise((r) => setTimeout(r, COLLAPSE_DISCARD_DELAY_MS));
  let group;
  try {
    group = await chrome.tabGroups.get(groupId);
  } catch {
    return 0; // group was closed meanwhile
  }
  if (!group.collapsed) return 0;
  const profile = resolveProfile(await getSettings(), groupKey(group));
  if (!profile.enabled || !profile.discardOnCollapse) return 0;
  return discardGroup(groupId);
}

async function discardIdleTabs(now = Date.now()) {
  const groups = await collectGroups(await getSettings());
  let count = 0;
  for (const g of groups) {
    if (!g.profile.enabled) continue;
    count += await discardTabs(pickIdleTabs(g.tabs, g.profile.idleDiscardMinutes, now));
  }
  return count;
}

async function ensureAlarm() {
  const alarm = await chrome.alarms.get(IDLE_ALARM);
  if (!alarm) await chrome.alarms.create(IDLE_ALARM, { periodInMinutes: 1 });
}

// ----------------------------------------------------------------- stats

let pendingStats = {};
let flushTimer = null;

async function getTabMap() {
  if (!tabMapCache) {
    const { tabMap } = await chrome.storage.session.get('tabMap');
    tabMapCache = tabMap || {};
  }
  return tabMapCache;
}

async function flushStats() {
  flushTimer = null;
  const delta = pendingStats;
  pendingStats = {};
  if (Object.keys(delta).length === 0) return;
  const { stats } = await chrome.storage.session.get('stats');
  await chrome.storage.session.set({ stats: mergeStats(stats || {}, delta) });
}

function record(tabId, field, amount) {
  if (tabId < 0) return; // not from a tab (service workers, extensions, ...)
  getTabMap().then((map) => {
    const key = map[tabId];
    if (!key) return; // tab is not in an optimized group
    const s = (pendingStats[key] ||= emptyStats());
    s[field] += amount;
    if (!flushTimer) flushTimer = setTimeout(flushStats, STATS_FLUSH_MS);
  });
}

function contentLength(headers = []) {
  const h = headers.find((x) => x.name.toLowerCase() === 'content-length');
  const n = Number(h?.value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

chrome.webRequest.onCompleted.addListener(
  (d) => {
    record(d.tabId, 'requests', 1);
    if (!d.fromCache) record(d.tabId, 'bytes', contentLength(d.responseHeaders));
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

chrome.webRequest.onErrorOccurred.addListener(
  (d) => {
    if (d.error === 'net::ERR_BLOCKED_BY_CLIENT') record(d.tabId, 'blocked', 1);
  },
  { urls: ['<all_urls>'] },
);

// ------------------------------------------------------------- listeners

chrome.tabs.onCreated.addListener((tab) => {
  // A link opened from a grouped tab is born inside the group: protect it fast.
  if (tab.groupId !== TAB_GROUP_ID_NONE) syncNow();
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if ('groupId' in changeInfo) scheduleSync();
});
chrome.tabs.onRemoved.addListener(scheduleSync);
chrome.tabs.onReplaced.addListener(scheduleSync);
chrome.tabs.onAttached.addListener(scheduleSync);

chrome.tabGroups.onCreated.addListener(scheduleSync);
chrome.tabGroups.onRemoved.addListener(scheduleSync);
chrome.tabGroups.onUpdated.addListener((group) => {
  scheduleSync(); // the title (and so the settings key) may have changed
  if (group.collapsed) onGroupCollapsed(group.id);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) scheduleSync();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === IDLE_ALARM) discardIdleTabs();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    discardGroup: () => discardGroup(msg.groupId).then((discarded) => ({ discarded })),
    resetStats: () => chrome.storage.session.set({ stats: {} }).then(() => ({ ok: true })),
    syncNow: () => syncNow().then((rules) => ({ rules: rules.length })),
  };
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler()
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String(err) }));
  return true; // keep the channel open for the async answer
});

async function init() {
  // Show "number of blocked requests in this tab" on the toolbar icon.
  await chrome.declarativeNetRequest.setExtensionActionOptions({
    displayActionCountAsBadgeText: true,
  });
  await ensureAlarm();
  await syncNow();
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
// Session rules survive a service-worker restart, but re-check on wake-up anyway.
ensureAlarm();

// Handy from the service-worker DevTools console (and used by the e2e tests).
globalThis.tgno = { syncNow, discardGroup, discardIdleTabs, flushStats, getSettings };
