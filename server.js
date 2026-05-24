const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8888;
const scriptPath = path.join(__dirname, 'index.js');

console.log('Server starting...');
console.log('__dirname:', __dirname);
console.log('Serving:', scriptPath);

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '/index.js') {
    const content = fs.readFileSync(scriptPath);
    console.log('Request:', req.url, '- serving', content.length, 'bytes');
    res.writeHead(200, {
      'Content-Type': 'application/javascript',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Content-Length': content.length
    });
    res.end(content);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`Server ready: http://localhost:${PORT}/index.js`);
});
