// End-to-end test: loads the unpacked extension into real Chromium, puts tabs
// into tab groups, and checks what actually reaches a local web server.
//
//   npm run test:e2e
//
// Needs Playwright with a Chromium build (set CHROMIUM_PATH to use a specific binary).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = 'site.test';
const TRACKER = 'doubleclick.net';

// ------------------------------------------------------------ test server

const hits = [];
let port;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  hits.push({
    host: url.hostname,
    path: url.pathname,
    run: url.searchParams.get('run'),
    saveData: req.headers['save-data'] ?? null,
  });
  const run = url.searchParams.get('run') ?? '';
  const send = (type, body) => {
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  switch (url.pathname) {
    case '/page':
      return send(
        'text/html; charset=utf-8',
        `<!doctype html><meta charset="utf-8"><title>run ${run}</title>
         <style>
           @font-face { font-family: Probe; src: url(/font.woff2?run=${run}) format('woff2'); }
           body { font-family: Probe, sans-serif; }
         </style>
         <p>Xin chào</p>
         <img src="/img.png?run=${run}" width="10" height="10">
         <script src="http://${TRACKER}:${port}/ad.js?run=${run}"></script>`,
      );
    case '/img.png':
      return send('image/png', 'x'.repeat(2000));
    case '/font.woff2':
      return send('font/woff2', 'x'.repeat(500));
    case '/ad.js':
      return send('text/javascript', '/* ad */');
    default:
      return send('text/html', `<!doctype html><title>${url.search}</title>blank`);
  }
});

const hitsFor = (run) => hits.filter((h) => h.run === String(run));
const has = (run, host, p) => hitsFor(run).some((h) => h.host === host && h.path === p);

// ---------------------------------------------------------- browser setup

let context;
let sw;
let userDataDir;
let runCounter = 0;

async function waitFor(fn, what, timeout = 5000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Open a new tab and return { page, tabId }. */
async function openTab() {
  const page = await context.newPage();
  const tag = `t${Math.random().toString(36).slice(2)}`;
  await page.goto(`http://${SITE}:${port}/blank?tag=${tag}`);
  const tabId = await waitFor(
    () => sw.evaluate(async (tag) => (await chrome.tabs.query({})).find((t) => t.url?.includes(tag))?.id, tag),
    'tab id',
  );
  return { page, tabId };
}

/** Load the probe page and return its run number. */
async function loadProbe(page) {
  const run = ++runCounter;
  await page.goto(`http://${SITE}:${port}/page?run=${run}`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 150));
  return run;
}

const sessionRules = () => sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules());

async function rulesSettled(predicate, what) {
  return waitFor(async () => predicate(await sessionRules()), what);
}

const tabCovered = (rules, tabId, pred = () => true) => rules.some((r) => pred(r) && r.condition.tabIds?.includes(tabId));
const isTrackerRule = (r) => Boolean(r.condition.requestDomains);
const isImageRule = (r) => r.condition.resourceTypes?.[0] === 'image';

async function setSettings(settings) {
  await sw.evaluate((s) => chrome.storage.local.set({ settings: s }), settings);
}

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  userDataDir = mkdtempSync(path.join(tmpdir(), 'tgno-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    deviceScaleFactor: process.env.SCREENSHOT ? 2 : 1,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      `--host-resolver-rules=MAP * 127.0.0.1`,
      '--no-proxy-server',
    ],
  });
  sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  await waitFor(() => sw.evaluate(() => typeof globalThis.tgno === 'object'), 'service worker ready');
});

