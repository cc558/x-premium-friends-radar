(() => {
  'use strict';
  const form = document.querySelector('#settings-form');
  const enabled = document.querySelector('#enabled');
  const hideFollowedUsers = document.querySelector('#hide-followed-users');
  const maxResults = document.querySelector('#max-results');
  const save = document.querySelector('#save');
  const feedback = document.querySelector('#feedback');
  const active = document.querySelector('#active-state');

  function report(message, isError = false) {
    feedback.textContent = message;
    feedback.dataset.error = String(isError);
  }

  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || '扩展暂时没有响应，请重新加载扩展后重试。');
    return response;
  }

  function showSettings(settings) {
    enabled.checked = settings?.enabled !== false;
    hideFollowedUsers.checked = settings?.hideFollowedUsers === true;
    const value = settings?.maxResults;
    maxResults.value = Number.isInteger(value) && value >= 1 && value <= 20 ? String(value) : '20';
  }

  function showState(state) {
    if (!state) { active.textContent = '打开 X 用户主页后，推荐区块会出现在主页里。'; return; }
    const name = state.handle ? `@${state.handle}` : '这个账号';
    const found = Array.isArray(state.results) ? state.results.length : 0;
    const messages = {
      checking:`${name}：正在确认蓝标状态。`,
      queued:`${name}：等待扫描。`,
      scanning:`${name}：扫描中，已找到 ${found} 人。`,
      complete:`${name}：扫描完成，找到 ${found} 人。`,
      stopped:`${name}：扫描停止，保留 ${found} 人。`,
      error:`${name}：扫描暂时失败，可在主页点击重试。`,
      'not-premium':`${name}：未检测到蓝标 Premium 状态。`
    };
    active.textContent = messages[state.status] || `${name}：打开主页查看推荐。`;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const amount = Number(maxResults.value);
    if (!Number.isInteger(amount) || amount < 1 || amount > 20) {
      report('推荐人数请输入 1–20 之间的整数。',true);
      maxResults.focus();
      return;
    }
    save.disabled = true;
    try {
      const response = await send({ type:'SET_SETTINGS', settings:{ enabled:enabled.checked, hideFollowedUsers:hideFollowedUsers.checked, maxResults:amount } });
      showSettings(response.settings);
      report('设置已保存。');
      try { showState((await send({ type:'GET_ACTIVE_STATE' })).state); } catch { /* Settings were saved successfully. */ }
    } catch (error) { report(error.message || '保存失败，请重试。',true); }
    finally { save.disabled = false; }
  });

  Promise.allSettled([
    send({ type:'GET_SETTINGS' }).then(response => { showSettings(response.settings); save.disabled = false; }),
    send({ type:'GET_ACTIVE_STATE' }).then(response => showState(response.state))
  ]).then(results => {
    if (results[0].status === 'rejected') report('无法读取设置，请重新加载扩展后再打开。',true);
    if (results[1].status === 'rejected') active.textContent = '暂时无法读取页面状态。打开 X 主页后重试。';
  });
})();
