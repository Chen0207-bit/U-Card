/**
 * Durable Object — 持有 core.js 的运行状态并通过 Repository 写入 storage。
 * 所有 API 请求经 worker 转发到同一 DO 实例，实例回收后从版本化快照恢复。
 */
import { createApp } from './src/app/create-app.js';
import { createCoreRuntime } from './core.js';
import { DurableSnapshotRepository } from './src/repositories/durable-repository.js';

export class AppState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.core = createCoreRuntime();
    this.app = createApp({ env, core: this.core });
    this.repository = new DurableSnapshotRepository(state.storage);
    this.hasSnapshot = false;
    this.ready = state.blockConcurrencyWhile(async () => {
      const snapshot = await this.repository.load();
      if (snapshot) {
        this.core.importInternalSnapshot(snapshot);
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
        await this.repository.save(this.core.exportInternalSnapshot());
        this.hasSnapshot = true;
      }
      return Response.json(r.json, { status: r.status, headers: { 'X-Request-Id': r.requestId } });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  }
}
