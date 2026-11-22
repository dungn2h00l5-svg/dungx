// Pure logic shared by the service worker and the popup.
// Nothing in this file touches the `chrome.*` APIs, so it can be unit-tested in Node.

export const TAB_GROUP_ID_NONE = -1;

/** Optimizations applied to a group when it has no custom profile. */
export const DEFAULT_PROFILE = Object.freeze({
  blockTrackers: true,
  saveData: true,
  blockImages: false,
  blockMedia: false,
  blockFonts: false,
  blockThirdPartyFrames: false,
  discardOnCollapse: true,
  idleDiscardMinutes: 30, // 0 = never put idle tabs to sleep
});

export const IDLE_DISCARD_CHOICES = Object.freeze([0, 10, 30, 60, 120]);

/** Labels and help text for the popup, in display order. */
export const FEATURES = Object.freeze([
  {
    flag: 'blockTrackers',
    label: 'Chặn quảng cáo & theo dõi',
    hint: 'Không tải mã quảng cáo, đo lường từ khoảng 80 tên miền phổ biến.',
  },
  {
    flag: 'saveData',
    label: 'Gửi tín hiệu tiết kiệm dữ liệu (Save-Data)',
    hint: 'Báo cho trang web gửi bản nhẹ hơn, nếu trang có hỗ trợ.',
  },
  {
    flag: 'blockImages',
    label: 'Chặn hình ảnh',
    hint: 'Tiết kiệm nhiều nhất, nhưng trang sẽ không hiện ảnh.',
  },
  {
    flag: 'blockMedia',
    label: 'Chặn video & âm thanh',
    hint: 'Ngăn video tự phát ngốn băng thông.',
  },
  {
    flag: 'blockFonts',
    label: 'Chặn phông chữ web',
    hint: 'Dùng phông có sẵn trên máy thay vì tải về.',
  },
  {
    flag: 'blockThirdPartyFrames',
    label: 'Chặn khung nhúng từ trang khác',
    hint: 'Có thể làm hỏng video nhúng, captcha hoặc cổng thanh toán.',
  },
  {
    flag: 'discardOnCollapse',
    label: 'Ngủ đông khi thu gọn nhóm',
    hint: 'Tab ngừng mọi kết nối khi bạn thu gọn nhóm; bấm vào tab để tải lại.',
  },
]);

/** Resource types that get the `Save-Data: on` request header. */
export const SAVE_DATA_RESOURCE_TYPES = Object.freeze([
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'media',
  'object',
  'other',
]);

const BOOLEAN_FLAGS = Object.keys(DEFAULT_PROFILE).filter(
  (k) => typeof DEFAULT_PROFILE[k] === 'boolean',
);

function cleanProfile(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const flag of BOOLEAN_FLAGS) {
    if (typeof raw[flag] === 'boolean') out[flag] = raw[flag];
  }
  const minutes = Number(raw.idleDiscardMinutes);
  if (Number.isFinite(minutes) && minutes >= 0) out.idleDiscardMinutes = Math.round(minutes);
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  return out;
}

/** Fill missing fields and drop unknown ones from whatever is in storage. */
export function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const groupProfiles = {};
  if (s.groupProfiles && typeof s.groupProfiles === 'object') {
    for (const [key, profile] of Object.entries(s.groupProfiles)) {
      groupProfiles[key] = cleanProfile(profile);
    }
  }
  const defaults = { ...DEFAULT_PROFILE, ...cleanProfile(s.defaults) };
  delete defaults.enabled;
  return {
    applyToAllGroups: typeof s.applyToAllGroups === 'boolean' ? s.applyToAllGroups : true,
    defaults,
    groupProfiles,
  };
}

/**
 * Stable identity for a group. Chrome gives groups new numeric ids after a
 * restart, but keeps their titles, so titled groups keep their settings.
 */
export function groupKey(group) {
  const title = String(group?.title ?? '').trim().toLowerCase();
  return title ? `title:${title}` : `id:${group.id}`;
}

/** Effective profile for a group: its own override, else the defaults. */
export function resolveProfile(settings, key) {
  const base = { ...DEFAULT_PROFILE, ...settings.defaults };
  const override = settings.groupProfiles[key];
  if (override) return { ...base, enabled: true, ...override };
  return { ...base, enabled: Boolean(settings.applyToAllGroups) };
}

