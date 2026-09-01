/**
 * Durable Object — 持有 core.js 的内存状态(种子数据+运行时交易)
 * 所有 API 请求经 worker 转发到同一 DO 实例, 保证演示期间数据强一致。
 * DO 空闲被回收后自动重建种子数据(demo 可接受)。
 */
import { createApp } from './src/app/create-app.js';
import { exportInternalSnapshot, importInternalSnapshot } from './core.js';

const SNAPSHOT_KEY = 'runtime-snapshot-v1';

export class AppState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.app = createApp({ env });
    this.hasSnapshot = false;
    this.ready = state.blockConcurrencyWhile(async () => {
      const snapshot = await state.storage.get(SNAPSHOT_KEY);
      if (snapshot) {
        importInternalSnapshot(snapshot);
        this.hasSnapshot = true;
      }
    });
  }
  async fetch(req) {
    try {
      await this.ready;
      const url = new URL(req.url);
      const b = req.method === 'GET' ? {} : await req.json().catch(() => ({}));
      const h = Object.fromEntries(req.headers.entries()); // Headers → 普通对象(小写键), 与 node 壳一致
      const r = await this.app.handleApi(req.method, url.pathname, Object.fromEntries(url.searchParams), b || {}, h);
      if (!this.hasSnapshot || req.method !== 'GET') {
        await this.state.storage.put(SNAPSHOT_KEY, exportInternalSnapshot());
        this.hasSnapshot = true;
      }
      return Response.json(r.json, { status: r.status, headers: { 'X-Request-Id': r.requestId } });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  }
}
