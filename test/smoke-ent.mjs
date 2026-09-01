// 企业服务域 HTTP 冒烟: 充值→部门预算→批量发卡备案→超限消费审批→账单开票/支付→复式账本平衡
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

// 0. 重置演示数据
let r = await call('POST', '/api/demo/reset');
log('演示数据重置(需总监)', r.status === 200, JSON.stringify(r).slice(0, 120));

// 1. 企业列表
r = await call('GET', '/api/admin/ent/accounts');
log('企业账户列表', r.status === 200 && Array.isArray(r.json.list) && r.json.list.length > 0, JSON.stringify(r).slice(0, 120));
const ent = (r.json.list || []).find(item => item.status === 'active');
log('存在 active 企业', !!ent, JSON.stringify(r.json.list || []).slice(0, 200));
const entId = ent.id;
const before = { balance: ent.balance, pendingBills: ent.pendingBills, pendingApprovals: ent.pendingApprovals };

// 2. 权限: 普通销售 403 / 匿名 401
r = await call('GET', '/api/admin/ent/accounts', {}, { 'x-sales': '30' });
log('普通销售访问企业服务 403', r.status === 403, JSON.stringify(r).slice(0, 100));
r = await call('GET', '/api/admin/ent/accounts', {}, {});
log('匿名访问企业服务 403(与 legacy 一致)', r.status === 403, JSON.stringify(r).slice(0, 100));

// 3. 企业详情
r = await call('GET', `/api/admin/ent/accounts/${entId}`);
log('企业详情(members/depts/cards)', r.status === 200 && Array.isArray(r.json.members) && Array.isArray(r.json.depts), JSON.stringify(r).slice(0, 120));
const dept = (r.json.depts || [])[0];
log('企业有部门', !!dept, JSON.stringify(r.json.depts || []).slice(0, 200));

// 4. 企业充值
r = await call('POST', '/api/admin/ent/topup', { entId, amount: 50000, method: 'fiat' });
log('企业充值 $50000', r.status === 200 && r.json.ok === true && r.json.balance === before.balance + 50000, JSON.stringify(r).slice(0, 200));
const topupRoute = r.json.route;

// 5. 部门预算调整
r = await call('POST', `/api/admin/ent/depts/${dept.id}/budget`, { delta: 8000, note: 'Q4 采购追加' });
log('部门预算追加 $8000', r.status === 200 && r.json.ok === true, JSON.stringify(r).slice(0, 200));
const budgetFrom = r.json.dept ? r.json.dept.monthlyBudget - 8000 : null;

// 6. 批量发卡(备案审批)
r = await call('POST', '/api/admin/ent/cards/issue', { entId, deptId: dept.id, count: 3, level: 'gold' });
log('批量发卡 3 张 gold', r.status === 200 && r.json.count === 3 && r.json.approvalNo > 0, JSON.stringify(r).slice(0, 200));
const approvalNo = r.json.approvalNo;
const card = (r.json.cards || [])[0];

// 备案单进入审批中心
r = await call('GET', '/api/admin/approvals');
const filing = (r.json.list || []).find(item => item.id === approvalNo);
log('备案单已进入审批中心', !!filing, JSON.stringify(r.json.list || []).slice(0, 200));
r = await call('POST', `/api/admin/approvals/${approvalNo}/action`, { action: 'approve', note: '归档确认' });
log('备案单审批中心归档', r.status === 200, JSON.stringify(r).slice(0, 160));

// 7. 超限消费 → 待审批
r = await call('POST', '/api/admin/ent/consume', { entId, cardId: card.id, amount: 5000, merchant: 'AWS Cloud', note: '云服务采购' });
log('超限消费生成待审批单', r.status === 200 && r.json.needApproval === true && r.json.approval.status === 'pending', JSON.stringify(r).slice(0, 200));
const txApprovalId = r.json.approval.id;

// 额度内消费 → 免审直接入账
r = await call('POST', '/api/admin/ent/consume', { entId, cardId: card.id, amount: 100, merchant: '星巴克', note: '部门下午茶' });
log('额度内消费免审入账', r.status === 200 && r.json.auto === true, JSON.stringify(r).slice(0, 200));

