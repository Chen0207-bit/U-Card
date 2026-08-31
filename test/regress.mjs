// U-Card 3.0 全量回归: 前端调用路径 + 核心业务流 — 用法: node test/regress.mjs
import { handleApi } from '../core.js';
const ADMIN = { 'x-sales': '1' };      // 销售总监
const ADMIN3 = { 'x-sales': '30' };    // 三级销售(权限测试)
const APP = { 'x-user': '1' };         // 持卡用户 1
const APP2 = { 'x-user': '2' };
const MCH = { 'x-mch': '8301' };       // 商户 Noon
let pass = 0, fail = 0; const fails = [];
const call = async (name, method, p, q = {}, b = {}, h = ADMIN, expect = 200) => {
  let r; try { r = await handleApi(method, p, q, b, h); }
  catch (e) { fail++; fails.push(`${name} THROW ${e.message}`); return null; }
  const ok = r.status === expect;
  if (ok) pass++; else { fail++; fails.push(`${name} [${method} ${p}] expect ${expect} got ${r.status}: ${JSON.stringify(r.json).slice(0, 140)}`); }
  return r;
};
const bad = (name, cond, detail = '') => { if (cond) { pass++; } else { fail++; fails.push(name + (detail ? ' :: ' + detail : '')); } };
const ledgerOk = (j) => j && j.balanced === true && j.accountsConsistent === true && !(j.errors || []).length;

// ---------- 1. 登录/账号 ----------
const accounts = await call('后台账号列表', 'GET', '/api/admin/accounts');
bad('账号列表含总监', accounts?.json?.length >= 19, `got ${accounts?.json?.length}`);
await call('后台 me', 'GET', '/api/admin/me');
await call('用户端账号列表', 'GET', '/api/app/users', {}, {}, {});
await call('商户列表', 'GET', '/api/mch/merchants', {}, {}, {});

