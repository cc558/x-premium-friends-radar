(() => {
  'use strict';
  const Core = globalThis.BlueFriendsCore;
  globalThis.BlueFriendsScanner = {
    create(job) {
      let stopped = false;
      let pending = false;
      let gotPage = false;
      let lastPageAt = Date.now();
      let lastKey = null;
      let chain = Promise.resolve();
      const send = (message) => chrome.runtime.sendMessage({...message, jobId: job.id});
      const isCurrentPath = () => location.pathname.toLowerCase() === `/${job.handle}/verified_followers`;
      function destroy() { stopped = true; clearInterval(timer); }
      async function stop(reason) {
        if (stopped) return;
        destroy();
        try { await send({type: 'SCAN_STOP', reason}); } catch {}
      }
      function accept(event) {
        if (stopped || event.type !== 'VERIFIED_PAGE' || event.targetId !== job.profileId ||
            Core.normalizeHandle(event.handle) !== job.handle || !isCurrentPath()) return;
        chain = chain.then(async () => {
          if (stopped) return;
          pending = true;
          try {
            const response = await send({type: 'SCAN_PAGE', page: event.page, targetId: event.targetId,
              requestCursor: event.requestCursor, handle: event.handle, status: event.status});
            if (!response?.ok || !response.continue) { destroy(); return; }
            gotPage = true;
            const key = `${event.requestCursor || ''}|${event.page.nextCursor || ''}|${event.page.users.map((user) => user.id || user.handle).join(',')}`;
            if (!response.duplicate && key !== lastKey) {
              lastPageAt = Date.now();
              lastKey = key;
            }
          } catch { await stop('scanner-error'); }
          finally { pending = false; }
        });
      }
      let ticking = false;
      async function tick() {
        if (stopped || ticking || pending) return;
        ticking = true;
        try {
          if (!isCurrentPath()) { await stop(location.pathname.includes('/login') ? 'login' : 'navigation'); return; }
          if (Date.now() >= job.deadline) { await stop('time-limit'); return; }
          if (!gotPage && Date.now() - lastPageAt > 30_000) { await stop('no-data'); return; }
          if (gotPage && Date.now() - lastPageAt > 45_000) { await stop('no-progress'); return; }
          const reply = await send({type: 'SCAN_HEARTBEAT'});
          if (!reply?.continue) { destroy(); return; }
          // Scroll the actual X list: X supplies its own current API/signatures.
          if (gotPage) {
            window.scrollBy({top: Math.max(window.innerHeight * 0.9, 500), behavior: 'instant'});
          }
        } catch { await stop('scanner-error'); }
        finally { ticking = false; }
      }
      const timer = setInterval(tick, 1800);
      return {accept, destroy};
    }
  };
})();
