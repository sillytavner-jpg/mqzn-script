const fs = require('fs');
const path = require('path');

// Generate JSON
const js = fs.readFileSync(path.resolve(__dirname, '../备份/fix12-data-persistence/index.js'), 'utf-8');
const obj = { type: 'script', enabled: true, name: 'mqzn-script-fix12', id: 'mqzn-script-fix12', content: js };
const out = path.resolve(__dirname, '../备份/fix12-data-persistence/明月秋青脚本-fix12.json');
fs.writeFileSync(out, JSON.stringify(obj));
console.log('Generated: ' + out + ' (' + js.length + ' chars)');

// Verify localStorage + parent
const j = JSON.parse(fs.readFileSync(out, 'utf-8'));
const c = j.content;

// Check for window.parent.localStorage pattern
let foundParent = false;
let idx = c.indexOf('parent).localStorage');
if (idx >= 0) {
  foundParent = true;
  console.log('\nFOUND window.parent.localStorage at ' + idx);
  console.log('Context:', c.substring(Math.max(0, idx - 80), idx + 120));
}

// Also check for plain localStorage.getItem(mqzn...)
idx = c.indexOf('mqzn_global_settings');
if (idx >= 0) {
  console.log('\nFOUND mqzn_global_settings at ' + idx);
  console.log('Load context:', c.substring(Math.max(0, idx - 300), idx + 200));
}

// Verify load priority: localStorage > script > chat embedded
const loadMatch = c.match(/console\.info\('\[智脑\] 从 localStorage 加载全局设置'\)/);
console.log('\nLoad priority log:', loadMatch ? 'FOUND' : 'MISSING');

// Verify save uses window.parent/localStorage
const savePattern = /parent.*localStorage.*setItem.*mqzn/i;
console.log('Save pattern:', savePattern.test(c) ? 'FOUND' : 'MISSING');

// Count setItem for mqzn
let count = 0;
let pos = -1;
let foundTarget = false;
while ((pos = c.indexOf('setItem', pos + 1)) !== -1) {
  const ctx = c.substring(Math.max(0, pos), pos + 80);
  if (ctx.includes('mqzn') || ctx.includes('T,')) {
    console.log('\nPotential mqzn setItem at ' + pos + ': ' + ctx);
    foundTarget = true;
  }
  count++;
  if (count > 20) break;
}

if (!foundTarget) {
  console.log('\nWARNING: No mqzn setItem found!');
} else {
  console.log('\nOK: mqzn setItem found');
}

// Final summary
console.log('\n=== SUMMARY ===');
console.log('File size:', c.length, 'chars');
console.log('window.parent.localStorage:', foundParent ? 'YES' : 'NO');
console.log('Valid JSON:', 'YES');