// ---------- 2. 全量 GET 路径 (总监身份) ----------
const adminGets = [
  ['/api/admin/dashboard', { range: 'today' }], ['/api/admin/dashboard', { range: 'week' }],
  ['/api/admin/dashboard', { range: 'month' }], ['/api/admin/dashboard', { range: 'quarter' }],
  ['/api/admin/users'], ['/api/admin/cards'], ['/api/admin/kyc'], ['/api/admin/kyc', { status: 'pending' }],
  ['/api/admin/transactions'], ['/api/admin/transactions', { type: 'topup' }],
  ['/api/admin/customers'], ['/api/admin/customers', { stage: '签约' }],
  ['/api/admin/performance'], ['/api/admin/commissions'],
  ['/api/admin/commissions/tree'], ['/api/admin/points'], ['/api/admin/products'], ['/api/admin/orders'],
  ['/api/admin/goals'], ['/api/admin/goals', { period: 'quarter' }],
  ['/api/admin/risk'], ['/api/admin/risk', { level: 'high' }], ['/api/admin/risk/rules'], ['/api/admin/risk/lists'], ['/api/admin/risk/tags'],
  ['/api/admin/finance/recon', { type: 'topup' }], ['/api/admin/finance/recon', { type: 'consume' }],
  ['/api/admin/finance/recon', { type: 'refund' }], ['/api/admin/finance/diff'], ['/api/admin/finance/merchant'],
  ['/api/admin/finance/report'],
  ['/api/admin/sys/accounts'], ['/api/admin/sys/roles'], ['/api/admin/sys/perms', { role: 'director' }],
  ['/api/admin/sys/org'], ['/api/admin/sys/params'], ['/api/admin/sys/dicts'], ['/api/admin/sys/loginlogs'], ['/api/admin/sys/oplogs'],
  ['/api/admin/tenants'], ['/api/admin/tenants', { id: '1' }],
  ['/api/admin/ledger/accounts'], ['/api/admin/ledger/entries'], ['/api/admin/ledger/entries', { account: 'CH-WIRE' }],
  ['/api/admin/ledger/snapshots'], ['/api/admin/ledger/verify'],
  ['/api/admin/approvals', { box: 'todo' }], ['/api/admin/approvals', { box: 'mine' }], ['/api/admin/approvals', { box: 'all' }],
  ['/api/admin/risk-engine/rules'], ['/api/admin/risk-engine/scores'], ['/api/admin/risk-engine/hits'], ['/api/admin/risk-engine/versions'],
  ['/api/admin/open/apps'], ['/api/admin/open/keys'], ['/api/admin/open/webhooks'], ['/api/admin/open/apilogs'],
  ['/api/admin/notify/templates'], ['/api/admin/notify/sends'], ['/api/admin/notify/channels'],
  ['/api/admin/orch/adapters'], ['/api/admin/orch/routes'], ['/api/admin/orch/routes/simulate', { kind: 'topup_fiat', amount: '100' }],
  ['/api/admin/orch/health'], ['/api/admin/orch/compare'], ['/api/admin/orch/txs'], ['/api/admin/orch/recon'],
  ['/api/admin/compliance/kyc'], ['/api/admin/compliance/kyb'], ['/api/admin/compliance/screenings'],
  ['/api/admin/compliance/sanctions'], ['/api/admin/compliance/peps'], ['/api/admin/compliance/str'],
  ['/api/admin/compliance/docs'], ['/api/admin/compliance/cases'], ['/api/admin/compliance/countries'],
  ['/api/admin/ent/accounts'], ['/api/admin/ent/approvals'], ['/api/admin/ent/bills'], ['/api/admin/ent/report'],
  ['/api/admin/mch/accounts'], ['/api/admin/mch/orders'], ['/api/admin/mch/refunds'], ['/api/admin/mch/settles'],
  ['/api/admin/mch/splits'], ['/api/admin/mch/risk'], ['/api/admin/mch/report'],
  ['/api/admin/bi/overview'], ['/api/admin/bi/users'], ['/api/admin/bi/tx'], ['/api/admin/bi/sales'], ['/api/admin/bi/funnel'],
  ['/api/admin/bi/report'],
  ['/api/admin/ops/arch'], ['/api/admin/ops/flags'], ['/api/admin/ops/ratelimit'], ['/api/admin/ops/audit'],
  ['/api/admin/ops/monitor'], ['/api/admin/ops/alerts'], ['/api/admin/ops/trace'], ['/api/admin/ops/backup'],
];
for (const [path, q] of adminGets) await call(`GET ${path}${q ? '?' + new URLSearchParams(q) : ''}`, 'GET', path, q || {});
const ver = await handleApi('GET', '/api/admin/ledger/verify', {}, {}, ADMIN);
bad('账本借贷恒等三查全过', ledgerOk(ver.json), JSON.stringify(ver.json).slice(0, 200));
bad('账本无 undefined/NaN 序列化', !/undefined|NaN/.test(JSON.stringify(ver.json)), '');

// ---------- 3. 用户端核心流: 冻结→解冻→挂失 ----------
const appGets = [
  ['/api/app/me'], ['/api/app/transactions'], ['/api/app/points'], ['/api/app/points/summary'],
  ['/api/app/products'], ['/api/app/orders'], ['/api/app/invite'], ['/api/app/tasks'], ['/api/app/notifications'],
];
for (const [path, q] of appGets) await call(`APP GET ${path}`, 'GET', path, q || {}, {}, APP);
// 用户1的卡(pubUser.card 为单卡对象)
const me1 = await handleApi('GET', '/api/app/me', {}, {}, APP);
const card1 = me1.json?.card;
bad('用户1有卡', !!card1, JSON.stringify(me1.json).slice(0, 120));
if (card1) {
  await call('冻结卡', 'POST', '/api/app/card/freeze', {}, {}, APP);
  let r = await handleApi('POST', '/api/app/pay', {}, { amount: 10, merchant: 'Amazon' }, APP);
  bad('冻结卡消费被拒', r.status >= 400 || r.json?.error, JSON.stringify(r.json).slice(0, 100));
  r = await handleApi('POST', '/api/app/topup', {}, { amount: 50, method: 'usdt' }, APP);
  bad('冻结卡充值被拒', r.status >= 400 || r.json?.error, JSON.stringify(r.json).slice(0, 100));
  await call('解冻卡', 'POST', '/api/app/card/unfreeze', {}, {}, APP);
  r = await handleApi('GET', '/api/app/me', {}, {}, APP);
  bad('解冻后状态恢复 active', r.json?.card?.status === 'active', JSON.stringify(r.json?.card).slice(0, 120));
}
// 挂失(用户2, 不可逆)
const me2 = await handleApi('GET', '/api/app/me', {}, {}, APP2);
const card2 = me2.json?.card;
if (card2) {
  await call('挂失卡', 'POST', '/api/app/card/lost', {}, {}, APP2);
  let r = await handleApi('POST', '/api/app/card/unfreeze', {}, {}, APP2);
  bad('挂失卡不能恢复active(400)', r.status === 400, JSON.stringify(r.json).slice(0, 100));
  r = await handleApi('POST', '/api/app/pay', {}, { amount: 5, merchant: 'Amazon' }, APP2);
  bad('挂失卡不能消费', r.status === 400 || !!r.json?.error, JSON.stringify(r.json).slice(0, 100));
} else { pass++; console.log('  (user2 no card — skip lost flow)'); }

