// 支付编排域 HTTP 冒烟: 创建→幂等→回调成功 / 非法迁移 409 / 失败重放 / 超时补偿 / 冲正退款 / 对账补单
const BASE = 'http://127.0.0.1:5177';
let pass = 0;
let fail = 0;
const log = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
};
const call = async (method, path, body = {}, headers = { 'x-sales': '1' }) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* noop */ }
  return { status: res.status, json };
};

// 0. 重置 + 权限
let r = await call('POST', '/api/demo/reset');
log('演示数据重置', r.status === 200, JSON.stringify(r).slice(0, 120));
r = await call('GET', '/api/admin/orch/adapters', {}, { 'x-sales': '30' });
log('普通销售 403', r.status === 403, JSON.stringify(r).slice(0, 100));
r = await call('GET', '/api/admin/orch/adapters', {}, {});
log('匿名 401', r.status === 401, JSON.stringify(r).slice(0, 100));

// 1. 适配器注册表 + 路由表 + 模拟路由 + 费率比较
r = await call('GET', '/api/admin/orch/adapters');
log('适配器列表', r.status === 200 && r.json.list.length > 0 && r.json.summary.total > 0, JSON.stringify(r).slice(0, 120));
const adapter = r.json.list[0];
r = await call('GET', '/api/admin/orch/routes');
log('路由表(场景×币种)', r.status === 200 && r.json.table.length >= 6 && r.json.table.some(row => row.adapter), JSON.stringify(r).slice(0, 120));
r = await call('GET', '/api/admin/orch/routes/simulate?scene=topup_fiat&currency=USD&amount=1000');
log('模拟路由决策', r.status === 200 && r.json.decision.adapterId > 0 && r.json.decision.totalCost > 1000, JSON.stringify(r).slice(0, 200));
r = await call('GET', '/api/admin/orch/routes/simulate?scene=not_a_scene');
log('未知场景 400', r.status === 400, JSON.stringify(r).slice(0, 100));
r = await call('GET', '/api/admin/orch/compare?amount=5000');
log('费率比较', r.status === 200 && r.json.groups.length > 0, JSON.stringify(r).slice(0, 120));

// 2. 适配器人工标记: down → 路由切换; 恢复 healthy
r = await call('PATCH', `/api/admin/orch/adapters/${adapter.id}`, { status: 'down', note: '演示故障切换' });
log('人工标记 down', r.status === 200 && r.json.adapter.status === 'down' && r.json.adapter.manual === true, JSON.stringify(r).slice(0, 160));
r = await call('GET', '/api/admin/orch/routes');
const affected = r.json.table.filter(row => row.adapter && row.adapter.id === adapter.id).length;
log('down 渠道不再被路由', affected === 0 || r.json.table.every(row => row.adapter?.id !== adapter.id || !!row.backup), JSON.stringify(r.json.table.filter(row => row.adapter?.id === adapter.id)).slice(0, 200));
r = await call('PATCH', `/api/admin/orch/adapters/${adapter.id}`, { status: 'healthy' });
log('人工恢复 healthy', r.status === 200 && r.json.adapter.manual === false, JSON.stringify(r).slice(0, 160));
r = await call('PATCH', `/api/admin/orch/adapters/${adapter.id}`, { note: '什么都不改' });
log('空更新 400', r.status === 400, JSON.stringify(r).slice(0, 100));

// 3. 健康探测
r = await call('GET', '/api/admin/orch/health');
log('健康时间线', r.status === 200 && Array.isArray(r.json.list), JSON.stringify(r).slice(0, 120));
r = await call('POST', '/api/admin/orch/health/check');
log('一键全量探测', r.status === 200 && r.json.results.length > 0, JSON.stringify(r).slice(0, 160));

// 4. 创建编排单 → 幂等命中
const key = 'smoke-orch-key-001';
r = await call('POST', '/api/admin/orch/txs', { scene: 'topup_fiat', amount: 250.5, currency: 'USD', idempotencyKey: key });
log('创建编排单(路由+尝试#1)', r.status === 200 && r.json.idempotent === false && r.json.tx.state === 'pending' && r.json.tx.attempts.length === 1, JSON.stringify(r).slice(0, 240));
const txId = r.json.tx.id;
const adapterName = r.json.routing.adapter;
r = await call('POST', '/api/admin/orch/txs', { scene: 'topup_fiat', amount: 250.5, currency: 'USD', idempotencyKey: key });
log('幂等命中返回同一单', r.status === 200 && r.json.idempotent === true && r.json.tx.id === txId, JSON.stringify(r).slice(0, 160));
r = await call('POST', '/api/admin/orch/txs', { scene: 'topup_crypto', amount: 0 });
log('金额非法 400', r.status === 400, JSON.stringify(r).slice(0, 100));

