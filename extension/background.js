import './shared/core.js';

const Core = globalThis.BlueFriendsCore;
const SESSION_KEY = 'radarState';
const LIMITS = {duration: 180_000, pages: 100, users: 3000};
const active = (job) => job && ['queued', 'scanning'].includes(job.status);
let data = {jobs: [], visits: {}};
const ready = chrome.storage.session.get(SESSION_KEY).then((saved) => {
  if (saved[SESSION_KEY]?.jobs && saved[SESSION_KEY]?.visits) {
    data = saved[SESSION_KEY];
    for (const job of data.jobs) {
      const prefs = Core.normalizeSettings({maxResults: job.maxResults, hideFollowedUsers: job.hideFollowedUsers});
      job.maxResults = prefs.maxResults;
      job.hideFollowedUsers = prefs.hideFollowedUsers;
      job.results = Array.isArray(job.results)
        ? job.results.map((user) => Core.sanitizeUser(user)).filter((user) => user && (!job.hideFollowedUsers || !user.isFollowing)).slice(0, job.maxResults)
        : [];
      if (job.status === 'complete' && job.reason === 'target') job.message = `已找到 ${job.results.length} 位朋友。`;
    }
  }
});
let queue = Promise.resolve();
function serial(task) {
  const next = queue.then(() => ready).then(task);
  queue = next.catch(() => {});
  return next;
}
const persist = () => chrome.storage.session.set({[SESSION_KEY]: data});
const settings = async () => Core.normalizeSettings((await chrome.storage.local.get('settings')).settings);
const ownerJob = (tabId) => data.jobs.find((job) => job.ownerTabId === tabId);
const scanJob = (tabId) => data.jobs.find((job) => active(job) && job.scanTabId === tabId);