// ---------- 4. 充值/消费/积分/任务 ----------
let r = await handleApi('POST', '/api/app/topup', {}, { amount: 100, method: 'usdt' }, APP);
bad('充值成功', r.status === 200 && r.json?.balance != null, JSON.stringify(r.json).slice(0, 140));
r = await handleApi('POST', '/api/app/pay', {}, { amount: 30, merchant: 'Starbucks', usePoints: false }, APP);
bad('消费成功', r.status === 200 && !r.json?.error, JSON.stringify(r.json).slice(0, 140));
r = await handleApi('POST', '/api/app/pay', {}, { amount: 0 }, APP);
bad('0元消费被拒', r.status >= 400 || !!r.json?.error, JSON.stringify(r.json).slice(0, 100));
r = await handleApi('POST', '/api/app/topup', {}, { amount: -50, method: 'usdt' }, APP);
bad('负数充值被拒', r.status >= 400 || !!r.json?.error, JSON.stringify(r.json).slice(0, 100));
r = await handleApi('POST', '/api/app/pay', {}, { amount: 'abc' }, APP);
bad('非数字金额被拒(NaN 防护)', r.status >= 400 || !!r.json?.error, JSON.stringify(r.json).slice(0, 100));
r = await handleApi('POST', '/api/app/sign', {}, {}, APP);
bad('签到 ok 或已签', r.status === 200 || (r.status === 400 && /已签到/.test(r.json?.error || '')), JSON.stringify(r.json).slice(0, 100));
// 任务领取防重复 + 无效任务
const tasks = await handleApi('GET', '/api/app/tasks', {}, {}, APP);
const t0 = (tasks.json?.tasks || []).find(t => t.type === 'once') || (tasks.json?.tasks || [])[0];
if (t0) {
  const first = await handleApi('POST', '/api/app/task/claim', {}, { id: t0.id }, APP);
  const second = await handleApi('POST', '/api/app/task/claim', {}, { id: t0.id }, APP);
  bad('任务领取/防重', first.status === 200 && second.status === 400, `1st:${first.status} 2nd:${second.status} ${JSON.stringify(second.json).slice(0, 80)}`);
  const tDaily = (tasks.json?.tasks || []).find(t => t.type === 'daily');
  if (tDaily) {
    const d1 = await handleApi('POST', '/api/app/task/claim', {}, { id: tDaily.id }, APP);
    const d2 = await handleApi('POST', '/api/app/task/claim', {}, { id: tDaily.id }, APP);
    bad('每日任务当日防重', (d1.status === 200 || d1.status === 400) && d2.status === 400, `1st:${d1.status} 2nd:${d2.status} ${JSON.stringify(d2.json).slice(0, 60)}`);
  }
}
r = await handleApi('POST', '/api/app/task/claim', {}, { id: 99999 }, APP);
bad('无效任务 id 返回 404 不崩溃', r.status === 404, `got ${r.status} ${JSON.stringify(r.json).slice(0, 80)}`);
// 商城兑换 + 取消退分
const prods = await handleApi('GET', '/api/app/products', {}, {}, APP);
const p0 = (prods.json?.products || [])[0];
if (p0) {
  const rd = await handleApi('POST', '/api/app/redeem', {}, { id: p0.id }, APP);
  bad('兑换 ok 或积分不足', rd.status === 200 || rd.status === 400, JSON.stringify(rd.json).slice(0, 100));
  if (rd.status === 200) {
    const ords = await handleApi('GET', '/api/app/orders', {}, {}, APP);
    const o = (ords.json || []).find(x => x.status === 'pending');
    if (o) { const cc = await handleApi('POST', '/api/app/orders/cancel', {}, { id: o.id }, APP); bad('订单取消', cc.status === 200, JSON.stringify(cc.json).slice(0, 100)); }
  }
}
// KYC 升级 + 改密 + 通知已读
await call('KYC升级申请', 'POST', '/api/app/kyc', {}, {}, APP);
await call('修改密码', 'POST', '/api/app/password', {}, { oldPassword: 'demo', newPassword: 'demo123', newPassword2: 'demo123' }, APP);
r = await handleApi('POST', '/api/app/password', {}, { oldPassword: 'demo', newPassword: 'a12345', newPassword2: 'a54321' }, APP);
bad('两次密码不一致被拒 400', r.status === 400, `got ${r.status}`);
await call('通知已读', 'POST', '/api/app/notifications/read', {}, { id: 1 }, APP);

