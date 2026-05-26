const fs = require('fs');
const working = fs.readFileSync('D:/桌面/游戏/酒馆/明月秋青脚本-修复版/index -7+捕获+重新总结和回滚正常+时间正常.js', 'utf8');
const ours = fs.readFileSync('dist/src/index.js', 'utf8');

// Check for features that only exist in our source version
const features = [
  'emotionAccumulation', '情绪积累', 'emotionEnabled', 'emotionInterval',
  'plotFate', '倒果为因', 'plotFateEnabled',
  'nsfwIsolation', 'NSFW记录', '第四部分',
  'DreamtalkTab', 'SettingsTab',
  'executeEmotionAnalysis', 'executePlotFateAnalysis',
];

console.log('=== Feature presence ===');
for (const f of features) {
  const wHas = working.includes(f);
  const oHas = ours.includes(f);
  if (wHas !== oHas) {
    console.log(`${f}: 正常=${wHas} 源码=${oHas} *** DIFF ***`);
  }
}

// Check complete prompt chain sent to AI
console.log('\n=== 时间正常版 - complete ordered_prompts chain ===');
const wOp = working.match(/ordered_prompts:\[[^\]]+\]/);
if (wOp) console.log(wOp[0]);

console.log('\n=== 源码版 - complete ordered_prompts chain ===');
const oOp = ours.match(/ordered_prompts:\[[^\]]+\]/);
if (oOp) console.log(oOp[0]);
