/* Profile panel. All account-controlled strings are rendered as text. */
(() => {
  'use strict';

  const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
  const number = new Intl.NumberFormat('zh-CN');
  const percentage = new Intl.NumberFormat('zh-CN', { maximumFractionDigits:1 });
  const css = `
    :host { --bg:#fff; --text:#0f1419; --muted:#536471; --line:#eff3f4; --hover:#f7f9f9; --blue:#1d9bf0; display:block; color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC",sans-serif; margin:16px 16px 20px; color-scheme:light; }
    :host([hidden]) { display:none!important; }
    :host([data-theme="dark"]) { --bg:#000; --text:#e7e9ea; --muted:#71767b; --line:#2f3336; --hover:#101214; color-scheme:dark; }
    :host([data-theme="dim"]) { --bg:#15202b; --text:#f7f9f9; --muted:#8b98a5; --line:#38444d; --hover:#1c2938; color-scheme:dark; }
    * { box-sizing:border-box; }
    [hidden] { display:none!important; }
    section { background:var(--bg); border:1px solid var(--line); border-radius:16px; overflow:hidden; }
    header { padding:16px 16px 12px; display:flex; flex-wrap:wrap; gap:10px; align-items:flex-start; justify-content:space-between; }
    .title-block { flex:1; min-width:120px; }
    h2 { margin:0; font-size:20px; line-height:26px; font-weight:800; letter-spacing:-.3px; }
    .eyebrow { margin:5px 0 0; font-size:12px; line-height:18px; color:var(--muted); }
    .actions,.scan-actions { display:flex; gap:6px; flex-shrink:0; }
    button { font:inherit; font-size:12px; line-height:18px; font-weight:700; color:var(--text); background:transparent; border:1px solid var(--line); border-radius:999px; padding:6px 11px; cursor:pointer; }
    button:hover { background:var(--hover); }
    button:focus-visible,a:focus-visible { outline:2px solid var(--blue); outline-offset:3px; }
    button[hidden] { display:none; }
    .status { padding:0 16px 14px; color:var(--muted); font-size:13px; line-height:20px; overflow-wrap:anywhere; }
    .status strong { color:var(--blue); font-weight:700; }
    .progress { height:3px; background:var(--line); overflow:hidden; }
    .progress > span { display:block; height:100%; background:var(--blue); transition:width .25s; }
    .results { list-style:none; margin:0; padding:4px 8px 8px; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:2px; }
    .results:empty { display:none; }
    .card { display:flex; align-items:flex-start; gap:10px; border-radius:12px; padding:10px 8px; color:var(--text); text-decoration:none; min-width:0; }
    .card:hover { background:var(--hover); }
    .avatar { width:40px; height:40px; border-radius:50%; flex-shrink:0; object-fit:cover; background:var(--line); display:grid; place-items:center; font-size:18px; font-weight:700; color:var(--muted); }
    .info { min-width:0; }
    .name { display:block; font-size:14px; line-height:20px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .handle { display:block; font-size:12px; line-height:18px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .following-badge { display:inline-block; margin-top:3px; padding:1px 6px; border-radius:4px; background:var(--line); color:var(--text); font-size:11px; line-height:16px; font-weight:600; }
    .counts { display:block; margin-top:4px; color:var(--muted); font-size:11px; line-height:17px; }
    .ratio { display:inline-block; color:var(--blue); margin-top:2px; font-size:11px; line-height:17px; font-weight:600; }
    footer { padding:10px 16px; border-top:1px solid var(--line); font-size:11px; line-height:17px; color:var(--muted); }
    :host([data-collapsed="true"]) { margin-top:8px; margin-bottom:12px; }
    :host([data-collapsed="true"]) header { padding:8px 16px; align-items:center; }
    :host([data-collapsed="true"]) h2 { font-size:16px; line-height:22px; }
    @media(max-width:480px) { :host { margin:12px 12px 16px; } .results { grid-template-columns:minmax(0,1fr); } h2 { font-size:18px; } header { padding:14px 12px 10px; } .status { padding:0 12px 12px; } }
    @media(max-width:480px) { :host([data-collapsed="true"]) { margin:8px 12px 12px; } :host([data-collapsed="true"]) header { padding:6px 12px; } }
    @media(prefers-reduced-motion:reduce) { .progress > span { transition:none; } }
  `;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function safeAvatar(value) {
    if (typeof value !== 'string' || value.length > 2048) return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'pbs.twimg.com' && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }

  function count(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function profilePlacement(handle) {
    const primary = document.querySelector('[data-testid="primaryColumn"]');
    if (!primary || !HANDLE.test(handle)) return null;
    const name = [...primary.querySelectorAll('[data-testid="UserName"]')]
      .find(node => !node.closest('article'));
    const following = [...primary.querySelectorAll('a[href]')].find(link => {
      if (link.closest('article')) return false;
      try { return new URL(link.href, location.href).pathname.toLowerCase() === `/${handle.toLowerCase()}/following`; }
      catch { return false; }
    });
    if (name && following) {
      let parent = following.parentElement;
      while (parent && parent !== primary) {
        if (parent.contains(name)) return { primary, after:parent };
        parent = parent.parentElement;
      }
    }
    // Keep the panel next to the actual profile header, never next to a tweet.
    const items = [...primary.querySelectorAll('[data-testid="UserProfileHeader_Items"]')]
      .find(node => !node.closest('article'));
    if (items && name) return { primary, after:items.parentElement || items };
    return null;
  }

  function theme(host, primary) {
    let rgb = null;
    for (const node of [primary, document.body, document.documentElement]) {
      if (!node) continue;
      const value = getComputedStyle(node).backgroundColor;
      const channels = value.match(/[\d.]+/g)?.map(Number);
      if (channels?.length >= 3 && (channels.length < 4 || channels[3] > 0.5)) {
        rgb = channels.slice(0,3);
        break;
      }
    }
    if (!rgb) {
      host.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      return;
    }
    const [r,g,b] = rgb;
    host.dataset.theme = (r + g + b) / 3 >= 120 ? 'light' : b > r + 7 ? 'dim' : 'dark';
  }

  function statusMessage(state, found) {
    if (typeof state.message === 'string' && state.message.trim()) return state.message;
    switch (state.status) {
      case 'checking': return '正在确认这个账号是否为蓝标 Premium 账号…';
      case 'queued': return '正在等待扫描，推荐结果会在这里出现。';
      case 'scanning': return '正在扫描认证关注者，找到符合条件的人就会显示。';
      case 'complete': return found ? '扫描完成，以下账号符合你的筛选条件。' : '扫描完成，暂未找到符合条件的账号。';
      case 'stopped': return '扫描已停止，已找到的推荐仍可查看。';
      case 'error': return '暂时无法扫描，请确认 X 已登录且认证关注者列表可以访问，然后重试。';
      default: return '从认证关注者中寻找符合关注比例的账号。';
    }
  }

  function create({ onRetry = () => {}, onCancel = () => {} } = {}) {
    const host = element('div');
    host.id = 'blue-friends-radar-panel';
    const shadow = host.attachShadow({ mode:'closed' });
    const style = element('style', '', css);
    const section = element('section');
    section.setAttribute('aria-label', '推荐蓝朋友');
    const header = element('header');
    const titleBlock = element('div', 'title-block');
    const subtitle = element('p', 'eyebrow', '正在关注数 > 关注者数的 80%');
    titleBlock.append(element('h2', '', '推荐蓝朋友'), subtitle);
    const actions = element('div', 'actions');
    const scanActions = element('div', 'scan-actions');
    const retry = element('button', '', '刷新');
    retry.type = 'button';
    retry.setAttribute('aria-label', '重新扫描认证关注者');
    retry.addEventListener('click', () => onRetry());
    const cancel = element('button', '', '停止');
    cancel.type = 'button';
    cancel.addEventListener('click', () => onCancel());
    scanActions.append(retry, cancel);
    const collapse = element('button', 'collapse-toggle', '收起');
    collapse.type = 'button';
    collapse.setAttribute('aria-controls', 'blue-friends-radar-body');
    actions.append(scanActions, collapse);
    header.append(titleBlock, actions);
    const body = element('div', 'body');
    body.id = 'blue-friends-radar-body';
    const status = element('div', 'status');
    status.setAttribute('role','status');
    status.setAttribute('aria-live','polite');
    const progress = element('div', 'progress');
    const bar = element('span');
    progress.setAttribute('role','progressbar');
    progress.setAttribute('aria-label','推荐人数');
    progress.setAttribute('aria-valuemin','0');
    progress.append(bar);
    const results = element('ul','results');
    const footer = element('footer', '', '仅按公开数量筛选；推荐顺序与 X 返回的列表顺序一致。');
    body.append(status, progress, results, footer);
    section.append(header, body);
    shadow.append(style, section);
    let current = { status:'checking', results:[], maxResults:20 };
    let mountedHandle = '';
    let collapsed = false;

    function updateCollapsed() {
      host.dataset.collapsed = String(collapsed);
      body.hidden = collapsed;
      subtitle.hidden = collapsed;
      scanActions.hidden = collapsed;
      collapse.textContent = collapsed ? '展开' : '收起';
      collapse.setAttribute('aria-expanded', String(!collapsed));
      const label = collapsed ? '展开推荐蓝朋友区块' : '收起推荐蓝朋友区块';
      collapse.setAttribute('aria-label', label);
      collapse.title = label;
    }
    collapse.addEventListener('click', () => { collapsed = !collapsed; updateCollapsed(); });
    updateCollapsed();

    function mount() {
      if (current.status === 'not-premium') {
        host.hidden = true;
        return false;
      }
      const handle = current.handle || location.pathname.split('/').filter(Boolean)[0] || '';
      const placement = profilePlacement(handle);
      if (!placement) return false;
      if (!host.isConnected || mountedHandle.toLowerCase() !== handle.toLowerCase() || !placement.primary.contains(host)) {
        placement.after.insertAdjacentElement('afterend',host);
        mountedHandle = handle;
      }
      theme(host,placement.primary);
      return true;
    }

    function render(state = {}) {
      current = { ...state, results:Array.isArray(state.results) ? state.results.slice(0,20) : [] };
      host.hidden = state.status === 'not-premium';
      if (host.hidden) return;
      const active = ['checking','queued','scanning'].includes(state.status);
      cancel.hidden = !active;
      retry.textContent = state.status === 'error' || state.status === 'stopped' ? '重试' : '刷新';
      const valid = current.results.filter(user => user && HANDLE.test(user.handle || ''));
      const target = Number.isSafeInteger(state.maxResults) && state.maxResults > 0 ? Math.min(20,state.maxResults) : 20;
      footer.textContent = state.hideFollowedUsers === true
        ? '已隐藏已关注用户；推荐顺序与 X 返回的列表顺序一致。'
        : '仅按公开数量筛选；推荐顺序与 X 返回的列表顺序一致。';
      status.replaceChildren();
      const summary = element('strong', '', `${valid.length} / ${target} 人`);
      const scanned = count(state.scanned);
      const skipped = count(state.skipped);
      status.append(summary, document.createTextNode(scanned !== null ? ` · 已查看 ${number.format(scanned)} 人` : ''));
      if (skipped) status.append(document.createTextNode(` · ${number.format(skipped)} 人数据不完整`));
      status.append(element('div', '', statusMessage(state,valid.length)));
      progress.setAttribute('aria-valuemax',String(target));
      progress.setAttribute('aria-valuenow',String(Math.min(target,valid.length)));
      bar.style.width = `${Math.min(100,valid.length / target * 100)}%`;
      const cards = document.createDocumentFragment();
      for (const user of valid) {
        const li = element('li');
        const link = element('a','card');
        link.href = `https://x.com/${user.handle}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        const label = typeof user.name === 'string' && user.name ? user.name : user.handle;
        const fallback = () => element('span','avatar', [...label][0] || '?');
        const avatarUrl = safeAvatar(user.avatar);
        if (avatarUrl) {
          const avatar = element('img','avatar');
          avatar.alt = '';
          avatar.width = 40;
          avatar.height = 40;
          avatar.loading = 'lazy';
          avatar.referrerPolicy = 'no-referrer';
          avatar.addEventListener('error', () => avatar.replaceWith(fallback()), { once:true });
          avatar.src = avatarUrl;
          link.append(avatar);
        } else link.append(fallback());
        const info = element('div','info');
        const name = element('span','name',label);
        name.title = label;
        info.append(name,element('span','handle',`@${user.handle}`));
        if (user.isFollowing === true) info.append(element('span','following-badge','已关注'));
        const following = count(user.following);
        const followers = count(user.followers);
        if (following !== null && followers !== null) {
          info.append(element('span','counts',`关注 ${number.format(following)} · 粉丝 ${number.format(followers)}`));
          let ratioText = followers === 0 ? '关注比例：无粉丝' : `关注比例 ${percentage.format(following / followers * 100)}%`;
          if (followers > 0 && following / followers * 100 > 80 && following / followers * 100 < 80.05) ratioText = '关注比例 > 80%';
          const ratio = element('span','ratio',ratioText);
          ratio.title = `正在关注 ${following} / 关注者 ${followers}；筛选规则：${following} × 100 > ${followers} × 80`;
          info.append(ratio);
        }
        link.append(info);
        li.append(link);
        cards.append(li);
      }
      results.replaceChildren(cards);
      const primary = document.querySelector('[data-testid="primaryColumn"]');
      if (primary) theme(host,primary);
    }

    return Object.freeze({ mount, render, remove:() => { host.remove(); mountedHandle = ''; } });
  }

  globalThis.BlueFriendsView = Object.freeze({ create });
})();
