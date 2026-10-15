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

function runtime({ href = "https://x.com/owner/verified_followers", payload = verified, status = 200, viewerHandles = [] } = {}) {
  const posts = [];
  const fetchCalls = [];
  const profileLinks = [...viewerHandles];
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
    document: { querySelectorAll: selector => selector === 'a[data-testid="AppTabBar_Profile_Link"][href]'
      ? profileLinks.map(href => ({ getAttribute: () => href, secret: "private-dom" })) : [] },
    fetch: function (...args) { fetchCalls.push({ receiver: this, args }); return fetchPromise; },
    addEventListener: (type, listener) => windowListeners.set(type, listener),
    postMessage: (event, origin) => posts.push({ event: plain(event), origin }),
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(coreSource, context);
  vm.runInContext(bridgeSource, context);
  const ready = overrides => windowListeners.get("message")?.({ source: vm.runInContext("window", context), origin: sandbox.location.origin, data: { source: "blue-friends-controller", type: "BRIDGE_READY" }, ...overrides });
  return { context, sandbox, posts, fetchCalls, fetchPromise, response, ready, XHR, profileLinks };
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
  assert.equal(Object.hasOwn(posted.event, "requestViewerHandle"), false);
  assert.equal(posted.event.profile.handle, "friend123");
  const serialized = JSON.stringify(posted.event);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("never forward"), false);
});

test("only the five allowed X GraphQL operations are observed", async () => {
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
    source: "blue-friends-radar", type: "VERIFIED_PAGE", page: { users: [{ id: "123", handle: "friend123", name: "好友123", avatar: "https://pbs.twimg.com/avatar.jpg", isBlueVerified: true, isFollowing: false, isFollowedBy: null, followers: 100, following: 90 }], nextCursor: null, exhausted: true, hasTimeline: true, error: null },
    targetId: "123", requestCursor: "cursor-1", handle: "owner", status: 200,
  });
});

test("verified-page observations and replay retain the viewer follow relationship", async () => {
  const payload = plain(verified);
  const followed = payload.data.user.result.timeline_v2.timeline.instructions[0].entries[0].content.itemContent.user_results.result;
  followed.relationship_perspectives = { following: true, followed_by: false };
  const state = runtime({ payload });
  state.context.fetch(graphqlURL("BlueVerifiedFollowers", { userId: "123" }));
  await settle();
  assert.equal(state.posts[0].event.page.users[0].isFollowing, true);
  assert.equal(state.posts[0].event.page.users[0].isFollowedBy, false);
  state.ready();
  assert.equal(state.posts[1].event.page.users[0].isFollowing, true);
  assert.equal(state.posts[1].event.page.users[0].isFollowedBy, false);
});

test("Following pages snapshot the route and request metadata and replay only normalized data", async () => {
  const payload = plain(verified);
  const raw = payload.data.user.result.timeline_v2.timeline.instructions[0].entries[0].content.itemContent.user_results.result;
  raw.relationship_perspectives = { followed_by: false, secret: "private-relationship" };
  raw.legacy.followed_by = true;
  payload.private = "private-payload";
  const state = runtime({ href: "https://x.com/Owner_Name/following/?lang=en", payload, status: 206 });
  state.context.fetch(graphqlURL("Following", { userId: "456", cursor: "next-following", secret: "private-variable" }), { headers: { authorization: "private-token" } });
  state.sandbox.location = new URL("https://x.com/another/following");
  await settle();
  assert.equal(state.posts.length, 1);
  const event = state.posts[0].event;
  assert.equal(event.type, "FOLLOWING_PAGE");
  assert.equal(event.handle, "owner_name");
  assert.equal(event.targetId, "456");
  assert.equal(event.requestCursor, "next-following");
  assert.equal(event.status, 206);
  assert.equal(event.requestViewerHandle, null);
  assert.equal(event.page.users[0].isFollowedBy, false);
  assert.equal(JSON.stringify(event).includes("private-"), false);
  assert.equal(JSON.stringify(event).includes("never forward"), false);
  state.ready();
  assert.deepEqual(state.posts[1].event, event);
});

