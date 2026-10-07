const modulesPath = process.env.CODEX_NODE_MODULES;
const { chromium } = require(modulesPath ? `${modulesPath}/playwright` : 'playwright');
const assert = require('node:assert/strict');
const { resolve, join } = require('node:path');
const { tmpdir } = require('node:os');
const path = resolve(__dirname,'../extension');
const screenshot = name => join(tmpdir(),name);
(async () => {
  const browser = await chromium.launch({ headless:true, executablePath:process.env.CHROME_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
  const page = await browser.newPage({ viewport:{ width:680,height:900 } });
  await page.route('http://bluefriends.test/**', route => route.fulfill({ contentType:'text/html; charset=utf-8', body:'<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"></head><body style="margin:0;background:white;color:#0f1419;font-family:Arial"><div data-testid="primaryColumn" style="width:650px"><header style="padding:20px;border-bottom:1px solid #eee">X · 用户主页</header><div id="profile" style="padding:20px"><div data-testid="UserName"><h1>示例账号</h1><p>@example</p></div><div data-testid="UserProfileHeader_Items">2022 年加入</div><div><a href="/example/following">200 正在关注</a> · <a href="/example/verified_followers">1000 关注者</a></div></div><article>这是一条推文</article></div></body></html>' }));
  await page.route('https://pbs.twimg.com/**', route => route.abort());
  await page.goto('http://bluefriends.test/example');
  await page.evaluate(() => { const attach = Element.prototype.attachShadow; Element.prototype.attachShadow = function(options) { const root = attach.call(this,{ ...options,mode:'open' }); globalThis.testShadow = root; return root; }; });
  await page.addScriptTag({ path:`${path}/view.js` });
  const rendered = await page.evaluate(() => {
    globalThis.testView = BlueFriendsView.create({ onRetry:() => { globalThis.retried = true; },onCancel:() => { globalThis.cancelled = true; } });
    globalThis.testState = { handle:'example',status:'scanning',scanned:83,skipped:2,maxResults:20,results:[
      { handle:'friend_one',name:'蓝朋友一号',avatar:'https://pbs.twimg.com/no-image',followers:1000,following:801,isFollowing:true },
      { handle:'friend_two',name:'<img src=x onerror=alert(1)>',avatar:'javascript:alert(1)',followers:0,following:1,isFollowing:false },
      { handle:'friend_three',name:'非常接近边界',followers:10000000,following:8000001 },
      { handle:'../../bad',name:'不应出现',followers:1,following:1 }
    ] };
    testView.render(testState);
    const mounted = testView.mount();
    testView.mount();
    return { mounted,hostCount:document.querySelectorAll('#blue-friends-radar-panel').length,profileAfter:document.querySelector('#profile').nextElementSibling.id,names:[...testShadow.querySelectorAll('.name')].map(n => n.textContent),images:testShadow.querySelectorAll('img').length,ratios:[...testShadow.querySelectorAll('.ratio')].map(n => n.textContent) };
  });
  assert.equal(rendered.mounted,true);
  assert.equal(rendered.hostCount,1);
  assert.equal(rendered.profileAfter,'blue-friends-radar-panel');
  assert.deepEqual(rendered.names,['蓝朋友一号','<img src=x onerror=alert(1)>','非常接近边界']);
  assert.ok(rendered.images <= 1);
  assert.equal(rendered.ratios[2],'关注比例 > 80%');
  const panel = page.locator('#blue-friends-radar-panel');
  const followed = await page.evaluate(() => [...testShadow.querySelectorAll('.card')].map(card => ({
    handle:card.querySelector('.handle').textContent, followed:!!card.querySelector('.following-badge')
  })));
  assert.deepEqual(followed,[
    {handle:'@friend_one',followed:true},
    {handle:'@friend_two',followed:false},
    {handle:'@friend_three',followed:false}
  ],'Only isFollowing:true should show an 已关注 badge; false and unknown remain unmarked.');
  assert.equal(await panel.locator('.following-badge').textContent(),'已关注');
  const expandedHeight = (await panel.boundingBox()).height;
  await panel.getByRole('button',{name:'收起推荐蓝朋友区块',exact:true}).click();
  assert.equal(await panel.getAttribute('data-collapsed'),'true');
  assert.equal(await panel.getByRole('button',{name:'展开推荐蓝朋友区块',exact:true}).getAttribute('aria-expanded'),'false');
  assert.equal(await panel.getByRole('heading',{name:'推荐蓝朋友',exact:true}).isVisible(),true);
  for (const selector of ['.body','.eyebrow','.scan-actions','.status','.progress','.results','footer']) {
    assert.equal(await panel.locator(selector).isVisible(),false,`${selector} must be hidden when the block is collapsed.`);
  }
  const collapsedButtons = await page.evaluate(() => [...testShadow.querySelectorAll('button')]
    .filter(button => button.getClientRects().length > 0).map(button => button.getAttribute('aria-label')));
  assert.deepEqual(collapsedButtons,['展开推荐蓝朋友区块'],'The compact title bar must expose only its expand button.');
  assert.ok((await panel.boundingBox()).height < expandedHeight,'Collapsing must reduce the block height.');
  await page.evaluate(() => {
    testState = {...testState,scanned:110,results:[...testState.results.slice(0,3),
      {handle:'friend_four',name:'新发现的蓝朋友',followers:100,following:81,isFollowing:true}]};
    testView.render(testState);
    testView.mount();
  });
  assert.equal(await panel.getAttribute('data-collapsed'),'true','A scan render update must preserve the collapsed choice.');
  assert.equal(await panel.locator('.body').isVisible(),false);
  assert.equal(await panel.locator('.scan-actions').isVisible(),false);
  await page.screenshot({ path:screenshot('bluefriends-panel-collapsed.png') });
  await panel.getByRole('button',{name:'展开推荐蓝朋友区块',exact:true}).click();
  assert.equal(await panel.getAttribute('data-collapsed'),'false');
  assert.equal(await panel.getByRole('button',{name:'收起推荐蓝朋友区块',exact:true}).getAttribute('aria-expanded'),'true');
  assert.equal(await panel.locator('.body').isVisible(),true);
  assert.equal(await panel.locator('.scan-actions').isVisible(),true);
  assert.deepEqual(await panel.locator('.name').allTextContents(),['蓝朋友一号','<img src=x onerror=alert(1)>','非常接近边界','新发现的蓝朋友']);
  assert.equal(await panel.locator('.following-badge').count(),2,'Expanding must reveal the latest results and their followed markers.');
  assert.equal(await panel.locator('.following-badge').last().textContent(),'已关注');
  await panel.getByRole('button',{name:'停止',exact:true}).click();
  assert.equal(await page.evaluate(() => cancelled),true);
  await page.screenshot({ path:screenshot('bluefriends-panel-light.png') });
  await page.evaluate(() => { document.body.style.backgroundColor = 'rgb(21,32,43)'; document.body.style.color = '#f7f9f9'; testView.render({ handle:'example',status:'complete',scanned:110,maxResults:20,results:[{ handle:'friend_one',name:'蓝朋友一号',followers:1000,following:801 }] }); });
  assert.equal(await page.locator('#blue-friends-radar-panel').getAttribute('data-theme'),'dim');
  await page.screenshot({ path:screenshot('bluefriends-panel-dark.png') });
  await page.evaluate(() => testView.render({handle:'example',status:'not-premium'}));
  assert.equal(await page.locator('#blue-friends-radar-panel').isVisible(),false);
  await page.evaluate(() => testView.remove());
  assert.equal(await page.locator('#blue-friends-radar-panel').count(),0);
  const popup = await browser.newPage({ viewport:{width:360,height:650} });
  await popup.addInitScript(() => {
    globalThis.saved = null;
    globalThis.chrome = {runtime:{sendMessage:async message => {
      if (message.type === 'GET_SETTINGS') return {ok:true,settings:{enabled:true,maxResults:20,hideFollowedUsers:false}};
      if (message.type === 'SET_SETTINGS') { saved = message.settings; return {ok:true,settings:message.settings}; }
      if (message.type === 'GET_ACTIVE_STATE') return {ok:true,state:{handle:'example',status:'scanning',results:[{}]}};
      return {ok:false};
    }}};
  });
  await popup.goto(`file://${path}/popup.html`);
  await popup.locator('#save').waitFor();
  await popup.waitForFunction(() => !document.querySelector('#save').disabled);
  assert.equal(await popup.locator('#hide-followed-users').isChecked(),false);
  await popup.locator('#max-results').fill('17');
  await popup.locator('#enabled').uncheck();
  await popup.locator('#hide-followed-users').check();
  await popup.locator('#save').click();
  await popup.waitForFunction(() => document.querySelector('#feedback').textContent === '设置已保存。');
  assert.deepEqual(await popup.evaluate(() => saved),{enabled:false,maxResults:17,hideFollowedUsers:true});
  assert.equal(await popup.locator('#hide-followed-users').isChecked(),true);
  assert.equal(await popup.locator('#active-state').textContent(),'@example：扫描中，已找到 1 人。');
  await popup.screenshot({ path:screenshot('bluefriends-popup.png') });
  console.log('UI mock checks passed: profile placement, idempotence, untrusted text/avatar, ratio edge, strict followed markers, compact collapse, collapse retained across updates, latest results on expand, stop, themes, hidden panel, removal, settings persistence.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
