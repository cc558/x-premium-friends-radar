(() => {
  'use strict';
  const Core = globalThis.BlueFriendsCore;
  const profiles = new Map();
  let context = null;
  let scanner = null;
  let settings = Core.DEFAULT_SETTINGS;
  let currentHandle = null;
  let lastPath = null;
  let generation = 0;
  let startedHandle = null;
  let latestState = null;
  let panel = null;
  const buffered = [];
  const send = (message) => chrome.runtime.sendMessage(message);
  function removePanel() { panel?.remove(); panel = null; latestState = null; }
  function render(state) {
    if (!settings.enabled || state?.handle !== currentHandle || profiles.get(currentHandle)?.isBlueVerified === false) return;
    latestState = state;
    panel ||= globalThis.BlueFriendsView.create({
      onRetry: () => { startedHandle = null; void tryStart(true); },
      onCancel: async () => {
        try {
          const result = await send({type: 'CANCEL_SCAN'});
          if (result.state) render(result.state);
        } catch {}
      }
    });
    panel.render(state);
    panel.mount();
  }
  async function tryStart(force = false) {
    const handle = currentHandle;
    const gen = generation;
    const profile = profiles.get(handle);
    if (!settings.enabled || !handle || !profile) return;
    if (!profile.isBlueVerified) {
      const wasStarted = startedHandle === handle;
      startedHandle = null;
      removePanel();
      if (wasStarted) { try { await send({type: 'CANCEL_SCAN'}); } catch {} }
      return;
    }
    if (startedHandle === handle && !force) return;
    startedHandle = handle;
    render({handle, status: 'checking', message: '准备扫描认证关注者…', results: [], scanned: 0, skipped: 0, maxResults: settings.maxResults});
    try {
      const result = await send({type: 'START_SCAN', profile, force});
      if (gen !== generation || currentHandle !== handle) return;
      if (result.ok && result.state) render(result.state);
      else if (!result.ok) render({handle, status: 'error', message: result.message || '未能启动扫描，请重试。', results: [], scanned: 0, skipped: 0, maxResults: settings.maxResults});
    } catch {
      if (gen === generation) render({handle, status: 'error', message: '扩展已重载，请刷新 X 页面。', results: [], scanned: 0, skipped: 0, maxResults: settings.maxResults});
    }
  }
  async function route(force = false) {
    if (context?.role !== 'profile') return;
    const path = location.pathname;
    if (path === lastPath && !force) {
      if (latestState) panel?.mount();
      return;
    }
    lastPath = path;
    const handle = Core.profileHandle(location.href);
    if (handle === currentHandle && !force) return;
    generation += 1;
    const gen = generation;
    currentHandle = handle;
    startedHandle = null;
    removePanel();
    try {
      const result = await send({type: 'PROFILE_VISIT', handle});
      if (gen !== generation) return;
      if (result.state?.handle === handle && settings.enabled) {
        startedHandle = handle;
        render(result.state);
      } else await tryStart();
    } catch {}
  }
  function consume(event) {
    if (!context) { if (buffered.length >= 30) buffered.shift(); buffered.push(event); return; }
    if (context.role === 'scan') { scanner?.accept(event); return; }
    if (event.type === 'PROFILE_DATA') {
      const profile = Core.sanitizeUser(event.profile);
      if (!profile) return;
      profiles.delete(profile.handle);
      profiles.set(profile.handle, profile);
      if (profiles.size > 60) profiles.delete(profiles.keys().next().value);
      if (profile.handle === currentHandle) void tryStart();
    }
  }
  // Install before the ready handshake so fast first responses cannot be lost.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'blue-friends-radar') return;
    if (!['PROFILE_DATA', 'VERIFIED_PAGE'].includes(event.data.type)) return;
    consume(event.data);
  });
  window.postMessage({source: 'blue-friends-controller', type: 'BRIDGE_READY'}, location.origin);
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'SCAN_STATE' && context?.role === 'profile' && message.state?.handle === currentHandle) render(message.state);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings || context?.role !== 'profile') return;
    settings = Core.normalizeSettings(changes.settings.newValue);
    void route(true);
  });
  send({type: 'BF_CONTEXT'}).then(async (reply) => {
    if (!reply?.ok) return;
    context = reply;
    settings = Core.normalizeSettings(reply.settings);
    if (reply.role === 'scan') scanner = globalThis.BlueFriendsScanner.create(reply.job);
    else await route();
    for (const event of buffered.splice(0)) consume(event);
    if (reply.role === 'profile') {
      setInterval(() => { void route(); }, 600);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) void route(); });
    }
  }).catch(() => {});
  window.addEventListener('pagehide', () => scanner?.destroy());
})();