after(async () => {
  await context?.close();
  server.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ tests

test('tab outside any group loads everything normally', async () => {
  const { page } = await openTab();
  const run = await loadProbe(page);
  assert.ok(has(run, TRACKER, '/ad.js'), 'tracker script loaded');
  assert.ok(has(run, SITE, '/img.png'), 'image loaded');
  assert.equal(hitsFor(run).find((h) => h.path === '/page').saveData, null, 'no Save-Data header');
  await page.close();
});

test('grouped tab: trackers blocked + Save-Data sent; ungrouped tab next to it untouched', async () => {
  const work = await openTab();
  const plain = await openTab();
  await sw.evaluate(async (tabId) => {
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, { title: 'Work', color: 'blue' });
  }, work.tabId);
  const rules = await rulesSettled((r) => tabCovered(r, work.tabId, isTrackerRule) && r, 'tracker rule for grouped tab');
  assert.ok(!tabCovered(rules, plain.tabId), 'ungrouped tab is in no rule');

  const run = await loadProbe(work.page);
  assert.ok(!has(run, TRACKER, '/ad.js'), 'tracker blocked in grouped tab');
  assert.ok(has(run, SITE, '/img.png'), 'images still load by default');
  assert.equal(hitsFor(run).find((h) => h.path === '/page').saveData, 'on');
  assert.equal(hitsFor(run).find((h) => h.path === '/img.png').saveData, 'on');

  const runPlain = await loadProbe(plain.page);
  assert.ok(has(runPlain, TRACKER, '/ad.js'), 'tracker still loads in ungrouped tab');
  assert.equal(hitsFor(runPlain).find((h) => h.path === '/page').saveData, null);

  // Stats are counted for the group.
  const stats = await waitFor(
    () => sw.evaluate(async () => (await chrome.storage.session.get('stats')).stats?.['title:work']),
    'stats for group',
  );
  assert.ok(stats.blocked >= 1, `blocked count ${stats.blocked}`);
  assert.ok(stats.requests >= 2, `request count ${stats.requests}`);
  assert.ok(stats.bytes >= 2000, `byte count ${stats.bytes}`);

  // Per-group profile: also block images and fonts for "Work".
  await setSettings({ applyToAllGroups: true, groupProfiles: { 'title:work': { blockImages: true, blockFonts: true } } });
  await rulesSettled((r) => tabCovered(r, work.tabId, isImageRule), 'image rule');
  const run2 = await loadProbe(work.page);
  assert.ok(!has(run2, SITE, '/img.png'), 'image blocked');
  assert.ok(!has(run2, SITE, '/font.woff2'), 'web font blocked');
  assert.ok(!has(run2, TRACKER, '/ad.js'), 'tracker still blocked');
  const run2plain = await loadProbe(plain.page);
  assert.ok(has(run2plain, SITE, '/img.png') && has(run2plain, SITE, '/font.woff2'), 'ungrouped tab keeps images & fonts');

  // Turning the group off removes every rule for it.
  await setSettings({ applyToAllGroups: true, groupProfiles: { 'title:work': { enabled: false } } });
  await rulesSettled((r) => !tabCovered(r, work.tabId), 'rules removed for disabled group');
  const run3 = await loadProbe(work.page);
  assert.ok(has(run3, TRACKER, '/ad.js'), 'tracker loads again when group is off');

  // Back on, then leave the group: the tab is no longer optimized.
  await setSettings({ applyToAllGroups: true, groupProfiles: {} });
  await rulesSettled((r) => tabCovered(r, work.tabId, isTrackerRule), 'rules back');
  await sw.evaluate((tabId) => chrome.tabs.ungroup(tabId), work.tabId);
  await rulesSettled((r) => !tabCovered(r, work.tabId), 'rules removed after ungroup');
  const run4 = await loadProbe(work.page);
  assert.ok(has(run4, TRACKER, '/ad.js'), 'tracker loads after leaving the group');

  await work.page.close();
  await plain.page.close();
});

test('applyToAllGroups=false: only groups switched on are optimized', async () => {
  const a = await openTab();
  const b = await openTab();
  await setSettings({ applyToAllGroups: false, groupProfiles: { 'title:news': { enabled: true } } });
  await sw.evaluate(
    async ([ta, tb]) => {
      await chrome.tabGroups.update(await chrome.tabs.group({ tabIds: [ta] }), { title: 'News' });
      await chrome.tabGroups.update(await chrome.tabs.group({ tabIds: [tb] }), { title: 'Shopping' });
    },
    [a.tabId, b.tabId],
  );
  const rules = await rulesSettled((r) => tabCovered(r, a.tabId, isTrackerRule) && r, 'News rules');
  assert.ok(!tabCovered(rules, b.tabId), 'Shopping group is not optimized');
  const runA = await loadProbe(a.page);
  const runB = await loadProbe(b.page);
  assert.ok(!has(runA, TRACKER, '/ad.js'));
  assert.ok(has(runB, TRACKER, '/ad.js'));
  await setSettings({ applyToAllGroups: true, groupProfiles: {} });
  await a.page.close();
  await b.page.close();
});

// Putting tabs to sleep (collapse / idle) is covered by sleep.test.js, which
// runs without Playwright: its DevTools session crashes Chromium on discard.

test('popup lists groups, shows stats and toggles a group', async () => {
  // Three demo groups: one customised, one switched off.
  const demo = [
    { title: 'Học tập', color: 'blue' },
    { title: 'Tin tức', color: 'red' },
    { title: 'Mua sắm', color: 'green' },
  ];
  await setSettings({
    applyToAllGroups: true,
    groupProfiles: { 'title:tin tức': { blockImages: true }, 'title:mua sắm': { enabled: false } },
  });
  for (const g of demo) {
    const tabs = [await openTab(), await openTab()];
    await sw.evaluate(
      async ({ ids, title, color }) => {
        await chrome.tabGroups.update(await chrome.tabs.group({ tabIds: ids }), { title, color });
      },
      { ids: tabs.map((t) => t.tabId), title: g.title, color: g.color },
    );
    g.tabs = tabs;
  }
  await rulesSettled((r) => tabCovered(r, demo[0].tabs[0].tabId, isTrackerRule), 'demo rules');
  for (const g of demo.slice(0, 2)) for (const t of g.tabs) await loadProbe(t.page);
  await waitFor(
    () => sw.evaluate(async () => (await chrome.storage.session.get('stats')).stats?.['title:tin tức']),
    'demo stats',
  );

  const extId = new URL(sw.url()).host;
  const page = await context.newPage();
  await page.setViewportSize({ width: 370, height: 600 });
  await page.goto(`chrome-extension://${extId}/popup/popup.html`);
  await page.waitForSelector('.group');
  const names = await page.$$eval('.group .name', (els) => els.map((e) => e.textContent));
  for (const g of demo) assert.ok(names.includes(g.title), `popup lists ${g.title}: ${names}`);
  assert.match(await page.textContent('#groupsHeading'), /2\/3/);
  const news = page.locator('.group', { hasText: 'Tin tức' });
  assert.match(await news.locator('.stats').textContent(), /Đã chặn [1-9]/);
  assert.equal(await news.locator('.tag').textContent(), 'riêng');

  // Switching "Học tập" off in the popup writes an override and drops its rules.
  const study = page.locator('.group', { hasText: 'Học tập' });
  await study.locator('input.switch').click();
  const override = await waitFor(
    () => sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.groupProfiles?.['title:học tập']),
    'override written',
  );
  assert.equal(override.enabled, false);
  await rulesSettled((r) => !tabCovered(r, demo[0].tabs[0].tabId), 'rules dropped for switched-off group');
  await study.locator('input.switch').click();
  await rulesSettled((r) => tabCovered(r, demo[0].tabs[0].tabId, isTrackerRule), 'rules back');

  if (process.env.SCREENSHOT) {
    await news.getByRole('button', { name: /Tùy chỉnh/ }).click();
    await page.screenshot({ path: process.env.SCREENSHOT, fullPage: true, scale: 'device' });
  }
  await page.close();
});
