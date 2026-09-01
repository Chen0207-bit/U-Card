/**
 * 优卡 U-Card Demo — Cloudflare Worker 入口
 * 静态 assets + API 转发到 Durable Object(单实例内存状态, 演示强一致)
 * 部署: npx wrangler deploy  →  https://fc-ucard.<account>.workers.dev
 */
import { AppState } from './do.js';
import { createConfig } from './src/config.js';
import { corsHeaders, SECURITY_HEADERS } from './src/runtime/http.js';
import { resolveStaticPath } from './src/runtime/static-routes.js';
export { AppState }; // DO class 必须从入口模块导出

export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url);
      const config = createConfig(env);
      if (url.pathname.startsWith('/api/')) {
        const cors = corsHeaders(config, req.headers.get('origin') || '');
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, ...SECURITY_HEADERS } });
        const id = env.APP_STATE.idFromName('global');
        const resp = await env.APP_STATE.get(id).fetch(req);
        const h = new Headers(resp.headers);
        for (const [k, v] of Object.entries({ ...cors, ...SECURITY_HEADERS })) h.set(k, v);
        return new Response(resp.body, { status: resp.status, headers: h });
      }
      url.pathname = resolveStaticPath(url.pathname, req.headers.get('user-agent') || '');
      return env.ASSETS.fetch(new Request(url, req));
    } catch (e) {
      return new Response('worker error: ' + String(e), { status: 500 });
    }
  },
};