function state(job) {
  if (!job) return null;
  const {handle, status, reason, message, results, scanned, skipped, maxResults, hideFollowedUsers, updatedAt} = job;
  return {handle, status, reason, message, results, scanned, skipped, maxResults, hideFollowedUsers, updatedAt};
}
async function notify(job) {
  job.updatedAt = Date.now();
  await persist();
  try { await chrome.tabs.sendMessage(job.ownerTabId, {type: 'SCAN_STATE', state: state(job)}); } catch {}
}
function scanPath(url, job) {
  try {
    const parsed = new URL(url);
    return ['x.com', 'twitter.com'].includes(parsed.hostname) &&
      parsed.pathname.toLowerCase() === `/${job.handle}/verified_followers`;
  } catch { return false; }
}
async function finish(job, status, reason, message) {
  if (!active(job)) return;
  job.status = status;
  job.reason = reason;
  job.message = message;
  await chrome.alarms.clear(`scan:${job.id}`);
  const scanTabId = job.scanTabId;
  job.scanTabId = null;
  await notify(job);
  if (scanTabId != null) {
    try {
      const tab = await chrome.tabs.get(scanTabId);
      // Only close the page we created, never a page the user navigated to.
      if (scanPath(tab.url, job) || tab.url === 'about:blank') await chrome.tabs.remove(scanTabId);
    } catch {}
  }
}
async function pump() {
  if (data.jobs.some((job) => job.status === 'scanning')) return;
  let job;
  while ((job = data.jobs.find((item) => item.status === 'queued'))) {
    let owner;
    try { owner = await chrome.tabs.get(job.ownerTabId); } catch {}
    if (!owner || Core.profileHandle(owner.url) !== job.handle) {
      await finish(job, 'stopped', 'navigation', '已离开该用户主页。');
      continue;
    }
    try {
      job.status = 'scanning';
      job.startedAt = Date.now();
      job.deadline = job.startedAt + LIMITS.duration;
      const tab = await chrome.tabs.create({url: `https://x.com/${job.handle}/verified_followers`, active: false, windowId: owner.windowId});
      job.scanTabId = tab.id;
      await notify(job);
      await chrome.alarms.create(`scan:${job.id}`, {when: job.deadline});
      // Context requests use the same serial queue; they run after registration.
      return;
    } catch {
      await finish(job, 'error', 'tab-error', '无法打开扫描页，请重新扫描。');
    }
  }
}
function cleanUser(user) {
  return Core.sanitizeUser(user);
}
function contentSender(sender) {
  if (sender.tab?.id == null || sender.frameId !== 0) return false;
  try { return ['x.com', 'twitter.com'].includes(new URL(sender.url).hostname); } catch { return false; }
}
async function visit(handle, tabId) {
  const previous = ownerJob(tabId);
  if (active(previous) && previous.handle !== handle) {
    await finish(previous, 'stopped', 'navigation', '已离开该用户主页。');
  }
  data.visits[tabId] = handle;
  // Results are scoped to this visit; coming back scans anew.
  if (previous && (!active(previous) || previous.handle !== handle)) data.jobs = data.jobs.filter((job) => job !== previous);
  await persist();
  await pump();
}
async function start(profile, tabId, force) {
  const prefs = await settings();
  if (!prefs.enabled) return {ok: true, state: null};
  const user = cleanUser(profile);
  if (!user?.id || !user.isBlueVerified || data.visits[tabId] !== user.handle) {
    return {ok: false, message: '没有当前主页的蓝标资料。'};
  }
  const tab = await chrome.tabs.get(tabId);
  if (Core.profileHandle(tab.url) !== user.handle) return {ok: false, message: '主页已切换。'};
  const previous = ownerJob(tabId);
  if (previous && previous.handle === user.handle && !force) return {ok: true, state: state(previous)};
  if (active(previous)) await finish(previous, 'stopped', 'replaced', '重新扫描。');
  data.jobs = data.jobs.filter((job) => job.ownerTabId !== tabId);
  const job = {
    id: crypto.randomUUID(), ownerTabId: tabId, scanTabId: null,
    handle: user.handle, profileId: user.id, maxResults: prefs.maxResults, hideFollowedUsers: prefs.hideFollowedUsers,
    status: 'queued', reason: null, message: '正在等待扫描…',
    results: [], scanned: 0, skipped: 0, pages: 0,
    seen: [], pageKeys: [], lastCursor: null, nonAdvancing: 0,
    updatedAt: Date.now(), deadline: null
  };
  data.jobs.push(job);
  await notify(job);
  await pump();
  return {ok: true, state: state(job)};
}
async function acceptPage(message, sender) {
  const job = scanJob(sender.tab.id);
  if (!job || job.id !== message.jobId || message.targetId !== job.profileId ||
      Core.normalizeHandle(message.handle) !== job.handle) return {ok: false, continue: false};
  if (Date.now() >= job.deadline) {
    await finish(job, 'stopped', 'time-limit', '已到扫描时间上限，保留找到的朋友。');
    await pump();
    return {ok: true, continue: false};
  }
  const page = message.page;
  if (!page || !Array.isArray(page.users) || page.users.length > 500) return {ok: false, continue: false};
  if (page.error || message.status >= 400) {
    const code = page.error?.code;
    const limited = message.status === 429 || Number(code) === 88;
    const denied = [401, 403].includes(message.status) || [32, 89, 179, 200, 215, 326].includes(Number(code));
    await finish(job, 'error', limited ? 'rate-limit' : denied ? 'access' : 'x-error',
      limited ? 'X 暂时限制了访问，请稍后重新扫描。' : denied ? '请确认已登录 X，且能查看该用户的认证关注者。' : 'X 返回错误，扫描已停止。');
    await pump();
    return {ok: true, continue: false};
  }
  if (!page.hasTimeline) {
    await finish(job, 'error', 'unsupported-data', '未能识别认证关注者数据，X 的页面结构可能已变化。');
    await pump();
    return {ok: true, continue: false};
  }
  const users = page.users.map(cleanUser).filter(Boolean);
  const cursor = typeof page.nextCursor === 'string' ? page.nextCursor.slice(0, 4096) : null;
  const key = `${message.requestCursor || ''}|${cursor || ''}|${users.map((user) => user.id || user.handle).join(',')}`;
  if (job.pageKeys.includes(key)) return {ok: true, continue: true, duplicate: true};
  job.pageKeys.push(key);
  job.pages += 1;
  const seen = new Set(job.seen);
  const before = seen.size;
  for (const user of users) {
    const identity = user.id || user.handle;
    if (seen.has(identity)) continue;
    if (job.scanned >= LIMITS.users || job.results.length >= job.maxResults) break;
    seen.add(identity);
    job.scanned += 1;
    if (user.followers === null || user.following === null) job.skipped += 1;
    if (job.hideFollowedUsers && user.isFollowing === true) continue;
    if (Core.matches(user)) job.results.push(user);
  }
  job.seen = [...seen];
  job.nonAdvancing = seen.size === before || (cursor && cursor === job.lastCursor) ? job.nonAdvancing + 1 : 0;
  job.lastCursor = cursor;
  if (job.results.length >= job.maxResults) {
    await finish(job, 'complete', 'target', `已找到 ${job.maxResults} 位朋友。`);
  } else if (page.exhausted === true) {
    await finish(job, 'complete', 'exhausted', '认证关注者已扫描完毕。');
  } else if (job.nonAdvancing >= 2) {
    await finish(job, 'stopped', 'no-progress', '列表没有继续加载，保留找到的朋友。');
  } else if (job.pages >= LIMITS.pages || job.scanned >= LIMITS.users) {
    await finish(job, 'stopped', 'scan-limit', '已到扫描上限，保留找到的朋友。');
  } else {
    job.message = '正在扫描认证关注者…';
    await notify(job);
  }
  const more = active(job);
  if (!more) await pump();
  return {ok: true, continue: more};
}
async function handle(message, sender) {
  if (!message || sender.id !== chrome.runtime.id) return {ok: false};
  const fromContent = contentSender(sender);
  // The same trusted extension UI can be a toolbar popup or an extension tab.
  const fromPopup = sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL('popup.html');
  if (message.type === 'GET_SETTINGS' && (fromPopup || fromContent)) return {ok: true, settings: await settings()};
  if (message.type === 'SET_SETTINGS' && fromPopup) {
    const prefs = Core.normalizeSettings(message.settings);
    await chrome.storage.local.set({settings: prefs});
    for (const job of data.jobs) {
      if (active(job)) await finish(job, 'stopped', 'settings', '设置已更改。');
    }
    await pump();
    return {ok: true, settings: prefs};
  }
  if (message.type === 'GET_ACTIVE_STATE' && fromPopup) {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    return {ok: true, state: state(ownerJob(tab?.id))};
  }
  if (!fromContent) return {ok: false};
  const tabId = sender.tab.id;
  if (message.type === 'BF_CONTEXT') {
    const job = scanJob(tabId);
    return {ok: true, role: job ? 'scan' : 'profile', settings: await settings(),
      job: job ? {id: job.id, handle: job.handle, profileId: job.profileId, maxResults: job.maxResults, deadline: job.deadline} : null};
  }
  if (message.type === 'PROFILE_VISIT') {
    await visit(Core.normalizeHandle(message.handle), tabId);
    return {ok: true, state: state(ownerJob(tabId))};
  }
  if (message.type === 'START_SCAN') return start(message.profile, tabId, message.force === true);
  if (message.type === 'CANCEL_SCAN') {
    const job = ownerJob(tabId);
    if (active(job)) await finish(job, 'stopped', 'cancelled', '已停止扫描。');
    await pump();
    return {ok: true, state: state(job)};
  }
  if (message.type === 'SCAN_PAGE') return acceptPage(message, sender);
  if (message.type === 'SCAN_HEARTBEAT') {
    const job = scanJob(tabId);
    if (!job || job.id !== message.jobId) return {ok: true, continue: false};
    if (Date.now() >= job.deadline) {
      await finish(job, 'stopped', 'time-limit', '已到扫描时间上限，保留找到的朋友。');
      await pump();
      return {ok: true, continue: false};
    }
    return {ok: true, continue: true};
  }
  if (message.type === 'SCAN_STOP') {
    const job = scanJob(tabId);
    if (job?.id === message.jobId) {
      const reason = ['no-data', 'no-progress', 'navigation', 'time-limit', 'login', 'scanner-error'].includes(message.reason) ? message.reason : 'scanner-error';
      const texts = {
        'no-data': '未收到认证关注者数据。请确认已登录 X，并能打开认证关注者列表。',
        'no-progress': '列表没有继续加载，保留找到的朋友。',
        'navigation': '扫描页已离开认证关注者列表。',
        'time-limit': '已到扫描时间上限，保留找到的朋友。',
        'login': '请先在 Chrome 中登录 X，再重新扫描。',
        'scanner-error': '扫描中断，请重新扫描。'
      };
      await finish(job, ['no-data', 'login', 'scanner-error'].includes(reason) ? 'error' : 'stopped', reason, texts[reason]);
      await pump();
    }
    return {ok: true, continue: false};
  }
  return {ok: false};
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  serial(() => handle(message, sender)).then(sendResponse).catch(() => sendResponse({ok: false, message: '扩展暂时无法完成操作，请刷新页面。'}));
  return true;
});
chrome.tabs.onRemoved.addListener((tabId) => {
  serial(async () => {
    const scanner = scanJob(tabId);
    if (scanner) await finish(scanner, 'stopped', 'tab-closed', '扫描页已关闭，保留找到的朋友。');
    const owner = ownerJob(tabId);
    if (active(owner)) await finish(owner, 'stopped', 'navigation', '来源页面已关闭。');
    data.jobs = data.jobs.filter((job) => job.ownerTabId !== tabId);
    delete data.visits[tabId];
    await persist();
    await pump();
  }).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url && change.status !== 'complete') return;
  serial(async () => {
    let url = change.url;
    if (!url) {
      try { url = (await chrome.tabs.get(tabId)).url; } catch { return; }
    }
    const scanner = scanJob(tabId);
    if (scanner && url !== 'about:blank' && !scanPath(url, scanner)) {
      await finish(scanner, 'stopped', 'navigation', '扫描页已离开认证关注者列表。');
    }
    const owner = ownerJob(tabId);
    if (active(owner) && Core.profileHandle(url) !== owner.handle) {
      await finish(owner, 'stopped', 'navigation', '已离开该用户主页。');
    }
    await pump();
  }).catch(() => {});
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith('scan:')) return;
  serial(async () => {
    const job = data.jobs.find((item) => item.id === alarm.name.slice(5));
    if (active(job)) await finish(job, 'stopped', 'time-limit', '已到扫描时间上限，保留找到的朋友。');
    await pump();
  }).catch(() => {});
});

