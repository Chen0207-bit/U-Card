/**
 * 优卡 U-Card Demo — 业务核心 (node 本地 / Cloudflare Worker 共用, ESM)
 * 数据模型 + 种子数据 + 业务动作 + API 路由, 纯内存, 冷启动重建。
 */
// ---------------- 工具 ----------------
let seed = 42;
function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const now = () => Date.now();
const daysAgo = (d, jitterH = 0) => now() - d * 864e5 - ri(0, jitterH) * 36e5;
let idSeq = 1000;
const nid = () => ++idSeq;

// ---------------- 业务配置 ----------------
const CARD_LEVELS = {
  standard: { label: 'Standard 标准卡', monthlyFee: 1, pointRate: 1, color: '#64748b' },
  gold: { label: 'Gold 金卡', monthlyFee: 5, pointRate: 1.5, color: '#d4a017' },
  platinum: { label: 'Platinum 白金卡', monthlyFee: 15, pointRate: 2, color: '#0ea5e9' },
};
const KYC_LIMITS = { 0: { perTx: 100, perDay: 300 }, 1: { perTx: 1000, perDay: 3000 }, 2: { perTx: 10000, perDay: 50000 } };
// 多级分佣: tiers[0]=直属销售 tiers[1]=上级 tiers[2]=上上级(封顶 3 层), mode: rate=按交易额比例 / fixed=固定金额
const COMMISSION = {
  card:    { label: '发卡奖励', mode: 'fixed', tiers: [5, 1, 1] },
  topup:   { label: '充值佣金', mode: 'rate', tiers: [0.01, 0.02, 0.005] },
  consume: { label: '消费佣金', mode: 'rate', tiers: [0.01, 0.02, 0.005] },
};
const TIER_LABELS = ['直属', '上级', '上上级'];
const POINTS_PER_USD = 10; // 1 USD = 10 分(基础), 再乘卡等级倍率