// ---------- 5. 目标 / 客户全景 / 权限 ----------
await call('客户全景', 'GET', '/api/admin/customers/1/overview', {}, {}, ADMIN);
await call('目标配置', 'POST', '/api/admin/goals', {}, { type: 'personal', period: 'month', metric: 'topup', target: 50000 }, ADMIN);
await call('三级销售 dashboard', 'GET', '/api/admin/dashboard', { range: 'month' }, {}, ADMIN3);
r = await handleApi('GET', '/api/admin/risk-engine/rules', {}, {}, ADMIN3);
bad('三级销售访问风控引擎 403', r.status === 403, `got ${r.status}`);
r = await handleApi('GET', '/api/admin/approvals', { box: 'todo' }, {}, ADMIN3);
bad('三级销售访问审批中心 403', r.status === 403, `got ${r.status}`);
r = await handleApi('GET', '/api/admin/ops/flags', {}, {}, ADMIN3);
bad('三级销售访问运维中心 403', r.status === 403, `got ${r.status}`);

// ---------- 6. 审批中心真实流 ----------
const apTodo = await handleApi('GET', '/api/admin/approvals', { box: 'todo' }, {}, ADMIN);
const ap0 = (apTodo.json?.list || [])[0];
if (ap0) {
  r = await handleApi('POST', `/api/admin/approvals/${ap0.id}/action`, {}, { action: 'reject' }, ADMIN);
  bad('驳回无原因被拒 400', r.status === 400, `got ${r.status}`);
  let guard = 0, execNote = '';
  while (guard++ < 6) {
    r = await handleApi('POST', `/api/admin/approvals/${ap0.id}/action`, {}, { action: 'approve' }, ADMIN);
    if (r.status !== 200) { bad('审批 approve 失败', false, JSON.stringify(r.json).slice(0, 120)); break; }
    if (r.json?.executed) { execNote = r.json?.bizNote || ''; pass++; break; }
    if (r.json?.advanced) { continue; }
    break;
  }
  bad('审批流程走完有业务联动', execNote.length > 0, execNote || 'no note');
  r = await handleApi('POST', `/api/admin/approvals/${ap0.id}/action`, {}, { action: 'approve' }, ADMIN);
  bad('已审批单重复操作被拒 400', r.status === 400, `got ${r.status}`);
} else { pass++; console.log('  (no pending approvals — skip approve flow)'); }

// ---------- 7. 风控引擎 CRUD + 命中 ----------
r = await handleApi('POST', '/api/admin/risk-engine/rules', {}, {
  name: '回归-单笔大额', priority: 99, enabled: true, action: 'manual',
  condOp: 'and', scene: ['pay'], conditions: [{ field: 'amount', op: '>', value: 100000 }]
}, ADMIN);
bad('新建风控规则', r.status === 200 && (r.json?.rule?.id || r.json?.id), JSON.stringify(r.json).slice(0, 120));
const ruleId = r.json?.rule?.id || r.json?.id;
if (ruleId) {
  r = await handleApi('PATCH', `/api/admin/risk-engine/rules/${ruleId}`, {}, { enabled: false }, ADMIN);
  bad('停用风控规则', r.status === 200, JSON.stringify(r.json).slice(0, 100));
  r = await handleApi('DELETE', `/api/admin/risk-engine/rules/${ruleId}`, {}, {}, ADMIN);
  bad('删除风控规则', r.status === 200, JSON.stringify(r.json).slice(0, 100));
}
r = await handleApi('POST', '/api/app/pay', {}, { amount: 999999, merchant: 'Test' }, APP);
bad('触发风控的消费被拦', r.status === 400 || r.status === 403 || !!r.json?.error, `got ${r.status} ${JSON.stringify(r.json).slice(0, 100)}`);

