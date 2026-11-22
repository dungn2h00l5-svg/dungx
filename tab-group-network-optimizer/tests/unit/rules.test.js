import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_PROFILE,
  buildRules,
  buildTabMap,
  formatBytes,
  groupKey,
  isDiscardable,
  mergeStats,
  normalizeSettings,
  pickIdleTabs,
  resolveProfile,
} from '../../src/rules.js';
import { TRACKER_DOMAINS } from '../../src/trackers.js';

const on = (extra = {}) => ({ ...DEFAULT_PROFILE, enabled: true, ...extra });

test('groupKey uses the title so settings survive a restart, id when untitled', () => {
  assert.equal(groupKey({ id: 7, title: '  Work ' }), 'title:work');
  assert.equal(groupKey({ id: 7, title: '' }), 'id:7');
  assert.equal(groupKey({ id: 9 }), 'id:9');
});

test('normalizeSettings fills defaults and drops junk', () => {
  const s = normalizeSettings({
    applyToAllGroups: false,
    defaults: { blockImages: true, bogus: 1, enabled: false },
    groupProfiles: { 'title:a': { blockFonts: true, idleDiscardMinutes: '10', x: 2 } },
  });
  assert.equal(s.applyToAllGroups, false);
  assert.equal(s.defaults.blockImages, true);
  assert.equal(s.defaults.blockTrackers, true);
  assert.ok(!('bogus' in s.defaults));
  assert.ok(!('enabled' in s.defaults));
  assert.deepEqual(s.groupProfiles['title:a'], { blockFonts: true, idleDiscardMinutes: 10 });
  assert.equal(normalizeSettings(null).applyToAllGroups, true);
});

test('resolveProfile: applyToAllGroups decides groups without an override', () => {
  const all = normalizeSettings({});
  assert.equal(resolveProfile(all, 'title:x').enabled, true);
  const none = normalizeSettings({ applyToAllGroups: false });
  assert.equal(resolveProfile(none, 'title:x').enabled, false);
});

test('resolveProfile: a partial override keeps following the defaults', () => {
  const s = normalizeSettings({
    applyToAllGroups: false,
    defaults: { blockFonts: true },
    groupProfiles: { 'title:x': { blockImages: true } },
  });
  const p = resolveProfile(s, 'title:x');
  assert.equal(p.enabled, true);
  assert.equal(p.blockImages, true);
  assert.equal(p.blockFonts, true); // inherited from defaults
  const off = normalizeSettings({ groupProfiles: { 'title:x': { enabled: false } } });
  assert.equal(resolveProfile(off, 'title:x').enabled, false);
});

test('buildRules only lists tabs of enabled groups, one rule per feature', () => {
  const groups = [
    { tabIds: [5, 3], profile: on() },
    { tabIds: [8], profile: on({ blockImages: true, saveData: false }) },
    { tabIds: [11], profile: { ...on({ blockImages: true }), enabled: false } },
  ];
  const rules = buildRules(groups, TRACKER_DOMAINS);
  const byKind = Object.fromEntries(
    rules.map((r) => [r.action.type === 'modifyHeaders' ? 'saveData' : (r.condition.resourceTypes?.[0] ?? 'trackers'), r]),
  );

  assert.deepEqual(byKind.trackers.condition.tabIds, [3, 5, 8]);
  assert.deepEqual(byKind.trackers.condition.requestDomains, [...TRACKER_DOMAINS]);
  assert.deepEqual(byKind.image.condition.tabIds, [8]); // tab 11's group is off
  assert.deepEqual(byKind.saveData.condition.tabIds, [3, 5]);
  assert.deepEqual(byKind.saveData.action.requestHeaders, [{ header: 'Save-Data', operation: 'set', value: 'on' }]);
  assert.ok(!byKind.font && !byKind.media && !byKind.sub_frame);

  const ids = rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'rule ids are unique');
  assert.ok(ids.every((id) => Number.isInteger(id) && id >= 1));
  for (const r of rules) assert.ok(!r.condition.resourceTypes?.includes('main_frame') || r.action.type !== 'block');
});

test('buildRules never emits an empty tabIds list (DNR rejects it)', () => {
  assert.deepEqual(buildRules([], TRACKER_DOMAINS), []);
  assert.deepEqual(buildRules([{ tabIds: [], profile: on() }], TRACKER_DOMAINS), []);
  assert.deepEqual(buildRules([{ tabIds: [1], profile: { ...on(), enabled: false } }], TRACKER_DOMAINS), []);
  // no tracker list -> no tracker rule, other rules still built
  const rules = buildRules([{ tabIds: [1], profile: on() }], []);
  assert.deepEqual(rules.map((r) => r.action.type), ['modifyHeaders']);
});

test('third-party frame rule is scoped to thirdParty sub_frames', () => {
  const [rule] = buildRules([{ tabIds: [2], profile: on({ blockThirdPartyFrames: true, blockTrackers: false, saveData: false }) }]);
  assert.deepEqual(rule.condition, { resourceTypes: ['sub_frame'], domainType: 'thirdParty', tabIds: [2] });
});

test('tracker list is clean: lowercase, unique, no scheme or path', () => {
  assert.equal(new Set(TRACKER_DOMAINS).size, TRACKER_DOMAINS.length);
  for (const d of TRACKER_DOMAINS) assert.match(d, /^[a-z0-9.-]+\.[a-z]{2,}$/);
});

test('buildTabMap maps tabs of enabled groups to their key', () => {
  const map = buildTabMap([
    { key: 'title:a', tabIds: [1, 2], profile: on() },
    { key: 'title:b', tabIds: [3], profile: { ...on(), enabled: false } },
  ]);
  assert.deepEqual(map, { 1: 'title:a', 2: 'title:a' });
});

test('isDiscardable protects the tab you are using, audio, pinned and special pages', () => {
  const base = { active: false, discarded: false, audible: false, pinned: false, url: 'https://a.vn/' };
  assert.equal(isDiscardable(base), true);
  assert.equal(isDiscardable({ ...base, active: true }), false);
  assert.equal(isDiscardable({ ...base, discarded: true }), false);
  assert.equal(isDiscardable({ ...base, audible: true }), false);
  assert.equal(isDiscardable({ ...base, pinned: true }), false);
  assert.equal(isDiscardable({ ...base, autoDiscardable: false }), false);
  assert.equal(isDiscardable({ ...base, url: 'chrome://settings' }), false);
});

test('pickIdleTabs uses lastAccessed and ignores 0 minutes', () => {
  const now = 10_000_000;
  const tab = (id, minsAgo) => ({ id, url: 'https://x.vn', lastAccessed: now - minsAgo * 60_000 });
  const tabs = [tab(1, 5), tab(2, 31), tab(3, 120), { id: 4, url: 'https://x.vn' }];
  assert.deepEqual(pickIdleTabs(tabs, 30, now).map((t) => t.id), [2, 3]);
  assert.deepEqual(pickIdleTabs(tabs, 0, now), []);
});

test('mergeStats and formatBytes', () => {
  const s = mergeStats({ a: { requests: 1, blocked: 0, bytes: 10 } }, { a: { requests: 2, blocked: 1, bytes: 5 }, b: { blocked: 3 } });
  assert.deepEqual(s, { a: { requests: 3, blocked: 1, bytes: 15 }, b: { requests: 0, blocked: 3, bytes: 0 } });
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(25 * 1024 * 1024), '25 MB');
});