// ---------------- 种子数据(懒初始化: Workers 全局作用域 Date.now()=0, 必须等首个请求再生成真实时间) ----------------
let salesReps, users, cards, transactions, pointsLogs, commissions, customers, followups, products, orders, tasks;
let inited = false;
function initSeed() {
// ---------------- 销售组织(总监→一级→二级→三级) ----------------
// id 段: 1=总监, 10-11 一级, 20-23 二级, 30-41 三级
const S1 = [
  [10, 'Omar Hassan', 1], [11, 'Khalid Al-Suwaidi', 1],
];
const S2 = [
  [20, 'Layla Al-Saad', 10], [21, 'Yusuf Karim', 10], [22, 'Sara Ahmed', 11], [23, 'Mona Sharif', 11],
];
const S3 = [
  [30, 'Tariq Al-Harbi', 20], [31, 'Jassim Al-Thani', 20], [32, 'Saad Al-Dosari', 20],
  [33, 'Rania Sameer', 21], [34, 'Hala Nasser', 21], [35, 'Amira Zaki', 21],
  [36, 'Majed Al-Ghamdi', 22], [37, 'Dalia Kamel', 22], [38, 'Iman Fathi', 22],
  [39, 'Bakr Al-Marri', 23], [40, 'Sana Mahmoud', 23], [41, 'Waleed Al-Faisal', 23],
];
const TARGETS = { 1: null, 1.5: 120000, 2.5: 60000, 3.5: 25000 }; // key=level+0.5 防整数键碰撞
salesReps = [
  { id: 1, name: 'Noura Al-Faisal', role: '销售总监', parentId: null, level: 0, region: '全局', target: null },
  ...S1.map(([id, name, parent]) => ({ id, name, role: '一级销售', parentId: parent, level: 1, region: pick(['海湾北区', '海湾南区']), target: 120000 })),
  ...S2.map(([id, name, parent]) => ({ id, name, role: '二级销售', parentId: parent, level: 2, region: pick(['沙特', '阿联酋', '卡塔尔', '科威特']), target: 60000 })),
  ...S3.map(([id, name, parent]) => ({ id, name, role: '三级销售', parentId: parent, level: 3, region: pick(['利雅得', '迪拜', '多哈', '吉达', '阿布扎比', '科威特城']), target: 25000 })),
];
// 持卡用户 / 卡 ----------------
const userSeed = [
  ['Ahmed Al-Rashid', '+966 55 201 4471', 'Saudi Arabia', 'SA', 'Riyadh', 2, 30],
  ['Fatima Hassan', '+971 50 882 1190', 'UAE', 'AE', 'Dubai', 2, 31],
  ['Mohammed Al-Mutairi', '+966 54 773 8821', 'Saudi Arabia', 'SA', 'Jeddah', 1, 32],
  ['Aisha Abdullah', '+974 33 654 0921', 'Qatar', 'QA', 'Doha', 2, 33],
  ['Khalid Al-Sabah', '+965 99 127 4463', 'Kuwait', 'KW', 'Kuwait City', 1, 34],
  ['Nour El-Sayed', '+20 100 552 8834', 'Egypt', 'EG', 'Cairo', 1, 35],
  ['Hassan Ali', '+971 52 447 2260', 'UAE', 'AE', 'Abu Dhabi', 0, 36],
  ['Mariam Al-Zahrani', '+966 56 338 9052', 'Saudi Arabia', 'SA', 'Dammam', 1, 37],
  ['Ali Al-Mansouri', '+971 55 914 7738', 'UAE', 'AE', 'Sharjah', 0, 38],
  ['Zainab Ibrahim', '+974 55 820 3347', 'Qatar', 'QA', 'Al Wakrah', 1, 39],
  ['Omar Farouk', '+20 111 764 2289', 'Egypt', 'EG', 'Alexandria', 0, 40],
  ['Salma Al-Kuwari', '+974 66 193 5580', 'Qatar', 'QA', 'Doha', 1, 41],
];
users = userSeed.map(([name, phone, country, cc, city, kyc, repId], i) => ({
  id: i + 1, name, phone, email: name.toLowerCase().replace(/[^a-z]+/g, '.') + '@ucard.io',
  country, cc, city, kycLevel: kyc, kycStatus: 'approved', salesRepId: repId,
  invitedBy: i >= 8 ? pick([1, 3, 5]) : null, points: ri(200, 3000), createdAt: daysAgo(ri(10, 90)),
}));
users[2].kycStatus = 'pending_upgrade'; users[4].kycStatus = 'pending_upgrade'; users[10].kycStatus = 'pending_upgrade';

// (genCardNo/cardBins 已移至模块级, 供 initSeed 种子与开户发卡共用)
cards = users.map((u, i) => ({
  id: i + 1, userId: u.id, cardNo: genCardNo(i),
  cvv: String(ri(100, 999)), expMonth: ri(1, 12), expYear: ri(28, 31),
  level: u.kycLevel === 2 ? pick(['gold', 'platinum']) : pick(['standard', 'gold']),
  status: i === 10 ? 'frozen' : 'active', balance: u.kycLevel ? ri(80, 5200) : ri(0, 40),
  salesRepId: u.salesRepId, createdAt: daysAgo(ri(5, 85)),
}));

// ---------------- 交易/积分/佣金 ----------------
const MERCHANTS = ['Amazon', 'Apple Store', 'Noon', 'Namshi', 'Careem', 'Starbucks', 'Emirates Airline', 'Talabat', 'AliExpress', 'STC Recharge', 'Netflix', 'Booking.com'];
transactions = [];
pointsLogs = [];
commissions = [];

// (addPointsLog / addCommissions 已移至模块级, 供 initSeed 种子与 handleApi 业务动作共用)

// 近 30 天种子交易
for (let d = 30; d >= 0; d--) {
  const nTx = ri(2, 5);
  for (let k = 0; k < nTx; k++) {
    const u = pick(users); const card = cards.find(c => c.userId === u.id);
    const ts = daysAgo(d, 23);
    if (rnd() < 0.35) {
      const method = rnd() < 0.6 ? 'usdt' : 'fiat';
      const amt = pick([50, 100, 200, 500, 1000]);
      const fee = +(amt * 0.01).toFixed(2);
      card.balance += amt - fee;
      const tx = { id: nid(), type: 'topup', userId: u.id, cardId: card.id, amount: amt, fee, method, ref: method === 'usdt' ? '0x' + Array.from({ length: 12 }, () => '0123456789abcdef'[ri(0, 15)]).join('') : 'BK' + ri(100000, 999999), pointsEarned: 0, status: 'success', createdAt: ts };
      transactions.push(tx);
      addCommissions(card.salesRepId, 'topup', amt, tx.id, ts);
    } else {
      if (card.balance < 20) continue;
      const amt = +Math.min(rnd() * 480 + 5, card.balance * 0.4).toFixed(2);
      const merchant = pick(MERCHANTS);
      const rate = CARD_LEVELS[card.level].pointRate;
      const pts = Math.floor(amt * POINTS_PER_USD * rate);
      card.balance = +(card.balance - amt).toFixed(2);
      const tx = { id: nid(), type: 'consume', userId: u.id, cardId: card.id, amount: amt, fee: +(amt * 0.02).toFixed(2), method: 'card', merchant, pointsEarned: pts, status: rnd() < 0.03 ? 'refunded' : 'success', createdAt: ts };
      transactions.push(tx);
      if (tx.status === 'success') { addPointsLog(u.id, pts, '消费返积分', tx.id, ts); addCommissions(card.salesRepId, 'consume', amt, tx.id, ts); }
    }
  }
}
transactions.sort((a, b) => b.createdAt - a.createdAt);

// ---------------- CRM ----------------
const STAGES = ['线索', '意向', '方案', '开卡', '充值', '活跃', '沉睡'];
const SOURCES = ['自主注册', '销售开发', '推荐引流', '活动导入'];
const crmNames = ['Sultan Al-Qahtani', 'Huda Mansour', 'Rashid Al-Nuaimi', 'Dalia Kamel', 'Faisal Al-Otaibi', 'Mona Sharif', 'Bakr Al-Suwaidi', 'Rana Adel', 'Tariq Al-Harbi', 'Sana Mahmoud', 'Jassim Al-Thani', 'Iman Fathi', 'Saad Al-Dosari', 'Hala Nasser', 'Waleed Al-Faisal', 'Amira Zaki', 'Majed Al-Ghamdi', 'Rania Sameer'];
customers = crmNames.map((name, i) => ({
  id: i + 1, name, country: pick(['Saudi Arabia', 'UAE', 'Qatar', 'Kuwait', 'Egypt']),
  source: pick(SOURCES), industry: pick(['电商个体户', '外贸公司', '自由职业', '留学家庭', '数码零售', '物流公司']),
  contact: '+9' + ri(10, 77) + ' ' + ri(100, 999) + ' ' + ri(1000, 9999),
  ownerSalesId: i < 15 ? 30 + i : pick([20, 21, 22, 23]), // 主要落在三级销售, 3 个归二级
  stage: STAGES[Math.min(6, Math.floor(rnd() * 8))], tags: pick([['高净值'], ['价格敏感'], ['老客户转介绍'], ['企业采购'], []]),
  nextFollowAt: daysAgo(-ri(0, 6)), remark: pick(['对费率敏感，已发报价单', '等待 KYC 资料', '想对比竞品', '首充意愿强', '需阿语客服支持', '']),
  userId: i < 6 ? users[i].id : null, createdAt: daysAgo(ri(3, 60)),
}));
followups = [];
customers.forEach(c => {
  const n = ri(1, 4);
  for (let j = 0; j < n; j++) {
    followups.push({ id: nid(), customerId: c.id, salesId: c.ownerSalesId, type: pick(['电话', '面谈', 'WhatsApp', '邮件']),
      content: pick(['沟通了费率方案，客户表示可以考虑', '发送了产品介绍视频和阿语手册', '客户询问 USDT 充值到账时间', '约定本周五演示系统', '提醒补充 KYC 证件照片', '客户已确认套餐，等待开户']),
      nextPlan: pick(['3 天内跟进 KYC 资料', '下周一发送正式报价', '等待客户财务确认', '']), createdAt: daysAgo(ri(1, 25), 23) });
  }
});
followups.sort((a, b) => b.createdAt - a.createdAt);

// ---------------- 商城 / 任务 / 订单 ----------------
products = [
  { id: 1, name: 'Apple Gift Card $25', category: '充值券', points: 2400, cash: 0, stock: 50, icon: '📱', status: 'on', desc: '美区 Apple ID 充值卡' },
  { id: 2, name: '星巴克中杯券 x2', category: '卡券', points: 900, cash: 0, stock: 100, icon: '☕', status: 'on', desc: '全国门店通用' },
  { id: 3, name: 'USDT 返现 $10', category: '充值券', points: 1050, cash: 0, stock: 999, icon: '💵', status: 'on', desc: '直接充入卡账户余额' },
  { id: 4, name: 'Netflix 一个月', category: '卡券', points: 1300, cash: 0, stock: 80, icon: '🎬', status: 'on', desc: '标准高清会员' },
  { id: 5, name: 'Anker 65W 充电器', category: '实物', points: 5200, cash: 9, stock: 30, icon: '🔌', status: 'on', desc: 'GaN 快充, 顺丰包邮' },
  { id: 6, name: 'AirPods 4', category: '实物', points: 15800, cash: 29, stock: 12, icon: '🎧', status: 'on', desc: '全新正品, 海外仓直发' },
  { id: 7, name: '机场贵宾厅券', category: '权益', points: 3600, cash: 0, stock: 40, icon: '✈️', status: 'on', desc: '全球 700+ 机场贵宾厅' },
  { id: 8, name: '白金卡升级券', category: '权益', points: 8000, cash: 0, stock: 20, icon: '💳', status: 'on', desc: '积分倍率 x2, 免月费 3 个月' },
  { id: 9, name: '积分加成卡 +50%', category: '权益', points: 1500, cash: 0, stock: 60, icon: '⚡', status: 'on', desc: '7 天内消费返积分 1.5 倍' },
  { id: 10, name: 'U-Card 周边礼盒', category: '周边', points: 3000, cash: 5, stock: 0, icon: '🎁', status: 'off', desc: '含卡包/贴纸/挂件' },
];
orders = [
  { id: 9001, userId: 1, productId: 2, pointsCost: 900, status: 'redeemed', redeemCode: 'UC-8821-4402', trackingNo: '', createdAt: daysAgo(12) },
  { id: 9002, userId: 3, productId: 5, pointsCost: 5200, status: 'shipped', redeemCode: '', trackingNo: 'SF' + ri(100000000, 999999999) + 'SA', createdAt: daysAgo(5) },
  { id: 9003, userId: 5, productId: 1, pointsCost: 2400, status: 'pending', redeemCode: '', trackingNo: '', createdAt: daysAgo(1) },
];
tasks = [
  { id: 1, code: 'sign', title: '每日签到', desc: '每天登录即得', points: 20, type: 'daily', icon: '📅' },
  { id: 2, code: 'first_top', title: '首次充值', desc: '完成首笔充值', points: 500, type: 'once', icon: '💰' },
  { id: 3, code: 'first_pay', title: '首次消费', desc: '完成首笔消费', points: 300, type: 'once', icon: '🛍️' },
  { id: 4, code: 'profile', title: '完善个人资料', desc: '填写职业与地址', points: 100, type: 'once', icon: '📝' },
  { id: 5, code: 'invite', title: '邀请 1 位好友', desc: '好友完成注册', points: 800, type: 'once', icon: '🤝' },
];
  inited = true;
}

