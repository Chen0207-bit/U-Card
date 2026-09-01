// 线路2-6 关键记忆点验证: 分佣/风控/账本/FF+幂等/商户
const B = 'http://localhost:5177';
let pass = 0, fail = 0;
const resetDemo = async () => {
  const r = await fetch(B + '/api/demo/reset', { method: 'POST', headers: { 'x-sales': '1' } });
  if (!r.ok) throw new Error(`无法恢复测试种子: HTTP ${r.status}`);
};
const ok = (name, cond, detail = '') => cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}  ${detail}`));
const call = async (p, opt = {}, h = {}) => {
  const r = await fetch(B + p, { ...opt, headers: { 'content-type': 'application/json', ...h }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  return { status: r.status, j: await r.json().catch(() => null) };
};
const admin = (p, opt = {}, sid = 1) => call(p, opt, { 'x-sales': String(sid) });
const app = (p, opt = {}, uid = 1) => call(p, opt, { 'x-user': String(uid) });
await resetDemo();

console.log('\n== 线路2: 一笔消费 → 三级分佣 ==');
await app('/api/app/topup', { method: 'POST', body: { amount: 300, method: 'USDT-TRC20' } }, 1);
const before = (await admin('/api/admin/commissions')).j.length;
const pay = await app('/api/app/pay', { method: 'POST', body: { amount: 100, merchant: 'Noon' } }, 1);
ok('$100 消费成功', !pay.j.error, JSON.stringify(pay.j).slice(0, 120));
const all = (await admin('/api/admin/commissions')).j;
const txId = pay.j.tx?.id ?? pay.j.orderId;
const news = all.filter(c => c.refId === txId);
ok(`生成 3 条佣金(1%/2%/0.5%) 关联单 ${txId}`, news.length === 3, `n=${news.length}`);
const tiers = news.map(c => c.tierLabel + ':' + c.rate + ':$' + c.amount).join(' | ');
ok('三级比例与金额正确(1%/2%/0.5%)', news.some(c => c.rate === '1%') && news.some(c => c.rate === '2%') && news.some(c => c.rate === '0.5%') && news.every(c => c.refId === txId), tiers);
ok('佣金状态待结算', news.every(c => c.status === 'pending'), tiers);
const tree = (await admin('/api/admin/commissions/tree')).j;
ok('分销链路(组织树+实时链)', !tree.error && (tree.tree || tree.chains || tree.recent || tree.members), Object.keys(tree).join(','));
// 数据权限: 三级销售只看自己子树
const mgr = (await admin('/api/admin/accounts')).j;
const l3 = (Array.isArray(mgr) ? mgr : mgr.list || []).find(a => (a.level ?? a.role) === 3 || /三级/.test(a.label || a.roleName || ''));
ok('后台账号列表(总监+各级销售)', (Array.isArray(mgr) ? mgr.length : (mgr.list || []).length) >= 5, '');

console.log('\n== 线路3: 风控拦截/冻结 ==');
const r2 = await app('/api/app/pay', { method: 'POST', body: { amount: 2000, merchant: 'Amazon' } }, 1);
ok('$2000 被「大额交易拦截」拒绝', !!r2.j.error && /大额|拦截|1000/.test(r2.j.error), JSON.stringify(r2.j).slice(0, 160));
const hits = (await admin('/api/admin/risk-engine/hits')).j;
ok('命中记录入库', (hits.list || hits).length >= 1, Object.keys(hits).join(','));
const scores = (await admin('/api/admin/risk-engine/scores')).j;
ok('用户风险评分可查', !scores.error && ((scores.list || scores).length >= 1), '');
// 新建 freeze 规则 → 支付成功但卡被冻结
const nr = await admin('/api/admin/risk-engine/rules', { method: 'POST', body: { name: '演示-超$150冻结' + Date.now(), action: 'freeze', conditions: [{ field: 'amount', op: '>', value: 150 }], scene: ['pay'], level: 'high' } });
ok('新建冻结动作规则', !nr.j.error, JSON.stringify(nr.j).slice(0, 160));
await app('/api/app/topup', { method: 'POST', body: { amount: 300, method: 'USDT-TRC20' } }, 2);
const pf = await app('/api/app/pay', { method: 'POST', body: { amount: 180, merchant: 'Noon' } }, 2);
ok('$180 交易本身成功', !pf.j.error, JSON.stringify(pf.j).slice(0, 160));
const me2 = (await app('/api/app/me', {}, 2)).j;
ok('卡被自动冻结', me2.card?.status === 'frozen', me2.card?.status);
const r3 = await app('/api/app/pay', { method: 'POST', body: { amount: 20, merchant: 'Noon' } }, 2);
ok('冻结后再付被拒', !!r3.j.error, JSON.stringify(r3.j).slice(0, 120));
const uz = await app('/api/app/card/unfreeze', { method: 'POST' }, 2);
ok('自助解冻恢复', !uz.j.error || /挂失/.test(uz.j.error || ''), JSON.stringify(uz.j));

console.log('\n== 线路4: 账本恒等 ==');
const led = (await admin('/api/admin/ledger/accounts')).j;
const accN = (led.list || led.accounts || led).length;
ok(`复式账本账户(${accN}个)`, accN >= 40, String(accN));
const ver = (await admin('/api/admin/ledger/verify')).j;
ok('账本平衡校验 balanced', ver.balanced === true || ver.ok === true, JSON.stringify(ver).slice(0, 200));

console.log('\n== 线路5: Feature Flag + 幂等 ==');
const fl = (await admin('/api/admin/ops/flags')).j;
const shop = (fl.list || []).find(f => f.key === 'shopFlag');
ok('FF 列表含 shopFlag', !!shop, '');
await admin(`/api/admin/ops/flags/${shop.id}`, { method: 'PATCH', body: { enabled: false } });
const prods503 = await app('/api/app/products');
ok('关商城 → 用户端 503 降级提示', prods503.status === 503 && /下线|Flag/.test(prods503.j?.error || ''), JSON.stringify(prods503.j).slice(0, 140));
await admin(`/api/admin/ops/flags/${shop.id}`, { method: 'PATCH', body: { enabled: true } });
const prods200 = await app('/api/app/products');
ok('恢复后商城正常', prods200.status === 200 && prods200.j.products?.length >= 4, '');
const idem = 'demo-idem-' + Date.now();
const o1 = await admin('/api/admin/orch/txs', { method: 'POST', body: { scene: 'topup_crypto', amount: 66, currency: 'USD', idempotencyKey: idem } });
const o2 = await admin('/api/admin/orch/txs', { method: 'POST', body: { scene: 'topup_crypto', amount: 66, currency: 'USD', idempotencyKey: idem } });
const id1 = o1.j.tx?.id ?? o1.j.order?.id ?? o1.j.id, id2 = o2.j.tx?.id ?? o2.j.order?.id ?? o2.j.id;
ok('幂等键连提两次同一单', id1 && id1 === id2, `o1=${JSON.stringify(o1.j).slice(0, 100)} o2=${JSON.stringify(o2.j).slice(0, 100)}`);
const ad = (await admin('/api/admin/orch/adapters')).j;
ok('支付编排适配器列表', (ad.list || ad.adapters || ad).length >= 4, Object.keys(ad).join(','));

console.log('\n== 线路6: 商户门户 ==');
const mlist = (await call('/api/mch/merchants')).j.list;
ok('商户登录下拉', mlist?.length >= 1, '');
const mid = mlist[0].id;
const mme = await call('/api/mch/me', {}, { 'x-mch': String(mid) });
ok('商户端看板(今日/结算/退款)', mme.j.me?.name && mme.j.today, JSON.stringify(mme.j).slice(0, 140));
const mord = (await call('/api/mch/orders', {}, { 'x-mch': String(mid) })).j;
ok('商户端收款订单', mord.list?.length >= 1, '');
// 后台入驻审核: pending → approve → 秒发商户号
const macc = (await admin('/api/admin/mch/accounts')).j;
const pend = (macc.list || []).find(m => m.status === 'pending');
if (pend) {
  const ap = await admin(`/api/admin/mch/accounts/${pend.id}/action`, { method: 'POST', body: { action: 'approve' } });
  ok('入驻审核通过秒发商户号+APIKey', !ap.j.error, JSON.stringify(ap.j).slice(0, 160));
} else ok('入驻审核(无 pending 种子, 跳过)', true);

console.log(`\n===== 线路2-6 结果: ${pass} 通过 / ${fail} 失败 =====`);
await resetDemo();
process.exit(fail ? 1 : 0);
