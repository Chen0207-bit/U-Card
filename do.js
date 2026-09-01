/**
 * Durable Object — 持有 core.js 的运行状态并通过 Repository 写入 storage。
 * 所有 API 请求经 worker 转发到同一 DO 实例，实例回收后从版本化快照恢复。
 */
import { createApp } from './src/app/create-app.js';
import { createCoreRuntime } from './core.js';
import { DurableSnapshotRepository } from './src/repositories/durable-repository.js';
import { createUnitOfWork } from './src/domain/shared/unit-of-work.js';

export class AppState {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.core = createCoreRuntime();
    this.app = createApp({ env, core: this.core });
    this.repository = new DurableSnapshotRepository(state.storage);
    this.uow = createUnitOfWork({
      exportSnapshot: () => this.core.exportInternalSnapshot(),
      importSnapshot: (snapshot) => this.core.importInternalSnapshot(snapshot),
    });
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
      if (req.method !== 'GET') {
        // 写请求走 UnitOfWork: 业务失败或 storage 写入失败都整体回滚内存状态
        const outcome = await this.uow.run(
          () => this.app.handleApi(req.method, url.pathname, Object.fromEntries(url.searchParams), b || {}, h),
          () => this.repository.save(this.core.exportInternalSnapshot()),
        );
        if (!outcome.committed) {
          return Response.json({ error: outcome.stage === 'persist' ? '持久化失败, 已回滚本次写入' : String(outcome.error) }, { status: 500 });
        }
        this.hasSnapshot = true;
        return Response.json(outcome.result.json, { status: outcome.result.status, headers: { 'X-Request-Id': outcome.result.requestId } });
      }
      const r = await this.app.handleApi(req.method, url.pathname, Object.fromEntries(url.searchParams), b || {}, h);
      if (!this.hasSnapshot) { // 首个 GET 也会把种子快照落盘, 保持与旧实现一致
        await this.repository.save(this.core.exportInternalSnapshot());
        this.hasSnapshot = true;
      }
      return Response.json(r.json, { status: r.status, headers: { 'X-Request-Id': r.requestId } });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  }
}
