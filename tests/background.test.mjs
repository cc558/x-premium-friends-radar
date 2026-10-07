import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const coreSource = await readFile(new URL('../extension/shared/core.js', import.meta.url), 'utf8');
const workerSource = (await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')).replace(/^import[^\n]+\n/, '');
const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
const user = (number, values = {}) => ({
  id: String(number), handle: `friend${number}`, name: `Friend ${number}`,
  avatar: `https://pbs.twimg.com/profile_images/${number}/avatar.jpg`,
  isBlueVerified: true, followers: 100, following: 81, ...values,
});
const profile = (handle, id = '1', values = {}) => user(id, {handle, name: handle, ...values});

function event() {
  const listeners = [];
  return {
    addListener: (listener) => listeners.push(listener),
    emit: (...args) => listeners.forEach((listener) => listener(...args)),
    listeners,
  };
}

function memory(settings = {enabled: true, maxResults: 20}) {
  return {session: {}, local: {settings}, tabs: new Map(), created: [], removed: [], notifications: [], alarms: new Map(), nextTab: 100, uuid: 0, now: 1000};
}

function worker(shared = memory()) {
  const onMessage = event();
  const onRemoved = event();
  const onUpdated = event();
  const onAlarm = event();
  const storage = (name) => ({
    async get(key) { return copy({[key]: shared[name][key]}); },
    async set(value) { Object.assign(shared[name], copy(value)); },
  });
  const chrome = {
    runtime: {id: 'radar-extension', onMessage, getURL: (path) => `chrome-extension://radar-extension/${path}`},
    storage: {session: storage('session'), local: storage('local')},
    tabs: {
      onRemoved, onUpdated,
      async get(id) { if (!shared.tabs.has(id)) throw new Error('Tab not found'); return copy(shared.tabs.get(id)); },
      async create(properties) {
        const tab = {...properties, id: shared.nextTab++};
        shared.tabs.set(tab.id, tab); shared.created.push(copy(tab)); return copy(tab);
      },
      async update(id, properties) {
        const tab = shared.tabs.get(id); if (!tab) throw new Error('Tab not found');
        Object.assign(tab, properties); onUpdated.emit(id, copy(properties), copy(tab)); return copy(tab);
      },
      async remove(id) {
        if (!shared.tabs.has(id)) throw new Error('Tab not found');
        shared.tabs.delete(id); shared.removed.push(id); onRemoved.emit(id, {});
      },
      async sendMessage(id, message) { shared.notifications.push({id, message: copy(message)}); },
      async query() { return [...shared.tabs.values()].filter((tab) => tab.active).map(copy); },
    },
    alarms: {
      onAlarm,
      async create(name, details) { shared.alarms.set(name, copy(details)); },
      async clear(name) { return shared.alarms.delete(name); },
    },
  };
  class Clock extends Date { static now() { return shared.now; } }
  const context = vm.createContext({chrome, URL, Date: Clock, crypto: {randomUUID: () => `job-${++shared.uuid}`}});
  vm.runInContext(coreSource, context);
  vm.runInContext(workerSource, context);
  function addOwner(id, handle) { shared.tabs.set(id, {id, url: `https://x.com/${handle}`, windowId: 9, active: true}); }
  function sender(tabId, values = {}) {
    const tab = shared.tabs.get(tabId);
    return {id: chrome.runtime.id, frameId: 0, tab: {id: tabId}, url: tab?.url || 'https://x.com/unknown', ...values};
  }
  async function message(value, tabId, values = {}) {
    const response = await new Promise((resolve) => onMessage.listeners[0](copy(value), sender(tabId, values), resolve));
    await flush(); return copy(response);
  }
  async function begin(handle = 'alice', tabId = 1, values = {}) {
    addOwner(tabId, handle);
    await message({type: 'PROFILE_VISIT', handle}, tabId);
    const response = await message({type: 'START_SCAN', profile: profile(handle, String(tabId), values)}, tabId);
    return {response, job: copy(shared.session.radarState.jobs.find((job) => job.ownerTabId === tabId))};
  }
  const jobs = () => copy(shared.session.radarState?.jobs || []);
  async function page(job, users, values = {}, tabId = job.scanTabId) {
    return message({type: 'SCAN_PAGE', jobId: job.id, handle: job.handle, targetId: job.profileId, status: 200,
      page: {users, hasTimeline: true, exhausted: false, nextCursor: 'cursor-1'}, ...values}, tabId);
  }
  return {shared, message, begin, page, jobs, addOwner, onRemoved, onUpdated, onAlarm};
}

test('stops exactly at the configured target even when a page has more matching users', async () => {
  const api = worker();
  const {job} = await api.begin();
  assert.equal(job.status, 'scanning');
  assert.equal(api.shared.created.length, 1);
  const response = await api.page(job, Array.from({length: 45}, (_, index) => user(index + 20)));
  assert.deepEqual(response, {ok: true, continue: false});
  const completed = api.jobs()[0];
  assert.equal(completed.status, 'complete');
  assert.equal(completed.reason, 'target');
  assert.equal(completed.results.length, 20);
  assert.equal(completed.scanned, 20);
  assert.deepEqual(completed.results.map((candidate) => candidate.id), Array.from({length: 20}, (_, index) => String(index + 20)));
  assert.equal(completed.scanTabId, null);
  assert.deepEqual(api.shared.removed, [job.scanTabId]);
});

test('deduplicates pagination and skips missing counts and the exact 80% boundary', async () => {
  const api = worker();
  const {job} = await api.begin();
  const unknown = user(11, {followers: null});
  const boundary = user(12, {following: 80});
  assert.equal((await api.page(job, [user(10), unknown, boundary])).continue, true);
  const duplicate = await api.page(job, [user(10), unknown, boundary]);
  assert.equal(duplicate.duplicate, true);
  assert.equal(api.jobs()[0].pages, 1);
  await api.page(job, [user(10), unknown, boundary, user(13)], {requestCursor: 'cursor-1', page: {users: [user(10), unknown, boundary, user(13)], hasTimeline: true, exhausted: true, nextCursor: null}});
  const completed = api.jobs()[0];
  assert.equal(completed.reason, 'exhausted');
  assert.equal(completed.scanned, 4);
  assert.equal(completed.skipped, 1);
  assert.deepEqual(completed.results.map((candidate) => candidate.id), ['10', '13']);
});

test('keeps strict viewer follow flags in recommendations, notifications, and worker recovery', async () => {
  const api = worker();
  const {job} = await api.begin();
  const users = [user(10, {isFollowing: true}), user(11, {isFollowing: false}), user(12), user(13, {isFollowing: 'true'})];
  await api.page(job, users, {page: {users, hasTimeline: true, exhausted: true, nextCursor: null}});
  const expected = [true, false, false, false];
  assert.deepEqual(api.jobs()[0].results.map(candidate => candidate.isFollowing), expected);
  assert.deepEqual(api.shared.notifications.at(-1).message.state.results.map(candidate => candidate.isFollowing), expected);
  const restored = worker(api.shared);
  await flush();
  const reply = await restored.message({type: 'GET_ACTIVE_STATE'}, 1, {url: 'chrome-extension://radar-extension/popup.html'});
  assert.deepEqual(reply.state.results.map(candidate => candidate.isFollowing), expected);
  assert.deepEqual(restored.jobs()[0].results.map(candidate => candidate.isFollowing), expected);
});

test('old cached results with missing or invalid viewer follow flags never become followed', async () => {
  const api = worker();
  const {job} = await api.begin();
  const users = [user(10), user(11), user(12, {isFollowing: true})];
  await api.page(job, users, {page: {users, hasTimeline: true, exhausted: true, nextCursor: null}});
  delete api.shared.session.radarState.jobs[0].results[0].isFollowing;
  api.shared.session.radarState.jobs[0].results[1].isFollowing = 'true';
  const restored = worker(api.shared);
  await flush();
  assert.deepEqual(restored.jobs()[0].results.map(candidate => candidate.isFollowing), [false, false, true]);
  assert.equal(restored.jobs()[0].hideFollowedUsers, false);
});

test('hiding followed accounts fills its result quota across pages and keeps unknown relationships', async () => {
  const api = worker(memory({enabled: true, maxResults: 3, hideFollowedUsers: true}));
  const {job, response} = await api.begin();
  assert.equal(job.hideFollowedUsers, true);
  assert.equal(response.state.hideFollowedUsers, true);
  const first = await api.page(job, [user(10, {isFollowing: true}), user(11, {isFollowing: false}), user(12, {isFollowing: true})]);
  assert.equal(first.continue, true);
  assert.deepEqual(api.jobs()[0].results.map(candidate => candidate.id), ['11']);
  assert.equal(api.jobs()[0].scanned, 3);
  const users = [user(10, {isFollowing: true}), user(13), user(14, {isFollowing: 'true'}), user(15, {isFollowing: false})];
  const completed = await api.page(job, users, {requestCursor: 'cursor-1', page: {users, hasTimeline: true, exhausted: false, nextCursor: 'cursor-2'}});
  assert.equal(completed.continue, false);
  assert.equal(api.jobs()[0].reason, 'target');
  assert.equal(api.jobs()[0].pages, 2);
  assert.equal(api.jobs()[0].scanned, 5);
  assert.deepEqual(api.jobs()[0].results.map(candidate => candidate.id), ['11', '13', '14']);
  assert.deepEqual(api.shared.removed, [job.scanTabId]);
});

test('worker recovery keeps the job hide-followed snapshot and continues filling its quota', async () => {
  const original = worker(memory({enabled: true, maxResults: 2, hideFollowedUsers: true}));
  const {job} = await original.begin();
  await original.page(job, [user(10, {isFollowing: true}), user(11, {isFollowing: false})]);
  original.shared.local.settings.hideFollowedUsers = false;
  const restored = worker(original.shared);
  await flush();
  assert.equal(restored.jobs()[0].hideFollowedUsers, true);
  assert.deepEqual(restored.jobs()[0].results.map(candidate => candidate.id), ['11']);
  const users = [user(12, {isFollowing: true}), user(13)];
  await restored.page(job, users, {requestCursor: 'cursor-1', page: {users, hasTimeline: true, exhausted: true, nextCursor: null}});
  assert.deepEqual(restored.jobs()[0].results.map(candidate => candidate.id), ['11', '13']);
  assert.equal(restored.jobs()[0].status, 'complete');
  assert.equal(restored.shared.created.length, 1);
  const state = await restored.message({type: 'GET_ACTIVE_STATE'}, 1, {url: 'chrome-extension://radar-extension/popup.html'});
  assert.equal(state.state.hideFollowedUsers, true);
});

test('restored hide-followed caches remove explicit followed results without inferring unknowns', async () => {
  const original = worker();
  const {job} = await original.begin();
  const users = [user(10, {isFollowing: true}), user(11, {isFollowing: false}), user(12)];
  await original.page(job, users, {page: {users, hasTimeline: true, exhausted: true, nextCursor: null}});
  original.shared.session.radarState.jobs[0].hideFollowedUsers = true;
  const restored = worker(original.shared);
  await flush();
  assert.deepEqual(restored.jobs()[0].results.map(candidate => candidate.id), ['11', '12']);
  assert.equal(restored.jobs()[0].hideFollowedUsers, true);
});

test('changing hide-followed settings stops the current scan and force-start uses the new preference', async () => {
  const api = worker();
  const {job} = await api.begin();
  await api.page(job, [user(10, {isFollowing: true})]);
  const prefs = {enabled: true, maxResults: 2, hideFollowedUsers: true};
  await api.message({type: 'SET_SETTINGS', settings: prefs}, 1, {url: 'chrome-extension://radar-extension/popup.html'});
  assert.equal(api.jobs()[0].status, 'stopped');
  assert.equal(api.jobs()[0].reason, 'settings');
  assert.deepEqual(api.shared.removed, [job.scanTabId]);
  const restarted = await api.message({type: 'START_SCAN', profile: profile('alice', '1'), force: true}, 1);
  assert.equal(restarted.state.hideFollowedUsers, true);
  assert.equal(restarted.state.maxResults, 2);
  assert.equal(api.jobs()[0].results.length, 0);
  assert.equal(api.shared.created.length, 2);
});

test('rejects scan pages from another tab, job or target without changing results', async () => {
  const api = worker();
  const {job} = await api.begin();
  api.addOwner(2, 'bob');
  assert.equal((await api.page(job, [user(10)], {}, 2)).ok, false);
  assert.equal((await api.page(job, [user(10)], {jobId: 'other-job'})).ok, false);
  assert.equal((await api.page(job, [user(10)], {targetId: '999'})).ok, false);
  assert.equal((await api.page(job, [user(10)], {handle: 'bob'})).ok, false);
  const validMessage = {type: 'SCAN_PAGE', jobId: job.id, targetId: job.profileId, handle: job.handle, status: 200,
    page: {users: [user(10)], hasTimeline: true, exhausted: false, nextCursor: 'next'}};
  assert.equal((await api.message(validMessage, job.scanTabId, {frameId: 1})).ok, false);
  assert.equal((await api.message(validMessage, job.scanTabId, {id: 'another-extension'})).ok, false);
  assert.equal((await api.page(job, [user(10)], {}, job.scanTabId)).continue, true);
  assert.equal(api.jobs()[0].scanned, 1);
  assert.equal(api.jobs()[0].results.length, 1);
});

test('owner SPA navigation cancels the old scan and rejects its late results', async () => {
  const api = worker();
  const {job} = await api.begin();
  await api.page(job, [user(10)]);
  api.shared.tabs.get(1).url = 'https://x.com/bob';
  await api.message({type: 'PROFILE_VISIT', handle: 'bob'}, 1);
  assert.equal(api.jobs().length, 0);
  const response = await api.page(job, [user(11)]);
  assert.equal(response.continue, false);
  assert.equal(response.ok, false);
  assert.equal(api.jobs().length, 0);
  assert.deepEqual(api.shared.removed, [job.scanTabId]);
});

test('closing the scan tab preserves partial results and releases the next queued job', async () => {
  const api = worker();
  const {job: first} = await api.begin('alice', 1);
  await api.page(first, [user(10)]);
  const {job: second} = await api.begin('bob', 2);
  assert.equal(second.status, 'queued');
  assert.equal(api.shared.created.length, 1);
  api.shared.tabs.delete(first.scanTabId);
  api.onRemoved.emit(first.scanTabId, {});
  await flush();
  const [stopped, scanning] = api.jobs();
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.reason, 'tab-closed');
  assert.equal(stopped.results.length, 1);
  assert.equal(scanning.status, 'scanning');
  assert.equal(api.shared.created.length, 2);
});

