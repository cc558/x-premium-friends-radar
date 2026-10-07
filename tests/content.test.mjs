import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const coreSource = await readFile(new URL('../extension/shared/core.js', import.meta.url), 'utf8');
const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
const copy = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return {promise, resolve}; };
const profile = (handle, changes = {}) => ({id: '42', handle, name: handle, avatar: null, isBlueVerified: true, followers: 100, following: 90, ...changes});
const stateFor = (handle, changes = {}) => ({handle, status: 'scanning', results: [], scanned: 0, skipped: 0, maxResults: 20, ...changes});

function events() {
  const callbacks = new Map();
  return {
    add(name, listener) { if (!callbacks.has(name)) callbacks.set(name, []); callbacks.get(name).push(listener); },
    emit(name, value) { for (const listener of callbacks.get(name) || []) listener(value); },
  };
}

function content(respond) {
  const state = {messages: [], panels: [], timers: [], scannerJobs: [], scannerEvents: [], scannerDestroyed: 0};
  const windowEvents = events();
  const runtimeEvents = events();
  const storageEvents = events();
  const documentEvents = events();
  const location = {href: 'https://x.com/alice', pathname: '/alice', origin: 'https://x.com'};
  const window = {addEventListener: (name, listener) => windowEvents.add(name, listener), postMessage() {}};
  const document = {hidden: false, addEventListener: (name, listener) => documentEvents.add(name, listener)};
  const defaultRespond = (message) => {
    if (message.type === 'BF_CONTEXT') return {ok: true, role: 'profile', settings: {enabled: true, maxResults: 20}};
    if (message.type === 'PROFILE_VISIT') return {ok: true, state: null};
    if (message.type === 'START_SCAN') return {ok: true, state: stateFor(message.profile.handle)};
    if (message.type === 'CANCEL_SCAN') return {ok: true, state: stateFor('alice', {status: 'stopped'})};
    return {ok: true};
  };
  const context = vm.createContext({
    URL, window, document, location,
    setInterval: (callback) => { state.timers.push(callback); return state.timers.length; },
    chrome: {
      runtime: {
        async sendMessage(message) { state.messages.push(copy(message)); return respond?.(message) ?? defaultRespond(message); },
        onMessage: {addListener: (callback) => runtimeEvents.add('message', callback)},
      },
      storage: {onChanged: {addListener: (callback) => storageEvents.add('change', callback)}},
    },
    BlueFriendsView: {
      create(callbacks) {
        const panel = {callbacks, states: [], removed: false, mounts: 0,
          render(value) { this.states.push(copy(value)); }, mount() { this.mounts++; }, remove() { this.removed = true; }};
        state.panels.push(panel); return panel;
      },
    },
    BlueFriendsScanner: {
      create(job) {
        state.scannerJobs.push(copy(job));
        return {accept: (value) => state.scannerEvents.push(copy(value)), destroy: () => { state.scannerDestroyed++; }};
      },
    },
  });
  vm.runInContext(coreSource, context);
  vm.runInContext(contentSource, context);
  async function bridge(data, values = {}) {
    windowEvents.emit('message', {source: window, origin: location.origin, data: {source: 'blue-friends-radar', ...data}, ...values});
    await flush();
  }
  async function route(handle) {
    location.pathname = `/${handle}`; location.href = `https://x.com/${handle}`;
    for (const callback of state.timers) callback(); await flush();
  }
  async function runtime(value) { runtimeEvents.emit('message', value); await flush(); }
  return {state, bridge, route, runtime, windowEvents, storageEvents, window, location};
}

test('buffers profile data before context resolves and automatically starts a blue profile once', async () => {
  const contextReady = deferred();
  const api = content((message) => message.type === 'BF_CONTEXT' ? contextReady.promise : undefined);
  await api.bridge({type: 'PROFILE_DATA', profile: profile('alice')});
  assert.equal(api.state.messages.length, 1);
  contextReady.resolve({ok: true, role: 'profile', settings: {enabled: true, maxResults: 20}});
  await flush();
  assert.deepEqual(api.state.messages.map((message) => message.type), ['BF_CONTEXT', 'PROFILE_VISIT', 'START_SCAN']);
  await api.bridge({type: 'PROFILE_DATA', profile: profile('alice')});
  assert.equal(api.state.messages.filter((message) => message.type === 'START_SCAN').length, 1);
  assert.equal(api.state.panels.at(-1).states.at(-1).handle, 'alice');
});

