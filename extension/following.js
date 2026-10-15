/* Decorate only the signed-in account's own Following timeline. */
(() => {
  'use strict';
  const Core = globalThis.BlueFriendsCore;
  const MARK = 'data-blue-friends-non-follower';
  const FILTERED = 'data-blue-friends-filtered';
  const HOST_ID = 'blue-friends-following-filter';
  const css = `
    :host { display:block; z-index:10; color:#0f1419; font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,"PingFang SC",sans-serif; color-scheme:light; }
    :host([data-theme="dark"]) { color:#e7e9ea; color-scheme:dark; }
    section { padding:16px; border:1px solid #f0b36c; border-radius:16px; background:#fff8ef; }
    :host([data-theme="dark"]) section { background:#2c2118; border-color:#735133; }
    button { width:100%; padding:9px 12px; border:1px solid #c9680d; border-radius:999px; background:transparent; color:inherit; font:inherit; font-weight:700; cursor:pointer; }
    button:hover { background:rgba(245,139,31,.12); }
    button[aria-pressed="true"] { background:#c9680d; color:#fff; }
    button:focus-visible { outline:2px solid #1d9bf0; outline-offset:3px; }
    .reload { margin-top:10px; font-weight:500; }
    p { margin:10px 0 0; overflow-wrap:anywhere; }
    .legend { display:flex; align-items:center; gap:7px; }
    .swatch { width:12px; height:12px; flex-shrink:0; background:rgba(255,153,51,.3); border:1px solid #c9680d; border-radius:3px; }
    .status { font-size:12px; opacity:.85; white-space:pre-line; }
  `;

  function handleFromLink(link) {
    try { return Core.profileHandle(new URL(link.getAttribute('href'), location.href).href); }
    catch { return null; }
  }

  function followingHandle() {
    const match = /^\/([^/]+)\/following\/?$/i.exec(location.pathname);
    const handle = match && Core.normalizeHandle(match[1]);
    return handle && Core.profileHandle(`${location.origin}/${handle}`) ? handle : null;
  }

  function viewerHandle() {
    const handles = new Set([...document.querySelectorAll('a[data-testid="AppTabBar_Profile_Link"][href]')]
      .map(handleFromLink).filter(Boolean));
    return handles.size === 1 ? [...handles][0] : null;
  }

  function create() {
    const users = new Map();
    const marked = new Set();
    const hidden = new Set();
    let routeHandle = null;
    let dataHandle = null;
    let lastViewer = null;
    let viewerChanged = false;
    let active = false;
    let onlyNonFollowers = false;
    let host = null;
    let button = null;
    let reload = null;
    let status = null;
    let style = null;
    let frame = null;
    let destroyed = false;
    let observing = false;

    function restore() {
      for (const node of marked) node.removeAttribute(MARK);
      for (const node of hidden) node.removeAttribute(FILTERED);
      marked.clear();
      hidden.clear();
    }

    function removeUI() {
      restore();
      host?.remove();
      style?.remove();
      host = button = reload = status = style = null;
    }

    function syncContext() {
      const nextRoute = followingHandle();
      const viewer = viewerHandle();
      const accountChanged = viewer && lastViewer && viewer !== lastViewer;
      if (accountChanged) {
        viewerChanged = true;
        users.clear();
        dataHandle = null;
      }
      if (nextRoute !== routeHandle || accountChanged) {
        onlyNonFollowers = false;
        removeUI();
      }
      routeHandle = nextRoute;
      if (viewer) lastViewer = viewer;
      active = !!routeHandle && viewer === routeHandle;
      if (active && dataHandle && dataHandle !== routeHandle) {
        users.clear();
        dataHandle = null;
      }
      if (!active) removeUI();
    }

    function makeUI(primary) {
      if (!style) {
        style = document.createElement('style');
        style.textContent = `
          [data-testid="primaryColumn"] [${MARK}="true"] { background-color:rgba(255,153,51,.24)!important; }
          [data-testid="primaryColumn"] [${FILTERED}="true"] { height:1px!important; min-height:0!important; padding:0!important; border-width:0!important; overflow:hidden!important; pointer-events:none!important; }
          [data-testid="primaryColumn"] [${FILTERED}="true"] [data-testid="UserCell"],
          [data-testid="primaryColumn"] [data-testid="UserCell"][${FILTERED}="true"] { display:none!important; }
        `;
      }
      if (!style.isConnected) (document.head || document.documentElement).append(style);
      if (!host) {
        host = document.createElement('div');
        host.id = HOST_ID;
        const shadow = host.attachShadow({mode:'closed'});
        const sheet = document.createElement('style');
        sheet.textContent = css;
        const section = document.createElement('section');
        section.setAttribute('aria-label', '正在关注筛选');
        button = document.createElement('button');
        button.type = 'button';
        button.addEventListener('click', () => {
          // A click can race an SPA navigation; recheck ownership first.
          syncContext();
          if (!active) return;
          onlyNonFollowers = !onlyNonFollowers;
          refresh();
        });
        const legend = document.createElement('p');
        legend.className = 'legend';
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.setAttribute('aria-hidden', 'true');
        legend.append(swatch, document.createTextNode('橙色表示未关注你'));
        status = document.createElement('p');
        status.className = 'status';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        reload = document.createElement('button');
        reload.type = 'button';
        reload.className = 'reload';
        reload.textContent = '刷新页面';
        reload.addEventListener('click', () => { syncContext(); if (active) location.reload(); });
        section.append(button, legend, status, reload);
        shadow.append(sheet, section);
      }
      const bounds = primary.getBoundingClientRect();
      const floating = window.innerWidth - bounds.right >= 256;
      if (floating) {
        if (host.parentElement !== document.body) document.body.append(host);
        host.style.cssText = `position:fixed;top:88px;left:${Math.round(bounds.right + 16)}px;width:224px;`;
      } else {
        // On narrow screens keep the same control right-aligned above the list.
        if (host.parentElement !== primary) primary.prepend(host);
        host.style.cssText = 'position:relative;margin:12px 16px 12px auto;width:min(260px,calc(100% - 32px));';
      }
      const colors = [primary, document.body, document.documentElement].map(node => getComputedStyle(node).backgroundColor);
      const color = colors.map(value => value.match(/[\d.]+/g)?.map(Number))
        .find(channels => channels?.length >= 3 && (channels.length < 4 || channels[3] > .5));
      const dark = color ? (color[0] + color[1] + color[2]) / 3 < 120 : matchMedia('(prefers-color-scheme:dark)').matches;
      host.dataset.theme = dark ? 'dark' : 'light';
    }

    function refresh() {
      if (destroyed) return;
      if (!observing && document.documentElement) {
        observer.observe(document.documentElement, {childList:true, subtree:true, attributes:true, attributeFilter:['href', 'data-testid']});
        observing = true;
      }
      syncContext();
      if (!active) return;
      const primary = document.querySelector('[data-testid="primaryColumn"]');
      if (!primary || !document.body) { removeUI(); return; }
      makeUI(primary);
      const nextMarked = new Set();
      const nextHidden = new Set();
      for (const row of primary.querySelectorAll('[data-testid="UserCell"]')) {
        // A UserCell may also link to handles in its bio; the account header is
        // the first profile link, before any description links.
        const handle = [...row.querySelectorAll('a[href]')].map(handleFromLink).find(Boolean);
        const user = users.get(handle);
        if (user?.isFollowedBy === false) nextMarked.add(row);
        // Rows absent from the observed Following response may be recommendations.
        // Never decorate or hide those unrelated modules.
        if (onlyNonFollowers && user && user.isFollowedBy !== false) {
          // Keep the native virtual cell measurable: a positive collapsed height
          // lets resize-driven timelines update offsets and retain pagination.
          nextHidden.add(row.closest('[data-testid="cellInnerDiv"]') || row);
        }
      }
      for (const node of marked) if (!nextMarked.has(node)) node.removeAttribute(MARK);
      for (const node of hidden) if (!nextHidden.has(node)) node.removeAttribute(FILTERED);
      marked.clear();
      hidden.clear();
      for (const node of nextMarked) {
        if (node.getAttribute(MARK) !== 'true') node.setAttribute(MARK, 'true');
        marked.add(node);
      }
      for (const node of nextHidden) {
        if (node.getAttribute(FILTERED) !== 'true') node.setAttribute(FILTERED, 'true');
        hidden.add(node);
      }
      const label = onlyNonFollowers ? '显示全部正在关注' : '只显示未关注你的';
      if (button.textContent !== label) button.textContent = label;
      button.setAttribute('aria-pressed', String(onlyNonFollowers));
      let nonFollowers = 0;
      let unknown = 0;
      for (const user of users.values()) {
        if (user.isFollowedBy === false) nonFollowers++;
        else if (user.isFollowedBy === null) unknown++;
      }
      let message = users.size ? `已加载 ${users.size} 人 · 未关注你 ${nonFollowers} 人` : '等待正在关注列表数据…';
      reload.hidden = !viewerChanged || users.size > 0;
      if (viewerChanged && !users.size) message = '等待当前账号的列表数据；可刷新页面重新读取。';
      if (unknown) message += `\n${unknown} 人关注关系未知，未计入筛选。`;
      if (onlyNonFollowers && !nonFollowers) message += '\n已加载用户中暂无可显示的账号；可先显示全部，再向下滚动加载。';
      if (status.textContent !== message) status.textContent = message;
    }

    function schedule() {
      if (destroyed || frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; refresh(); });
    }
    const observer = new MutationObserver(records => {
      if (!followingHandle() && !host) return;
      if (records.some(record => record.target !== host && !host?.contains(record.target) && record.target !== style)) schedule();
    });

    function accept(event) {
      if (destroyed || event?.type !== 'FOLLOWING_PAGE') return;
      syncContext();
      const requestViewer = Core.normalizeHandle(event.requestViewerHandle);
      if (active && requestViewer && requestViewer !== routeHandle) {
        viewerChanged = true;
        refresh();
        return;
      }
      if (!routeHandle || Core.normalizeHandle(event.handle) !== routeHandle ||
          (lastViewer && lastViewer !== routeHandle) ||
          (event.requestViewerHandle != null && !requestViewer) ||
          (requestViewer && requestViewer !== routeHandle) ||
          (viewerChanged && requestViewer !== routeHandle) ||
          !/^\d{1,30}$/.test(event.targetId) || !Number.isInteger(event.status) || event.status < 200 || event.status >= 300 ||
          !event.page?.hasTimeline || event.page.error || !Array.isArray(event.page.users)) return;
      if (dataHandle !== routeHandle) { users.clear(); dataHandle = routeHandle; }
      for (const raw of event.page.users) {
        const user = Core.sanitizeUser(raw);
        if (!user) continue;
        users.set(user.handle, user);
        if (users.size > 10000) users.delete(users.keys().next().value);
      }
      refresh();
    }

    window.addEventListener('resize', schedule);
    refresh();
    return Object.freeze({accept, refresh, destroy() {
      destroyed = true;
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      removeUI();
      users.clear();
    }});
  }

  globalThis.BlueFriendsFollowing = Object.freeze({create});
})();