test('a reconstructed MV3 worker continues its session job without opening another tab', async () => {
  const original = worker();
  const {job} = await original.begin();
  await original.page(job, [user(10)]);
  const resumed = worker(original.shared);
  const context = await resumed.message({type: 'BF_CONTEXT'}, job.scanTabId);
  assert.equal(context.role, 'scan');
  assert.equal(context.job.id, job.id);
  assert.equal(original.shared.created.length, 1);
  await resumed.page(job, [user(10), user(11)], {requestCursor: 'cursor-1', page: {users: [user(10), user(11)], hasTimeline: true, exhausted: true, nextCursor: null}});
  assert.equal(resumed.jobs()[0].status, 'complete');
  assert.deepEqual(resumed.jobs()[0].results.map((candidate) => candidate.id), ['10', '11']);
  assert.equal(original.shared.created.length, 1);
});

test('worker startup starts a persisted queued job without waiting for a content message', async () => {
  const original = worker();
  const {job} = await original.begin();
  const stored = original.shared.session.radarState.jobs[0];
  stored.status = 'queued';
  stored.scanTabId = null;
  original.shared.tabs.delete(job.scanTabId);
  const resumed = worker(original.shared);
  await flush();
  assert.equal(resumed.jobs()[0].status, 'scanning');
  assert.equal(original.shared.created.length, 2);
  assert.equal(original.shared.tabs.get(resumed.jobs()[0].scanTabId).url, 'https://x.com/alice/verified_followers');
});

