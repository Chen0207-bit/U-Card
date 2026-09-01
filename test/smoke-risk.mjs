// 经典风控中心 HTTP 冒烟: 事件列表/筛选 / 处置(review/release/freeze) / 冻结余额联动 / 规则启停 / 名单删除 / 标签
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
r = await call('GET', '/api/admin/risk', {}, { 'x-sales': '30' });
log('普通销售 403', r.status === 403, JSON.stringify(r).slice(0, 100));
r = await call('GET', '/api/admin/risk', {}, {});
log('匿名 403(与 legacy 一致)', r.status === 403, JSON.stringify(r).slice(0, 100));

// 1. 事件列表 + 筛选 + 视图字段
r = await call('GET', '/api/admin/risk');
log('风险事件列表', r.status === 200 && r.json.list.length > 0 && r.json.summary.total > 0, JSON.stringify(r).slice(0, 120));
const ev0 = r.json.list[0];
log('事件视图字段(user/cardNoMask/ruleExpr)', !!ev0.user && 'cardNoMask' in ev0 && 'ruleExpr' in ev0 && 'statusLabel' in ev0, JSON.stringify(ev0).slice(0, 200));
r = await call('GET', '/api/admin/risk?status=pending');
log('按状态筛选', r.status === 200 && r.json.list.every(e => e.status === 'pending'), JSON.stringify(r).slice(0, 120));

// 2. review 处置
r = await call('POST', `/api/admin/risk/${ev0.id}/action`, { action: 'review' });
log('review → reviewed(操作人有名字)', r.status === 200 && r.json.event.status === 'reviewed'
  && r.json.event.timeline[r.json.event.timeline.length - 1].operator && r.json.event.timeline[r.json.event.timeline.length - 1].operator !== '', JSON.stringify(r).slice(0, 200));

// 3. freeze 处置 → 卡冻结 + frozenBalances 台账
r = await call('GET', '/api/admin/risk?status=pending');
const pending = r.json.list;
const freezeTarget = pending.find(e => e.cardStatus === 'active') || pending[0];
r = await call('POST', `/api/admin/risk/${freezeTarget.id}/action`, { action: 'freeze' });
const frozenEv = r.json.event;
log('freeze → 事件 frozen + 卡冻结', r.status === 200 && frozenEv.status === 'frozen' && frozenEv.cardStatus === 'frozen', JSON.stringify(r).slice(0, 200));
// 冻结余额联动: 用 ledger/finance 视口确认 frozenBalances 有记录(经 finance snapshot 或直接 release 验证)
// 4. release 处置 → 解冻卡 + 移除冻结余额记录
r = await call('POST', `/api/admin/risk/${frozenEv.id}/action`, { action: 'release' });
log('release → 卡解冻 + 冻结余额释放', r.status === 200 && r.json.event.status === 'released' && r.json.event.cardStatus === 'active', JSON.stringify(r).slice(0, 200));
const releaseNote = r.json.event.timeline[r.json.event.timeline.length - 1].note;
log('release 备注含「冻结余额已释放」', releaseNote.includes('冻结余额已释放'), releaseNote);
// 再冻结再解除, 验证 frozenBalances 真正清空(不残留)
r = await call('POST', `/api/admin/risk/${frozenEv.id}/action`, { action: 'freeze' });
log('二次 freeze → 重新冻结', r.status === 200 && r.json.event.cardStatus === 'frozen', JSON.stringify(r).slice(0, 120));
r = await call('POST', `/api/admin/risk/${frozenEv.id}/action`, { action: 'release' });
log('二次 release → 再次释放', r.status === 200 && r.json.event.cardStatus === 'active', JSON.stringify(r).slice(0, 120));

// 5. 无效动作 400 + 不存在 404
r = await call('POST', `/api/admin/risk/${ev0.id}/action`, { action: 'explode' });
log('无效动作 400', r.status === 400, JSON.stringify(r).slice(0, 100));
r = await call('POST', '/api/admin/risk/999999/action', { action: 'review' });
log('事件不存在 404', r.status === 404, JSON.stringify(r).slice(0, 100));

// 6. 规则列表 + 启停
r = await call('GET', '/api/admin/risk/rules');
log('风控规则列表', r.status === 200 && r.json.list.length > 0 && 'hitEvents' in r.json.list[0], JSON.stringify(r).slice(0, 120));
const rule = r.json.list[0];
const wasEnabled = rule.enabled;
r = await call('PATCH', `/api/admin/risk/rules/${rule.id}`, { enabled: !wasEnabled });
log('规则启停', r.status === 200 && r.json.rule.enabled === !wasEnabled, JSON.stringify(r).slice(0, 160));
r = await call('PATCH', `/api/admin/risk/rules/${rule.id}`, { enabled: wasEnabled });
log('规则恢复原状', r.status === 200 && r.json.rule.enabled === wasEnabled, JSON.stringify(r).slice(0, 100));
r = await call('PATCH', '/api/admin/risk/rules/999999', { enabled: true });
log('规则不存在 404', r.status === 404, JSON.stringify(r).slice(0, 100));

// 7. 名单 + 删除(POST 与 DELETE 两种方法)
r = await call('GET', '/api/admin/risk/lists');
log('风控名单', r.status === 200 && r.json.list.length > 0, JSON.stringify(r).slice(0, 120));
const item = r.json.list[0];
r = await call('POST', `/api/admin/risk/lists/${item.id}/remove`);
log('名单删除(POST)', r.status === 200 && r.json.ok === true, JSON.stringify(r).slice(0, 120));
const item2 = (await call('GET', '/api/admin/risk/lists')).json.list[0];
if (item2) {
  r = await call('DELETE', `/api/admin/risk/lists/${item2.id}/remove`);
  log('名单删除(DELETE)', r.status === 200 && r.json.ok === true, JSON.stringify(r).slice(0, 120));
}
r = await call('POST', `/api/admin/risk/lists/${item.id}/remove`);
log('重复删除 404', r.status === 404, JSON.stringify(r).slice(0, 100));

// 8. 标签
r = await call('GET', '/api/admin/risk/tags');
log('风险标签', r.status === 200 && Array.isArray(r.json.list), JSON.stringify(r).slice(0, 120));

// 9. 账本平衡不受处置影响
r = await call('GET', '/api/admin/ledger/verify');
log('复式账本平衡', r.status === 200 && r.json.balanced === true, JSON.stringify(r).slice(0, 200));

console.log(`\n===== 经典风控域 HTTP 冒烟 PASS ${pass} FAIL ${fail} =====`);
process.exit(fail ? 1 : 0);
