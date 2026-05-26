var path = require('path');
var fs = require('fs');

var js = fs.readFileSync(path.resolve(__dirname, '../备份/fix12-data-persistence/index.js'), 'utf-8');
var obj = {
    type: 'script',
    enabled: true,
    name: 'mqzn-script-fix12',
    id: 'mqzn-script-fix12',
    content: js
};
var out = path.resolve(__dirname, '../备份/fix12-data-persistence/明月秋青脚本-fix12.json');
fs.writeFileSync(out, JSON.stringify(obj));
console.log('done, ' + js.length + ' chars -> ' + out);