// ---------------- 业务动作工具(模块级, 依赖 initSeed 填充的数据数组) ----------------
const cardBins = ['5533', '5299', '4571'];
const genCardNo = () => cardBins[ri(0, 2)] + ' ' + String(ri(1000, 9999)) + ' ' + String(ri(1000, 9999)) + ' ' + String(ri(1000, 9999));
function addPointsLog(userId, delta, source, refNo, ts) {
  const u = users.find(x => x.id === userId);
  u.points = Math.max(0, u.points + delta);
  pointsLogs.push({ id: nid(), userId, delta, source, refNo, balanceAfter: u.points, createdAt: ts });
}
// 多级佣金: 从直属销售沿 parent 链向上, 最多 3 层(tiers), 逐级生成佣金记录
function addCommissions(salesId, type, baseAmt, refId, ts) {
  const rule = COMMISSION[type];
  let cur = repById(salesId), tier = 0;
  while (cur && tier < rule.tiers.length) {
    const val = rule.tiers[tier];
    if (val > 0) {
      commissions.push({
        id: nid(), salesId: cur.id, fromSalesId: salesId, tier,
        tierLabel: TIER_LABELS[tier], type, typeLabel: rule.label,
        baseAmt: +baseAmt.toFixed(2),
        rate: rule.mode === 'fixed' ? '$' + val.toFixed(0) : (val * 100).toFixed(val * 100 % 1 ? 1 : 0) + '%',
        amount: +(rule.mode === 'fixed' ? val : baseAmt * val).toFixed(2),
        refId, status: ts < now() - 3 * 864e5 ? 'settled' : 'pending', createdAt: ts,
      });
    }
    cur = cur.parentId ? repById(cur.parentId) : null; tier++;
  }
}