// ---------- 8. 支付编排 ----------
r = await handleApi('POST', '/api/admin/orch/txs', {}, { scene: 'topup_fiat', amount: 200 }, ADMIN);
bad('编排下单', r.status === 200 && (r.json?.tx?.id || r.json?.id), JSON.stringify(r.json).slice(0, 120));
const txId = r.json?.tx?.id || r.json?.id;
if (txId) {
  r = await handleApi('POST', `/api/admin/orch/tx/${txId}/callback`, {}, { result: 'success' }, ADMIN);
  bad('编排回调', r.status === 200, JSON.stringify(r.json).slice(0, 120));
  r = await handleApi('GET', `/api/admin/orch/tx/${txId}`, {}, {}, ADMIN);
  bad('编排详情', r.status === 200, JSON.stringify(r.json).slice(0, 100));
}
await call('编排健康探测', 'POST', '/api/admin/orch/health/check', {}, {}, ADMIN);
const recon = await handleApi('GET', '/api/admin/orch/recon', {}, {}, ADMIN);
if (recon.json?.diffs?.length) {
  const d0 = recon.json.diffs[0];
  r = await handleApi('POST', `/api/admin/orch/diff/${d0.id}/fix`, {}, {}, ADMIN);
  bad('对账差异补单', r.status === 200, JSON.stringify(r.json).slice(0, 100));
} else pass++;

// ---------- 9. 合规中心 ----------
await call('AML筛查', 'POST', '/api/admin/compliance/screen', {}, { name: '测试公司', type: 'kyb' }, ADMIN);
r = await handleApi('GET', '/api/admin/risk', {}, {}, ADMIN);
const ev0 = (r.json?.list || [])[0];
if (ev0) {
  r = await handleApi('POST', '/api/admin/compliance/str', {}, { riskEventId: ev0.id }, ADMIN);
  bad('由风险事件生成STR草稿', r.status === 200, JSON.stringify(r.json).slice(0, 120));
} else pass++;
const strs = await handleApi('GET', '/api/admin/compliance/str', {}, {}, ADMIN);
const s0 = (strs.json?.list || [])[0];
if (s0 && s0.status !== 'submitted') {
  r = await handleApi('POST', `/api/admin/compliance/str/${s0.id}/submit`, {}, {}, ADMIN);
  bad('STR 提交', r.status === 200, JSON.stringify(r.json).slice(0, 100));
} else pass++;
const kybs = await handleApi('GET', '/api/admin/compliance/kyb', {}, {}, ADMIN);
const kb0 = (kybs.json?.list || kybs.json || [])[0];
if (kb0 && kb0.status === 'pending') {
  r = await handleApi('POST', `/api/admin/compliance/kyb/${kb0.id}/action`, {}, { action: 'approve' }, ADMIN);
  bad('KYB 审核', r.status === 200, JSON.stringify(r.json).slice(0, 100));
} else pass++;
const cases = await handleApi('GET', '/api/admin/compliance/cases', {}, {}, ADMIN);
const c0 = (cases.json?.list || [])[0];
if (c0) {
  r = await handleApi('POST', `/api/admin/compliance/cases/${c0.id}/action`, {}, { action: 'close', note: '回归关闭' }, ADMIN);
  bad('合规案件动作', r.status === 200 || r.status === 400, JSON.stringify(r.json).slice(0, 100));
} else pass++;