// A worker can be stopped between events. Reconcile persisted jobs on restart.
serial(async () => {
  for (const job of [...data.jobs]) {
    if (!active(job)) continue;
    let owner;
    try { owner = await chrome.tabs.get(job.ownerTabId); } catch {}
    if (!owner || Core.profileHandle(owner.url) !== job.handle) {
      await finish(job, 'stopped', 'navigation', '已离开该用户主页。');
      if (!owner) data.jobs = data.jobs.filter((item) => item !== job);
      continue;
    }
    if (job.results.length >= job.maxResults) {
      await finish(job, 'complete', 'target', `已找到 ${job.maxResults} 位朋友。`);
      continue;
    }
    if (job.status === 'scanning') {
      let tab;
      try { tab = await chrome.tabs.get(job.scanTabId); } catch {}
      if (!tab) await finish(job, 'stopped', 'tab-closed', '扫描页已关闭，保留找到的朋友。');
      else if (Date.now() >= job.deadline) await finish(job, 'stopped', 'time-limit', '已到扫描时间上限，保留找到的朋友。');
      else if (!scanPath(tab.url, job) && tab.url !== 'about:blank') await finish(job, 'stopped', 'navigation', '扫描页已离开认证关注者列表。');
      else {
        await chrome.alarms.create(`scan:${job.id}`, {when: job.deadline});
        // Recover older/staged sessions without creating a second scan tab.
        if (tab.url === 'about:blank') await chrome.tabs.update(tab.id, {url: `https://x.com/${job.handle}/verified_followers`});
      }
    }
  }
  await persist();
  await pump();
}).catch(() => {});