// ---------------- 销售组织工具(模块级, 依赖 initSeed 填充的 salesReps) ----------------
const repById = (id) => salesReps.find(s => s.id === id);
function subtreeIds(salesId) { // 本人 + 全部后代
  const out = [salesId];
  const walk = (pid) => salesReps.filter(s => s.parentId === pid).forEach(c => { out.push(c.id); walk(c.id); });
  walk(salesId);
  return out;
}
const scopeOf = (headers) => { // 数据范围: 未传=总监全量; 传销售 id=其子树
  const sid = parseInt(headers['x-sales'] || headers['x-Sales'] || '0', 10);
  if (!sid || sid === 1) return { sid: 1, ids: salesReps.map(s => s.id) };
  return { sid, ids: subtreeIds(sid) };
};

// ---------------- 业务动作 ----------------
function doTopup(userId, amount, method) {
  const card = cards.find(c => c.userId === userId);
  if (!card) return { error: '未找到卡' };
  if (card.status === 'lost') return { error: '卡已挂失, 无法充值, 请联系客服' };
  if (card.status !== 'active') return { error: '卡已冻结, 无法充值' };
  const fee = +(amount * (method === 'usdt' ? 0.01 : 0.02)).toFixed(2);
  card.balance = +(card.balance + amount - fee).toFixed(2);
  const tx = { id: nid(), type: 'topup', userId, cardId: card.id, amount, fee, method, ref: method === 'usdt' ? '0x' + Array.from({ length: 12 }, () => '0123456789abcdef'[ri(0, 15)]).join('') : 'BK' + ri(100000, 999999), pointsEarned: 0, status: 'success', createdAt: now() };
  transactions.unshift(tx);
  addPointsLog(userId, Math.floor(amount * 5), '充值奖励', tx.id, now());
  addCommissions(card.salesRepId, 'topup', amount, tx.id, now());
  return { tx, balance: card.balance };
}
function doPay(userId, amount, merchant, usePoints) {
  const card = cards.find(c => c.userId === userId);
  const user = users.find(u => u.id === userId);
  if (!card) return { error: '未找到卡' };
  if (card.status === 'lost') return { error: '卡已挂失, 无法支付, 请联系客服' };
  if (card.status !== 'active') return { error: '卡已冻结, 无法支付' };
  const lim = KYC_LIMITS[user.kycLevel];
  if (amount > lim.perTx) return { error: `超出单笔限额($${lim.perTx}), 请升级 KYC` };
  let pointsUsed = 0;
  if (usePoints) { const maxOff = amount * 0.3; pointsUsed = Math.min(user.points, Math.floor(maxOff * 100)); }
  const payUsd = +(amount - pointsUsed / 100).toFixed(2);
  if (payUsd > card.balance) return { error: `余额不足(可用 $${card.balance.toFixed(2)})` };
  const rate = CARD_LEVELS[card.level].pointRate;
  const pts = Math.floor(payUsd * POINTS_PER_USD * rate);
  card.balance = +(card.balance - payUsd).toFixed(2);
  const tx = { id: nid(), type: 'consume', userId, cardId: card.id, amount, fee: +(payUsd * 0.02).toFixed(2), method: 'card', merchant, pointsEarned: pts, pointsUsed, status: 'success', createdAt: now() };
  transactions.unshift(tx);
  if (pointsUsed) addPointsLog(userId, -pointsUsed, '消费抵扣', tx.id, now());
  addPointsLog(userId, pts, '消费返积分', tx.id, now());
  addCommissions(card.salesRepId, 'consume', payUsd, tx.id, now());
  return { tx, balance: card.balance, pointsEarned: pts, pointsUsed };
}
function doRedeem(userId, productId) {
  const p = products.find(x => x.id === productId);
  const user = users.find(u => u.id === userId);
  if (!p || p.status !== 'on') return { error: '商品不可兑换' };
  if (p.stock <= 0) return { error: '库存不足' };
  if (user.points < p.points) return { error: `积分不足(还差 ${p.points - user.points} 分)` };
  p.stock--;
  const order = { id: nid(), userId, productId, pointsCost: p.points, status: p.category === '实物' ? 'pending' : 'redeemed', redeemCode: p.category !== '实物' ? 'UC-' + ri(1000, 9999) + '-' + ri(1000, 9999) : '', trackingNo: '', createdAt: now() };
  orders.unshift(order);
  addPointsLog(userId, -p.points, '商城兑换', order.id, now());
  return { order };
}

// ---------------- 视图辅助 ----------------
const pubUser = (u) => ({ ...u, card: cards.find(c => c.userId === u.id), salesRep: repById(u.salesRepId)?.name });
const pubOrder = (o) => ({ ...o, product: products.find(p => p.id === o.productId), user: users.find(u => u.id === o.userId)?.name });
const pubTx = (t) => ({ ...t, user: users.find(u => u.id === t.userId)?.name, cardNo: cards.find(c => c.id === t.cardId)?.cardNo });
const pubCustomer = (c) => ({ ...c, owner: repById(c.ownerSalesId)?.name, followups: followups.filter(f => f.customerId === c.id) });
const pubCommission = (c) => ({ ...c, sales: repById(c.salesId)?.name, fromSales: repById(c.fromSalesId)?.name });

