import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const coreSource = await readFile(new URL('../extension/shared/core.js', import.meta.url), 'utf8');
const scannerSource = await readFile(new URL('../extension/scanner.js', import.meta.url), 'utf8');
const copy = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };

function scanner() {
  const job = {id: 'scan-1', handle: 'alice', profileId: '42', deadline: 180000};
  const state = {now: 0, messages: [], scrolls: [], timers: new Map(), respond: () => ({ok: true, continue: true})};
  const location = {pathname: '/alice/verified_followers'};
  const window = {innerHeight: 900, scrollBy: (options) => state.scrolls.push(copy(options))};
  class Clock extends Date { static now() { return state.now; } }
  const context = vm.createContext({
    URL, Date: Clock, location, window,
    chrome: {runtime: {async sendMessage(message) { state.messages.push(copy(message)); return state.respond(message); }}},
    setInterval(callback, delay) { state.timers.set(1, {callback, delay}); return 1; },
    clearInterval(id) { state.timers.delete(id); },
  });
  vm.runInContext(coreSource, context);
  vm.runInContext(scannerSource, context);
  const instance = context.BlueFriendsScanner.create(job);
  const valid = {type: 'VERIFIED_PAGE', targetId: '42', handle: 'alice', status: 200,
    page: {users: [{id: '1', handle: 'one'}], nextCursor: 'next', hasTimeline: true, exhausted: false}};
  async function accept(changes = {}) { instance.accept({...copy(valid), ...changes}); await flush(); }
  async function tick(now = state.now) { state.now = now; await state.timers.get(1)?.callback(); await flush(); }
  return {state, location, instance, accept, tick, valid};
}

test('accepts only verified pages matching the assigned profile and current path', async () => {
  const api = scanner();
  await api.accept({type: 'PROFILE_DATA'});
  await api.accept({targetId: 'other-profile'});
  await api.accept({handle: 'bob'});
  api.location.pathname = '/bob/verified_followers';
  await api.accept();
  assert.equal(api.state.messages.length, 0);
  api.location.pathname = '/alice/verified_followers';
  await api.accept({handle: 'ALICE'});
  assert.equal(api.state.messages.length, 1);
  assert.equal(api.state.messages[0].type, 'SCAN_PAGE');
  assert.equal(api.state.messages[0].jobId, 'scan-1');
  assert.equal(api.state.messages[0].targetId, '42');
});

test('scrolls after accepted data and stops all work when the worker says continue false', async () => {
  const api = scanner();
  await api.tick(1800);
  assert.equal(api.state.messages[0].type, 'SCAN_HEARTBEAT');
  assert.equal(api.state.scrolls.length, 0);
  await api.accept();
  await api.tick(3600);
  assert.deepEqual(api.state.scrolls, [{top: 810, behavior: 'instant'}]);
  api.state.respond = (message) => ({ok: true, continue: message.type !== 'SCAN_PAGE'});
  await api.accept({requestCursor: 'next'});
  const count = api.state.messages.length;
  await api.accept({requestCursor: 'later'});
  await api.tick(10000);
  assert.equal(api.state.messages.length, count);
  assert.equal(api.state.timers.size, 0);
  assert.equal(api.state.scrolls.length, 1);
});

test('forwards known and unknown viewer follow status with scan-page data', async () => {
  const api = scanner();
  const users = [
    {id: '1', handle: 'followed', isFollowing: true},
    {id: '2', handle: 'notfollowed', isFollowing: false},
    {id: '3', handle: 'unknown'},
  ];
  await api.accept({ page: {...api.valid.page, users} });
  assert.deepEqual(api.state.messages[0].page.users, users);
});

test('queued pages do not leak requests after an earlier page completes the scan', async () => {
  const api = scanner();
  let resolve;
  api.state.respond = (message) => message.type === 'SCAN_PAGE' ? new Promise((done) => { resolve = done; }) : {ok: true, continue: true};
  api.instance.accept(api.valid);
  api.instance.accept({...api.valid, requestCursor: 'next'});
  await flush();
  assert.equal(api.state.messages.length, 1);
  await api.tick(1800);
  assert.equal(api.state.messages.length, 1, 'pending page suppresses heartbeats and scrolls');
  resolve({ok: true, continue: false});
  await flush();
  assert.equal(api.state.messages.length, 1);
  assert.equal(api.state.timers.size, 0);
});

test('stops with no-data when no usable page arrives within 30 seconds', async () => {
  const api = scanner();
  await api.tick(30001);
  assert.deepEqual(api.state.messages, [{type: 'SCAN_STOP', reason: 'no-data', jobId: 'scan-1'}]);
  assert.equal(api.state.timers.size, 0);
  await api.accept();
  assert.equal(api.state.messages.length, 1);
});

test('duplicate pages do not extend the 45-second no-progress deadline', async () => {
  const api = scanner();
  await api.accept();
  api.state.now = 44000;
  api.state.respond = () => ({ok: true, continue: true, duplicate: true});
  await api.accept();
  await api.tick(45001);
  assert.equal(api.state.messages.at(-1).type, 'SCAN_STOP');
  assert.equal(api.state.messages.at(-1).reason, 'no-progress');
  assert.equal(api.state.scrolls.length, 0);
});

test('stops on route changes, login redirects and the total scan deadline', async () => {
  for (const [path, now, reason] of [
    ['/bob/verified_followers', 100, 'navigation'],
    ['/i/flow/login', 100, 'login'],
    ['/alice/verified_followers', 180000, 'time-limit'],
  ]) {
    const api = scanner();
    api.location.pathname = path;
    await api.tick(now);
    assert.equal(api.state.messages.at(-1).reason, reason);
    assert.equal(api.state.timers.size, 0);
  }
});

test('worker heartbeat cancellation stops before another scroll', async () => {
  const api = scanner();
  await api.accept();
  api.state.respond = () => ({ok: true, continue: false});
  await api.tick(1800);
  assert.equal(api.state.scrolls.length, 0);
  assert.equal(api.state.timers.size, 0);
});