// 8. 消费审批: 通过 → 复式记账+扣部门预算
r = await call('GET', '/api/admin/ent/approvals');
log('消费审批列表', r.status === 200 && r.json.summary.total > 0, JSON.stringify(r).slice(0, 120));
r = await call('POST', `/api/admin/ent/approvals/${txApprovalId}/action`, { action: 'approve' });
log('超限消费审批通过并入账', r.status === 200 && r.json.ok === true && r.json.ledgerTxId, JSON.stringify(r).slice(0, 200));

// 重复操作 → 409
r = await call('POST', `/api/admin/ent/approvals/${txApprovalId}/action`, { action: 'approve' });
log('重复审批返回 409', r.status === 409, JSON.stringify(r).slice(0, 100));

// 驳回路径: 再造一笔超限, 驳回必须带原因
r = await call('POST', '/api/admin/ent/consume', { entId, cardId: card.id, amount: 4500, merchant: 'AWS Cloud 2' });
const rejectId = r.json.approval ? r.json.approval.id : null;
r = await call('POST', `/api/admin/ent/approvals/${rejectId}/action`, { action: 'reject' });
log('驳回缺原因返回 400', r.status === 400, JSON.stringify(r).slice(0, 100));
r = await call('POST', `/api/admin/ent/approvals/${rejectId}/action`, { action: 'reject', note: '非必要采购' });
log('驳回成功且不入账', r.status === 200 && r.json.approval.status === 'rejected', JSON.stringify(r).slice(0, 160));

// 9. 账单开票/支付
r = await call('GET', '/api/admin/ent/bills');
log('企业账单列表', r.status === 200 && Array.isArray(r.json.list), JSON.stringify(r).slice(0, 120));
const pendingBill = (r.json.list || []).find(item => item.status === 'pending');
log('存在待支付账单', !!pendingBill, JSON.stringify(r.json.list || []).slice(0, 300));
r = await call('POST', `/api/admin/ent/bills/${pendingBill.id}/invoice`);
log('账单开票', r.status === 200 && /^INV-/.test(r.json.bill.invoiceNo || ''), JSON.stringify(r).slice(0, 160));
r = await call('POST', `/api/admin/ent/bills/${pendingBill.id}/invoice`);
log('重复开票返回 409', r.status === 409, JSON.stringify(r).slice(0, 100));
r = await call('POST', `/api/admin/ent/bills/${pendingBill.id}/pay`);
log('账单支付(借 ent / 贷 fee)', r.status === 200 && r.json.bill.status === 'paid', JSON.stringify(r).slice(0, 160));
r = await call('POST', `/api/admin/ent/bills/${pendingBill.id}/pay`);
log('重复支付返回 409', r.status === 409, JSON.stringify(r).slice(0, 100));

// 10. 部门报表 + 卡限额
r = await call('GET', '/api/admin/ent/report');
log('部门预算报表', r.status === 200 && r.json.summary.depts > 0, JSON.stringify(r).slice(0, 120));
r = await call('POST', '/api/admin/ent/cards/limits', { cardId: card.id, single: 8000, daily: 20000, monthly: 90000 });
log('卡限额调整(单笔≤日≤月)', r.status === 200 && r.json.card.limits.single === 8000, JSON.stringify(r).slice(0, 160));
r = await call('POST', '/api/admin/ent/cards/limits', { cardId: card.id, single: 90000, daily: 20000, monthly: 90000 });
log('非法限额(单笔>日)返回 400', r.status === 400, JSON.stringify(r).slice(0, 100));

// 11. 充值后复式账本仍平衡
r = await call('GET', '/api/admin/ledger/verify');
log('复式账本平衡', r.status === 200 && r.json.balanced === true, JSON.stringify(r).slice(0, 300));

// 12. 动态路由 404
r = await call('GET', '/api/admin/ent/accounts/999999');
log('企业不存在返回 404', r.status === 404, JSON.stringify(r).slice(0, 100));

console.log(`\n===== 企业域 HTTP 冒烟 PASS ${pass} FAIL ${fail} =====`);
process.exit(fail ? 1 : 0);