// 绩效聚合(scopeIds 内的销售)
function perfRows(scopeIds) {
  return salesReps.filter(s => scopeIds.includes(s.id) && s.level > 0).map(s => { // 总监不进业绩榜(与销售同榜无意义)
    const team = subtreeIds(s.id);
    const myUid = users.filter(u => team.includes(u.salesRepId)).map(u => u.id);
    const my = transactions.filter(t => myUid.includes(t.userId) && t.status === 'success');
    const mineUid = users.filter(u => u.salesRepId === s.id).map(u => u.id);
    const mine = transactions.filter(t => mineUid.includes(t.userId) && t.status === 'success');
    return { id: s.id, name: s.name, role: s.role, level: s.level, region: s.region, parentId: s.parentId, target: s.target,
      cards: cards.filter(c => c.salesRepId === s.id).length, customers: customers.filter(c => c.ownerSalesId === s.id).length,
      topup: +my.filter(t => t.type === 'topup').reduce((a, t) => a + t.amount, 0).toFixed(0),
      consume: +my.filter(t => t.type === 'consume').reduce((a, t) => a + t.amount, 0).toFixed(0),
      mineTopup: +mine.filter(t => t.type === 'topup').reduce((a, t) => a + t.amount, 0).toFixed(0),
      mineConsume: +mine.filter(t => t.type === 'consume').reduce((a, t) => a + t.amount, 0).toFixed(0),
      commission: +commissions.filter(c => c.salesId === s.id).reduce((a, c) => a + c.amount, 0).toFixed(2),
      commissionFromTeam: +commissions.filter(c => c.salesId === s.id && c.fromSalesId !== s.id).reduce((a, c) => a + c.amount, 0).toFixed(2),
      teamSize: team.length - 1 };
  });
}

// 最近分佣链路样例: 每笔交易 → 沿链各级佣金
function recentChains(scopeIds, n = 10) {
  const seen = new Set(); const out = [];
  for (const c of [...commissions].sort((a, b) => b.createdAt - a.createdAt)) {
    if (out.length >= n) break;
    if (seen.has(c.refId) || !scopeIds.includes(c.fromSalesId)) continue;
    seen.add(c.refId);
    const tx = transactions.find(t => t.id === c.refId);
    const directRep = repById(c.fromSalesId);
    if (!tx) continue;
    out.push({
      txId: tx.id, type: tx.type, typeLabel: COMMISSION[tx.type]?.label || tx.type, user: users.find(u => u.id === tx.userId)?.name,
      amount: tx.amount, merchant: tx.merchant || '', createdAt: tx.createdAt, directRep: directRep?.name,
      path: commissions.filter(x => x.refId === c.refId).sort((a, b) => a.tier - b.tier).map(x => ({ salesId: x.salesId, sales: repById(x.salesId)?.name, tier: x.tier, tierLabel: x.tierLabel, rate: x.rate, amount: x.amount })),
    });
  }
  return out;
}

