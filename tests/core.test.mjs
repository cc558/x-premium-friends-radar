import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = vm.createContext({ URL });
vm.runInContext(readFileSync(new URL("../extension/shared/core.js", import.meta.url), "utf8"), context);
const core = context.BlueFriendsCore;
const plain = value => JSON.parse(JSON.stringify(value));

function legacyUser(overrides = {}) {
  return {
    __typename: "User", rest_id: "123", is_blue_verified: true,
    legacy: { screen_name: "Good_Friend", name: "好友", profile_image_url_https: "https://pbs.twimg.com/profile_images/123/avatar.jpg", followers_count: 100, friends_count: 81 },
    ...overrides,
  };
}

const userEntry = (raw, entryId = "user-123") => ({
  entryId,
  content: { __typename: "TimelineTimelineItem", itemContent: { __typename: "TimelineUser", user_results: { result: raw } } },
});
const cursor = value => ({ entryId: "cursor-bottom-1", content: { __typename: "TimelineTimelineCursor", cursorType: "Bottom", value } });
const pagePayload = instructions => ({ data: { user: { result: { timeline_v2: { timeline: { instructions } } } } } });

test("settings enforce a bounded configurable target while keeping defaults", () => {
  assert.deepEqual(plain(core.normalizeSettings()), { enabled: true, maxResults: 20, hideFollowedUsers: false });
  assert.deepEqual(plain(core.normalizeSettings({ enabled: false, maxResults: 200 })), { enabled: false, maxResults: 20, hideFollowedUsers: false });
  assert.equal(core.normalizeSettings({ maxResults: -3 }).maxResults, 1);
  assert.equal(core.normalizeSettings({ maxResults: 25.9 }).maxResults, 20);
  assert.equal(core.normalizeSettings({ maxResults: 15.9 }).maxResults, 15);
  assert.equal(core.normalizeSettings({ maxResults: "30" }).maxResults, 20);
  assert.equal(core.normalizeSettings({ maxResults: "10" }).maxResults, 10);
  for (const maxResults of [null, "", true, Infinity, "many"]) assert.equal(core.normalizeSettings({ maxResults }).maxResults, 20);
});

test("hide-followed preference defaults off and accepts only boolean true", () => {
  assert.equal(core.DEFAULT_SETTINGS.hideFollowedUsers, false);
  assert.equal(core.normalizeSettings({ hideFollowedUsers: true }).hideFollowedUsers, true);
  for (const hideFollowedUsers of [undefined, null, false, "true", "false", 1, 0, {}, []]) {
    assert.equal(core.normalizeSettings({ hideFollowedUsers }).hideFollowedUsers, false);
  }
});

test("profile matching excludes navigation, foreign hosts, and other profile sections", () => {
  assert.equal(core.normalizeHandle("@Good_Friend"), "good_friend");
  for (const handle of ["", "longlonglonglonglong", "space name", "a/b", "@@a", null]) assert.equal(core.normalizeHandle(handle), null);
  assert.equal(core.profileHandle("https://x.com/Good_Friend?lang=en"), "good_friend");
  assert.equal(core.profileHandle("https://twitter.com/Good_Friend/media/"), "good_friend");
  for (const url of ["https://x.com/home", "https://x.com/i/status/1", "https://x.com/user/status/1", "https://x.com/user/verified_followers", "https://x.com/user/following", "https://x.com/user/bogus", "https://example.com/user", "https://x.com.evil.com/user"]) assert.equal(core.profileHandle(url), null, url);
});

