/* MAIN-world observer: uses only responses that X itself has already requested. */
(() => {
  "use strict";
  const core = globalThis.BlueFriendsCore;
  if (!core || globalThis.__blueFriendsBridgeInstalled) return;
  const allowedHosts = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
  if (!allowedHosts.has(location.hostname)) return;
  Object.defineProperty(globalThis, "__blueFriendsBridgeInstalled", { value: true });

  const source = "blue-friends-radar";
  const recentEvents = [];
  const profileOperations = new Set(["UserByScreenName", "UserByRestId"]);

  function followersHandle() {
    const match = /^\/([^/]+)\/verified_followers\/?$/.exec(location.pathname);
    if (!match) return null;
    const handle = core.normalizeHandle(match[1]);
    return handle && core.profileHandle(`${location.origin}/${handle}`) ? handle : null;
  }

  function requestInfo(input) {
    try {
      const value = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
      const url = new URL(value, location.href);
      if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) || url.username || url.password) return null;
      const match = /^\/i\/api\/graphql\/[^/]+\/(UserByScreenName|UserByRestId|BlueVerifiedFollowers|VerifiedFollowers)\/?$/.exec(url.pathname);
      if (!match) return null;
      let variables = {};
      try { variables = JSON.parse(url.searchParams.get("variables") || "{}"); } catch { /* Unsupported variables are left empty. */ }
      const targetId = typeof variables?.userId === "string" && /^\d{1,30}$/.test(variables.userId) ? variables.userId : null;
      const requestCursor = typeof variables?.cursor === "string" && variables.cursor.length <= 4096 && variables.cursor ? variables.cursor : null;
      return { operation: match[1], targetId, requestCursor, handle: followersHandle() };
    } catch {
      return null;
    }
  }

  function post(event, remember = true) {
    if (remember) {
      recentEvents.push(event);
      if (recentEvents.length > 20) recentEvents.shift();
    }
    window.postMessage(event, location.origin);
  }

  function observe(info, payload, status) {
    if (!info) return;
    try {
      if (profileOperations.has(info.operation)) {
        const profile = core.parseProfile(payload);
        if (profile) post({ source, type: "PROFILE_DATA", profile });
      } else {
        post({
          source,
          type: "VERIFIED_PAGE",
          page: core.parseVerifiedPage(payload),
          targetId: info.targetId,
          requestCursor: info.requestCursor,
          handle: info.handle,
          status: Number.isInteger(status) && status >= 0 && status <= 599 ? status : 0,
        });
      }
    } catch { /* An observer must never interfere with the page's network code. */ }
  }

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.source !== "blue-friends-controller" || event.data?.type !== "BRIDGE_READY") return;
    recentEvents.forEach(item => post(item, false));
  });

  if (typeof globalThis.fetch === "function") {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = function (...args) {
      const promise = nativeFetch.apply(this, args);
      const info = requestInfo(args[0]);
      if (info) {
        // Return the original promise; JSON parsing uses a cloned response asynchronously.
        try {
          promise.then(response => {
            try {
              response.clone().json().then(
                payload => observe(info, payload, response.status),
                () => observe(info, null, response.status),
              );
            } catch { /* Some response types cannot be cloned. */ }
          }, () => {}).catch(() => {});
        } catch { /* Preserve nonstandard fetch implementations too. */ }
      }
      return promise;
    };
  }

  if (typeof globalThis.XMLHttpRequest === "function") {
    const prototype = globalThis.XMLHttpRequest.prototype;
    const nativeOpen = prototype.open;
    const nativeSend = prototype.send;
    const requests = new WeakMap();
    prototype.open = function (...args) {
      const result = nativeOpen.apply(this, args);
      requests.set(this, requestInfo(args[1]));
      return result;
    };
    prototype.send = function (...args) {
      const info = requests.get(this);
      if (!info) return nativeSend.apply(this, args);
      const onLoad = () => {
        if (requests.get(this) !== info) return;
        let payload = null;
        try {
          if (this.responseType === "json") payload = this.response;
          else if (!this.responseType || this.responseType === "text") payload = JSON.parse(this.responseText);
          else return;
        } catch { /* Emit a recognizable unsupported-response state for the scanner. */ }
        observe(info, payload, this.status);
      };
      this.addEventListener("load", onLoad, { once: true });
      try {
        return nativeSend.apply(this, args);
      } catch (error) {
        this.removeEventListener("load", onLoad);
        throw error;
      }
    };
  }
})();
