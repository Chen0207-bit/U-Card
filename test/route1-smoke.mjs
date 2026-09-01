// 线路1: 持卡人全生命周期冒烟 — 选账号→卡包→KYC→充值→消费→签到→积分→商城→个人中心
const B = 'http://localhost:5177';
let pass = 0, fail = 0;
const resetDemo = async () => {
  const r = await fetch(B + '/api/demo/reset', { method: 'POST', headers: { 'x-sales': '1' } });
  if (!r.ok) throw new Error(`无法恢复测试种子: HTTP ${r.status}`);
};
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
};
const api = async (p, opt = {}) => {
  const r = await fetch(B + p, {
    ...opt,
    headers: { 'content-type': 'application/json', 'x-user': String(U), ...(opt.headers || {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  return { status: r.status, j: await r.json().catch(() => null) };
};
let U = 3; // Mohammed, KYC L1
await resetDemo();

console.log('\n== 1. 选账号/登录态 ==');
let r = await api('/api/app/users');
ok('账号列表', r.status === 200 && Array.isArray(r.j) && r.j.length >= 6, JSON.stringify(r.j).slice(0, 120));
r = await api('/api/app/me');
ok('me 卡包信息(卡号/余额/KYC/积分)', r.status === 200 && r.j.card && r.j.points >= 0, JSON.stringify(r.j).slice(0, 200));
const me0 = r.j;
const kycBefore = me0.kycLevel;

console.log('\n== 2. KYC 升级 ==');
r = await api('/api/app/kyc', { method: 'POST' });
ok('提交 KYC 升级申请', r.status === 200 && r.j.ok, JSON.stringify(r.j));
r = await api('/api/app/me');
ok('状态变为待审核', r.j.kycStatus === 'pending_upgrade' || r.j.kycLevel >= kycBefore, JSON.stringify(r.j).slice(0, 160));

console.log('\n== 3. USDT 充值 ==');
const balBefore = me0.balances?.find?.(x => x.currency === 'USD')?.amount ?? me0.balance ?? me0.card?.balance;
r = await api('/api/app/topup', { method: 'POST', body: { amount: 500, method: 'USDT-TRC20' } });
ok('充值 $500 返回订单/到账', r.status === 200 && !r.j.error, JSON.stringify(r.j).slice(0, 200));
r = await api('/api/app/me');
const balAfter = r.j.balances?.find?.(x => x.currency === 'USD')?.amount ?? r.j.balance ?? r.j.card?.balance;
ok('余额已增加', Number(balAfter) > Number(balBefore), `before=${balBefore} after=${balAfter}`);
r = await api('/api/app/transactions');
ok('交易流水含充值记录', Array.isArray(r.j) && r.j.some(t => /充值|topup|Topup/i.test(t.type + t.desc + (t.merchant || ''))), '');

console.log('\n== 4. 消费(积分抵扣+返积分) ==');
const ptsBefore = (await api('/api/app/me')).j.points;
r = await api('/api/app/pay', { method: 'POST', body: { amount: 100, merchant: 'Amazon', usePoints: true } });
ok('$100 消费成功', r.status === 200 && !r.j.error, JSON.stringify(r.j).slice(0, 200));
const me1 = (await api('/api/app/me')).j;
ok('返积分实时到账', me1.points !== ptsBefore, `before=${ptsBefore} after=${me1.points}`);
r = await api('/api/app/points');
ok('积分流水含消费返积分', Array.isArray(r.j) && r.j.length > 0 && r.j.some(l => /消费|返/.test(l.source || '')), '');

console.log('\n== 5. 任务签到 ==');
r = await api('/api/app/sign', { method: 'POST' });
ok('每日签到+20 或今日已签到', (r.status === 200 && r.j.ok) || (r.status === 400 && r.j.error === '今日已签到'), JSON.stringify(r.j));
r = await api('/api/app/tasks');
ok('任务列表+签到状态', r.j.tasks?.length >= 3 && 'signedToday' in r.j, JSON.stringify(r.j).slice(0, 160));
const t = (r.j.tasks || []).find(x => !((r.j.claimed || []).includes(x.id)));
if (t) {
  r = await api('/api/app/task/claim', { method: 'POST', body: { id: t.id } });
  ok(`领取任务「${t.title}」`, r.status === 200 && !r.j.error, JSON.stringify(r.j));
}

console.log('\n== 6. 积分中心 ==');
r = await api('/api/app/points/summary');
ok('积分总览(冻结/即将过期/分类)', r.j.total >= 0 && ('frozen' in r.j || 'expiring' in r.j || r.j.categories || r.j.bySource), JSON.stringify(r.j).slice(0, 240));

console.log('\n== 7. 商城兑换 ==');
r = await api('/api/app/products');
ok('商品列表(限购/评分)', r.j.products?.length >= 4 && r.j.categories?.length >= 1, JSON.stringify(r.j).slice(0, 200));
const prod = (r.j.products || []).find(p => p.points <= me1.points) || r.j.products?.[0];
r = await api('/api/app/redeem', { method: 'POST', body: { id: prod.id } });
ok(`兑换「${prod.name}」`, r.status === 200 && !r.j.error, JSON.stringify(r.j).slice(0, 200));
r = await api('/api/app/orders');
const order = Array.isArray(r.j) ? r.j[0] : r.j.orders?.[0];
ok('订单列表最新一条', !!order, JSON.stringify(r.j).slice(0, 200));
if (order && order.status === 'pending') {
  r = await api('/api/app/orders/cancel', { method: 'POST', body: { id: order.id } });
  ok('取消订单退积分', r.status === 200 && !r.j.error, JSON.stringify(r.j).slice(0, 160));
}

console.log('\n== 8. 个人中心 ==');
r = await api('/api/app/notifications');
ok('消息通知', r.status === 200 && (r.j.list?.length >= 0 || Array.isArray(r.j)), '');
r = await api('/api/app/notifications/read', { method: 'POST', body: { all: true } });
ok('一键已读', r.status === 200, JSON.stringify(r.j));
r = await api('/api/app/password', { method: 'POST', body: { oldPassword: 'old123', newPassword: 'Abc12345', newPassword2: 'Abc12345' } });
ok('修改密码校验通过', r.status === 200 && !r.j.error, JSON.stringify(r.j));
r = await api('/api/app/password', { method: 'POST', body: { oldPassword: 'old123', newPassword: 'A', newPassword2: 'B' } });
ok('两次不一致被拦截', !!r.j.error, JSON.stringify(r.j));
r = await api('/api/app/invite');
ok('邀请返利页', r.status === 200 && r.j.code, JSON.stringify(r.j).slice(0, 160));

console.log('\n== 9. 卡自助管控(加分项) ==');
r = await api('/api/app/card/freeze', { method: 'POST' });
const fz = r.status === 200 && !r.j.error;
ok('自助冻结', fz, JSON.stringify(r.j));
if (fz) {
  r = await api('/api/app/pay', { method: 'POST', body: { amount: 10, merchant: 'Amazon' } });
  ok('冻结后支付被拒', !!r.j.error, JSON.stringify(r.j).slice(0, 160));
  r = await api('/api/app/card/unfreeze', { method: 'POST' });
  ok('自助解冻', r.status === 200 && !r.j.error, JSON.stringify(r.j));
}

console.log(`\n===== 线路1 结果: ${pass} 通过 / ${fail} 失败 =====`);
await resetDemo();
process.exit(fail ? 1 : 0);
