// v4独立存储版：构建 + 导出 JSON + 复制到服务器
var cp=require('child_process'),fs=require('fs'),p=require('path');
var BASE='D:/桌面/游戏/酒馆';
var SRC=p.join(BASE,'mqzn-build');
var DIST=p.join(SRC,'dist','src','index.js');
var OUT=p.join(BASE,'明月秋青脚本-独立存储版-v4.json');
var SERVER=p.join(BASE,'明月秋青脚本-修复版','index.js');

console.log('[v4版] 构建中...');
cp.execSync('npm run build',{cwd:SRC,stdio:'inherit'});

var js=fs.readFileSync(DIST,'utf8');
var m=js.replace(/\n/g,' ').replace(/\s+/g,' ').trim();
fs.writeFileSync(OUT,JSON.stringify({
  type:'script',enabled:true,name:'明月秋青脚本-独立存储版-v4',content:m
}),'utf8');
fs.copyFileSync(DIST,SERVER);
console.log('[v4版] 导出完成: '+OUT+' ('+(m.length/1024).toFixed(1)+' KB)');
console.log('[v4版] 复制到服务器: '+SERVER);
