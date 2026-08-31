/**
 * Durable Object — 持有 core.js 的内存状态(种子数据+运行时交易)
 * 所有 API 请求经 worker 转发到同一 DO 实例, 保证演示期间数据强一致。
 * DO 空闲被回收后自动重建种子数据(demo 可接受)。
 */
import { handleApi } from './core.js';

export class AppState {
  constructor(state, env) { this.env = env; }
  async fetch(req) {
    try {
      const url = new URL(req.url);
      const b = req.method === 'GET' ? {} : await req.json().catch(() => ({}));
      const h = Object.fromEntries(req.headers.entries()); // Headers → 普通对象(小写键), 与 node 壳一致
      const r = handleApi(req.method, url.pathname, Object.fromEntries(url.searchParams), b || {}, h);
      return Response.json(r.json, { status: r.status });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  }
}