test('worker startup finishes navigation when it was interrupted after creating a blank scanner tab', async () => {
  const original = worker();
  const {job} = await original.begin();
  original.shared.tabs.get(job.scanTabId).url = 'about:blank';
  const resumed = worker(original.shared);
  await flush();
  assert.equal(resumed.jobs()[0].status, 'scanning');
  assert.equal(original.shared.created.length, 1);
  assert.equal(original.shared.tabs.get(job.scanTabId).url, 'https://x.com/alice/verified_followers');
});

test('serializes scans across owners and starts the queued job after the first completes', async () => {
  const api = worker(memory({enabled: true, maxResults: 1}));
  const {job: first} = await api.begin('alice', 1);
  const {job: second} = await api.begin('bob', 2);
  assert.equal(second.status, 'queued');
  assert.equal(api.shared.created.length, 1);
  await api.page(first, [user(10)]);
  assert.deepEqual(api.jobs().map((job) => job.status), ['complete', 'scanning']);
  assert.equal(api.shared.created.length, 2);
  assert.equal(api.shared.tabs.get(api.jobs()[1].scanTabId).url, 'https://x.com/bob/verified_followers');
});

test('does not start for an ineligible, stale or malformed profile', async () => {
  const api = worker();
  const {response} = await api.begin('alice', 1, {isBlueVerified: false});
  assert.equal(response.ok, false);
  assert.equal(api.shared.created.length, 0);
  assert.equal((await api.message({type: 'START_SCAN', profile: profile('bob')}, 1)).ok, false);
  assert.equal((await api.message({type: 'START_SCAN', profile: profile('alice', 'not-an-id')}, 1)).ok, false);
  assert.equal(api.jobs().length, 0);
});

