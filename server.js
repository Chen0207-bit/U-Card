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
import { createApp } from './src/app/create-app.js';
import { corsHeaders, SECURITY_HEADERS } from './src/runtime/http.js';
import { resolveStaticPath } from './src/runtime/static-routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const body = (req) => new Promise(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } }); });
const app = createApp({ env: process.env, defaults: { APP_MODE: 'demo', AUTH_MODE: 'demo-header', ALLOW_DEMO_RESET: 'true', CORS_ORIGINS: '*' } });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  const q = Object.fromEntries(url.searchParams);
  const cors = corsHeaders(app.config, req.headers.origin || '');
  try {
    if (p.startsWith('/api/')) {
      if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, ...SECURITY_HEADERS }); return res.end(); }
      const b = req.method === 'GET' ? {} : await body(req);
      const r = await app.handleApi(req.method, p, q, b, req.headers);
      res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Request-Id': r.requestId, ...cors, ...SECURITY_HEADERS });
      return res.end(JSON.stringify(r.json));
    }
    const file = resolveStaticPath(p, req.headers['user-agent'] || '');
    const publicRoot = path.resolve(__dirname, 'public');
    const fp = path.resolve(publicRoot, '.' + file);
    if (fp !== publicRoot && !fp.startsWith(publicRoot + path.sep)) { res.writeHead(403, SECURITY_HEADERS); return res.end('403'); }
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', ...SECURITY_HEADERS });
    fs.createReadStream(fp).pipe(res);
  } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: String(e) })); }
});
const PORT = 5177;
server.listen(PORT, () => console.log(`\n  优卡 U-Card Demo 已启动\n  ─ 后台/销售工作台:  http://localhost:${PORT}/\n  ─ 用户端H5:  http://localhost:${PORT}/app\n`));