test('rejects foreign bridge messages and keeps non-blue profiles free of recommendation panels', async () => {
  const api = content();
  await flush();
  await api.bridge({type: 'PROFILE_DATA', profile: profile('alice')}, {source: {}});
  await api.bridge({type: 'PROFILE_DATA', profile: profile('alice')}, {origin: 'https://example.com'});
  await api.bridge({type: 'PROFILE_DATA', profile: profile('alice', {isBlueVerified: false})});
  assert.equal(api.state.messages.filter((message) => message.type === 'START_SCAN').length, 0);
  assert.equal(api.state.panels.length, 0);
});

test('a profile losing its blue badge cancels its scan and late state cannot remount the panel', async () => {
  const api = content();
  await flush();
  await api.bridge({type: 'PROFILE_DATA', profile: profile('alice')});
  const panel = api.state.panels.at(-1);
  const renders = panel.states.length;
  const mounts = panel.mounts;
  await api.bridge({type: 'PROFILE_DATA', profile: profile('alice', {isBlueVerified: false})});
  assert.equal(panel.removed, true);
  assert.equal(api.state.messages.at(-1).type, 'CANCEL_SCAN');
  assert.equal(api.state.messages.filter((message) => message.type === 'CANCEL_SCAN').length, 1);
  await api.runtime({type: 'SCAN_STATE', state: stateFor('alice', {status: 'stopped'})});
  await api.route('alice');
  assert.equal(api.state.panels.length, 1);
  assert.equal(panel.states.length, renders);
  assert.equal(panel.mounts, mounts);
});

test('rapid SPA navigation ignores late old-profile responses and pushes new visit before scanning', async () => {
  const oldStart = deferred();
  const api = content((message) => message.type === 'START_SCAN' && message.profile.handle === 'alice' ? oldStart.promise : undefined);
  await flush();
  await api.bridge({type: 'PROFILE_DATA', profile: profile('alice')});
  const oldPanel = api.state.panels.at(-1);
  assert.equal(oldPanel.states.at(-1).status, 'checking');
  await api.route('bob');
  await api.bridge({type: 'PROFILE_DATA', profile: profile('bob')});
  assert.equal(oldPanel.removed, true);
  const currentPanel = api.state.panels.at(-1);
  assert.equal(currentPanel.states.at(-1).handle, 'bob');
  oldStart.resolve({ok: true, state: stateFor('alice', {status: 'complete', results: [profile('oldfriend')]})});
  await flush();
  await api.runtime({type: 'SCAN_STATE', state: stateFor('alice', {status: 'complete'})});
  assert.equal(currentPanel.states.at(-1).handle, 'bob');
  assert.equal(oldPanel.states.length, 1);
  const bobVisit = api.state.messages.findIndex((message) => message.type === 'PROFILE_VISIT' && message.handle === 'bob');
  const bobStart = api.state.messages.findIndex((message) => message.type === 'START_SCAN' && message.profile.handle === 'bob');
  assert.ok(bobVisit !== -1 && bobStart > bobVisit);
});

test('returning to a profile starts a new visit using cached profile data', async () => {
  const api = content();
  await flush();
  await api.bridge({type: 'PROFILE_DATA', profile: profile('alice')});
  await api.route('bob');
  await api.route('alice');
  assert.equal(api.state.messages.filter((message) => message.type === 'START_SCAN').length, 2);
  assert.equal(api.state.panels.at(-1).states.at(-1).handle, 'alice');
});

test('scan tabs forward only bridge data to their assigned scanner and destroy it on pagehide', async () => {
  const api = content((message) => message.type === 'BF_CONTEXT'
    ? {ok: true, role: 'scan', settings: {enabled: true, maxResults: 20}, job: {id: 'job-1', handle: 'alice', profileId: '42'}}
    : undefined);
  await flush();
  await api.bridge({type: 'VERIFIED_PAGE', handle: 'alice', targetId: '42', page: {users: []}});
  assert.equal(api.state.scannerJobs.length, 1);
  assert.equal(api.state.scannerEvents.length, 1);
  assert.equal(api.state.messages.filter((message) => message.type === 'PROFILE_VISIT').length, 0);
  assert.equal(api.state.panels.length, 0);
  api.windowEvents.emit('pagehide', {});
  assert.equal(api.state.scannerDestroyed, 1);
});

test('retry and stop actions send explicit worker commands and show resulting state', async () => {
  const api = content();
  await flush();
  await api.bridge({type: 'PROFILE_DATA', profile: profile('alice')});
  const panel = api.state.panels.at(-1);
  await panel.callbacks.onCancel();
  await flush();
  assert.equal(api.state.messages.at(-1).type, 'CANCEL_SCAN');
  assert.equal(panel.states.at(-1).status, 'stopped');
  panel.callbacks.onRetry();
  await flush();
  assert.equal(api.state.messages.at(-1).type, 'START_SCAN');
  assert.equal(api.state.messages.at(-1).force, true);
});
