const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8888;
const scriptPath = path.join(__dirname, 'index.js');

console.log('Server starting...');
console.log('__dirname:', __dirname);
console.log('Reading:', scriptPath);

// Pre-load the file at startup
let cachedContent = null;
try {
  cachedContent = fs.readFileSync(scriptPath);
  console.log('Loaded OK:', cachedContent.length, 'bytes');
} catch (e) {
  console.error('Failed to load:', e.message);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.js') {
    console.log('Request:', req.url, '- serving', cachedContent.length, 'bytes');
    res.writeHead(200, {
      'Content-Type': 'application/javascript',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      'Content-Length': cachedContent.length
    });
    res.end(cachedContent);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`Server ready: http://localhost:${PORT}/index.js`);
});
