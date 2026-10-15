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
        ...(index === 0 ? { relationship_perspectives: { following: true } } : {}),
        ...(index === 1 ? { legacy: { following: false } } : {}),
        ...(index === 9 ? { legacy: { following: true } } : {}),
      } },
    } },
  }));
const timelinePayload = entries => ({ data: { user: { result: { timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } } } });
const firstListPayload = timelinePayload([
  ...listEntries.slice(0, 8),
  { entryId: 'cursor-bottom', content: { __typename: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'mock-next' } },
]);
const nextListPayload = timelinePayload(listEntries.slice(8));
const followingUsers = [
  { rest_id: '2001', core: { screen_name: 'modernfalse', name: '现代字段未回关' }, relationship_perspectives: { followed_by: false }, legacy: { followed_by: true } },
  { rest_id: '2002', core: { screen_name: 'moderntrue', name: '现代字段已回关' }, relationship_perspectives: { followed_by: true }, legacy: { followed_by: false } },
  { rest_id: '2003', core: { screen_name: 'unknown', name: '关系未知' } },
  { rest_id: '2004', core: { screen_name: 'legacyfalse', name: '旧字段未回关' }, legacy: { followed_by: false } },
  { rest_id: '2005', core: { screen_name: 'legacytrue', name: '旧字段已回关' }, legacy: { followed_by: true } },
  // This account is returned before its virtualized DOM row is mounted.
  { rest_id: '2006', core: { screen_name: 'latefalse', name: '稍后出现的未回关' }, relationship_perspectives: { followed_by: false } },
  { rest_id: '2007', core: { screen_name: 'recycled', name: '复用列表行' } },
  { rest_id: '2008', core: { screen_name: 'lateunknown', name: '稍后出现的未知关系' } },
];
const followingPayload = users => timelinePayload(users.map(user => ({
  entryId: `user-${user.rest_id}`,
  content: { __typename: 'TimelineTimelineItem', itemContent: { __typename: 'TimelineUser', user_results: { result: user } } },
})));
const recycledUser = followedBy => ({ rest_id: '2007', core: { screen_name: 'recycled', name: '复用列表行' }, relationship_perspectives: { followed_by: followedBy } });
const scrollFollowingUsers = [
  { rest_id: '2010', core: { screen_name: 'scrollfalse', name: '滚动加载的未回关' }, relationship_perspectives: { followed_by: false } },
  { rest_id: '2011', core: { screen_name: 'scrolltrue', name: '滚动加载的已回关' }, relationship_perspectives: { followed_by: true } },
];
const switchedFollowingUsers = [
  { rest_id: '2004', core: { screen_name: 'legacyfalse', name: '切换账号后已回关' }, relationship_perspectives: { followed_by: true } },
  { rest_id: '2005', core: { screen_name: 'legacytrue', name: '切换账号后未回关' }, relationship_perspectives: { followed_by: false } },
];
const followingRowHTML = (handle, name = handle) => `<div data-testid="cellInnerDiv" data-fixture-wrapper="${handle}" style="border-bottom:1px solid #eff3f4"><div data-testid="UserCell" data-fixture-handle="${handle}" style="padding:18px"><a href="/${handle}"><strong>${name}</strong><span>@${handle}</span></a><button type="button">正在关注</button></div></div>`;

