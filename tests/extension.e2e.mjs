/* Optional real MV3 smoke test. Requires an existing Playwright/browser install.
 * Uses a fresh temporary browser profile and mock X responses; no X login or data.
 * Run with the Codex bundled Node executable. Override BLUE_FRIENDS_PLAYWRIGHT
 * and BLUE_FRIENDS_BROWSER for another already-installed runtime/browser.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const modulePath = process.env.BLUE_FRIENDS_PLAYWRIGHT || 'playwright';
const { chromium } = require(modulePath);
const extensionPath = resolve(fileURLToPath(new URL('../extension/', import.meta.url)));
const installedChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.BLUE_FRIENDS_BROWSER ||
  (existsSync(chromium.executablePath()) ? chromium.executablePath() : installedChrome);
if (!existsSync(executablePath)) throw new Error('No existing Chrome/Chromium executable is available; this test does not install a browser.');

const profilePayload = { data: { user: { result: {
  rest_id: '42', is_blue_verified: true,
  core: { screen_name: 'demo', name: '模拟 Premium 主页' },
  relationship_counts: { followers: 100, following: 20 },
} } } };
const listEntries = Array.from({ length: 25 }, (_, index) => ({
    entryId: `user-${1000 + index}`,
    content: { __typename: 'TimelineTimelineItem', itemContent: {
      __typename: 'TimelineUser', user_results: { result: {
        rest_id: String(1000 + index), is_blue_verified: false,
        core: { screen_name: `friend${index + 1}`, name: `模拟好友 ${index + 1}` },
        relationship_counts: { followers: 100, following: 81 + index },
      } },
    } },
  }));
const timelinePayload = entries => ({ data: { user: { result: { timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } } } });
const firstListPayload = timelinePayload([
  ...listEntries.slice(0, 8),
  { entryId: 'cursor-bottom', content: { __typename: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'mock-next' } },
]);
const nextListPayload = timelinePayload(listEntries.slice(8));

const endpoint = (operation, variables) => `/i/api/graphql/mock-query/${operation}?variables=${encodeURIComponent(JSON.stringify(variables))}`;
function mockHTML(path) {
  const scan = path === '/demo/verified_followers';
  const url = scan ? endpoint('BlueVerifiedFollowers', { userId: '42' }) : endpoint('UserByScreenName', { screen_name: 'demo' });
  const onScroll = scan ? `let requestedNext=false;window.addEventListener('scroll',()=>{if(!requestedNext&&window.scrollY>0){requestedNext=true;fetch(${JSON.stringify(endpoint('BlueVerifiedFollowers', { userId: '42', cursor: 'mock-next' }))}).then(response=>response.json());}});` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Mock X</title><style>body{font-family:system-ui;margin:0;background:#fff;color:#0f1419}main{width:600px;margin:0 auto}[data-testid="primaryColumn"]{min-height:100vh;border:1px solid #eff3f4}.profile{padding:24px}a{color:#0f1419;text-decoration:none}</style></head><body><main><div data-testid="primaryColumn"><div class="profile"><div data-testid="UserName"><h1>模拟 Premium 主页</h1><p>@demo</p></div><div data-testid="UserProfileHeader_Items"><a href="/demo/following">20 正在关注</a> · <a href="/demo/followers">100 关注者</a></div></div>${scan ? '<div style="height:4000px">模拟认证关注者列表</div>' : ''}</div></main><script>${onScroll}fetch(${JSON.stringify(url)}).then(response=>response.json());</script></body></html>`;
}

async function until(read, predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await read();
    if (predicate(latest)) return latest;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: ${JSON.stringify(latest)}`);
}

function descendants(node) {
  return [node, ...(node.children || []).flatMap(descendants), ...(node.shadowRoots || []).flatMap(descendants)];
}
const attributes = node => Object.fromEntries(Array.from({ length: (node.attributes || []).length / 2 }, (_, index) => [node.attributes[index * 2], node.attributes[index * 2 + 1]]));

const profileDir = await mkdtemp(join(tmpdir(), 'blue-friends-mv3-'));
let context;
let fixtureServer;
try {
  // Chrome-created tabs can navigate before Playwright's target interception is
  // attached. A local HTTPS fixture plus DNS mapping covers even that first load.
  const keyPath = join(profileDir, 'fixture-key.pem');
  const certPath = join(profileDir, 'fixture-cert.pem');
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', keyPath, '-out', certPath, '-subj', '/CN=x.com'], { stdio: 'ignore' });
  const publicKey = execFileSync('/usr/bin/openssl', ['x509', '-pubkey', '-noout', '-in', certPath]);
  const publicKeyDER = execFileSync('/usr/bin/openssl', ['pkey', '-pubin', '-outform', 'DER'], { input: publicKey });
  const fixtureSPKI = createHash('sha256').update(publicKeyDER).digest('base64');
  fixtureServer = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (request, response) => {
    const url = new URL(request.url, 'https://x.com');
    let body;
    let contentType;
    if (/\/UserByScreenName$/.test(url.pathname)) {
      contentType = 'application/json';
      body = JSON.stringify(profilePayload);
    } else if (/\/BlueVerifiedFollowers$/.test(url.pathname)) {
      contentType = 'application/json';
      const variables = JSON.parse(url.searchParams.get('variables'));
      body = JSON.stringify(variables.cursor === 'mock-next' ? nextListPayload : firstListPayload);
    } else if (['/demo', '/demo/verified_followers'].includes(url.pathname)) {
      contentType = 'text/html; charset=utf-8';
      body = mockHTML(url.pathname);
    } else {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    fixtureServer.once('error', reject);
    fixtureServer.listen(0, '127.0.0.1', resolve);
  });
  const fixturePort = fixtureServer.address().port;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath, channel: 'chromium', headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        '--disable-background-networking', '--disable-component-update', '--no-first-run',
        '--no-proxy-server', `--ignore-certificate-errors-spki-list=${fixtureSPKI}`,
        `--host-resolver-rules=MAP x.com 127.0.0.1:${fixturePort}, MAP * ~NOTFOUND`,
        // Debugging is limited to this disposable profile and Playwright's pipe.
        '--enable-unsafe-extension-debugging',
      ],
      viewport: { width: 1100, height: 1000 },
    });
  } catch (error) {
    throw new Error(`MV3_BROWSER_START_UNAVAILABLE: The isolated test browser could not start. ${String(error.message).split('\n')[0]}`);
  }
  let extensionId;
  let loaderCDP;
  let worker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension://'));
  if (!worker) {
    // Branded Chrome 137+ removed --load-extension; use its supported test API.
    loaderCDP = await context.browser().newBrowserCDPSession();
    // Keep this session alive: debug-installed extensions belong to its lifetime.
    ({id: extensionId} = await loaderCDP.send('Extensions.loadUnpacked', {path: extensionPath, enableInIncognito: false}));
    worker = context.serviceWorkers().find(item => item.url().startsWith('chrome-extension://'));
  }
  // Dynamic test installation completes asynchronously. Wait for the worker
  // before navigating so document_start injection is already registered.
  if (!worker) {
    try { worker = await context.waitForEvent('serviceworker', { timeout: 10000, predicate: item => item.url().startsWith('chrome-extension://') }); }
    catch {
      const version = context.browser()?.version() || 'unknown';
      const diagnostics = loaderCDP || await context.browser().newBrowserCDPSession();
      const installed = await diagnostics.send('Extensions.getExtensions');
      const targets = await diagnostics.send('Target.getTargets');
      await diagnostics.detach();
      throw new Error(`MV3_EXTENSION_LOAD_UNAVAILABLE: Chrome ${version}; ${JSON.stringify({extensionId, installed, targets:targets.targetInfos.map(({type,url})=>({type,url}))})}`);
    }
  }
  extensionId ||= new URL(worker.url()).hostname;
  if (process.env.BLUE_FRIENDS_E2E_DEBUG) {
    await worker.evaluate(() => {
      globalThis.__e2eMessages = [];
      chrome.runtime.onMessage.addListener((message, sender) => {
        globalThis.__e2eMessages.push({ type: message?.type, id: sender.id, url: sender.url, frameId: sender.frameId, tabId: sender.tab?.id });
      });
    });
  }
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  if (process.env.BLUE_FRIENDS_E2E_DEBUG) {
    page.on('pageerror', error => console.log('PAGE_ERROR', error.message));
    page.on('console', message => { if (message.type() === 'error') console.log('PAGE_CONSOLE_ERROR', message.text()); });
  }
  await page.goto('https://x.com/demo');
  if (process.env.BLUE_FRIENDS_E2E_DEBUG) {
    const debugCDP = await context.newCDPSession(page);
    const executionContexts = [];
    debugCDP.on('Runtime.executionContextCreated', event => executionContexts.push(event.context));
    await debugCDP.send('Runtime.enable');
    const worlds = [];
    for (const executionContext of executionContexts) {
      const evaluated = await debugCDP.send('Runtime.evaluate', { contextId: executionContext.id, expression: 'JSON.stringify({core:!!globalThis.BlueFriendsCore,view:!!globalThis.BlueFriendsView,scanner:!!globalThis.BlueFriendsScanner,chromeId:globalThis.chrome?.runtime?.id})' });
      worlds.push({ name: executionContext.name, origin: executionContext.origin, data: evaluated.result.value });
    }
    console.log('WORLD_DIAGNOSTICS', JSON.stringify(worlds));
    console.log('MESSAGE_DIAGNOSTICS', JSON.stringify(await worker.evaluate(() => globalThis.__e2eMessages)));
  }
  let state;
  try {
    state = await until(
      () => worker.evaluate(() => chrome.storage.session.get('radarState')),
      saved => saved.radarState?.jobs?.some(job => job.handle === 'demo' && job.status === 'complete'),
      'The real service worker did not complete the mock scan',
    );
  } catch (error) {
    if (process.env.BLUE_FRIENDS_E2E_DEBUG) {
      for (const candidate of context.pages()) {
        console.log('PAGE_DIAGNOSTICS', JSON.stringify(await candidate.evaluate(() => ({ url: location.href, title: document.title, body: document.body?.innerText.slice(0, 100), hasCore: !!globalThis.BlueFriendsCore, bridgeInstalled: !!globalThis.__blueFriendsBridgeInstalled })).catch(failure => ({ error: failure.message }))));
      }
      console.log('MESSAGE_DIAGNOSTICS', JSON.stringify(await worker.evaluate(() => globalThis.__e2eMessages)));
    }
    throw error;
  }
  const job = state.radarState.jobs.find(item => item.handle === 'demo');
  assert.equal(job.reason, 'target');
  assert.equal(job.maxResults, 20);
  assert.equal(job.results.length, 20);
  assert.equal(job.scanned, 20);
  assert.equal(job.pages, 2, 'The real scanner must scroll to obtain the second mock page.');
  assert.equal(job.scanTabId, null);
  assert.equal(job.results[0].handle, 'friend1');
  assert.equal(job.results[19].handle, 'friend20');
  assert.equal(job.results[0].isBlueVerified, false, 'List membership must only be filtered by the requested count ratio.');
  await page.locator('#blue-friends-radar-panel').waitFor({ state: 'visible' });
  const cdp = await context.newCDPSession(page);
  const documentTree = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const panel = descendants(documentTree.root).find(node => attributes(node).id === 'blue-friends-radar-panel');
  assert.ok(panel?.shadowRoots?.length, 'The actual content-script panel must contain its closed shadow root.');
  assert.equal(descendants(panel).filter(node => node.nodeName === 'A' && attributes(node).class === 'card').length, 20);
  assert.equal(descendants(panel).some(node => node.nodeName === '#text' && node.nodeValue === '推荐蓝朋友'), true);
  await until(
    () => worker.evaluate(() => chrome.tabs.query({})),
    tabs => !tabs.some(tab => tab.url === 'https://x.com/demo/verified_followers'),
    'The extension-created scanner tab was not closed',
  );
  const screenshotPath = join(tmpdir(), `blue-friends-mv3-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  // A genuine action popup has different sender metadata than an extension tab.
  await page.bringToFront();
  await worker.evaluate(() => chrome.action.openPopup());
  const popupCDP = await context.browser().newBrowserCDPSession();
  const popupTargets = await until(
    () => popupCDP.send('Target.getTargets'),
    targets => targets.targetInfos.some(target => target.url === `chrome-extension://${extensionId}/popup.html`),
    'Chrome did not expose the actual action popup target',
  );
  const popupTarget = popupTargets.targetInfos.find(target => target.url === `chrome-extension://${extensionId}/popup.html`);
  const { sessionId: popupSessionId } = await popupCDP.send('Target.attachToTarget', { targetId: popupTarget.targetId, flatten: false });
  const pendingPopupCommands = new Map();
  let popupCommandId = 0;
  popupCDP.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== popupSessionId) return;
    const message = JSON.parse(event.message);
    const pending = pendingPopupCommands.get(message.id);
    if (!pending) return;
    pendingPopupCommands.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  });
  const popupCommand = (method, params) => new Promise((resolve, reject) => {
    const id = ++popupCommandId;
    const timer = setTimeout(() => { pendingPopupCommands.delete(id); reject(new Error(`Popup CDP ${method} timed out.`)); }, 10000);
    pendingPopupCommands.set(id, { resolve, reject, timer });
    void popupCDP.send('Target.sendMessageToTarget', { sessionId: popupSessionId, message: JSON.stringify({ id, method, params }) }).catch(error => {
      pendingPopupCommands.delete(id);
      clearTimeout(timer);
      reject(error);
    });
  });
  await until(
    () => popupCommand('Runtime.evaluate', { expression: '!!document.querySelector("#save") && !document.querySelector("#save").disabled', returnByValue: true }),
    result => result.result.value === true,
    'The actual popup did not load its settings',
  );
  await popupCommand('Runtime.evaluate', { expression: 'document.querySelector("#max-results").value="7";document.querySelector("#max-results").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#save").click();', returnByValue: true });
  await until(
    () => popupCommand('Runtime.evaluate', { expression: 'document.querySelector("#feedback").textContent', returnByValue: true }),
    result => result.result.value === '设置已保存。',
    'The actual popup did not confirm saved settings',
  );
  const prefs = await worker.evaluate(() => chrome.storage.local.get('settings'));
  assert.deepEqual(prefs.settings, { enabled: true, maxResults: 7 });
  console.log(JSON.stringify({ ok: true, browser: context.browser()?.version(), extensionId, found: job.results.length, pages: job.pages, scannerTabClosed: true, savedMaxResults: prefs.settings.maxResults, screenshotPath }, null, 2));
} finally {
  await context?.close();
  if (fixtureServer) {
    fixtureServer.closeAllConnections();
    await new Promise(resolve => fixtureServer.close(resolve));
  }
  await rm(profileDir, { recursive: true, force: true });
}