function sortedUnique(numbers) {
  return [...new Set(numbers)].sort((a, b) => a - b);
}

const RULE_FACTORIES = [
  {
    flag: 'blockTrackers',
    make: (tabIds, trackerDomains) =>
      trackerDomains.length
        ? {
            action: { type: 'block' },
            // No resourceTypes: matches everything except main_frame, so
            // typing a tracker URL in the address bar still works.
            condition: { requestDomains: [...trackerDomains], tabIds },
          }
        : null,
  },
  {
    flag: 'blockImages',
    make: (tabIds) => ({
      action: { type: 'block' },
      condition: { resourceTypes: ['image'], tabIds },
    }),
  },
  {
    flag: 'blockMedia',
    make: (tabIds) => ({
      action: { type: 'block' },
      condition: { resourceTypes: ['media'], tabIds },
    }),
  },
  {
    flag: 'blockFonts',
    make: (tabIds) => ({
      action: { type: 'block' },
      condition: { resourceTypes: ['font'], tabIds },
    }),
  },
  {
    flag: 'blockThirdPartyFrames',
    make: (tabIds) => ({
      action: { type: 'block' },
      condition: { resourceTypes: ['sub_frame'], domainType: 'thirdParty', tabIds },
    }),
  },
  {
    flag: 'saveData',
    make: (tabIds) => ({
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'Save-Data', operation: 'set', value: 'on' }],
      },
      condition: { resourceTypes: [...SAVE_DATA_RESOURCE_TYPES], tabIds },
    }),
  },
];

/**
 * Build declarativeNetRequest *session* rules (the only rule kind that accepts
 * `tabIds`). One rule per optimization, scoped to every tab whose group turns
 * that optimization on. Tabs outside any group are never listed, so they are
 * never touched.
 *
 * @param {{tabIds:number[], profile:object}[]} groups
 * @param {string[]} trackerDomains
 */
export function buildRules(groups, trackerDomains = []) {
  const rules = [];
  let id = 1;
  for (const { flag, make } of RULE_FACTORIES) {
    const tabIds = sortedUnique(
      groups
        .filter((g) => g.profile.enabled && g.profile[flag])
        .flatMap((g) => g.tabIds)
        .filter((tabId) => Number.isInteger(tabId) && tabId >= 0),
    );
    if (tabIds.length === 0) continue; // DNR rejects an empty tabIds list
    const rule = make(tabIds, trackerDomains);
    if (rule) rules.push({ id: id++, priority: 1, ...rule });
  }
  return rules;
}

/** Map tabId -> group key for tabs whose group is being optimized. */
export function buildTabMap(groups) {
  const map = {};
  for (const g of groups) {
    if (!g.profile.enabled) continue;
    for (const tabId of g.tabIds) map[tabId] = g.key;
  }
  return map;
}

/** A tab we may put to sleep without hurting what the user is doing. */
export function isDiscardable(tab) {
  const url = tab.url || tab.pendingUrl || '';
  return (
    !tab.active &&
    !tab.discarded &&
    !tab.audible &&
    !tab.pinned &&
    tab.autoDiscardable !== false &&
    /^https?:\/\//i.test(url)
  );
}

/** Tabs not looked at for `minutes` or more. */
export function pickIdleTabs(tabs, minutes, now = Date.now()) {
  if (!(minutes > 0)) return [];
  const limit = minutes * 60_000;
  return tabs.filter(
    (t) => isDiscardable(t) && typeof t.lastAccessed === 'number' && now - t.lastAccessed >= limit,
  );
}

export function emptyStats() {
  return { requests: 0, blocked: 0, bytes: 0 };
}

/** Add `delta` counters into `target` (mutates and returns target). */
export function mergeStats(target, delta) {
  for (const [key, d] of Object.entries(delta)) {
    const t = (target[key] ||= emptyStats());
    t.requests += d.requests || 0;
    t.blocked += d.blocked || 0;
    t.bytes += d.bytes || 0;
  }
  return target;
}

export function formatBytes(bytes) {
  if (!(bytes > 0)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}
