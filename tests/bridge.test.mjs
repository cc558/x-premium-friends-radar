import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const coreSource = readFileSync(new URL("../extension/shared/core.js", import.meta.url), "utf8");
const bridgeSource = readFileSync(new URL("../extension/bridge.js", import.meta.url), "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
const user = (id = "123") => ({ rest_id: id, is_blue_verified: true, legacy: { screen_name: `Friend${id}`, name: `好友${id}`, followers_count: 100, friends_count: 90, profile_image_url_https: "https://pbs.twimg.com/avatar.jpg" }, secret: "never forward" });
const profile = id => ({ data: { user: { result: user(id) } } });
const verified = { data: { user: { result: { timeline_v2: { timeline: { instructions: [{ type: "TimelineAddEntries", entries: [{ entryId: "user-123", content: { itemContent: { __typename: "TimelineUser", user_results: { result: user() } } } }] }] } } } } } };
const graphqlURL = (operation, variables = {}) => `https://x.com/i/api/graphql/query-id/${operation}?variables=${encodeURIComponent(JSON.stringify(variables))}`;

function runtime({ href = "https://x.com/owner/verified_followers", payload = verified, status = 200 } = {}) {
  const posts = [];
  const fetchCalls = [];
  const windowListeners = new Map();
  const response = { status, clone: () => ({ json: () => Promise.resolve(payload) }) };
  const fetchPromise = Promise.resolve(response);
  class XHR {
    constructor() { this.events = new Map(); this.responseType = ""; this.responseText = JSON.stringify(payload); this.status = status; this.onload = null; }
    open(...args) { this.openArgs = args; return "open-result"; }
    send(...args) {
      this.sendArgs = args;
      for (const record of [...(this.events.get("load") || [])]) {
        record.handler.call(this, { target: this });
        if (record.once) this.removeEventListener("load", record.handler);
      }
      this.onload?.({ target: this });
      return "send-result";
    }
    addEventListener(type, handler, options) {
      const records = this.events.get(type) || [];
      records.push({ handler, once: options?.once });
      this.events.set(type, records);
    }
    removeEventListener(type, handler) { this.events.set(type, (this.events.get(type) || []).filter(record => record.handler !== handler)); }
  }
  const sandbox = {
    URL, location: new URL(href), XMLHttpRequest: XHR,
    fetch: function (...args) { fetchCalls.push({ receiver: this, args }); return fetchPromise; },
    addEventListener: (type, listener) => windowListeners.set(type, listener),
    postMessage: (event, origin) => posts.push({ event: plain(event), origin }),
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(coreSource, context);
  vm.runInContext(bridgeSource, context);
  const ready = overrides => windowListeners.get("message")?.({ source: vm.runInContext("window", context), origin: sandbox.location.origin, data: { source: "blue-friends-controller", type: "BRIDGE_READY" }, ...overrides });
  return { context, sandbox, posts, fetchCalls, fetchPromise, response, ready, XHR };
}

test("fetch observer preserves the exact promise, call receiver, args, and response body", async () => {
  const runtimeState = runtime({ payload: profile("123") });
  const receiver = { app: "x" };
  const options = { credentials: "include", headers: { authorization: "secret-token" } };
  const url = graphqlURL("UserByScreenName", { screen_name: "Friend123" });
  const result = runtimeState.context.fetch.call(receiver, url, options);
  assert.equal(result, runtimeState.fetchPromise);
  assert.equal(runtimeState.fetchCalls[0].receiver, receiver);
  assert.equal(runtimeState.fetchCalls[0].args[0], url);
  assert.equal(runtimeState.fetchCalls[0].args[1], options);
  assert.equal(await result, runtimeState.response);
  await settle();
  assert.equal(runtimeState.posts.length, 1);
  const posted = runtimeState.posts[0];
  assert.equal(posted.origin, "https://x.com");
  assert.equal(posted.event.type, "PROFILE_DATA");
  assert.equal(posted.event.profile.handle, "friend123");
  const serialized = JSON.stringify(posted.event);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("never forward"), false);
});

test("only the four allowed X GraphQL operations are observed", async () => {
  const state = runtime();
  for (const url of [
    "https://example.com/i/api/graphql/id/VerifiedFollowers",
    "https://x.com.evil.com/i/api/graphql/id/VerifiedFollowers",
    "http://x.com/i/api/graphql/id/VerifiedFollowers",
    "https://x.com/api/graphql/id/VerifiedFollowers",
    graphqlURL("HomeTimeline"),
    graphqlURL("Followers"),
  ]) state.context.fetch(url);
  await settle();
  assert.equal(state.posts.length, 0);
  state.context.fetch(graphqlURL("BlueVerifiedFollowers", { userId: "123", cursor: "cursor-1" }));
  await settle();
  assert.equal(state.posts.length, 1);
  assert.deepEqual(state.posts[0].event, {
    source: "blue-friends-radar", type: "VERIFIED_PAGE", page: { users: [{ id: "123", handle: "friend123", name: "好友123", avatar: "https://pbs.twimg.com/avatar.jpg", isBlueVerified: true, followers: 100, following: 90 }], nextCursor: null, exhausted: true, hasTimeline: true, error: null },
    targetId: "123", requestCursor: "cursor-1", handle: "owner", status: 200,
  });
});

test("same-origin controller readiness replays buffered events and ignores spoofed origins", async () => {
  const state = runtime({ payload: profile("123") });
  state.context.fetch(graphqlURL("UserByRestId", { userId: "123" }));
  await settle();
  assert.equal(state.posts.length, 1);
  state.ready({ origin: "https://evil.com" });
  state.ready({ source: {} });
  state.ready({ data: { source: "other", type: "BRIDGE_READY" } });
  assert.equal(state.posts.length, 1);
  state.ready();
  assert.equal(state.posts.length, 2);
  assert.deepEqual(state.posts[1], state.posts[0]);
});

test("replay is bounded to the most recent 20 observations", async () => {
  const state = runtime({ payload: profile("123") });
  for (let index = 0; index < 25; index += 1) state.context.fetch(graphqlURL("UserByRestId", { userId: String(index) }));
  await settle();
  assert.equal(state.posts.length, 25);
  state.ready();
  assert.equal(state.posts.length, 45);
});

test("XHR preserves open/send arguments, original handlers, and JSON responses", () => {
  const state = runtime({ status: 429 });
  const xhr = new state.XHR();
  let handlerCalls = 0;
  xhr.onload = () => { handlerCalls += 1; };
  xhr.responseType = "json";
  xhr.response = verified;
  const url = graphqlURL("VerifiedFollowers", { userId: "123" });
  assert.equal(xhr.open("GET", url, true, "user", "password"), "open-result");
  assert.deepEqual(xhr.openArgs, ["GET", url, true, "user", "password"]);
  assert.equal(xhr.send(null), "send-result");
  assert.deepEqual(xhr.sendArgs, [null]);
  assert.equal(handlerCalls, 1);
  assert.equal(state.posts.length, 1);
  assert.equal(state.posts[0].event.status, 429);
  assert.equal(state.posts[0].event.targetId, "123");
  assert.equal(state.posts[0].event.requestCursor, null);
  assert.equal(state.posts[0].event.page.hasTimeline, true);
});

test("unsupported response remains distinguishable and observer is not installed on other sites", async () => {
  const state = runtime({ payload: { data: {} }, status: 403 });
  state.context.fetch(graphqlURL("VerifiedFollowers", { userId: "123" }));
  await settle();
  assert.equal(state.posts[0].event.page.hasTimeline, false);
  assert.equal(state.posts[0].event.page.exhausted, false);
  assert.equal(state.posts[0].event.status, 403);
  const outside = runtime({ href: "https://example.com/owner/verified_followers" });
  outside.context.fetch(graphqlURL("VerifiedFollowers", { userId: "123" }));
  await settle();
  assert.equal(outside.posts.length, 0);
});
