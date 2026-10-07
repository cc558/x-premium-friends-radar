const demoNames = ['林间风', 'Nora', '许三水', '小宇宙', 'Ming', '陈慢慢', 'Alex', '一只海獭', '阿远', 'Riley', '南山', 'Mo'];
const demoResults = demoNames.map((name, index) => ({
  id: String(index + 1), handle: `demo_friend_${index + 1}`, name, avatar: null,
  isBlueVerified: true, isFollowing: index % 4 === 0, followers: 400 + index * 112, following: 380 + index * 105
}));
const demoState = {handle: 'radar_demo', status: 'complete', reason: 'exhausted',
  results: demoResults, maxResults: 20, scanned: 86, skipped: 2, message: '示例：认证关注者已扫描完毕，找到 12 位朋友。'};
const previewPanel = globalThis.BlueFriendsView.create({onRetry: () => previewPanel.render(demoState)});
previewPanel.render(demoState);
previewPanel.mount();
document.querySelector('#theme').addEventListener('click', () => {
  document.body.classList.toggle('light');
  previewPanel.render(demoState);
});