// ---------------- API 路由(同步, 壳层负责 body 解析与响应写出) ----------------
// 返回 {status, json}; p=pathname, q=query, b=body, h=headers
export function handleApi(method, p, q = {}, b = {}, h = {}) {
  if (!inited) initSeed(); // 懒初始化: 首个请求时生成种子(此时 Date.now() 为真实时间)
  const J = (data, status = 200) => ({ status, json: data });
  // 演示数据一键重置: 重建全部种子, 清空现场操作产生的数据(须在 J 声明后)
  if (p === '/api/demo/reset' && method === 'POST') { inited = false; initSeed(); return J({ ok: true, at: now() }); }

  // ============ 运营后台 / 销售工作台 ============
  if (p.startsWith('/api/admin')) {
    const { sid, ids } = scopeOf(h);
    const me = repById(sid);
    const scopedUserIds = users.filter(u => ids.includes(u.salesRepId)).map(u => u.id);
    const today = new Date().toDateString();
    const isToday = (ts) => new Date(ts).toDateString() === today;

    if (p === '/api/admin/accounts') { // demo 登录账号列表
      return J(salesReps.map(s => ({ id: s.id, name: s.name, role: s.role, level: s.level, region: s.region, parentId: s.parentId, parentName: repById(s.parentId)?.name || '—', teamSize: subtreeIds(s.id).length - 1 })));
    }
    if (p === '/api/admin/me') return J({ ...me, scope: '全部数据', teamIds: subtreeIds(sid) });

    if (p === '/api/admin/dashboard') {
      const topups = transactions.filter(t => t.type === 'topup' && t.status === 'success' && scopedUserIds.includes(t.userId));
      const consumes = transactions.filter(t => t.type === 'consume' && t.status === 'success' && scopedUserIds.includes(t.userId));
      const trend = [];
      for (let d = 13; d >= 0; d--) {
        const day = new Date(now() - d * 864e5).toDateString();
        trend.push({ date: new Date(now() - d * 864e5).toISOString().slice(5, 10),
          topup: +topups.filter(t => new Date(t.createdAt).toDateString() === day).reduce((s, t) => s + t.amount, 0).toFixed(0),
          consume: +consumes.filter(t => new Date(t.createdAt).toDateString() === day).reduce((s, t) => s + t.amount, 0).toFixed(0) });
      }
      const myCommissions = commissions.filter(c => ids.includes(c.salesId));
      return J({
        me: { id: me.id, name: me.name, role: me.role, level: me.level },
        stats: {
          totalCards: cards.filter(c => ids.includes(c.salesRepId)).length,
          activeCards: cards.filter(c => ids.includes(c.salesRepId) && c.status === 'active').length,
          todayTopup: +topups.filter(t => isToday(t.createdAt)).reduce((s, t) => s + t.amount, 0).toFixed(0),
          todayConsume: +consumes.filter(t => isToday(t.createdAt)).reduce((s, t) => s + t.amount, 0).toFixed(0),
          totalBalance: +cards.filter(c => ids.includes(c.salesRepId)).reduce((s, c) => s + c.balance, 0).toFixed(0),
          pendingKyc: users.filter(u => ids.includes(u.salesRepId) && u.kycStatus.startsWith('pending')).length,
          pendingOrders: sid === 1 ? orders.filter(o => o.status === 'pending').length : orders.filter(o => scopedUserIds.includes(o.userId) && o.status === 'pending').length,
          pendingCommission: +myCommissions.filter(c => c.status === 'pending').reduce((s, c) => s + c.amount, 0).toFixed(2),
          customers: customers.filter(c => ids.includes(c.ownerSalesId)).length,
          pointsIssued: sid === 1 ? pointsLogs.filter(l => l.delta > 0).reduce((s, l) => s + l.delta, 0) : pointsLogs.filter(l => l.delta > 0 && scopedUserIds.includes(l.userId)).reduce((s, l) => s + l.delta, 0),
        },
        trend, recentTx: transactions.filter(t => scopedUserIds.includes(t.userId)).slice(0, 8).map(pubTx), perf: perfRows(ids).sort((a, b) => (b.topup + b.consume) - (a.topup + a.consume)),
      });
    }
    if (p === '/api/admin/cards') return J(cards.filter(c => ids.includes(c.salesRepId)).map(c => ({ ...c, levelLabel: CARD_LEVELS[c.level].label, user: users.find(u => u.id === c.userId)?.name, kyc: users.find(u => u.id === c.userId)?.kycLevel, salesRep: repById(c.salesRepId)?.name })));
    if (p === '/api/admin/cards/issue' && method === 'POST') {
      const u = users.find(x => x.id === +b.userId); if (!u) return J({ error: '用户不存在' }, 400);
      const card = { id: nid(), userId: u.id, cardNo: genCardNo(ri(0, 2)), cvv: String(ri(100, 999)), expMonth: ri(1, 12), expYear: 30, level: b.level || 'standard', status: 'active', balance: 0, salesRepId: b.salesRepId || u.salesRepId, createdAt: now() };
      cards.push(card);
      addCommissions(card.salesRepId, 'card', 1, card.id, now());
      const cust = customers.find(c => c.userId === u.id); if (cust && ['线索', '意向', '方案'].includes(cust.stage)) cust.stage = '开卡';
      return J({ card });
    }
    if (p.startsWith('/api/admin/cards/') && method === 'PATCH') {
      if (sid !== 1) return J({ error: '仅运营总监可执行冻结/调账' }, 403);
      const card = cards.find(c => c.id === +p.split('/').pop()); if (!card) return J({ error: 'not found' }, 404);
      if (b.action === 'freeze') card.status = (card.status === 'frozen' || card.status === 'lost') ? 'active' : 'frozen'; // 冻结/解冻/解除挂失
      if (b.action === 'adjust') { card.balance = +(card.balance + +b.amount).toFixed(2); transactions.unshift({ id: nid(), type: 'adjust', userId: card.userId, cardId: card.id, amount: +b.amount, fee: 0, method: 'adjust', ref: 'OP-' + ri(10000, 99999), pointsEarned: 0, status: 'success', createdAt: now() }); }
      return J({ card });
    }
    if (p === '/api/admin/kyc') {
      return J(users.filter(u => ids.includes(u.salesRepId) && u.kycStatus.startsWith('pending')).map(u => ({ id: u.id, name: u.name, country: u.country, phone: u.phone, kycLevel: u.kycLevel, applyLevel: u.kycLevel + 1, idType: pick(['护照', '国民ID']), submitAt: daysAgo(ri(1, 5)), docs: ['passport.jpg', 'selfie.jpg'], owner: repById(u.salesRepId)?.name })));
    }
    if (p === '/api/admin/kyc/review' && method === 'POST') {
      if (sid !== 1) return J({ error: '仅运营总监可审核 KYC' }, 403);
      const u = users.find(x => x.id === +b.userId); if (!u) return J({ error: '用户不存在' }, 400);
      if (b.pass) { u.kycLevel = b.toLevel || u.kycLevel + 1; u.kycStatus = 'approved'; addPointsLog(u.id, 200, 'KYC 认证奖励', 'KYC', now()); }
      else u.kycStatus = 'rejected';
      return J({ ok: true });
    }
    if (p === '/api/admin/transactions') return J(transactions.filter(t => scopedUserIds.includes(t.userId) && (!q.type || t.type === q.type)).slice(0, 200).map(pubTx));
    if (p === '/api/admin/refund' && method === 'POST') {
      if (sid !== 1) return J({ error: '仅运营总监可执行退款' }, 403);
      const t = transactions.find(x => x.id === +b.txId); if (!t || t.type !== 'consume') return J({ error: '交易不存在' }, 400);
      t.status = 'refunded'; const card = cards.find(c => c.id === t.cardId); card.balance = +(card.balance + t.amount).toFixed(2);
      return J({ ok: true });
    }
    if (p === '/api/admin/customers') {
      if (q.id) { const c = customers.find(x => x.id === +q.id); return J(pubCustomer(c)); }
      return J(customers.filter(c => ids.includes(c.ownerSalesId)).map(pubCustomer));
    }
    if (p === '/api/admin/customers' && method === 'POST') {
      const dup = customers.find(c => c.contact === b.contact);
      if (dup) return J({ error: `查重: 已存在客户 ${dup.name}(${dup.stage})` }, 409);
      const c = { id: nid(), ...b, stage: '线索', userId: null, tags: [], createdAt: now(), nextFollowAt: now() + 3 * 864e5 };
      customers.unshift(c); return J(c);
    }
    if (p === '/api/admin/followups' && method === 'POST') {
      const f = { id: nid(), customerId: +b.customerId, salesId: +b.salesId || sid, type: b.type, content: b.content, nextPlan: b.nextPlan || '', createdAt: now() };
      followups.unshift(f);
      if (b.nextStage) { const c = customers.find(x => x.id === +b.customerId); if (c) c.stage = b.nextStage; }
      return J(f);
    }
    if (p === '/api/admin/performance') return J(perfRows(ids).sort((a, b) => (b.topup + b.consume) - (a.topup + a.consume)));
    if (p === '/api/admin/commissions') return J([...commissions].filter(c => ids.includes(c.salesId) || ids.includes(c.fromSalesId)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 300).map(pubCommission));
    if (p === '/api/admin/commissions/settle' && method === 'POST') { if (sid !== 1) return J({ error: '仅运营总监可结算佣金' }, 403); commissions.forEach(c => { if (c.id === +b.id) c.status = 'settled'; }); return J({ ok: true }); }
    // 分销链路: 组织树 + 各级佣金 + 最近分佣链
    if (p === '/api/admin/commissions/tree') {
      const rootIds = sid === 1 ? [1] : [sid];
      const nodes = salesReps.filter(s => ids.includes(s.id)).map(s => {
        const my = commissions.filter(c => c.salesId === s.id);
        return { id: s.id, name: s.name, role: s.role, level: s.level, region: s.region, parentId: s.parentId, teamSize: subtreeIds(s.id).length - 1, target: s.target,
          directTotal: +my.filter(c => c.tier === 0).reduce((a, c) => a + c.amount, 0).toFixed(2),
          uplineTotal: +my.filter(c => c.tier > 0).reduce((a, c) => a + c.amount, 0).toFixed(2),
          total: +my.reduce((a, c) => a + c.amount, 0).toFixed(2),
          customers: customers.filter(c => c.ownerSalesId === s.id).length, cards: cards.filter(c => c.salesRepId === s.id).length };
      });
      return J({ rules: COMMISSION, tierLabels: TIER_LABELS, nodes, chains: recentChains(ids) });
    }
    if (p === '/api/admin/points') return J({ rules: { POINTS_PER_USD, CARD_LEVELS, COMMISSION }, logs: pointsLogs.filter(l => sid === 1 || scopedUserIds.includes(l.userId)).slice(0, 200).map(l => ({ ...l, user: users.find(u => u.id === l.userId)?.name })) });
    if (p === '/api/admin/points/grant' && method === 'POST') { if (sid !== 1) return J({ error: '仅运营总监可发放积分' }, 403); addPointsLog(+b.userId, +b.delta, b.source || '运营发放', 'OP', now()); return J({ ok: true }); }
    if (p === '/api/admin/products') return J(products);
    if (p.startsWith('/api/admin/products/') && method === 'PATCH') { if (sid !== 1) return J({ error: '仅运营总监可上下架商品' }, 403); const pr = products.find(x => x.id === +p.split('/').pop()); if (pr) pr.status = pr.status === 'on' ? 'off' : 'on'; return J({ ok: true }); }
    if (p === '/api/admin/orders') return J(orders.filter(o => sid === 1 || scopedUserIds.includes(o.userId)).map(pubOrder));
    if (p === '/api/admin/orders/ship' && method === 'POST') { if (sid !== 1) return J({ error: '仅运营总监可发货' }, 403); const o = orders.find(x => x.id === +b.id); if (o) { o.status = 'shipped'; o.trackingNo = b.trackingNo || 'SF' + ri(100000000, 999999999); } return J({ ok: true }); }
    if (p === '/api/admin/users') {
      if (method === 'POST') { // 新建客户账号(开户即发标准卡, 可选等级)
        const name = String(b.name || '').trim(); if (!name) return J({ error: '请填写客户姓名' }, 400);
        const phone = String(b.phone || '').trim();
        if (phone && users.some(u => u.phone === phone)) return J({ error: '手机号已存在: ' + name }, 409);
        let repId = +b.salesRepId || (sid === 1 ? 30 : sid);
        if (!repById(repId)) return J({ error: '归属销售不存在' }, 400);
        if (sid !== 1 && !subtreeIds(sid).includes(repId)) return J({ error: '只能为本人或下级团队的客户开户' }, 403);
        const uid = Math.max(0, ...users.map(u => u.id)) + 1;
        users.push({ id: uid, name, phone: phone || ('+966 5' + ri(10000000, 99999999)), email: name.toLowerCase().replace(/[^a-z]+/g, '.') + '@ucard.io',
          country: b.country || 'Saudi Arabia', cc: 'SA', city: b.city || 'Riyadh', kycLevel: 0, kycStatus: 'pending_upgrade', salesRepId: repId, invitedBy: null, points: 200, createdAt: now() });
        let card = null;
        if (b.issueCard !== false) {
          card = { id: Math.max(0, ...cards.map(c => c.id)) + 1, userId: uid, cardNo: genCardNo(), cvv: String(ri(100, 999)), expMonth: ri(1, 12), expYear: ri(28, 31), level: b.level || 'standard', status: 'active', balance: 0, salesRepId: repId, createdAt: now() };
          cards.push(card);
          addCommissions(repId, 'card', 1, card.id, now());
        }
        return J({ user: pubUser(users.find(u => u.id === uid)), card });
      }
      return J(users.filter(u => ids.includes(u.salesRepId)).map(pubUser));
    }
    if (p === '/api/admin/sales' && method === 'POST') { // 新建销售/客服账号(总监专属)
      if (sid !== 1) return J({ error: '仅运营总监可创建销售账号' }, 403);
      const name = String(b.name || '').trim(); if (!name) return J({ error: '请填写姓名' }, 400);
      if (salesReps.some(s => s.name === name)) return J({ error: '同名销售已存在' }, 409);
      const parent = repById(+b.parentId); if (!parent) return J({ error: '请选择上级(挂靠的组织节点)' }, 400);
      const level = parent.level + 1; if (level > 3) return J({ error: '三级销售下不能再挂下级(演示上限三级)' }, 400);
      const ROLE_BY_LEVEL = { 1: '一级销售', 2: '二级销售', 3: '三级销售' };
      const TARGET_BY_LEVEL = { 1: 120000, 2: 60000, 3: 25000 };
      const id = Math.max(0, ...salesReps.map(s => s.id)) + 1;
      salesReps.push({ id, name, role: b.role || ROLE_BY_LEVEL[level], parentId: parent.id, level, region: b.region || parent.region, target: +b.target || TARGET_BY_LEVEL[level] });
      return J({ sales: salesReps.find(s => s.id === id) });
    }
    return J({ error: 'not found: ' + p }, 404);
  }

  // ============ 用户端 H5 ============
  if (p.startsWith('/api/app')) {
    const uid = parseInt(h['x-user'] || '0', 10);
    const me = () => users.find(u => u.id === uid);
    if (p === '/api/app/users') return J(users.map(u => ({ id: u.id, name: u.name, phone: u.phone, kycLevel: u.kycLevel, points: u.points })));
    if (p === '/api/app/me') { const u = me(); if (!u) return J({ error: '未登录' }, 401); return J(pubUser(u)); }
    if (p === '/api/app/transactions') { const u = me(); if (!u) return J({ error: '未登录' }, 401); return J(transactions.filter(t => t.userId === uid).slice(0, 50)); }
    if (p === '/api/app/topup' && method === 'POST') return J(doTopup(uid, +b.amount, b.method));
    if (p === '/api/app/pay' && method === 'POST') return J(doPay(uid, +b.amount, b.merchant || 'Amazon', b.usePoints));
    if (p === '/api/app/tasks') { const u = me(); if (!u) return J({ error: '未登录' }, 401); const day = new Date().toDateString();
      return J({ tasks, signedToday: pointsLogs.some(l => l.userId === uid && l.source === '每日签到' && new Date(l.createdAt).toDateString() === day),
        claimed: pointsLogs.filter(l => l.userId === uid && String(l.refNo).startsWith('TASK')).map(l => +String(l.refNo).slice(4)) }); }
    if (p === '/api/app/sign' && method === 'POST') { const u = me(); const day = new Date().toDateString(); if (pointsLogs.some(l => l.userId === uid && l.source === '每日签到' && new Date(l.createdAt).toDateString() === day)) return J({ error: '今日已签到' }, 400); addPointsLog(uid, 20, '每日签到', 'SIGN', now()); return J({ ok: true }); }
    if (p === '/api/app/task/claim' && method === 'POST') { const t = tasks.find(x => x.id === +b.id);
      if (t.type === 'once' && pointsLogs.some(l => l.userId === uid && l.refNo === 'TASK' + t.id)) return J({ error: '该任务奖励已领取过, 不能重复领取' }, 400);
      addPointsLog(uid, t.points, '任务奖励:' + t.title, 'TASK' + t.id, now()); return J({ ok: true }); }
    // 卡片自助管控: 冻结/解冻/挂失(挂失需后台解除)
    if ((p === '/api/app/card/freeze' || p === '/api/app/card/unfreeze' || p === '/api/app/card/lost') && method === 'POST') {
      const card = cards.find(c => c.userId === uid); if (!card) return J({ error: '未找到卡' }, 404);
      const act = p.split('/').pop();
      if (act === 'freeze') { if (card.status !== 'active') return J({ error: '当前状态不可冻结' }, 400); card.status = 'frozen'; }
      if (act === 'unfreeze') { if (card.status !== 'frozen') return J({ error: '只有冻结状态可自助解冻, 挂失请联系客服' }, 400); card.status = 'active'; }
      if (act === 'lost') { if (card.status === 'lost') return J({ error: '卡已处于挂失状态' }, 400); card.status = 'lost'; }
      return J({ status: card.status });
    }
    if (p === '/api/app/products') return J(products.filter(pr => pr.status === 'on'));
    if (p === '/api/app/redeem' && method === 'POST') return J(doRedeem(uid, +b.id));
    if (p === '/api/app/orders') { const u = me(); if (!u) return J({ error: '未登录' }, 401); return J(orders.filter(o => o.userId === uid).map(pubOrder)); }
    if (p === '/api/app/points') { const u = me(); if (!u) return J({ error: '未登录' }, 401); return J(pointsLogs.filter(l => l.userId === uid).slice(0, 50)); }
    if (p === '/api/app/invite') { const u = me(); if (!u) return J({ error: '未登录' }, 401);
      const invited = users.filter(x => x.invitedBy === uid);
      return J({ code: 'UC' + String(uid).padStart(4, '0') + String(ri(100, 999)), link: `https://u-card.app/i/UC${String(uid).padStart(4, '0')}`, invited: invited.map(x => ({ name: x.name, at: x.createdAt, reward: 800 })), totalReward: invited.length * 800 });
    }
    if (p === '/api/app/kyc' && method === 'POST') { const u = me(); u.kycStatus = 'pending_upgrade'; return J({ ok: true }); }
    return J({ error: 'not found' }, 404);
  }
  return null; // 非 API
}