test('stops on access/rate-limit errors and retains results already found', async () => {
  for (const [status, reason] of [[429, 'rate-limit'], [403, 'access']]) {
    const api = worker();
    const {job} = await api.begin();
    await api.page(job, [user(10)]);
    assert.equal((await api.page(job, [], {status})).continue, false);
    assert.equal(api.jobs()[0].reason, reason);
    assert.equal(api.jobs()[0].status, 'error');
    assert.equal(api.jobs()[0].results.length, 1);
  }
});

test('time limit rejects additional results and preserves partial matches', async () => {
  const api = worker();
  const {job} = await api.begin();
  await api.page(job, [user(10)]);
  api.shared.now = job.deadline;
  assert.equal((await api.page(job, [user(11)])).continue, false);
  assert.equal(api.jobs()[0].reason, 'time-limit');
  assert.deepEqual(api.jobs()[0].results.map((candidate) => candidate.id), ['10']);
});

test('enforces user and page bounds when there are too few qualifying accounts', async () => {
  for (const [pages, size, expectedScanned] of [[6, 500, 3000], [100, 1, 100]]) {
    const api = worker();
    const {job} = await api.begin();
    let reply;
    for (let pageNumber = 0; pageNumber < pages; pageNumber++) {
      const users = Array.from({length: size}, (_, index) => user(pageNumber * size + index + 1000, {following: 1}));
      reply = await api.page(job, users, {requestCursor: `request-${pageNumber}`,
        page: {users, hasTimeline: true, exhausted: false, nextCursor: `cursor-${pageNumber}`}});
    }
    assert.equal(reply.continue, false);
    assert.equal(api.jobs()[0].reason, 'scan-limit');
    assert.equal(api.jobs()[0].scanned, expectedScanned);
    assert.equal(api.jobs()[0].results.length, 0);
  }
});

