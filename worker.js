/**
 * 优卡 U-Card Demo — Cloudflare Worker 入口
 * 静态 assets + API 转发到 Durable Object(单实例内存状态, 演示强一致)
 * 部署: npx wrangler deploy  →  https://fc-ucard.<account>.workers.dev
 */
import { AppState } from './do.js';
export { AppState }; // DO class 必须从入口模块导出

export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url);
      if (url.pathname.startsWith('/api/')) {
        const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,x-user,x-sales', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
        const id = env.APP_STATE.idFromName('global');
        const resp = await env.APP_STATE.get(id).fetch(req);
        const h = new Headers(resp.headers);
        for (const [k, v] of Object.entries(CORS)) h.set(k, v);
        return new Response(resp.body, { status: resp.status, headers: h });
      }
      // 静态: /app 按设备直达(电脑→网页版, 手机→H5), /app/select 保留手动选择
      if (url.pathname === '/' || url.pathname === '/admin') url.pathname = '/admin.html';
      else if (url.pathname === '/app') {
        const ua = req.headers.get('user-agent') || '';
        url.pathname = /Mobile|Android|iPhone/i.test(ua) ? '/app.html' : '/app-pc.html';
      }
      else if (url.pathname === '/app/select') url.pathname = '/app-select.html';
      else if (url.pathname === '/app/m' || url.pathname === '/app/mobile') url.pathname = '/app.html';
      else if (url.pathname === '/app/pc') url.pathname = '/app-pc.html';
      return env.ASSETS.fetch(new Request(url, req));
    } catch (e) {
      return new Response('worker error: ' + String(e), { status: 500 });
    }
  },
};
