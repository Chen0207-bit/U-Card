/**
 * 优卡 U-Card Demo — Node 本地壳 (静态服务 + API 分发到 core.js)
 * 用法: node server.js  →  http://localhost:5177
 *  - /            运营后台/销售工作台 admin.html
 *  - /app         用户端 H5 app.html
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const body = (req) => new Promise(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } }); });
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,x-user,x-sales,x-app-key,x-mch', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' }; // 允许 file:// 双击打开页面直连本服务(x-mch: 商户门户)

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  const q = Object.fromEntries(url.searchParams);
  try {
    if (p.startsWith('/api/')) {
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
      const b = req.method === 'GET' ? {} : await body(req);
      const r = handleApi(req.method, p, q, b, req.headers);
      res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
      return res.end(JSON.stringify(r.json));
    }
    let file = (p === '/' || p === '/admin') ? '/admin.html'
      : p === '/app' ? (/Mobile|Android|iPhone/i.test(req.headers['user-agent'] || '') ? '/app.html' : '/app-pc.html')
      : p === '/app/select' ? '/app-select.html'
      : (p === '/app/m' || p === '/app/mobile') ? '/app.html'
      : p === '/app/pc' ? '/app-pc.html'
      : p === '/merchant' ? '/merchant.html' : p;
    const fp = path.join(__dirname, 'public', file);
    if (!fp.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end('403'); }
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: String(e) })); }
});
const PORT = 5177;
server.listen(PORT, () => console.log(`\n  优卡 U-Card Demo 已启动\n  ─ 后台/销售工作台:  http://localhost:${PORT}/\n  ─ 用户端H5:  http://localhost:${PORT}/app\n`));
