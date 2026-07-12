// 独立 HTTP 静态文件服务 — 端口 8889，服务 dist/ 目录
// 供开发时给酒馆加载编译产物，不依赖 webpack，常驻运行
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8889;
const DIST_DIR = path.join(__dirname, 'dist');

const MIME = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/src/index.js';
  const filePath = path.join(DIST_DIR, urlPath);

  // 防目录穿越
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      console.error(`[404] ${req.method} ${urlPath}`);
      return;
    }
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Content-Type', MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
    res.writeHead(200);
    res.end(data);
    console.info(`[200] ${req.method} ${urlPath} (${data.length} bytes)`);
  });
});

server.listen(PORT, () => {
  console.info('');
  console.info('============================================');
  console.info('  MQZN Dev HTTP Server');
  console.info('============================================');
  console.info(`  Root : ${DIST_DIR}`);
  console.info(`  URL  : http://localhost:${PORT}`);
  console.info(`  Entry: http://localhost:${PORT}/src/index.js`);
  console.info('  Ctrl+C to stop');
  console.info('============================================');
  console.info('');
  console.info('Waiting for requests... (run build-dev.bat to rebuild)');
  console.info('');
});