const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8888;
const scriptPath = path.join(__dirname, 'index.js');

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(scriptPath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`服务器已启动: http://localhost:${PORT}/index.js`);
  console.log('按 Ctrl+C 停止');
});
