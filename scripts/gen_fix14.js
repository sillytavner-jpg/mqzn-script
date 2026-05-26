const fs = require('fs');
const path = require('path');

// Generate fix14 JSON
const js = fs.readFileSync(path.resolve(__dirname, '../dist/src/index.js'), 'utf-8');
const outDir = path.resolve(__dirname, '../dist');
const jsonOut = path.resolve(outDir, '明月秋青脚本.json');

// Use the same id format as fix14 normally uses
const obj = { type: 'script', enabled: true, name: '明月秋青脚本', id: 'mqzn-script', content: js };
fs.writeFileSync(jsonOut, JSON.stringify(obj));
console.log('fix14 JSON: ' + jsonOut + ' (' + js.length + ' chars)');

// Verify localStorage in compiled code
const c = js;
let ok = true;

// Check mqzn_global_settings
if (c.indexOf('mqzn_global_settings') < 0) { ok = false; console.log('FAIL: mqzn_global_settings not found'); }
// Check load log
if (c.indexOf('从 localStorage 加载全局设置') < 0) { ok = false; console.log('FAIL: load log not found'); }
// Check save
if (!/setItem.*JSON\.stringify/i.test(c)) { ok = false; console.log('FAIL: save pattern not found'); }
// Check window.parent
if (c.indexOf('(window.parent||window)') < 0) { ok = false; console.log('FAIL: window.parent pattern not found'); }

if (ok) console.log('ALL CHECKS PASSED');
