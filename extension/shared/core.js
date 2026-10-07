/* Shared, dependency-free data boundary for the content scripts and worker. */
(() => {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({ enabled: true, maxResults: 20, hideFollowedUsers: false });
  const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
  const RESERVED_HANDLES = new Set([
    "home", "explore", "i", "settings", "search", "notifications", "messages",
    "compose", "login", "logout", "signup", "account", "communities", "premium",
  ]);
  const PROFILE_TABS = new Set(["with_replies", "media", "highlights", "articles"]);

  function normalizeSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    const requested = typeof source.maxResults === "number" || (typeof source.maxResults === "string" && source.maxResults.trim())
      ? Number(source.maxResults)
      : NaN;
    return {
      enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_SETTINGS.enabled,
      hideFollowedUsers: source.hideFollowedUsers === true,
      maxResults: Number.isFinite(requested)
        ? Math.max(1, Math.min(20, Math.trunc(requested)))
        : DEFAULT_SETTINGS.maxResults,
    };
  }

  function normalizeHandle(value) {
    return typeof value === "string" && /^@?[A-Za-z0-9_]{1,15}$/.test(value)
      ? value.replace(/^@/, "").toLowerCase()
      : null;
  }

  function profileHandle(value) {
    try {
      const url = new URL(value);
      if (!X_HOSTS.has(url.hostname.toLowerCase()) || !["https:", "http:"].includes(url.protocol)) return null;
      const parts = url.pathname.replace(/\/$/, "").split("/").slice(1);
      if (parts.length !== 1 && !(parts.length === 2 && PROFILE_TABS.has(parts[1]))) return null;
      const handle = normalizeHandle(parts[0]);
      return handle && !RESERVED_HANDLES.has(handle) ? handle : null;
    } catch {
      return null;
    }
  }

  function count(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function firstCount(...values) {
    for (const value of values) {
      const normalized = count(value);
      if (normalized !== null) return normalized;
    }
    return null;
  }

  function identifier(value) {
    return typeof value === "string" && /^\d{1,30}$/.test(value) ? value : null;
  }

  function safeAvatar(value) {
    if (typeof value !== "string" || value.length > 2048) return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "pbs.twimg.com" && !url.username && !url.password
        ? url.href
        : null;
    } catch {
      return null;
    }
  }

  function safeName(value, fallback) {
    return typeof value === "string" && value.trim() ? value.slice(0, 120) : fallback;
  }

  // Revalidate cross-world messages and cache records without accepting GraphQL fields.
  function sanitizeUser(raw) {
    if (!raw || typeof raw !== "object") return null;
    const handle = normalizeHandle(raw.handle);
    if (!handle) return null;
    return {
      id: identifier(raw.id),
      handle,
      name: safeName(raw.name, handle),
      avatar: safeAvatar(raw.avatar),
      isBlueVerified: raw.isBlueVerified === true,
      isFollowing: raw.isFollowing === true,
      followers: count(raw.followers),
      following: count(raw.following),
    };
  }

  function unwrapUser(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.user && typeof raw.user === "object" && (raw.__typename === "UserWithVisibilityResults" || (!raw.core && !raw.legacy))) {
      return raw.user;
    }
    return raw;
  }

  function normalizeUser(raw) {
    const user = unwrapUser(raw);
    if (!user) return null;
    const handle = normalizeHandle(user.core?.screen_name ?? user.legacy?.screen_name);
    if (!handle) return null;
    return {
      id: identifier(user.rest_id ?? user.id_str ?? user.legacy?.id_str),
      handle,
      name: safeName(user.core?.name ?? user.legacy?.name, handle),
      avatar: safeAvatar(user.avatar?.image_url ?? user.legacy?.profile_image_url_https),
      isBlueVerified: user.is_blue_verified === true,
      // X separates the viewer's follow relationship from following counts.
      // An explicit modern false overrides an older positive legacy value.
      isFollowing: typeof user.relationship_perspectives?.following === "boolean"
        ? user.relationship_perspectives.following
        : user.legacy?.following === true,
      followers: firstCount(user.relationship_counts?.followers, user.legacy?.followers_count, user.public_metrics?.followers_count),
      following: firstCount(user.relationship_counts?.following, user.legacy?.friends_count, user.public_metrics?.following_count),
    };
  }

  function matches(user) {
    const followers = count(user?.followers);
    const following = count(user?.following);
    // Multiplication by integers avoids accepting the exact 80% boundary through rounding.
    return followers !== null && following !== null && BigInt(following) * 5n > BigInt(followers) * 4n;
  }

  function parseProfile(payload) {
    return normalizeUser(payload?.data?.user?.result);
  }

  function responseError(payload) {
    const error = Array.isArray(payload?.errors) ? payload.errors.find(item => item && typeof item === "object") : null;
    if (!error) return null;
    const rawCode = error.code ?? error.extensions?.code;
    return {
      code: typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode).slice(0, 80) : "GRAPHQL_ERROR",
      message: typeof error.message === "string" ? error.message.slice(0, 300) : "X returned an error.",
    };
  }

  function parseVerifiedPage(payload) {
    const result = unwrapUser(payload?.data?.user?.result);
    const candidates = [
      result?.timeline_v2?.timeline?.instructions,
      result?.timeline?.timeline?.instructions,
      result?.timeline?.instructions,
      payload?.data?.timeline_v2?.timeline?.instructions,
      payload?.data?.timeline?.timeline?.instructions,
      payload?.data?.timeline?.instructions,
    ];
    const instructions = candidates.find(Array.isArray);
    const page = { users: [], nextCursor: null, exhausted: false, hasTimeline: !!instructions, error: responseError(payload) };
    if (!instructions) return page;

    const seen = new Set();
    let recognized = instructions.length === 0;
    let terminated = false;
    const isRecommendation = value => typeof value === "string" && /who[-_]?to[-_]?follow|recommend|suggest|related|connect/i.test(value);

    function readItem(content) {
      if (!content || typeof content !== "object") return;
      const item = content.itemContent;
      // Only TimelineUser items qualify; never search recursively through tweet authors.
      if (item?.__typename !== "TimelineUser" && item?.itemType !== "TimelineUser") return;
      const user = normalizeUser(item.user_results?.result);
      if (!user) return;
      const key = user.id ?? user.handle;
      if (seen.has(key)) return;
      seen.add(key);
      page.users.push(user);
    }

    function readEntry(entry) {
      if (!entry || isRecommendation(entry.entryId)) return;
      const content = entry.content;
      if (content?.cursorType === "Bottom" || content?.cursorType === "ShowMore") {
        if (typeof content.value === "string" && content.value && content.value.length <= 4096) page.nextCursor = content.value;
        return;
      }
      // Modules usually contain recommendations and are deliberately excluded.
      if (content?.__typename === "TimelineTimelineModule" || content?.entryType === "TimelineTimelineModule" || Array.isArray(content?.items)) return;
      readItem(content);
    }

    for (const instruction of instructions) {
      if (!instruction || typeof instruction !== "object") continue;
      const type = instruction.type ?? instruction.__typename;
      if (type === "TimelineAddEntries") {
        recognized = true;
        if (Array.isArray(instruction.entries)) instruction.entries.forEach(readEntry);
      } else if (type === "TimelineReplaceEntry") {
        recognized = true;
        readEntry(instruction.entry);
      } else if (type === "TimelineAddToModule") {
        recognized = true;
        if (isRecommendation(instruction.moduleEntryId)) continue;
        if (Array.isArray(instruction.moduleItems)) {
          for (const moduleItem of instruction.moduleItems) {
            if (!isRecommendation(moduleItem?.entryId)) readItem(moduleItem?.item);
          }
        }
      } else if (type === "TimelineTerminateTimeline" && instruction.direction === "Bottom") {
        recognized = true;
        terminated = true;
      }
    }
    page.exhausted = terminated || (recognized && !page.nextCursor);
    if (terminated) page.nextCursor = null;
    return page;
  }

  globalThis.BlueFriendsCore = Object.freeze({
    DEFAULT_SETTINGS, normalizeSettings, normalizeHandle, profileHandle,
    normalizeUser, sanitizeUser, matches, parseProfile, parseVerifiedPage,
  });
})();