// ---------- 10. 企业卡全链 ----------
const ents = await handleApi('GET', '/api/admin/ent/accounts', {}, {}, ADMIN);
const e0 = (ents.json?.list || [])[0];
const entDetail = e0 ? await handleApi('GET', `/api/admin/ent/accounts/${e0.id}`, {}, {}, ADMIN) : null;
const depts = entDetail?.json?.depts || [];
if (e0) {
  r = await handleApi('POST', '/api/admin/ent/topup', {}, { entId: e0.id, amount: 50000 }, ADMIN);
  bad('企业充值', r.status === 200, JSON.stringify(r.json).slice(0, 120));
  if (depts[0]) {
    r = await handleApi('POST', `/api/admin/ent/depts/${depts[0].id}/budget`, {}, { delta: 20000 }, ADMIN);
    bad('部门预算调整', r.status === 200, JSON.stringify(r.json).slice(0, 120));
  }
  r = await handleApi('POST', '/api/admin/ent/cards/issue', {}, { entId: e0.id, deptId: depts[0]?.id, count: 1 }, ADMIN);
  bad('批量发卡', r.status === 200, JSON.stringify(r.json).slice(0, 140));
  const ecards = r.json?.cards || r.json?.list || [];
  const ec0 = Array.isArray(ecards) ? ecards[0] : null;
  if (ec0) {
    await handleApi('POST', '/api/admin/ent/cards/limits', {}, { cardId: ec0.id, single: 500, monthly: 5000 }, ADMIN);
    r = await handleApi('POST', '/api/admin/ent/consume', {}, { entId: e0.id, cardId: ec0.id, amount: 100, merchant: 'OfficeDepot' }, ADMIN);
    bad('员工卡消费', r.status === 200, JSON.stringify(r.json).slice(0, 140));
    r = await handleApi('POST', '/api/admin/ent/consume', {}, { entId: e0.id, cardId: ec0.id, amount: 1000, merchant: 'Test' }, ADMIN);
    bad('超预算消费转审批或被拒', r.status === 200 || r.status === 400, JSON.stringify(r.json).slice(0, 140));
    const eaps = await handleApi('GET', '/api/admin/ent/approvals', {}, {}, ADMIN);
    const ea0 = (eaps.json?.list || [])[0];
    if (ea0 && ea0.status === 'pending') {
      r = await handleApi('POST', `/api/admin/ent/approvals/${ea0.id}/action`, {}, { action: 'approve' }, ADMIN);
      bad('企业消费审批', r.status === 200, JSON.stringify(r.json).slice(0, 120));
    } else pass++;
  }
  const bills = await handleApi('GET', '/api/admin/ent/bills', {}, {}, ADMIN);
  const b0 = (bills.json?.list || []).find(x => !x.invoiceNo) || (bills.json?.list || [])[0];
  if (b0) {
    r = await handleApi('POST', `/api/admin/ent/bills/${b0.id}/invoice`, {}, {}, ADMIN);
    bad('账单开票 ok 或已开票 400', r.status === 200 || r.status === 400, JSON.stringify(r.json).slice(0, 100));
    const b1 = (bills.json?.list || []).find(x => x.status !== 'paid');
    if (b1) {
      r = await handleApi('POST', `/api/admin/ent/bills/${b1.id}/pay`, {}, {}, ADMIN);
      bad('账单支付', r.status === 200, JSON.stringify(r.json).slice(0, 100));
    } else pass++;
  } else pass++;
} else { pass++; console.log('  (no ent accounts — skip)'); }

// ---------- 11. 商户后台 + 门户 ----------
r = await handleApi('GET', '/api/admin/mch/refunds', {}, {}, ADMIN);
const rf0 = (r.json?.list || [])[0];
if (rf0 && rf0.status === 'pending') {
  r = await handleApi('POST', `/api/admin/mch/refunds/${rf0.id}/action`, {}, { action: 'approve' }, ADMIN);
  bad('商户退款审核', r.status === 200, JSON.stringify(r.json).slice(0, 120));
} else pass++;
r = await handleApi('GET', '/api/admin/mch/settles', {}, {}, ADMIN);
const st0 = (r.json?.list || [])[0];
if (st0 && st0.status !== 'settled') {
  r = await handleApi('POST', `/api/admin/mch/settles/${st0.id}/settle`, {}, {}, ADMIN);
  bad('商户结算', r.status === 200, JSON.stringify(r.json).slice(0, 120));
} else pass++;
const mchs = await handleApi('GET', '/api/admin/mch/accounts', {}, {}, ADMIN);
const ma0 = (mchs.json?.list || [])[0];
if (ma0) {
  r = await handleApi('POST', `/api/admin/mch/accounts/${ma0.id}/rate`, {}, { credit: 0.025, debit: 0.012, fx: 0.01, debitCap: 2, settleDays: 1 }, ADMIN);
  bad('商户费率调整', r.status === 200, JSON.stringify(r.json).slice(0, 120));
}
// 商户门户
for (const [path] of [['/api/mch/me'], ['/api/mch/profile'], ['/api/mch/orders'], ['/api/mch/refunds'], ['/api/mch/settles']]) {
  await call(`MCH GET ${path}`, 'GET', path, {}, {}, MCH);
}
r = await handleApi('GET', '/api/mch/me', {}, {}, {});
bad('商户门户未登录 401', r.status === 401, `got ${r.status}`);
const mo = await handleApi('GET', '/api/mch/orders', { status: 'paid' }, {}, MCH);
const mo0 = (mo.json?.list || [])[0];
if (mo0) {
  r = await handleApi('POST', '/api/mch/refunds', {}, { orderId: mo0.id, reason: '回归退款' }, MCH);
  bad('商户门户发起退款', r.status === 200 || r.status === 409, JSON.stringify(r.json).slice(0, 100));
} else pass++;

