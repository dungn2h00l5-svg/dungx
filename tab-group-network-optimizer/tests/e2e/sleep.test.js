// "Sleep" (tab discard) tests, run WITHOUT Playwright.
//
// Playwright keeps a DevTools-protocol session on every tab, and with that
// session attached Chromium crashes right after a tab is discarded. Real
// browsers have no such session, so this test launches Chromium directly with
// the extension plus a small driver extension that runs the scenarios and
// reports over HTTP.
//
// The extension under test is a temp copy with one test-only listener appended
// (lets the driver trigger the idle check with a time offset). The shipped
// files are not modified.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(here, '../..');

const TEST_HOOK = `
// ---- test-only hook appended by tests/e2e/sleep.test.js ----
chrome.runtime.onMessageExternal.addListener((msg, _sender, send) => {
  if (msg?.type !== 'test:discardIdle') return false;
  globalThis.tgno.discardIdleTabs(Date.now() + msg.offsetMs).then((count) => send({ count }));
  return true;
});
`;

function chromePath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const { chromium } = createRequire(import.meta.url)('playwright');
  return chromium.executablePath();
}

let result;

test('run sleep scenarios in a real browser (no DevTools client attached)', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'tgno-sleep-'));
  const extCopy = path.join(tmp, 'ext');
  const driverDir = path.join(tmp, 'driver');
  cpSync(EXT_DIR, extCopy, { recursive: true, filter: (src) => !/[\\/](tests|node_modules|\.git)([\\/]|$)/.test(src) });
  appendFileSync(path.join(extCopy, 'src', 'background.js'), TEST_HOOK);
  cpSync(path.join(here, 'driver-ext'), driverDir, { recursive: true });

  let resolveReport;
  const reported = new Promise((r) => (resolveReport = r));
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url === '/report') resolveReport(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>${req.url}</title><p>${req.url}</p>`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(path.join(driverDir, 'config.json'), JSON.stringify({ port: server.address().port }));

  const exts = `${extCopy},${driverDir}`;
  const chrome = spawn(
    chromePath(),
    [
      '--headless=new',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-proxy-server',
      `--user-data-dir=${path.join(tmp, 'profile')}`,
      `--disable-extensions-except=${exts}`,
      `--load-extension=${exts}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  chrome.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((r) => chrome.on('exit', (code, signal) => r({ code, signal })));

  try {
    result = await Promise.race([
      reported,
      exited.then((e) => ({ crashed: e, log: stderr.split('\n').filter((l) => /SEGV|signal/.test(l)).join('\n') })),
      new Promise((_, reject) => setTimeout(() => reject(new Error('no report within 45s')), 45_000)),
    ]);
    assert.ok(!result.crashed, `Chromium exited early: ${JSON.stringify(result)}`);
    assert.ok(!result.error, result.error);
  } finally {
    chrome.kill('SIGKILL');
    await exited;
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('collapsing a group puts its tabs to sleep; tabs outside it stay awake', () => {
  assert.ok(result?.collapse, 'scenario ran');
  assert.equal(result.collapse.groupAsleep, true, 'tabs in the collapsed group are asleep');
  assert.equal(result.collapse.keep, false, 'active tab untouched');
  assert.equal(result.collapse.loose, false, 'background tab outside any group untouched');
});

test('idle grouped tabs are put to sleep; idle ungrouped and active tabs are not', () => {
  assert.ok(result?.idle, 'scenario ran');
  assert.ok(result.idle.count >= 1, `discarded ${result.idle.count}`);
  assert.equal(result.idle.grouped, true, 'idle grouped tab asleep');
  assert.equal(result.idle.loose, false, 'idle tab outside any group untouched');
  assert.equal(result.idle.active, false, 'active tab untouched');
});
