// Test-only extension used by sleep.test.js. It runs the scenarios from inside
// the browser, so no DevTools-protocol client is attached: Playwright's CDP
// session makes Chromium crash right after a tab is discarded, which real
// users never hit.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - start > timeout) return v;
    await sleep(100);
  }
}

const discarded = async (id) => (await chrome.tabs.get(id)).discarded;

async function openTabs(base, names) {
  const tabs = [];
  for (const name of names) tabs.push(await chrome.tabs.create({ url: `${base}/page/${name}`, active: false }));
  await waitFor(async () => {
    const all = await Promise.all(tabs.map((t) => chrome.tabs.get(t.id)));
    return all.every((t) => t.status === 'complete');
  });
  return tabs;
}

async function collapseScenario(base) {
  const [keep, loose, g1, g2] = await openTabs(base, ['keep', 'loose', 'g1', 'g2']);
  const groupId = await chrome.tabs.group({ tabIds: [g1.id, g2.id] });
  await chrome.tabGroups.update(groupId, { title: 'Read later' });
  await chrome.tabs.update(keep.id, { active: true });
  await sleep(300);
  await chrome.tabGroups.update(groupId, { collapsed: true });
  const groupAsleep = await waitFor(async () => (await chrome.tabs.query({ groupId })).every((t) => t.discarded));
  return { groupAsleep: Boolean(groupAsleep), keep: await discarded(keep.id), loose: await discarded(loose.id) };
}

async function idleScenario(base, extId) {
  const [active, grouped, loose] = await openTabs(base, ['active', 'grouped', 'loose2']);
  await chrome.tabGroups.update(await chrome.tabs.group({ tabIds: [grouped.id] }), { title: 'Idle' });
  await chrome.tabs.update(active.id, { active: true });
  await sleep(300);
  // Ask the extension to run its idle check as if 31 minutes had passed (limit: 30).
  const { count } = await chrome.runtime.sendMessage(extId, { type: 'test:discardIdle', offsetMs: 31 * 60_000 });
  return { count, grouped: await discarded(grouped.id), loose: await discarded(loose.id), active: await discarded(active.id) };
}

(async () => {
  // sleep.test.js writes config.json (the test server's port) into a temp copy.
  const { port } = await (await fetch(chrome.runtime.getURL('config.json'))).json();
  const base = `http://127.0.0.1:${port}`;
  const report = (body) => fetch(`${base}/report`, { method: 'POST', body: JSON.stringify(body) });
  try {
    const ext = (await chrome.management.getAll()).find((e) => e.name === 'Tab Group Network Optimizer');
    await sleep(500); // let the extension finish its first sync
    const collapse = await collapseScenario(base);
    const idle = await idleScenario(base, ext.id);
    await report({ collapse, idle });
  } catch (err) {
    await report({ error: String(err?.stack || err) });
  }
})();
