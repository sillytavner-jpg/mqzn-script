const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8889;
const scriptPath = path.join(__dirname, 'index.js');

console.log('__dirname:', __dirname);
console.log('scriptPath:', scriptPath);
console.log('File exists:', fs.existsSync(scriptPath));
if (fs.existsSync(scriptPath)) {
  console.log('File size:', fs.statSync(scriptPath).size);
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.js') {
    const content = fs.readFileSync(scriptPath);
    console.log('Serving', content.length, 'bytes');
    res.writeHead(200, {
      'Content-Type': 'application/javascript',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      'Content-Length': content.length
    });
    res.end(content);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