// 5. 详情 + 回调成功
r = await call('GET', `/api/admin/orch/tx/${txId}`);
log('编排单详情(含 nextStates)', r.status === 200 && Array.isArray(r.json.nextStates), JSON.stringify(r).slice(0, 160));
r = await call('POST', `/api/admin/orch/tx/${txId}/callback`, { result: 'success', receipt: 'RCPT-SMOKE-1' });
log('回调 success → 终态', r.status === 200 && r.json.tx.state === 'success' && r.json.tx.callbacks.length === 1, JSON.stringify(r).slice(0, 200));
r = await call('POST', `/api/admin/orch/tx/${txId}/callback`, { result: 'success' });
log('终态再回调 409', r.status === 409, JSON.stringify(r).slice(0, 100));
r = await call('POST', `/api/admin/orch/tx/${txId}/replay`, {});
log('成功单不可重放 409', r.status === 409, JSON.stringify(r).slice(0, 100));

// 6. 冲正 → 已终态不可退款
r = await call('POST', `/api/admin/orch/tx/${txId}/reverse`, { note: '冒烟冲正' });
log('冲正 success → reversed', r.status === 200 && r.json.tx.state === 'reversed', JSON.stringify(r).slice(0, 160));

// 7. 失败链路: 新单回调 fail → 重放 → 回调成功 → 退款
r = await call('POST', '/api/admin/orch/txs', { scene: 'pay', amount: 88, currency: 'USD' });
const tx2 = r.json.tx.id;
r = await call('POST', `/api/admin/orch/tx/${tx2}/callback`, { result: 'fail' });
log('回调 fail → failed', r.status === 200 && r.json.tx.state === 'failed', JSON.stringify(r).slice(0, 160));
r = await call('POST', `/api/admin/orch/tx/${tx2}/replay`, {});
log('失败单重放 → pending', r.status === 200 && r.json.tx.state === 'pending' && r.json.tx.attempts.length === 2, JSON.stringify(r).slice(0, 200));
r = await call('POST', `/api/admin/orch/tx/${tx2}/callback`, { result: 'success' });
log('重放后回调成功', r.status === 200 && r.json.tx.state === 'success', JSON.stringify(r).slice(0, 160));
r = await call('POST', `/api/admin/orch/tx/${tx2}/refund`, { note: '冒烟退款' });
log('退款 success → refunded', r.status === 200 && r.json.tx.state === 'refunded', JSON.stringify(r).slice(0, 160));

// 8. 超时补偿: 新单未到阈值 409 → force 成功
r = await call('POST', '/api/admin/orch/txs', { scene: 'fx', amount: 300, currency: 'AED' });
const tx3 = r.json.tx.id;
r = await call('POST', `/api/admin/orch/tx/${tx3}/compensate`, {});
log('未到超时阈值 409', r.status === 409, JSON.stringify(r).slice(0, 120));
r = await call('POST', `/api/admin/orch/tx/${tx3}/compensate`, { force: true, outcome: 'success' });
log('强制超时补偿成功', r.status === 200 && r.json.tx.state === 'success', JSON.stringify(r).slice(0, 160));

// 9. 列表筛选 + webhook 记录
r = await call('GET', '/api/admin/orch/txs?state=refunded');
log('列表按状态筛选', r.status === 200 && r.json.list.every(t => t.state === 'refunded') && r.json.list.length >= 1, JSON.stringify(r).slice(0, 160));
r = await call('GET', '/api/admin/orch/txs');
log('webhook 出站记录', Array.isArray(r.json.webhooks) && r.json.webhooks.length > 0, JSON.stringify((r.json.webhooks || []).slice(0, 2)).slice(0, 200));

// 10. 三方对账 + 补单
r = await call('GET', '/api/admin/orch/recon');
log('三方对账报告', r.status === 200 && r.json.summary.checked > 0, JSON.stringify(r).slice(0, 160));
const diff = (r.json.diffs || [])[0];
if (diff) {
  r = await call('POST', `/api/admin/orch/diff/${diff.id}/fix`);
  log('对账差异补单', r.status === 200 && r.json.ok === true, JSON.stringify(r).slice(0, 160));
  r = await call('POST', `/api/admin/orch/diff/${diff.id}/fix`);
  log('重复补单 404', r.status === 404, JSON.stringify(r).slice(0, 100));
} else {
  console.log('  (种子无未处理差异, 跳过补单验证)');
}

// 11. 动态路由 404
r = await call('GET', '/api/admin/orch/tx/999999');
log('编排单不存在 404', r.status === 404, JSON.stringify(r).slice(0, 100));
r = await call('POST', '/api/admin/orch/tx/999999/callback', {});
log('动作路径不存在 404', r.status === 404, JSON.stringify(r).slice(0, 100));

console.log(`\n===== 支付编排域 HTTP 冒烟 PASS ${pass} FAIL ${fail} =====`);
process.exit(fail ? 1 : 0);