test('does not close a scanner tab the user has navigated to another page', async () => {
  const api = worker();
  const {job} = await api.begin();
  const nextUrl = 'https://x.com/home';
  api.shared.tabs.get(job.scanTabId).url = nextUrl;
  api.onUpdated.emit(job.scanTabId, {url: nextUrl});
  await flush();
  assert.equal(api.jobs()[0].reason, 'navigation');
  assert.equal(api.shared.tabs.get(job.scanTabId).url, nextUrl);
  assert.equal(api.shared.removed.length, 0);
});

test('owner navigation without URL visibility still cancels and closes its scan', async () => {
  const api = worker();
  const {job} = await api.begin();
  await api.page(job, [user(10)]);
  delete api.shared.tabs.get(1).url;
  api.onUpdated.emit(1, {status: 'complete'});
  await flush();
  assert.equal(api.jobs()[0].reason, 'navigation');
  assert.equal(api.jobs()[0].status, 'stopped');
  assert.equal(api.jobs()[0].results.length, 1);
  assert.deepEqual(api.shared.removed, [job.scanTabId]);
  assert.equal(api.shared.tabs.has(1), true);
});

test('scanner navigation without URL visibility stops without closing the navigated tab', async () => {
  const api = worker();
  const {job} = await api.begin();
  await api.page(job, [user(10)]);
  delete api.shared.tabs.get(job.scanTabId).url;
  api.onUpdated.emit(job.scanTabId, {status: 'complete'});
  await flush();
  assert.equal(api.jobs()[0].reason, 'navigation');
  assert.equal(api.jobs()[0].status, 'stopped');
  assert.equal(api.jobs()[0].results.length, 1);
  assert.equal(api.shared.removed.length, 0);
  assert.equal(api.shared.tabs.has(job.scanTabId), true);
});

test('only the exact extension popup may save settings, including when opened in a tab', async () => {
  const api = worker();
  api.addOwner(1, 'alice');
  const preferences = {enabled: true, maxResults: 7, hideFollowedUsers: false};
  const trusted = await api.message({type: 'SET_SETTINGS', settings: preferences}, 1,
    {url: 'chrome-extension://radar-extension/popup.html?view=settings#target'});
  assert.equal(trusted.ok, true);
  assert.deepEqual(trusted.settings, preferences);
  assert.deepEqual(api.shared.local.settings, preferences);
  const content = await api.message({type: 'SET_SETTINGS', settings: {enabled: false, maxResults: 99}}, 1);
  assert.equal(content.ok, false);
  const prefix = await api.message({type: 'SET_SETTINGS', settings: {enabled: false, maxResults: 99}}, 1,
    {url: 'chrome-extension://radar-extension/popup.html-other'});
  assert.equal(prefix.ok, false);
  assert.deepEqual(api.shared.local.settings, preferences);
});