test("legacy and split user schemas preserve exact counts and strict Premium state", () => {
  const old = core.normalizeUser(legacyUser());
  assert.deepEqual(plain(old), { id: "123", handle: "good_friend", name: "好友", avatar: "https://pbs.twimg.com/profile_images/123/avatar.jpg", isBlueVerified: true, isFollowing: false, followers: 100, following: 81 });
  const modern = core.normalizeUser({ __typename: "UserWithVisibilityResults", user: {
    rest_id: "456", core: { screen_name: "New_Friend", name: "新的好友" },
    avatar: { image_url: "https://pbs.twimg.com/profile_images/456/avatar.png" },
    relationship_counts: { followers: 200, following: 161 },
    is_blue_verified: false, legacy: { verified: true, followers_count: 999, friends_count: 999 },
  } });
  assert.equal(modern.handle, "new_friend");
  assert.equal(modern.followers, 200);
  assert.equal(modern.following, 161);
  assert.equal(modern.isBlueVerified, false);
  assert.equal(core.normalizeUser(legacyUser({ is_blue_verified: "true" })).isBlueVerified, false);
  assert.equal(core.normalizeUser({ __typename: "UserUnavailable", message: "Unavailable" }), null);
  const metrics = core.normalizeUser({ rest_id: "7", core: { screen_name: "Metrics" }, public_metrics: { followers_count: 4, following_count: 5 } });
  assert.equal(metrics.followers, 4);
  assert.equal(metrics.following, 5);
});

test("viewer following uses strict relationship booleans across both X user schemas", () => {
  const normalize = overrides => core.normalizeUser(legacyUser(overrides));
  assert.equal(normalize({ relationship_perspectives: { following: true } }).isFollowing, true);
  assert.equal(normalize({ legacy: { screen_name: "Legacy", following: true } }).isFollowing, true);
  assert.equal(normalize({ legacy: { screen_name: "Legacy", following: false } }).isFollowing, false);
  assert.equal(normalize({ relationship_perspectives: { following: false }, legacy: { screen_name: "Conflict", following: true } }).isFollowing, false);
  assert.equal(normalize({ relationship_perspectives: { following: true }, legacy: { screen_name: "Conflict", following: false } }).isFollowing, true);
  assert.equal(normalize({ relationship_perspectives: { following: null }, legacy: { screen_name: "Fallback", following: true } }).isFollowing, true);
  for (const value of [undefined, null, "true", "false", 1, 0, {}, []]) {
    assert.equal(normalize({ relationship_perspectives: { following: value }, legacy: { screen_name: "Unknown", following: value } }).isFollowing, false);
  }
  assert.equal(normalize({ relationship_perspectives: { followed_by: true }, legacy: { screen_name: "Reverse", followed_by: true, follow_request_sent: true }, relationship_counts: { followers: 100, following: 900 } }).isFollowing, false);
  const wrapped = core.normalizeUser({ __typename: "UserWithVisibilityResults", user: { core: { screen_name: "Wrapped" }, relationship_perspectives: { following: true } } });
  assert.equal(wrapped.isFollowing, true);
});

test("normalized follow relationship survives sanitization without coercing unknown values", () => {
  const followed = core.normalizeUser(legacyUser({ relationship_perspectives: { following: true } }));
  assert.equal(core.sanitizeUser(followed).isFollowing, true);
  assert.equal(core.matches(followed), true, "Follow status does not change the requested ratio filter.");
  for (const isFollowing of [undefined, null, "true", 1, false]) {
    assert.equal(core.sanitizeUser({ ...followed, isFollowing }).isFollowing, false);
  }
  const page = core.parseVerifiedPage(pagePayload([{ type: "TimelineAddEntries", entries: [userEntry(legacyUser({ relationship_perspectives: { following: true } }))] }]));
  assert.equal(page.users[0].isFollowing, true);
});