// ---------- 12. BI / 运维 ----------
r = await handleApi('GET', '/api/admin/bi/report', { metrics: 'gmv,topup,consume', dims: 'day', format: 'csv' }, {}, ADMIN);
bad('BI CSV 导出', r.status === 200 && typeof r.json?.csv === 'string' && r.json.csv.includes(','), `got ${r.status} ${String(r.json?.csv).slice(0, 60)}`);
r = await handleApi('POST', '/api/admin/ops/ratelimit/test', {}, {}, ADMIN);
bad('限流演示(429 或 ok)', r.status === 200 || r.status === 429, `got ${r.status}`);
const flags = await handleApi('GET', '/api/admin/ops/flags', {}, {}, ADMIN);
const f0 = (flags.json?.list || [])[0];
if (f0) {
  r = await handleApi('PATCH', `/api/admin/ops/flags/${f0.id}`, {}, { enabled: !f0.enabled }, ADMIN);
  bad('FF 切换', r.status === 200, JSON.stringify(r.json).slice(0, 100));
  await handleApi('PATCH', `/api/admin/ops/flags/${f0.id}`, {}, { enabled: f0.enabled }, ADMIN);
}
const traces = await handleApi('GET', '/api/admin/ops/trace', {}, {}, ADMIN);
const tc0 = (traces.json?.candidates || [])[0];
if (tc0) {
  r = await handleApi('GET', `/api/admin/ops/trace/${tc0.txId}`, {}, {}, ADMIN);
  bad('链路追踪详情', r.status === 200, JSON.stringify(r.json).slice(0, 100));
} else pass++;
r = await handleApi('GET', '/api/admin/ops/backup', {}, {}, ADMIN);
bad('全量备份导出', r.status === 200 && r.json?.counts, JSON.stringify(r.json).slice(0, 80));

// ---------- 13. 开放平台 ----------
const apps = await handleApi('GET', '/api/admin/open/apps', {}, {}, ADMIN);
const app0 = (apps.json?.list || [])[0];
const key = app0?.appKey || '';
if (key) {
  r = await handleApi('GET', '/api/open/user', {}, {}, { 'x-app-key': key });
  bad('开放API 鉴权调用', r.status === 200 || r.status === 404, `got ${r.status} ${JSON.stringify(r.json).slice(0, 80)}`);
  r = await handleApi('GET', '/api/open/balance', {}, { userId: 1 }, { 'x-app-key': key });
  bad('开放API balance', r.status === 200 || r.status === 404, `got ${r.status}`);
} else pass++;
r = await handleApi('GET', '/api/open/user', {}, {}, {});
bad('开放API 无key 401', r.status === 401, `got ${r.status}`);

// ---------- 14. demo reset 后账本仍恒等 ----------
r = await handleApi('POST', '/api/demo/reset', {}, {}, ADMIN);
bad('demo reset', r.status === 200, JSON.stringify(r.json).slice(0, 80));
r = await handleApi('GET', '/api/admin/ledger/verify', {}, {}, ADMIN);
bad('reset 后账本恒等', ledgerOk(r.json), JSON.stringify(r.json).slice(0, 160));

console.log(`\n===== PASS ${pass}  FAIL ${fail} =====`);
for (const f of fails) console.log('FAIL: ' + f);
process.exit(fail ? 1 : 0);
