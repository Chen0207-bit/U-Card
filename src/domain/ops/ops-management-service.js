import { failure, ok } from '../../api/response.js';

export function createOpsManagementService(port) {
  return {
    architecture: () => ok(port.architecture()),
    listFlags: () => ok({
      list: port.flags().map(flag => ({ ...flag })),
      effects: [
        { key: 'shopFlag', effect: '关闭后用户端 GET /api/app/products 返回 503 降级响应(商城页显示错误提示)' },
        { key: 'approvalsFlag', effect: '关闭后审批中心 GET /api/admin/approvals 返回 disabled 标记, 页面显示「功能已下线」横幅' },
        { key: 'grayPayFlag', effect: '灰度百分比控制新支付编排路由放量(演示展示, 不改路由)' },
      ],
      note: 'Feature Flag 为演示级内存开关(生产接入配置中心); 切换即写 opLogs 审计。',
    }),
    updateFlag(actorId, id, body = {}) {
      const flag = port.flags().find(item => item.id === id);
      if (!flag) return failure(404, '开关不存在');
      const changed = [];
      if (typeof body.enabled === 'boolean' && body.enabled !== flag.enabled) { flag.enabled = body.enabled; changed.push(`enabled → ${body.enabled}`); }
      if (body.rollout != null) { const rollout = Math.max(0, Math.min(100, Math.round(+body.rollout))); if (rollout !== flag.rollout) { flag.rollout = rollout; changed.push(`灰度 ${rollout}%`); } }
      if (!changed.length) return failure(400, '无有效修改字段(支持 enabled: boolean / rollout: 0-100)');
      flag.updatedAt = port.now();
      port.audit(actorId, '运维中心', 'Feature Flag 切换', `${flag.key}(${flag.label}): ${changed.join(', ')}`);
      return ok({ ok: true, flag: { ...flag } });
    },
    getRateLimit() {
      return ok({ ...port.rateConfig(), tracked: port.rateBuckets().size, note: '内存令牌桶(单实例演示); 生产预留网关级 Redis 滑动窗口按 key/租户聚合。全局限流开关关闭后 test 端点不再触发 429。' });
    },
    updateRateLimit(actorId, body = {}) {
      const config = port.rateConfig(); const changed = [];
      if (typeof body.enabled === 'boolean' && body.enabled !== config.enabled) { config.enabled = body.enabled; changed.push(`全局限流 → ${body.enabled}`); }
      if (body.qps != null || body.burst != null) {
        const rule = config.rules.find(item => item.key === body.key);
        if (!rule) return failure(400, `限流规则不存在: ${body.key || '(未指定)'}`);
        if (body.qps != null) { const value = Math.max(1, Math.round(+body.qps) || 1); if (value !== rule.qps) { rule.qps = value; changed.push(`${rule.key} QPS → ${value}`); } }
        if (body.burst != null) { const value = Math.max(1, Math.round(+body.burst) || 1); if (value !== rule.burst) { rule.burst = value; changed.push(`${rule.key} 突发 → ${value}`); port.rateBuckets().delete('ops-demo:default'); } }
      }
      if (!changed.length) return failure(400, '无有效修改字段(支持 enabled / key+qps / key+burst)');
      port.audit(actorId, '运维中心', '限流配置变更', changed.join(', '));
      return ok({ ok: true, cfg: { ...config } });
    },
    testRateLimit(demoKey = 'default') {
      const rule = port.rateConfig().rules.find(item => item.key === '/api/admin/ops/ratelimit/test') || { qps: 1, burst: 4 };
      const result = port.rateAllow(`ops-demo:${demoKey}`, rule.qps, rule.burst);
      if (!result.ok) return failure(429, `请求过于频繁: 已触发限流(429), 令牌不足, 约 ${result.retryAfterMs}ms 后恢复`, null, { rateLimited: true, retryAfterMs: result.retryAfterMs, tokensLeft: result.tokens, rule });
      return ok({ ok: true, seq: result.seq, tokensLeft: result.tokens, rule, note: `内存令牌桶 burst=${rule.burst}: 快速连打 ${rule.burst} 次后第 ${rule.burst + 1} 次返回 429。` });
    },
    audit: query => ok(port.auditData(query)),
    monitor: () => ok(port.monitorData()),
    alerts: () => ok(port.alertsData()),
    traceCandidates: () => ok({ candidates: port.traceCandidates() }),
    trace(id) {
      const data = port.traceData(String(id));
      return data.error ? failure(404, `交易不存在: #${id}`) : ok(data);
    },
  };
}