test("Following requests snapshot a unique sidebar viewer before navigation and exclude unrelated DOM data", async () => {
  const state = runtime({ href: "https://x.com/owner/following", viewerHandles: ["/Old_Viewer?private=private-query", "https://x.com/OLD_VIEWER"] });
  state.context.fetch(graphqlURL("Following", { userId: "123" }));
  state.profileLinks.splice(0, state.profileLinks.length, "/New_Viewer");
  state.sandbox.location = new URL("https://x.com/new_viewer/following");
  await settle();
  const event = state.posts[0].event;
  assert.equal(event.handle, "owner");
  assert.equal(event.requestViewerHandle, "old_viewer");
  assert.equal(JSON.stringify(event).includes("private-"), false);
  state.ready();
  assert.deepEqual(state.posts[1].event, event);
});

test("Following viewer snapshots remain unknown without a unique valid sidebar profile", async () => {
  for (const viewerHandles of [[], ["/alice", "/bob"], ["https://evil.com/alice"], ["/home"], ["/alice/following"], ["invalid handle"]]) {
    const state = runtime({ href: "https://x.com/owner/following", viewerHandles });
    state.context.fetch(graphqlURL("Following", { userId: "123" }));
    await settle();
    assert.equal(state.posts[0].event.requestViewerHandle, null, JSON.stringify(viewerHandles));
  }
  const noDocument = runtime({ href: "https://x.com/owner/following" });
  delete noDocument.sandbox.document;
  noDocument.context.fetch(graphqlURL("Following", { userId: "123" }));
  await settle();
  assert.equal(noDocument.posts[0].event.requestViewerHandle, null);
});

test("Following observation obeys the strict host and operation path allowlist", async () => {
  const state = runtime({ href: "https://x.com/owner/following" });
  for (const url of [
    "https://example.com/i/api/graphql/id/Following",
    "https://x.com.evil.com/i/api/graphql/id/Following",
    "https://user:secret@x.com/i/api/graphql/id/Following",
    "http://x.com/i/api/graphql/id/Following",
    "https://x.com/api/graphql/id/Following",
    "https://x.com/i/api/graphql/id/Following/extra",
    "https://x.com/i/api/graphql/id/following",
    "https://x.com/i/api/graphql/id/FollowingExtra",
    "https://x.com/i/api/graphql/id/Followers?operationName=Following",
  ]) state.context.fetch(url);
  await settle();
  assert.equal(state.posts.length, 0);
  for (const host of ["x.com", "www.x.com", "twitter.com", "www.twitter.com"]) {
    state.context.fetch(`https://${host}/i/api/graphql/id/Following/?variables=${encodeURIComponent('{"userId":"123"}')}`);
  }
  await settle();
  assert.equal(state.posts.length, 4);
  assert.equal(state.posts.every(({ event }) => event.type === "FOLLOWING_PAGE" && event.handle === "owner"), true);
});

test("Following route capture rejects unrelated routes and malformed handles or variables", async () => {
  for (const path of ["/owner", "/owner/verified_followers", "/owner/following/extra", "/home/following", "/longlonglonglonglong/following", "/%6fwner/following"]) {
    const state = runtime({ href: `https://x.com${path}` });
    state.context.fetch(graphqlURL("Following", { userId: "private-id", cursor: { secret: "private-cursor" } }));
    await settle();
    assert.equal(state.posts[0].event.handle, null, path);
    assert.equal(state.posts[0].event.targetId, null);
    assert.equal(state.posts[0].event.requestCursor, null);
    assert.equal(JSON.stringify(state.posts[0].event).includes("private-"), false);
  }
  const state = runtime({ href: "https://x.com/owner/following" });
  state.context.fetch(graphqlURL("VerifiedFollowers", { userId: "123" }));
  await settle();
  assert.equal(state.posts[0].event.type, "VERIFIED_PAGE");
  assert.equal(state.posts[0].event.handle, null, "Following routes must not become verified-follower routes.");
});

test("XHR Following pages retain the route at open and unknown follows-you state", () => {
  const state = runtime({ href: "https://twitter.com/Owner/following", viewerHandles: ["/Owner"] });
  const xhr = new state.XHR();
  xhr.open("GET", graphqlURL("Following", { userId: "789", cursor: "xhr-next" }));
  state.sandbox.location = new URL("https://twitter.com/other/following");
  state.profileLinks.splice(0, state.profileLinks.length, "/Other");
  xhr.send();
  assert.equal(state.posts[0].event.type, "FOLLOWING_PAGE");
  assert.equal(state.posts[0].event.handle, "owner");
  assert.equal(state.posts[0].event.requestViewerHandle, "owner");
  assert.equal(state.posts[0].event.targetId, "789");
  assert.equal(state.posts[0].event.requestCursor, "xhr-next");
  assert.equal(state.posts[0].event.page.users[0].isFollowedBy, null);
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