test("unknown or rounded counts never become matches; zero and the exact boundary are handled", () => {
  assert.equal(core.matches({ followers: 100, following: 80 }), false);
  assert.equal(core.matches({ followers: 100, following: 81, isBlueVerified: false }), true);
  assert.equal(core.matches({ followers: 0, following: 0 }), false);
  assert.equal(core.matches({ followers: 0, following: 1 }), true);
  assert.equal(core.matches({ followers: 5, following: 4 }), false);
  assert.equal(core.matches({ followers: 5, following: 5 }), true);
  for (const value of [undefined, null, "100", -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(core.matches({ followers: value, following: 100 }), false);
    assert.equal(core.matches({ followers: 100, following: value }), false);
  }
  const raw = legacyUser({ legacy: { screen_name: "Counts", followers_count: "1.2K", friends_count: 900 } });
  const normalized = core.normalizeUser(raw);
  assert.equal(normalized.followers, null);
  assert.equal(normalized.following, 900);
  assert.equal(core.matches(normalized), false);
  // Both counts are valid safe integers, with an exact integer-ratio boundary.
  assert.equal(core.matches({ followers: 9007199254740990, following: 7205759403792792 }), false);
});

test("profile and sanitized user output exclude untrusted avatars and extra fields", () => {
  assert.equal(core.parseProfile({ data: { user: { result: legacyUser() } } }).handle, "good_friend");
  assert.equal(core.parseProfile({ errors: [{ message: "Denied" }] }), null);
  for (const avatar of ["javascript:alert(1)", "http://pbs.twimg.com/a", "https://pbs.twimg.com.evil.com/a", "https://evil.com/a", "https://user:password@pbs.twimg.com/a"]) {
    const user = core.sanitizeUser({ id: "123", handle: "Friend", name: "好友", avatar, followers: 10, following: 9, extra: "secret" });
    assert.equal(user.avatar, null);
    assert.equal(Object.hasOwn(user, "extra"), false);
  }
  assert.equal(core.sanitizeUser({ handle: "invalid handle" }), null);
});

test("verified timeline reads direct users, paginates, and omits tweets and recommendation modules", () => {
  const tweet = { entryId: "tweet-1", content: { itemContent: { __typename: "TimelineTweet", tweet_results: { result: { core: { user_results: { result: legacyUser({ rest_id: "999" }) } } } } } } };
  const recommendations = { entryId: "who-to-follow-1", content: { __typename: "TimelineTimelineModule", items: [userEntry(legacyUser({ rest_id: "999" }))] } };
  const page = core.parseVerifiedPage(pagePayload([{ type: "TimelineAddEntries", entries: [userEntry(legacyUser()), userEntry(legacyUser()), tweet, recommendations, cursor("next-page")] }]));
  assert.equal(page.hasTimeline, true);
  assert.equal(page.users.length, 1);
  assert.equal(page.users[0].handle, "good_friend");
  assert.equal(page.nextCursor, "next-page");
  assert.equal(page.exhausted, false);
});

test("timeline replacement, module additions, old schema, and explicit termination work", () => {
  const unknownCount = legacyUser({ rest_id: "456", legacy: { screen_name: "Unknown", name: "未知" } });
  const instructions = [
    { type: "TimelineAddEntries", entries: [cursor("old-cursor")] },
    { type: "TimelineReplaceEntry", entry: cursor("new-cursor") },
    { type: "TimelineAddToModule", moduleEntryId: "users-module", moduleItems: [{ item: userEntry(unknownCount).content }] },
    { type: "TimelineAddToModule", moduleEntryId: "suggested-users", moduleItems: [{ item: userEntry(legacyUser()).content }] },
  ];
  const payload = { data: { user: { result: { timeline: { timeline: { instructions } } } } } };
  const page = core.parseVerifiedPage(payload);
  assert.equal(page.nextCursor, "new-cursor");
  assert.equal(page.users.length, 1);
  assert.equal(page.users[0].followers, null);
  assert.equal(core.matches(page.users[0]), false);
  instructions.push({ type: "TimelineTerminateTimeline", direction: "Bottom" });
  const finished = core.parseVerifiedPage(payload);
  assert.equal(finished.exhausted, true);
  assert.equal(finished.nextCursor, null);
});

test("unsupported and empty timelines are distinct and GraphQL errors are sanitized", () => {
  const unsupported = core.parseVerifiedPage({ data: { unrelated: { instructions: [] } } });
  assert.equal(unsupported.hasTimeline, false);
  assert.equal(unsupported.exhausted, false);
  const empty = core.parseVerifiedPage(pagePayload([{ type: "TimelineAddEntries", entries: [] }]));
  assert.equal(empty.hasTimeline, true);
  assert.equal(empty.exhausted, true);
  const error = core.parseVerifiedPage({ errors: [{ code: 88, message: "Rate limit", secret: "do not expose" }] });
  assert.deepEqual(plain(error.error), { code: "88", message: "Rate limit" });
  assert.equal(Object.hasOwn(error.error, "secret"), false);
});