const endpoint = (operation, variables) => `/i/api/graphql/mock-query/${operation}?variables=${encodeURIComponent(JSON.stringify(variables))}`;
function mockHTML(path) {
  if (/^\/(demo|other)\/following$/.test(path)) {
    const own = path.startsWith('/demo/');
    const rows = followingUsers.slice(0, 5).map(user => followingRowHTML(user.core.screen_name, user.core.name)).join('');
    const url = endpoint('Following', { userId: own ? '42' : '84' });
    // Model native virtualized cells: each wrapper is independently positioned,
    // and offsets change only after ResizeObserver reports a measured height.
    const virtualList = `const list=document.querySelector('[data-fixture-list]');let queued=false;const observed=new WeakSet();function layout(){queued=false;let top=0;for(const cell of list.children){cell.style.transform='translateY('+top+'px)';top+=cell.getBoundingClientRect().height;}list.style.height=top+'px';list.dataset.layout=String((Number(list.dataset.layout)||0)+1);}function scheduleLayout(){if(!queued){queued=true;requestAnimationFrame(layout);}}const resizeObserver=new ResizeObserver(scheduleLayout);function observeRows(){for(const cell of list.children){if(!observed.has(cell)){observed.add(cell);resizeObserver.observe(cell);}}scheduleLayout();}new MutationObserver(observeRows).observe(list,{childList:true});observeRows();`;
    const scrollPage = `let requestedScroll=false;window.addEventListener('scroll',()=>{if(!requestedScroll&&window.scrollY>0){requestedScroll=true;fetch(${JSON.stringify(endpoint('Following', { userId: own ? '42' : '84', cursor: 'scroll-page' }))}).then(response=>response.json()).then(()=>{list.insertAdjacentHTML('beforeend',${JSON.stringify(scrollFollowingUsers.map(user => followingRowHTML(user.core.screen_name, user.core.name)).join(''))});});}});`;
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Mock X Following</title><style>body{font-family:system-ui;margin:0;background:#fff;color:#0f1419}main{width:min(600px,100%);margin:0 auto}[data-testid="primaryColumn"]{min-height:100vh;border:1px solid #eff3f4;box-sizing:border-box}[data-fixture-list]{position:relative}[data-fixture-wrapper]{position:absolute;left:0;width:100%;box-sizing:border-box}a{color:inherit;text-decoration:none}nav{padding:12px}button{margin-left:16px}</style></head><body><nav><a href="/demo" data-testid="AppTabBar_Profile_Link">我的主页</a></nav><main><div data-testid="primaryColumn"><header><h1>${own ? '我的' : '别人的'}正在关注</h1></header><section data-fixture-list>${rows}</section></div></main><script>${virtualList}${scrollPage}fetch(${JSON.stringify(url)}).then(response=>response.json()).then(()=>{document.documentElement.dataset.fixtureLoaded='true';});</script></body></html>`;
  }
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
let followingRequestCount = 0;
let releaseDelayedFollowing;
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
    let delayFollowing = false;
    if (/\/UserByScreenName$/.test(url.pathname)) {
      contentType = 'application/json';
      body = JSON.stringify(profilePayload);
    } else if (/\/BlueVerifiedFollowers$/.test(url.pathname)) {
      contentType = 'application/json';
      const variables = JSON.parse(url.searchParams.get('variables'));
      body = JSON.stringify(variables.cursor === 'mock-next' ? nextListPayload : firstListPayload);
    } else if (/\/Following$/.test(url.pathname)) {
      followingRequestCount++;
      contentType = 'application/json';
      const variables = JSON.parse(url.searchParams.get('variables'));
      delayFollowing = variables.cursor === 'late-old-viewer';
      const users = variables.cursor === 'recycled-false' ? [recycledUser(false)] :
        variables.cursor === 'recycled-true' ? [recycledUser(true)] :
        variables.cursor === 'scroll-page' ? scrollFollowingUsers :
        variables.cursor === 'switched-page' ? switchedFollowingUsers : followingUsers;
      body = JSON.stringify(followingPayload(users));
    } else if (['/demo', '/demo/verified_followers', '/demo/following', '/other/following'].includes(url.pathname)) {
      contentType = 'text/html; charset=utf-8';
      body = mockHTML(url.pathname);
    } else {
      response.writeHead(404);
      response.end();
      return;
    }
    const sendResponse = () => {
      response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      response.end(body);
    };
    if (delayFollowing) releaseDelayedFollowing = sendResponse;
    else sendResponse();
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
  assert.equal(job.matched, 20);
  assert.equal(job.results.length, 20);
  assert.equal(job.scanned, 20);
  assert.equal(job.pages, 2, 'The real scanner must scroll to obtain the second mock page.');
  assert.equal(job.scanTabId, null);
  assert.equal(job.results[0].handle, 'friend1');
  assert.equal(job.results[19].handle, 'friend20');
  assert.equal(job.results[0].isBlueVerified, false, 'List membership must only be filtered by the requested count ratio.');
  assert.equal(job.results[0].isFollowing, true, 'Modern viewer relationship must survive the bridge and MV3 worker.');
  assert.equal(job.results[1].isFollowing, false);
  assert.equal(job.results[2].isFollowing, false, 'Unknown viewer relationship must never become a followed badge.');
  assert.equal(job.results[9].isFollowing, true, 'Legacy viewer relationship must survive pagination, the bridge and MV3 worker.');
  await page.locator('#blue-friends-radar-panel').waitFor({ state: 'visible' });
  const cdp = await context.newCDPSession(page);
  const documentTree = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const panel = descendants(documentTree.root).find(node => attributes(node).id === 'blue-friends-radar-panel');
  assert.ok(panel?.shadowRoots?.length, 'The actual content-script panel must contain its closed shadow root.');
  const cards = descendants(panel).filter(node => node.nodeName === 'A' && attributes(node).class === 'card');
  assert.equal(cards.length, 20);
  assert.equal(descendants(panel).some(node => node.nodeName === '#text' && node.nodeValue === '推荐蓝朋友'), true);
  const followedHandles = cards.filter(card => descendants(card).some(node => node.nodeName === '#text' && node.nodeValue === '已关注'))
    .map(card => attributes(card).href);
  assert.deepEqual(followedHandles, ['https://x.com/friend1', 'https://x.com/friend10'], 'Only explicit followed relationships receive the badge in the real closed-shadow panel.');
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
  const initiallyHidden = await popupCommand('Runtime.evaluate', { expression: 'document.querySelector("#hide-followed-users").checked', returnByValue: true });
  assert.equal(initiallyHidden.result.value, false, 'Hiding followed users must be opt-in by default.');
  await popupCommand('Runtime.evaluate', { expression: 'document.querySelector("#max-results").value="7";document.querySelector("#max-results").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#hide-followed-users").checked=true;document.querySelector("#hide-followed-users").dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#save").click();', returnByValue: true });
  await until(
    () => popupCommand('Runtime.evaluate', { expression: 'document.querySelector("#feedback").textContent', returnByValue: true }),
    result => result.result.value === '设置已保存。',
    'The actual popup did not confirm saved settings',
  );
  const prefs = await worker.evaluate(() => chrome.storage.local.get('settings'));
  assert.deepEqual(prefs.settings, { enabled: true, maxResults: 7, hideFollowedUsers: true });
  const rescanned = await until(
    () => worker.evaluate(() => chrome.storage.session.get('radarState')),
    saved => saved.radarState?.jobs?.some(item => item.handle === 'demo' && item.maxResults === 7 && item.status === 'complete'),
    'Saving the new hide-followed preference did not trigger a fresh scan',
  );
  const filteredJob = rescanned.radarState.jobs.find(item => item.handle === 'demo');
  assert.equal(filteredJob.matched, 7, 'Followed users that pass the ratio must consume the recommendation quota.');
  assert.equal(filteredJob.results.length, 6, 'Hiding a followed user must not scan for a replacement.');
  assert.equal(filteredJob.scanned, 7);
  assert.equal(filteredJob.pages, 1, 'The hidden match must count toward stopping on the first page.');
  assert.deepEqual(filteredJob.results.map(item => item.handle), ['friend2', 'friend3', 'friend4', 'friend5', 'friend6', 'friend7']);
  assert.equal(filteredJob.results.every(item => item.isFollowing === false), true);
  await until(
    () => cdp.send('DOM.getDocument', { depth: -1, pierce: true }),
    tree => {
      const filteredPanel = descendants(tree.root).find(node => attributes(node).id === 'blue-friends-radar-panel');
      if (!filteredPanel) return false;
      const nodes = descendants(filteredPanel);
      const progress = nodes.find(node => attributes(node).role === 'progressbar');
      return nodes.filter(node => node.nodeName === 'A' && attributes(node).class === 'card').length === 6 &&
        nodes.some(node => node.nodeName === '#text' && node.nodeValue === '7 / 7 人') &&
        nodes.some(node => node.nodeName === '#text' && node.nodeValue.includes('展示 6 人 · 已隐藏 1 人')) &&
        progress && attributes(progress)['aria-valuenow'] === '7' &&
        !nodes.some(node => node.nodeName === '#text' && node.nodeValue === '已关注');
    },
    'The real panel did not show six recommendations, one hidden match and complete seven-person progress',
  );
  // The own-Following tool is independent from the recommendation switches.
  await worker.evaluate(() => chrome.storage.local.set({ settings: { enabled: false, maxResults: 7, hideFollowedUsers: true } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('https://x.com/demo/following');
  const followingSnapshot = async () => {
    const tree = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const host = descendants(tree.root).find(node => attributes(node).id === 'blue-friends-following-filter');
    const button = host && descendants(host).find(node => node.nodeName === 'BUTTON');
    return {
      host, button,
      text: button && descendants(button).filter(node => node.nodeName === '#text').map(node => node.nodeValue).join(''),
      pressed: button && attributes(button)['aria-pressed'],
    };
  };
  const clickFollowingButton = async () => {
    const snapshot = await followingSnapshot();
    assert.ok(snapshot.button, 'The Following filter button must exist before clicking it.');
    const { object } = await cdp.send('DOM.resolveNode', { nodeId: snapshot.button.nodeId });
    try {
      await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function() { this.click(); }' });
    } finally { await cdp.send('Runtime.releaseObject', { objectId: object.objectId }); }
  };
  const followingRows = () => page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('[data-fixture-handle]'), row => {
    const wrapper = row.closest('[data-testid="cellInnerDiv"]') || row;
    return [row.dataset.fixtureHandle, {
      highlighted: row.getAttribute('data-blue-friends-non-follower') === 'true',
      filtered: wrapper.getAttribute('data-blue-friends-filtered') === 'true',
      visible: row.getBoundingClientRect().height > 0 && getComputedStyle(row).visibility !== 'hidden',
      backgrounds: [getComputedStyle(row).backgroundColor, getComputedStyle(wrapper).backgroundColor],
    }];
  })));
  const followingLayout = () => page.evaluate(() => {
    const list = document.querySelector('[data-fixture-list]');
    const wrappers = Array.from(list.children);
    const visible = wrappers.filter(wrapper => wrapper.querySelector('[data-testid="UserCell"]').getBoundingClientRect().height > 0)
      .map(wrapper => wrapper.getBoundingClientRect());
    return {
      virtual: wrappers.every(wrapper => getComputedStyle(wrapper).position === 'absolute' && wrapper.style.transform.startsWith('translateY(')),
      filtered: wrappers.filter(wrapper => wrapper.getAttribute('data-blue-friends-filtered') === 'true')
        .map(wrapper => ({ height: wrapper.getBoundingClientRect().height, display: getComputedStyle(wrapper).display })),
      gaps: visible.slice(1).map((rect, index) => rect.top - visible[index].bottom),
      listHeight: list.getBoundingClientRect().height,
    };
  });
  const assertCompactFollowingLayout = async () => {
    const layout = await until(followingLayout,
      value => value.virtual && value.filtered.length > 0 &&
        value.filtered.every(row => row.height > 0 && row.height <= 2 && row.display !== 'none') &&
        value.gaps.every(gap => gap >= 0 && gap <= 8),
      'ResizeObserver-driven virtual cells did not compact after filtering');
    assert.ok(layout.listHeight > 0, 'The virtual list must keep a measurable height for further scrolling.');
  };
  const ownFollowing = await until(followingSnapshot,
    snapshot => snapshot.text === '只显示未关注你的' && snapshot.pressed === 'false',
    'The own Following list did not receive its initial filter button');
  assert.ok(ownFollowing.host.shadowRoots?.length, 'The Following control must use its actual closed shadow root.');
  const initialRows = await until(followingRows,
    rows => rows.modernfalse?.highlighted && rows.legacyfalse?.highlighted,
    'Explicit modern and legacy non-followers were not highlighted');
  for (const handle of ['modernfalse', 'legacyfalse']) {
    assert.equal(initialRows[handle].visible, true);
    assert.equal(initialRows[handle].filtered, false);
    assert.equal(initialRows[handle].backgrounds.some(color => {
      const channels = color.match(/[\d.]+/g)?.map(Number) || [];
      const [red, green, blue, alpha = 1] = channels;
      return alpha > 0 && red >= 200 && green >= 80 && green < 250 && blue < green && red - blue >= 20;
    }), true, `${handle} must receive a visible orange background.`);
  }
  for (const handle of ['moderntrue', 'legacytrue', 'unknown']) {
    assert.equal(initialRows[handle].highlighted, false, `${handle} must not be treated as an explicit non-follower.`);
    assert.equal(initialRows[handle].filtered, false);
    assert.equal(initialRows[handle].visible, true, 'The initial state must show every Following row.');
  }
  const followingPlacement = await page.evaluate(() => ({
    hostLeft: document.querySelector('#blue-friends-following-filter').getBoundingClientRect().left,
    columnRight: document.querySelector('[data-testid="primaryColumn"]').getBoundingClientRect().right,
  }));
  assert.ok(followingPlacement.hostLeft >= followingPlacement.columnRight, 'The desktop filter belongs to the right of the Following list.');
  assert.equal(await page.locator('#blue-friends-radar-panel').count(), 0, 'Disabling recommendations must leave the independent Following tool available.');

  await clickFollowingButton();
  await until(followingSnapshot,
    snapshot => snapshot.text === '显示全部正在关注' && snapshot.pressed === 'true',
    'The Following filter button did not enter its pressed state');
  const filteredFollowingRows = await until(followingRows,
    rows => rows.moderntrue?.filtered && rows.legacytrue?.filtered && rows.unknown?.filtered,
    'The active Following filter did not hide followers and unknown relationships');
  assert.deepEqual(Object.entries(filteredFollowingRows).filter(([, row]) => row.visible).map(([handle]) => handle), ['modernfalse', 'legacyfalse']);
  await assertCompactFollowingLayout();

  // The response precedes these virtualized rows; a DOM-only refresh must use it.
  await page.locator('[data-fixture-list]').evaluate((list, html) => list.insertAdjacentHTML('beforeend', html), followingRowHTML('latefalse') + followingRowHTML('lateunknown'));
  const appendedFollowingRows = await until(followingRows,
    rows => rows.latefalse?.highlighted && rows.latefalse?.visible && rows.lateunknown?.filtered,
    'Newly mounted Following rows did not inherit the active filter');
  assert.equal(appendedFollowingRows.lateunknown.highlighted, false);
  assert.equal(appendedFollowingRows.lateunknown.visible, false);
  await assertCompactFollowingLayout();

  // Collapsed native cells must still allow the fixture's next-page loader and
  // resize-driven positioning to react to a real scrolling event.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await until(followingRows,
    rows => rows.scrollfalse?.highlighted && rows.scrollfalse?.visible && rows.scrolltrue?.filtered && !rows.scrolltrue.visible,
    'Scrolling the filtered virtual list did not load and filter the next Following response');
  await assertCompactFollowingLayout();

  // X reuses row elements while scrolling. An old orange row must lose its
  // previous relationship immediately, then react to subsequent real responses.
  await page.locator('[data-fixture-handle="modernfalse"]').evaluate(row => {
    row.dataset.fixtureHandle = 'recycled';
    row.closest('[data-testid="cellInnerDiv"]').dataset.fixtureWrapper = 'recycled';
    row.innerHTML = '<a href="/recycled"><strong>复用列表行</strong><span>@recycled</span></a><button type="button">正在关注</button>';
  });
  await until(followingRows,
    rows => rows.recycled?.filtered && !rows.recycled.highlighted && !rows.recycled.visible,
    'A recycled row retained the previous account highlight or visibility');
  await page.evaluate(url => fetch(url).then(response => response.json()), endpoint('Following', { userId: '42', cursor: 'recycled-false' }));
  await until(followingRows,
    rows => rows.recycled?.highlighted && rows.recycled.visible && !rows.recycled.filtered,
    'A later Following response did not reveal the recycled explicit non-follower');
  await page.evaluate(url => fetch(url).then(response => response.json()), endpoint('Following', { userId: '42', cursor: 'recycled-true' }));
  await until(followingRows,
    rows => !rows.recycled?.highlighted && rows.recycled?.filtered && !rows.recycled.visible,
    'A changed follow-back relationship did not clear orange highlighting');

  await clickFollowingButton();
  const restoredFollowingRows = await until(followingRows,
    rows => Object.values(rows).every(row => row.visible && !row.filtered),
    'Showing all Following rows did not restore filtered wrappers');
  assert.equal(restoredFollowingRows.legacyfalse.highlighted, true, 'Showing all must preserve explicit non-follower highlighting.');
  assert.equal((await followingSnapshot()).pressed, 'false');
  await clickFollowingButton();
  await until(followingRows, rows => rows.moderntrue?.filtered, 'The filter was not enabled before SPA navigation.');
  await page.evaluate(() => { history.pushState({}, '', '/other/following'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await until(followingSnapshot, snapshot => !snapshot.host, 'The Following control survived navigation to someone else’s list.');
  await until(followingRows,
    rows => Object.values(rows).every(row => row.visible && !row.filtered && !row.highlighted),
    'SPA navigation did not restore every hidden row and remove orange highlighting');
  const requestsBeforeSPAReturn = followingRequestCount;
  await page.evaluate(() => { history.pushState({}, '', '/demo/following'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await until(followingSnapshot,
    snapshot => snapshot.text === '只显示未关注你的' && snapshot.pressed === 'false',
    'SPA return did not reset the Following filter');
  await until(followingRows,
    rows => rows.legacyfalse?.highlighted && rows.latefalse?.highlighted && rows.scrollfalse?.highlighted &&
      Object.values(rows).every(row => row.visible && !row.filtered),
    'SPA return without a new response did not restore cached relationship highlights');
  assert.equal(followingRequestCount, requestsBeforeSPAReturn, 'The SPA-return regression must reuse existing data without making a Following request.');

  await clickFollowingButton();
  await until(followingRows, rows => rows.moderntrue?.filtered, 'The filter was not enabled before switching the signed-in account.');
  await page.locator('[data-testid="AppTabBar_Profile_Link"]').evaluate(link => link.setAttribute('href', '/switched'));
  await until(followingSnapshot, snapshot => !snapshot.host, 'Changing the signed-in account did not remove the original own-list control.');
  await until(followingRows,
    rows => Object.values(rows).every(row => row.visible && !row.filtered && !row.highlighted),
    'Changing the signed-in account left original-viewer row decorations behind');
  await page.evaluate(() => { history.pushState({}, '', '/switched/following'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await until(followingSnapshot, snapshot => snapshot.pressed === 'false', 'The new signed-in account did not receive its own-list control.');
  assert.equal(Object.values(await followingRows()).every(row => row.visible && !row.filtered && !row.highlighted), true,
    'The prior viewer’s follow-back data must not leak into the new account’s own list.');
  await page.evaluate(url => fetch(url).then(response => response.json()), endpoint('Following', { userId: '99', cursor: 'switched-page' }));
  await until(followingRows,
    rows => !rows.legacyfalse?.highlighted && rows.legacytrue?.highlighted,
    'The new signed-in account did not use its distinct follow-back relationships');
  await clickFollowingButton();
  await until(followingRows,
    rows => rows.legacyfalse?.filtered && !rows.legacyfalse.visible && !rows.legacytrue?.filtered && rows.legacytrue?.visible,
    'Filtering the new account reused the prior viewer’s opposite relationships');
  await page.evaluate(() => {
    document.querySelector('[data-testid="AppTabBar_Profile_Link"]').setAttribute('href', '/demo');
    history.pushState({}, '', '/demo/following');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await until(followingSnapshot, snapshot => snapshot.pressed === 'false', 'Switching back to the original account did not reset its filter.');
  await until(followingRows,
    rows => Object.values(rows).every(row => row.visible && !row.filtered && !row.highlighted),
    'Switching back reused the other signed-in account’s cached relationships');

  // This request starts while demo is signed in and the other account's list is
  // visible. Its response arrives only after other becomes the signed-in viewer.
  await page.evaluate(() => { history.pushState({}, '', '/other/following'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await until(followingSnapshot, snapshot => !snapshot.host, 'The late-response fixture did not enter the other-account list.');
  const delayedRequest = page.evaluate(url => fetch(url).then(response => response.json()), endpoint('Following', { userId: '84', cursor: 'late-old-viewer' }))
    .then(value => ({ value }), error => ({ error: error.message }));
  await until(() => !!releaseDelayedFollowing, ready => ready, 'The old-viewer Following request was not held by the fixture.');
  await page.locator('[data-testid="AppTabBar_Profile_Link"]').evaluate(link => link.setAttribute('href', '/other'));
  await until(followingSnapshot, snapshot => snapshot.pressed === 'false', 'The switched viewer did not receive its own-list control before the delayed response.');
  releaseDelayedFollowing();
  releaseDelayedFollowing = null;
  assert.equal((await delayedRequest).error, undefined, 'The delayed Following response must reach the real fetch observer.');
  // The observer clones and parses asynchronously, so allow a normal route tick.
  await page.waitForTimeout(700);
  assert.equal(Object.values(await followingRows()).every(row => row.visible && !row.filtered && !row.highlighted), true,
    'A delayed response from the previous signed-in viewer must not decorate the new viewer’s list.');
  await page.evaluate(url => fetch(url).then(response => response.json()), endpoint('Following', { userId: '84' }));
  await until(followingRows, rows => rows.legacyfalse?.highlighted && !rows.legacytrue?.highlighted,
    'A fresh request after the confirmed account switch did not restore correct highlighting');
  await page.goto('https://x.com/other/following');
  await page.locator('html[data-fixture-loaded="true"]').waitFor();
  // Give the content controller its normal route check after this genuine load.
  await page.waitForTimeout(700);
  assert.equal((await followingSnapshot()).host, undefined, 'Another account’s Following list must not get the own-account tool.');
  const otherFollowingRows = await followingRows();
  assert.equal(Object.values(otherFollowingRows).every(row => row.visible && !row.filtered && !row.highlighted), true);

  await page.goto('https://x.com/demo/following');
  await until(followingSnapshot,
    snapshot => snapshot.text === '只显示未关注你的' && snapshot.pressed === 'false',
    'Revisiting the own Following list did not restore the default show-all state');
  await until(followingRows,
    rows => rows.modernfalse?.highlighted && Object.values(rows).every(row => row.visible && !row.filtered),
    'Revisiting the own Following list reused stale filtering');
  const followingScreenshotPath = join(tmpdir(), `blue-friends-following-mv3-${Date.now()}.png`);
  await page.screenshot({ path: followingScreenshotPath, fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => { document.body.style.backgroundColor = '#000'; document.body.style.color = '#e7e9ea'; });
  await page.setViewportSize({ width: 540, height: 800 });
  await until(() => page.locator('#blue-friends-following-filter').getAttribute('data-theme'), theme => theme === 'dark',
    'The narrow Following control did not adopt the dark page theme');
  const narrowPlacement = await page.evaluate(() => {
    const host = document.querySelector('#blue-friends-following-filter');
    const bounds = host.getBoundingClientRect();
    return { inline: host.parentElement === document.querySelector('[data-testid="primaryColumn"]'), left: bounds.left, right: bounds.right, width: window.innerWidth };
  });
  assert.equal(narrowPlacement.inline, true, 'The narrow control must fit inside the Following column.');
  assert.ok(narrowPlacement.left >= 0 && narrowPlacement.right <= narrowPlacement.width, 'The narrow control must remain fully inside the viewport.');
  const darkSnapshot = await followingSnapshot();
  const darkSection = descendants(darkSnapshot.host).find(node => node.nodeName === 'SECTION');
  const { object: darkSectionObject } = await cdp.send('DOM.resolveNode', { nodeId: darkSection.nodeId });
  const darkColors = await cdp.send('Runtime.callFunctionOn', { objectId: darkSectionObject.objectId,
    functionDeclaration: 'function() { const style = getComputedStyle(this); return {background:style.backgroundColor,color:style.color}; }', returnByValue: true });
  await cdp.send('Runtime.releaseObject', { objectId: darkSectionObject.objectId });
  const darkChannels = darkColors.result.value.background.match(/[\d.]+/g).slice(0, 3).map(Number);
  const textChannels = darkColors.result.value.color.match(/[\d.]+/g).slice(0, 3).map(Number);
  assert.ok(darkChannels.reduce((sum, value) => sum + value, 0) < 360 && textChannels.reduce((sum, value) => sum + value, 0) > 500,
    'The closed-shadow control must render a dark background and readable light text.');
  await clickFollowingButton();
  await until(followingRows, rows => rows.moderntrue?.filtered && rows.unknown?.filtered && rows.modernfalse?.visible,
    'The narrow dark Following control did not filter its rows');
  await assertCompactFollowingLayout();
  const narrowFollowingScreenshotPath = join(tmpdir(), `blue-friends-following-narrow-mv3-${Date.now()}.png`);
  await page.evaluate(() => { window.scrollTo(0, 0); return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  await page.waitForTimeout(100);
  await page.screenshot({ path: narrowFollowingScreenshotPath, fullPage: true });
  console.log(JSON.stringify({ ok: true, browser: context.browser()?.version(), extensionId, found: job.results.length, pages: job.pages, followedBadges: followedHandles.length, scannerTabClosed: true, savedMaxResults: prefs.settings.maxResults, hideFollowedUsers: prefs.settings.hideFollowedUsers, filteredResults: filteredJob.results.length, ownFollowingHighlight: true, followingFilter: true, followingVirtualizedRows: true, followingVirtualLayout: true, followingSPACache: true, accountSwitchIsolation: true, delayedViewerResponseRejected: true, narrowDarkFollowing: true, otherFollowingUntouched: true, screenshotPath, followingScreenshotPath, narrowFollowingScreenshotPath }, null, 2));
} finally {
  await context?.close();
  if (fixtureServer) {
    fixtureServer.closeAllConnections();
    await new Promise(resolve => fixtureServer.close(resolve));
  }
  await rm(profileDir, { recursive: true, force: true });
}
