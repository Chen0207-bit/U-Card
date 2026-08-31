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
const d2 = (n) => String(n).padStart(2, '0');
const dayKey = (ts) => { const x = new Date(ts); return d2(x.getMonth() + 1) + '-' + d2(x.getDate()); }; // 本地时区 MM-DD(财务对账分组键)

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
// 月度目标默认值(P1.3): gmv=充值+消费, 4 类目标字段可由总监在目标管理页调整
const TARGET_DEFAULTS = {
  1: { gmv: 120000, topup: 70000, consume: 50000, cards: 40, points: 400000 },
  2: { gmv: 60000, topup: 35000, consume: 25000, cards: 25, points: 180000 },
  3: { gmv: 25000, topup: 15000, consume: 10000, cards: 15, points: 80000 },
};

// ---------------- 种子数据(懒初始化: Workers 全局作用域 Date.now()=0, 必须等首个请求再生成真实时间) ----------------
let salesReps, users, cards, transactions, pointsLogs, commissions, customers, followups, products, orders, tasks;
let riskEvents, riskRules, riskLists, riskTags, financeMeta; // P1: 风控中心 + 财务对账
let sysAccounts, sysRoles, sysPerms, sysLogs, opLogs, sysParams, sysDicts; // P3: 系统管理(账号/角色/权限/登录日志/操作日志/参数/字典)
let tenants; // P4.1 多租户(轻量演示): 租户 + 租户级配置(品牌/币种/佣金/积分规则/数据隔离视图)
let openApps, openKeys, openWebhooks, openApiLogs; // P4.5 开放平台: 应用 / API密钥 / Webhook / 调用日志
let notifyTemplates, notifySends, notifyChannels; // P4.6 消息通知中心: 模板 / 发送记录 / 渠道配置
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

// ---------------- P1.5 风控中心 + P1.6 财务对账 种子 ----------------
riskRules = [
  { id: 1, name: '单笔超阈值', expr: 'tx.amount > 400', level: 'high', action: 'freeze', enabled: true, desc: '单笔消费/充值金额超过 $400, 自动冻结卡片并转人工处置' },
  { id: 2, name: '24小时高频交易', expr: 'count(tx, 24h) > 10', level: 'mid', action: 'review', enabled: true, desc: '同一用户 24 小时内交易笔数超过 10 笔, 转人工审核' },
  { id: 3, name: '短时跨国消费', expr: 'geo_hops(tx, 2h) >= 2', level: 'high', action: 'freeze', enabled: true, desc: '2 小时内刷卡位置跨越 2 个及以上国家/地区' },
  { id: 4, name: '连续支付失败', expr: 'fail_streak(tx, 1h) >= 3', level: 'mid', action: 'review', enabled: true, desc: '1 小时内连续 3 笔支付失败(余额不足/风控拒绝)' },
  { id: 5, name: '新设备大额充值', expr: 'tx.type == "topup" && tx.amount >= 500 && device.is_new', level: 'low', action: 'mark', enabled: false, desc: '新绑定设备首次充值 $500 以上, 仅标记观察(演示停用状态)' },
];
// 风险事件种子: [userIdx, ruleId, status, daysAgo, jitterH, amount, scene, reason] — 等级/动作继承规则
const EVS = [
  [0, 1, 'released', 12, 5, 620.00, 'Apple Store', '单笔消费 $620.00 超过阈值 $400, 复核确认为本人购买 iPhone'],
  [1, 2, 'reviewed', 9, 3, 86.40, '24h 内 13 笔交易', '24 小时内累计 13 笔交易超过高频阈值 10 笔, 人工复核为正常小额'],
  [2, 3, 'released', 8, 6, 156.40, 'Dubai → Doha', '2 小时内刷卡位置跨 2 国(Dubai → Doha), 复核为商旅通勤'],
  [10, 3, 'frozen', 2, 4, 98.20, 'Cairo → Riyadh', '2 小时内刷卡位置跨 2 国(Cairo → Riyadh), 卡片已自动冻结待处置'],
  [10, 4, 'frozen', 1, 6, 45.00, 'Talabat', '1 小时内连续 3 笔支付失败, 触发连续失败规则'],
  [4, 5, 'pending', 3, 2, 800.00, 'USDT 充值', '新设备首次登录即充值 $800.00(USDT), 规则已停用, 事件留在观察池'],
  [5, 1, 'pending', 1, 8, 512.00, 'Noon', '单笔消费 $512.00 超过阈值 $400, 待人工处置'],
  [3, 4, 'reviewed', 6, 5, 67.30, 'Careem', '连续 3 笔支付失败后成功, 复核为余额不足所致'],
  [6, 2, 'released', 15, 4, 44.10, '24h 内 11 笔小额消费', '24 小时内 11 笔小额消费, 复核为正常生活消费'],
  [7, 1, 'released', 20, 7, 950.00, 'Emirates Airline', '单笔消费 $950.00 超过阈值, 复核确认为本人机票'],
  [8, 4, 'pending', 0, 1, 32.50, 'Netflix', '1 小时内 3 笔支付失败(扣款渠道抖动), 待复核'],
  [9, 3, 'reviewed', 5, 9, 210.00, 'Doha → Kuwait City', '跨国消费复核: 客户当日在多哈与科威特城往返'],
  [11, 1, 'pending', 2, 10, 430.00, 'AliExpress', '单笔消费 $430.00 超过阈值 $400, 待人工处置'],
  [1, 5, 'released', 18, 3, 600.00, '法币银行充值', '新设备充值 $600.00, 复核确认本人新手机'],
  [3, 2, 'released', 11, 6, 120.00, '24h 内 12 笔交易', '24 小时内 12 笔交易, 复核为购物节集中消费'],
];
riskEvents = EVS.map(([ui, ruleId, status, d, jh, amount, scene, reason]) => {
  const u = users[ui];
  const card = cards.find(c => c.userId === u.id);
  const rule = riskRules.find(r => r.id === ruleId);
  const ts = daysAgo(d, jh);
  // 风控时间轴: 事件产生 → (冻结类规则)自动冻结 → 人工复核 → 解除
  const timeline = [{ ts, node: 'created', label: '事件产生', note: reason, operator: '风控引擎' }];
  if (rule.action === 'freeze' && status !== 'pending') timeline.push({ ts: ts + 6e4, node: 'freeze', label: '自动冻结', note: '命中冻结类规则, 关联卡片已自动冻结', operator: '风控引擎' });
  if (status === 'reviewed' || status === 'released') timeline.push({ ts: ts + 36e5, node: 'review', label: '人工复核', note: '风控专员调取交易与设备信息完成人工复核', operator: 'Noura Al-Faisal' });
  if (status === 'released') timeline.push({ ts: ts + 72e5, node: 'release', label: '解除风控', note: '复核通过, 风险解除', operator: 'Noura Al-Faisal' });
  return { id: nid(), userId: u.id, cardId: card.id, ruleId, level: rule.level, reason, status, amount, scene,
    deviceId: 'DEV-' + ri(0x10000, 0xfffff).toString(16), createdAt: ts, timeline };
});
riskRules.forEach(r => { r.hits = riskEvents.filter(e => e.ruleId === r.id).length + { 1: 18, 2: 9, 3: 6, 4: 11, 5: 4 }[r.id]; }); // 历史+本月命中

riskLists = [
  { id: nid(), type: 'black', objType: 'user', target: 'Mahmoud Adel (UID 21)', reason: '多次伪冒申诉, 名下关联 3 张挂失卡', createdAt: daysAgo(22, 4), operator: 'Noura Al-Faisal' },
  { id: nid(), type: 'black', objType: 'card', target: '5533 **** **** 8241', reason: '盗刷争议卡, 永久冻结', createdAt: daysAgo(15, 2), operator: 'Noura Al-Faisal' },
  { id: nid(), type: 'black', objType: 'merchant', target: 'GoldSouq Exchange', reason: '疑似套现商户, 已终止合作', createdAt: daysAgo(9, 7), operator: 'Noura Al-Faisal' },
  { id: nid(), type: 'black', objType: 'device', target: 'DEV-a3f92c (Android · 代理 IP)', reason: '自动化注册脚本设备指纹', createdAt: daysAgo(4, 3), operator: 'Noura Al-Faisal' },
  { id: nid(), type: 'white', objType: 'user', target: 'Ahmed Al-Rashid (UID 1)', reason: '高净值老客户, 大额交易免拦截', createdAt: daysAgo(30, 5), operator: 'Noura Al-Faisal' },
  { id: nid(), type: 'white', objType: 'merchant', target: 'Emirates Airline', reason: '官方直连商户, 豁免跨国消费规则', createdAt: daysAgo(26, 8), operator: 'Noura Al-Faisal' },
  { id: nid(), type: 'white', objType: 'card', target: '5299 **** **** 1170', reason: '企业采购卡, 走白名单通道', createdAt: daysAgo(12, 6), operator: 'Noura Al-Faisal' },
];
riskTags = [
  { id: 1, name: '高净值', color: '#16a34a', desc: '月均充值 > $5,000', count: 18 },
  { id: 2, name: '跨境高频', color: '#0ea5e9', desc: '月跨国交易 ≥ 8 笔', count: 34 },
  { id: 3, name: '疑似代理', color: '#f59e0b', desc: '多账户同设备登录', count: 7 },
  { id: 4, name: '灰产风险', color: '#dc2626', desc: '命中黑名单关联网络', count: 3 },
  { id: 5, name: '夜枭交易', color: '#7c3aed', desc: '0-5 点交易占比 > 60%', count: 11 },
  { id: 6, name: '学生用户', color: '#64748b', desc: '年龄 < 25, 小额高频', count: 26 },
];
// 财务对账元数据: 结算周期 / 差异注入(渠道少入账 delta>0) / 商户结算预设
financeMeta = { period: { topup: 'T+1', consume: 'T+2', refund: 'T+0' }, diffs: { topup: {}, consume: {}, refund: {} }, merchantSettled: { Amazon: true, Starbucks: true } };
const reconTxOf = {
  topup: (t) => t.type === 'topup' && t.status === 'success',
  consume: (t) => t.type === 'consume' && t.status === 'success',
  refund: (t) => t.type === 'consume' && t.status === 'refunded',
};
const injectDiffs = (type, specs) => { // specs: [距今天数序号(从最近往回数), 少入账金额, 原因]
  const days = [...new Set(transactions.filter(reconTxOf[type]).map(t => dayKey(t.createdAt)))].sort();
  specs.forEach(([fromEnd, delta, reason]) => {
    const day = days[days.length - 1 - fromEnd];
    if (day) financeMeta.diffs[type][day] = { delta, reason };
  });
};
injectDiffs('topup', [[2, 61.40, '渠道延迟'], [6, 12.70, '手续费口径']]);
injectDiffs('consume', [[1, 28.36, '手续费口径'], [5, 45.00, '渠道延迟']]);
injectDiffs('refund', [[0, 45.00, '退款冲正'], [2, 19.50, '渠道延迟']]);

// ---------------- P3 系统管理种子: 角色 / 权限 / 账号 / 参数 / 字典 / 日志 ----------------
sysRoles = [
  { id: 1, code: 'super', name: '超级管理员', desc: '内置角色 · 后台全部权限, 含系统管理', builtin: true },
  { id: 2, code: 'director', name: '销售总监', desc: '销售组织负责人 · 全部业务模块与系统管理', builtin: true },
  { id: 3, code: 'sales_l1', name: '一级销售', desc: '管理二级销售团队 · CRM 客户跟进与团队业绩', builtin: true },
  { id: 4, code: 'sales_l2', name: '二级销售', desc: '管理三级销售团队 · CRM 客户跟进与团队业绩', builtin: true },
  { id: 5, code: 'sales_l3', name: '三级销售', desc: '一线销售 · CRM 客户跟进与个人业绩', builtin: true },
  { id: 6, code: 'ops', name: '运营专员', desc: 'U卡 / KYC / 积分商城 / 订单日常运营', builtin: false },
  { id: 7, code: 'finance', name: '财务专员', desc: '对账 / 差异 / 商户结算 / 财务报表', builtin: false },
  { id: 8, code: 'risk', name: '风控专员', desc: '风险事件处置 / 规则启停 / 黑白名单管理', builtin: false },
];
sysPerms = {}; // 角色 → 已勾选权限 key(副本, PATCH 只改内存副本, 重置演示数据后恢复默认)
sysRoles.forEach(r => { sysPerms[r.code] = [...(ROLE_PERM_DEFAULTS[r.code] || [])]; });
// 账号 = 销售账号(映射自 salesReps 19 人) + 平台账号(运营/财务/风控等, 1 个禁用态)
const ROLE_BY_LEVEL = { 0: 'director', 1: 'sales_l1', 2: 'sales_l2', 3: 'sales_l3' };
const unameOf = (name) => name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.+|\.+$/g, '');
sysAccounts = [
  ...salesReps.map(s => {
    const role = sysRoles.find(r => r.code === ROLE_BY_LEVEL[s.level]);
    const uname = unameOf(s.name);
    return { id: s.id, username: uname, name: s.name, type: 'sales', roleCode: role.code, roleName: role.name,
      org: s.level === 0 ? '全局销售体系' : ((repById(s.parentId) || {}).name || '—') + ' 团队',
      phone: '+966 5' + ri(10000000, 99999999), email: uname + '@ucard.io',
      enabled: true, lastLoginAt: daysAgo(ri(0, 2), 23), createdAt: daysAgo(ri(60, 200)) };
  }),
  ...[
    ['admin', 'Nasser Al-Kaabi', 'super', '平台管理组', true],
    ['ops.lina', 'Lina Haddad', 'ops', '运营中心', true],
    ['fin.yousef', 'Yousef Barakat', 'finance', '财务结算组', true],
    ['risk.muna', 'Muna Al-Ali', 'risk', '风控中心', true],
    ['ops.faris', 'Faris Al-Otaibi', 'ops', '运营中心', false], // 禁用态种子
  ].map(([username, name, code, org, enabled], i) => {
    const role = sysRoles.find(r => r.code === code);
    return { id: 900001 + i, username, name, type: 'platform', roleCode: code, roleName: role.name, org,
      phone: '+971 5' + ri(10000000, 99999999), email: username + '@ucard.io',
      enabled, lastLoginAt: enabled ? daysAgo(ri(0, 3), 23) : daysAgo(21, 5), createdAt: daysAgo(ri(120, 260)) };
  }),
];
sysParams = [
  { key: 'commission.withdraw.min', value: '50', label: '佣金提现最低金额', desc: '销售佣金单笔提现最低金额 (USD)', updatedAt: daysAgo(9, 3) },
  { key: 'kyc.auto_review.enabled', value: 'on', label: 'KYC 自动审核开关', desc: 'on=简单件自动审核, off=全部转人工', updatedAt: daysAgo(15, 6) },
  { key: 'points.expire_days', value: '90', label: '积分过期天数', desc: '积分获得后有效天数, 到期自动清零', updatedAt: daysAgo(7, 2) },
  { key: 'topup.daily_limit', value: '10000', label: '单日充值上限', desc: '单用户单日累计充值上限 (USD)', updatedAt: daysAgo(4, 8) },
  { key: 'commission.tiers.max', value: '3', label: '分佣层级上限', desc: '多级分佣最大层级数(直属/上级/上上级)', updatedAt: daysAgo(20, 4) },
  { key: 'risk.single_tx_threshold', value: '400', label: '风控单笔阈值', desc: '单笔交易超过该金额 (USD) 触发风控规则', updatedAt: daysAgo(11, 5) },
];
let dictSeq = 0;
const dItem = (key, value, label, sort, enabled = true) => ({ id: ++dictSeq, key, value, label, sort, enabled });
sysDicts = [
  { type: 'tx_type', typeLabel: '交易类型', remark: '交易流水与对账的类型口径', items: [
    dItem('topup', '充值', '充值入账', 1), dItem('consume', '消费', '商户消费', 2), dItem('refund', '退款', '退款冲正', 3), dItem('adjust', '调账', '运营调账', 4)] },
  { type: 'card_level', typeLabel: '卡等级', remark: 'U卡产品等级定义', items: [
    dItem('standard', 'Standard', '标准卡', 1), dItem('gold', 'Gold', '金卡', 2), dItem('platinum', 'Platinum', '白金卡', 3)] },
  { type: 'risk_level', typeLabel: '风险等级', remark: '风控事件与规则等级', items: [
    dItem('high', '高', '高风险', 1), dItem('mid', '中', '中风险', 2), dItem('low', '低', '低风险', 3)] },
  { type: 'order_status', typeLabel: '订单状态', remark: '积分商城兑换订单状态机', items: [
    dItem('pending', '待发货', '实物待发货', 1), dItem('shipped', '已发货', '物流配送中', 2), dItem('redeemed', '已核销', '虚拟/权益核销', 3), dItem('aftersale', '售后中', '售后处理中', 4), dItem('cancelled', '已取消', '用户取消退分', 5)] },
  { type: 'notify_type', typeLabel: '通知类型', remark: '站内消息通知分类', items: [
    dItem('tx', '交易', '交易动账提醒', 1), dItem('sys', '系统', '系统安全通知', 2), dItem('mkt', '营销', '活动营销推送', 3), dItem('sms', '短信', '短信渠道(演示停用)', 4, false)] },
];
sysLogs = buildSysLoginLogs();
opLogs = buildSysOpLogs();

// ---------------- P4.1 多租户 / P4.5 开放平台 / P4.6 消息中心 种子 ----------------
// P4.1 租户(轻量演示): 主租户 U-Card=本系统真实种子数据, 其余租户为平台层模拟隔离数据(不做真实改造)
const tReal = {
  users: users.length, cards: cards.length, tx: transactions.length,
  topup: +transactions.filter(t => t.type === 'topup' && t.status === 'success').reduce((s, t) => s + t.amount, 0).toFixed(2),
  consume: +transactions.filter(t => t.type === 'consume' && t.status === 'success').reduce((s, t) => s + t.amount, 0).toFixed(2),
};
tReal.gmv = +(tReal.topup + tReal.consume).toFixed(2);
// [name, code, plan, status, domain, currency, locale, timezone, brandColor, commission(null=平台默认), 到期月数, 积分规则]
const TENANT_DEF = [
  ['U-Card 优卡', 'ucard', 'Enterprise', 'active', 'app.ucard.io', 'USD', 'zh-CN', 'Asia/Riyadh', '#4f46e5', null, 24, { earnPerUsd: 10, pointsPerUsd: 100, maxOff: '30%', validityDays: 90 }],
  ['DubaiPay', 'dubaipay', 'Pro', 'active', 'portal.dubaipay.ae', 'AED', 'en-AE', 'Asia/Dubai', '#0ea5e9', { topup: [0.012, 0.018, 0.004], consume: [0.008, 0.015, 0.006], card: [6, 1, 1] }, 11, { earnPerUsd: 8, pointsPerUsd: 100, maxOff: '20%', validityDays: 60 }],
  ['RiyadhWallet', 'riyadhwallet', 'Basic', 'trial', 'app.riyadhwallet.sa', 'SAR', 'ar-SA', 'Asia/Riyadh', '#16a34a', { topup: [0.008, 0.012, 0.003], consume: [0.006, 0.01, 0.002], card: [3, 1, 0] }, 1, { earnPerUsd: 6, pointsPerUsd: 100, maxOff: '10%', validityDays: 45 }],
  ['DohaPay', 'dohapay', 'Pro', 'frozen', 'biz.dohapay.qa', 'QAR', 'en-QA', 'Asia/Qatar', '#d97706', { topup: [0.01, 0.02, 0.005], consume: [0.01, 0.02, 0.005], card: [5, 1, 1] }, 7, { earnPerUsd: 12, pointsPerUsd: 100, maxOff: '30%', validityDays: 120 }],
  ['Manama Pay', 'manamapay', 'Basic', 'pending', '—(待审核)', 'BHD', 'ar-BH', 'Asia/Bahrain', '#7c3aed', { topup: [0.008, 0.012, 0.003], consume: [0.006, 0.01, 0.002], card: [3, 1, 0] }, 1, { earnPerUsd: 6, pointsPerUsd: 100, maxOff: '10%', validityDays: 45 }],
];
tenants = TENANT_DEF.map((d, i) => {
  const [name, code, plan, status, domain, currency, locale, timezone, brandColor, comm, expM, pts] = d;
  const iso = i === 0
    ? { ...tReal, simulated: false }
    : { users: ri(280, 3600), cards: ri(260, 3200), tx: ri(3200, 46000),
        topup: ri(180000, 5200000), consume: ri(120000, 3800000), simulated: true };
  const c = comm || { topup: [...COMMISSION.topup.tiers], consume: [...COMMISSION.consume.tiers], card: [...COMMISSION.card.tiers] };
  const lvls = Object.entries(CARD_LEVELS).filter(([k]) => plan !== 'Basic' || k !== 'platinum');
  return {
    id: i + 1, name, code, plan, status, domain, currency, locale, timezone, brandColor,
    commission: c, pointsRule: pts, expireAt: now() + expM * 30 * 864e5, createdAt: daysAgo(ri(60, 420)),
    cardProducts: lvls.map(([key, v]) => ({ key, name: v.label, monthlyFee: +(v.monthlyFee * (plan === 'Basic' ? 0.5 : 1)).toFixed(0), pointRate: v.pointRate, color: v.color })),
    isolation: { ...iso, gmv: +(iso.topup + iso.consume).toFixed(2), note: i === 0 ? '主租户 · 数据为本演示系统真实种子统计' : '演示模拟数据(与主租户物理隔离, 平台侧仅见聚合数字)' },
    isMain: i === 0,
  };
});

// P4.5 开放平台: 应用 / 密钥 / Webhook / 调用日志
openApps = [
  ['DubaiPay 收单系统', 'ak-dpay-7f3m2kx9', true],
  ['RiyadhWallet 小程序', 'ak-rwlt-9q2x8d4v', true],
  ['ERP 对账集成', 'ak-erpcon-3n8v5t6m', false],
  ['渠道分销平台', 'ak-chdis-5j1w6y2p', true],
].map(([name, appKey, enabled], i) => ({ id: i + 1, name, appKey, enabled, todayCalls: enabled ? ri(120, 480) : 0, totalCalls: ri(52000, 186000), createdAt: daysAgo(ri(70, 320)) }));
const SCOPE_SETS = [
  ['user.read', 'balance.read', 'transaction.read'],
  ['user.create', 'kyc.submit', 'card.issue'],
  ['topup.callback', 'consume.callback'],
  ['balance.read', 'points.query', 'order.query', 'refund.create'],
  ['risk.webhook', 'order.webhook'],
];
openKeys = [
  [1, 'sk-9f2mkq7xw4d1plz8', 0, 'active', 0],
  [1, 'sk-3tb8nc2v6hj5qw09', 1, 'active', 45],
  [2, 'sk-7ke4xa9m2rt6yu3i', 3, 'active', 120],
  [3, 'sk-1pz6lo8k4de7vc2q', 2, 'revoked', 0],
  [4, 'sk-5wu9qn3j7hf2xs6o', 4, 'active', 200],
].map(([appId, appSecret, sc, status, usedDaysAgoJitter], i) => ({
  id: i + 1, appId, appSecret, scopes: SCOPE_SETS[sc], status,
  lastUsedAt: status === 'revoked' ? null : daysAgo(ri(0, 2), usedDaysAgoJitter || 6),
  expireAt: status === 'revoked' ? daysAgo(9) : now() + ri(60, 400) * 864e5,
  createdAt: daysAgo(ri(70, 320)),
}));
const WH_EVENTS = [['topup.success', '充值成功'], ['consume.success', '消费成功'], ['risk.triggered', '风控触发'], ['order.changed', '订单状态变更']];
openWebhooks = [
  [1, 0, 'https://biz.dubaipay.ae/hooks/topup', 'success', 0],
  [1, 2, 'https://biz.dubaipay.ae/hooks/risk', 'success', 1],
  [2, 1, 'https://app.riyadhwallet.sa/hooks/consume', 'failed', 3],
  [2, 3, 'https://app.riyadhwallet.sa/hooks/order', 'success', 0],
  [4, 0, 'https://dist.channel-ucard.com/hooks/topup', 'success', 0],
].map(([appId, evIdx, url, lastSt, fails], i) => ({
  id: i + 1, appId, event: WH_EVENTS[evIdx][0], eventLabel: WH_EVENTS[evIdx][1], url,
  retry: pick(['3 次 · 指数退避(1m/5m/30m)', '5 次 · 指数退避', '3 次 · 固定间隔 5m']),
  lastPush: { status: lastSt, httpCode: lastSt === 'success' ? 200 : 504, at: daysAgo(ri(0, 2), 8) },
  failCount: fails, pushCount: ri(320, 5800),
  pushes: [0, 1].map(k => ({ id: k + 1, at: daysAgo(ri(0, 3), 10), status: k === 0 ? lastSt : 'success', httpCode: k === 0 ? (lastSt === 'success' ? 200 : 504) : 200, ms: ri(80, 900) })),
}));
openApiLogs = buildOpenApiLogs();

// P4.6 消息通知中心: 渠道 / 模板 / 发送记录
notifyChannels = [
  ['inapp', '站内信', '🔔', true, { 通道: '平台内置', 保留天数: '90 天', 免打扰: '23:00 - 07:00' }],
  ['email', '邮件', '📧', true, { SMTP: 'smtp.ucard.io:465', 发件人: 'no-reply@ucard.io', 加密: 'TLS' }],
  ['sms', '短信', '💬', true, { 网关: 'Twilio / Unifonic', 签名: '【U-Card】', 单价: '$0.045 / 条' }],
  ['whatsapp', 'WhatsApp', '🟢', true, { 接入: 'WhatsApp Business API', 号码: '+971 4 *** ****', 模板审核: '已通过' }],
  ['webhook', 'Webhook', '🔗', true, { 回调地址: 'https://biz.ucard.io/notify', 签名: 'HMAC-SHA256', 重试: '3 次指数退避' }],
  ['push', 'App Push', '📱', true, { 通道: 'FCM + APNs', 角标: '开启', 离线保留: '7 天' }],
  ['voice', '语音电话', '📞', false, { 平台: 'Twilio Voice', 用途: '风控高危外呼', 单价: '$0.12 / 分钟' }],
].map(([key, name, icon, enabled, config], i) => ({ id: i + 1, key, name, icon, enabled, config }));
const NT_EVENTS = [['topup.success', '充值成功'], ['consume.success', '消费成功'], ['risk.triggered', '风控触发'], ['kyc.passed', 'KYC 通过'], ['order.shipped', '订单发货']];
notifyTemplates = [
  ['inapp', 0, '充值到账', '{{userName}} 您好, 您尾号 {{cardLast4}} 的 U 卡充值 {{amount}} 已到账, 交易号 {{transactionId}}, 时间 {{createdAt}}。', true],
  ['email', 0, '【U-Card】充值成功通知', '尊敬的 {{userName}}:\n\n您尾号 {{cardLast4}} 的卡片于 {{createdAt}} 成功充值 {{amount}}, 交易号 {{transactionId}}。\n\n如非本人操作请立即冻结卡片并联系客服。\n\nU-Card 优卡团队', true],
  ['sms', 0, '', '【U-Card】尾号{{cardLast4}}充值{{amount}}已到账,交易号{{transactionId}}', true],
  ['whatsapp', 1, '', '🛍️ *{{userName}}*, 您刚完成一笔消费\n\n💰 金额: {{amount}}\n💳 卡片: **** {{cardLast4}}\n🔖 交易号: {{transactionId}}\n🕐 时间: {{createdAt}}\n\n感谢您使用 U-Card! ✨', true],
  ['push', 1, '消费交易提醒', '您在商户消费 {{amount}}, 尾号 {{cardLast4}}, 本笔交易已返还积分, 点击查看详情。', true],
  ['sms', 2, '', '【U-Card】检测到尾号{{cardLast4}}异常交易,卡片已保护性冻结,交易号{{transactionId}}', true],
  ['email', 2, '【U-Card】风控安全提醒', '尊敬的 {{userName}}:\n\n系统检测到您尾号 {{cardLast4}} 的卡片存在风险交易({{amount}}, 交易号 {{transactionId}}), 卡片已保护性冻结。请通过 App 或客服完成身份核实后恢复。\n\nU-Card 风控中心 · {{createdAt}}', false],
  ['inapp', 3, 'KYC 认证通过', '恭喜 {{userName}}, 您的 KYC 认证已通过, 交易与额度限制已提升, 详见「安全中心」。', true],
  ['push', 4, '订单已发货', '{{userName}} 您好, 您的积分商城订单已发货, 消耗积分可在订单详情查看, 物流信息将同步更新。', true],
  ['webhook', 4, '', '{\n  "event": "order.shipped",\n  "userName": "{{userName}}",\n  "transactionId": "{{transactionId}}",\n  "amount": "{{amount}}",\n  "cardLast4": "{{cardLast4}}",\n  "createdAt": "{{createdAt}}"\n}', false],
].map(([channel, evIdx, title, body, enabled], i) => ({
  id: i + 1, channel, event: NT_EVENTS[evIdx][0], eventLabel: NT_EVENTS[evIdx][1], title, body, enabled, updatedAt: daysAgo(ri(2, 40)),
}));
notifySends = buildNotifySends();
rebuildLedgerSeed(); // P4.4: 为种子交易回填复式账本(与卡余额自洽) + 14 天余额快照 + 演示冻结余额
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

// ---------------- P4.4 资金账本(复式记账): 模块级模型与工具 ----------------
// 账户类型: channel=资金渠道(资产, 借增贷减) / card=用户卡账户(平台负债, 贷增借减) / merchant=商户待结算(负债, 贷增)
//           income=平台收入(手续费/卡月费, 贷增) / expense=平台支出(佣金/积分成本, 借增)
// 恒等式: ①任一业务单(txId) sum(借)===sum(贷) ②账户余额===流水重放===末条流水 balanceAfter ③卡账户余额===卡实际余额
// 流水只追加、永不修改/删除; 退款走反向分录, 不冲销历史。
let ledgerAccounts, ledgerEntries, balanceSnapshots, frozenBalances;
const LEDGER_DEBIT_POSITIVE = { channel: true, expense: true, card: false, merchant: false, income: false };
const LEDGER_TYPE_LABEL = { channel: '资金渠道', card: '用户卡账户', merchant: '商户待结算', income: '平台收入', expense: '平台支出' };
const lgR2 = (x) => +(+x || 0).toFixed(2);
const isoDay = (ts) => { const d = new Date(ts); return d.getFullYear() + '-' + d2(d.getMonth() + 1) + '-' + d2(d.getDate()); };
function ensureLedgerAccount(key, type, name) {
  let a = ledgerAccounts.find(x => x.key === key);
  if (!a) { a = { key, type, name, balance: 0 }; ledgerAccounts.push(a); }
  return a;
}
function ensureCardLedgerAccount(card) {
  const u = users.find(x => x.id === card.userId);
  return ensureLedgerAccount('card:' + card.id, 'card', '用户卡 · ' + (u ? u.name : 'UID ' + card.userId) + ' ' + maskCardNo(card.cardNo));
}
function ensureMerchantLedgerAccount(name) { return ensureLedgerAccount('merchant:' + name, 'merchant', '商户待结算 · ' + name); }
// 追加一条流水(只增不改): 按账户类型×借贷方向确定余额增量, 记录 balanceAfter
function postLedgerEntry(txId, accountKey, dir, amount, memo, ts) {
  const acc = ledgerAccounts.find(a => a.key === accountKey);
  if (!acc) { console.warn('[ledger] 未定义账户: ' + accountKey); return null; }
  const amt = lgR2(amount);
  if (!(amt > 0)) return null; // 零金额腿不入账
  const sgn = ((dir === 'debit') === !!LEDGER_DEBIT_POSITIVE[acc.type]) ? 1 : -1;
  acc.balance = lgR2(acc.balance + sgn * amt);
  const e = { id: nid(), txId, accountKey, dir, amount: amt, balanceAfter: acc.balance, memo: memo || '', createdAt: ts };
  ledgerEntries.push(e);
  return e;
}
// 一组平衡分录: 借贷和必须相等(不等仅告警, 不阻断业务动作)
function postLedgerTx(txId, memo, ts, legs) {
  const d = lgR2(legs.filter(l => l.dir === 'debit').reduce((s, l) => s + l.amount, 0));
  const c = lgR2(legs.filter(l => l.dir === 'credit').reduce((s, l) => s + l.amount, 0));
  if (Math.abs(d - c) > 0.005) console.warn('[ledger] 借贷不平 tx=' + txId + ' 借 ' + d + ' / 贷 ' + c);
  legs.forEach(l => postLedgerEntry(txId, l.key, l.dir, l.amount, l.memo || memo, ts));
}
// 消费拆腿: 现金部分(卡扣) 与 积分抵扣部分(计积分成本, 1 分=$0.01) —— 种子回填与运行时共用同一套算术, 保证卡账与卡余额严格一致
function consumeLegSplit(amount, pointsUsed) {
  const A = lgR2(amount);
  const cash = lgR2(A - (pointsUsed || 0) / 100);
  const pts = Math.max(0, lgR2(A - cash));
  return { A, cash, pts, cardLeg: lgR2(A - pts) };
}
// ---- 业务动作记账(运行时与种子回填共用; 只追加分录, 不改既有业务行为) ----
// 充值: 渠道 +amt / 用户卡 +(amt-fee) / 平台手续费 +fee
function ledgerForTopup(tx, card) {
  const ch = tx.method === 'usdt' ? 'channel:usdt' : 'channel:fiat';
  ensureCardLedgerAccount(card);
  postLedgerTx(tx.id, '充值入账 ' + (tx.method === 'usdt' ? 'USDT' : '法币'), tx.createdAt, [
    { key: ch, dir: 'debit', amount: lgR2(tx.amount), memo: '渠道收款 · 用户充值 $' + lgR2(tx.amount).toFixed(2) + (tx.ref ? ' · ' + tx.ref : '') },
    { key: 'card:' + card.id, dir: 'credit', amount: lgR2(lgR2(tx.amount) - lgR2(tx.fee)), memo: '充值入卡(扣手续费后净额)' },
    { key: 'fee', dir: 'credit', amount: lgR2(tx.fee), memo: '充值手续费 $' + lgR2(tx.fee).toFixed(2) },
  ]);
}
// 消费: 用户卡 -amt / 商户待结算 +(amt-fee) / 平台手续费 +fee; 积分抵扣部分计积分成本
function ledgerForConsume(tx, card, payUsd) {
  const { A, pts, cardLeg } = consumeLegSplit(tx.amount, tx.pointsUsed);
  const cashLeg = payUsd != null ? lgR2(Math.min(payUsd, cardLeg)) : cardLeg; // 运行时传实测现金额(与拆腿口径一致)
  ensureCardLedgerAccount(card);
  ensureMerchantLedgerAccount(tx.merchant || '未知商户');
  const legs = [
    { key: 'card:' + card.id, dir: 'debit', amount: cashLeg, memo: '消费扣卡 · ' + (tx.merchant || '') + ' $' + A.toFixed(2) },
    { key: 'merchant:' + (tx.merchant || '未知商户'), dir: 'credit', amount: lgR2(A - lgR2(tx.fee)), memo: '待结算净额(扣 2% 手续费)' },
    { key: 'fee', dir: 'credit', amount: lgR2(tx.fee), memo: '消费手续费 $' + lgR2(tx.fee).toFixed(2) },
  ];
  if (pts > 0) legs.push({ key: 'pointscost', dir: 'debit', amount: pts, memo: '积分抵扣成本 · ' + (tx.pointsUsed || 0) + ' 分 × $0.01' });
  postLedgerTx(tx.id, '消费 ' + (tx.merchant || '') + ' $' + A.toFixed(2), tx.createdAt, legs);
}
// 退款: 反向流水 卡 +amt / 商户待结算 -(amt-fee) / 手续费 -fee
function ledgerForRefund(tx, ts) {
  const A = lgR2(tx.amount), F = lgR2(tx.fee);
  ensureMerchantLedgerAccount(tx.merchant || '未知商户');
  postLedgerTx('RF' + tx.id, '退款冲正 · 消费 #' + tx.id + ' ' + (tx.merchant || ''), ts, [
    { key: 'card:' + tx.cardId, dir: 'credit', amount: A, memo: '退款回卡 · 消费 #' + tx.id + ' 全额 $' + A.toFixed(2) },
    { key: 'merchant:' + (tx.merchant || '未知商户'), dir: 'debit', amount: lgR2(A - F), memo: '冲回商户待结算净额' },
    { key: 'fee', dir: 'debit', amount: F, memo: '冲回消费手续费 $' + F.toFixed(2) },
  ]);
}
// 积分兑换: 积分成本 +pointsCost×$0.01, 由平台法币资金支付履约
function ledgerForRedeem(order, product, ts) {
  const pts = order.pointsCost || (product || {}).points || 0;
  const cost = lgR2(pts * 0.01);
  if (!(cost > 0)) return;
  postLedgerTx('ORD' + order.id, '积分兑换 · ' + ((product || {}).name || '商品#' + order.productId), ts, [
    { key: 'pointscost', dir: 'debit', amount: cost, memo: '兑换履约成本 · ' + pts + ' 分 × $0.01' },
    { key: 'channel:fiat', dir: 'credit', amount: cost, memo: '平台资金支付兑换履约' },
  ]);
}
// 卡月费: 开户/在册卡计提一笔月费收入(口径与财务报表 monthlyFeeIncome 一致, 不动卡余额)
function ledgerForMonthlyFee(card, ts) {
  const feeVal = lgR2((CARD_LEVELS[card.level] || {}).monthlyFee || 0);
  if (!(feeVal > 0)) return;
  postLedgerTx('FEE' + card.id, '卡月费计提 · ' + ((CARD_LEVELS[card.level] || {}).label || card.level), ts, [
    { key: 'channel:fiat', dir: 'debit', amount: feeVal, memo: '月费从平台代管资金计提' },
    { key: 'monthlyfee', dir: 'credit', amount: feeVal, memo: ((CARD_LEVELS[card.level] || {}).label || '') + ' $' + feeVal.toFixed(2) + '/月' },
  ]);
}
// 佣金结算: 平台佣金支出累计, 法币渠道出金
function ledgerForCommissionSettle(c, ts) {
  if (!(c.amount > 0)) return;
  const rep = repById(c.salesId);
  postLedgerTx('COMM' + c.id, '佣金结算 · ' + (rep ? rep.name : '销售#' + c.salesId) + ' ' + c.typeLabel + (c.tierLabel ? '(' + c.tierLabel + ')' : ''), ts, [
    { key: 'commission', dir: 'debit', amount: lgR2(c.amount), memo: '佣金打款 · ' + (c.rate || '') + ' · 基数 $' + lgR2(c.baseAmt).toFixed(2) },
    { key: 'channel:fiat', dir: 'credit', amount: lgR2(c.amount), memo: '渠道出金支付佣金' },
  ]);
}
// 运营调账: 卡账户与渠道账户对向调整(delta 为卡余额实际增量)
function ledgerForAdjust(tx, card, delta) {
  const amt = lgR2(delta != null ? delta : tx.amount);
  if (Math.abs(amt) < 0.005) return;
  postLedgerTx(tx.id, '运营调账 · ' + (tx.ref || ''), tx.createdAt, amt > 0 ? [
    { key: 'card:' + card.id, dir: 'credit', amount: amt, memo: '调账入卡 +' + amt.toFixed(2) + ' · ' + (tx.ref || '') },
    { key: 'channel:fiat', dir: 'debit', amount: amt, memo: '平台资金补入' },
  ] : [
    { key: 'card:' + card.id, dir: 'debit', amount: -amt, memo: '调账扣减 ' + amt.toFixed(2) + ' · ' + (tx.ref || '') },
    { key: 'channel:fiat', dir: 'credit', amount: -amt, memo: '调账扣减回流平台资金' },
  ]);
}
// 账本自测: 借贷平衡 + 账户余额一致 + 卡账与卡余额一致
function verifyLedger() {
  const errors = [];
  const byTx = new Map();
  ledgerEntries.forEach(e => {
    const k = String(e.txId);
    if (!byTx.has(k)) byTx.set(k, { d: 0, c: 0 });
    const g = byTx.get(k);
    if (e.dir === 'debit') g.d += e.amount; else g.c += e.amount;
  });
  let balanced = true;
  byTx.forEach((g, k) => {
    if (Math.abs(lgR2(g.d) - lgR2(g.c)) > 0.005) { balanced = false; errors.push('业务单 ' + k + ' 借贷不平: 借 $' + lgR2(g.d).toFixed(2) + ' / 贷 $' + lgR2(g.c).toFixed(2)); }
  });
  const accByKey = new Map(ledgerAccounts.map(a => [a.key, a]));
  const run = new Map(), lastAfter = new Map();
  ledgerEntries.forEach(e => {
    const acc = accByKey.get(e.accountKey);
    if (!acc) { errors.push('流水 #' + e.id + ' 引用不存在的账户 ' + e.accountKey); return; }
    const delta = ((e.dir === 'debit') === !!LEDGER_DEBIT_POSITIVE[acc.type] ? 1 : -1) * e.amount;
    run.set(e.accountKey, lgR2((run.get(e.accountKey) || 0) + delta));
    lastAfter.set(e.accountKey, e.balanceAfter);
  });
  let consistent = true;
  const fail = (msg) => { consistent = false; errors.push(msg); };
  ledgerAccounts.forEach(a => {
    const r = run.get(a.key) || 0;
    if (Math.abs(r - a.balance) > 0.005) fail('账户 ' + a.name + '(' + a.key + ') 余额 $' + a.balance.toFixed(2) + ' 与流水重放 $' + r.toFixed(2) + ' 不一致');
    const la = lastAfter.get(a.key);
    if (la == null) { if (Math.abs(a.balance) > 0.005) fail('账户 ' + a.key + ' 无流水但余额 $' + a.balance.toFixed(2)); }
    else if (Math.abs(la - a.balance) > 0.005) fail('账户 ' + a.key + ' 末条流水 balanceAfter $' + la.toFixed(2) + ' ≠ 当前余额 $' + a.balance.toFixed(2));
  });
  cards.forEach(c => {
    const a = accByKey.get('card:' + c.id);
    if (!a) fail('卡 #' + c.id + ' 缺少账本账户 card:' + c.id);
    else if (Math.abs(a.balance - c.balance) > 0.005) fail('卡账户 card:' + c.id + ' 余额 $' + a.balance.toFixed(2) + ' ≠ 卡实际余额 $' + c.balance.toFixed(2));
  });
  return { balanced, accountsConsistent: balanced && consistent, errors,
    stats: { accounts: ledgerAccounts.length, entries: ledgerEntries.length, txCount: byTx.size, snapshots: balanceSnapshots.length, frozen: frozenBalances.length } };
}
// 账户在 cutoff 时点的余额(按全部流水重放)
function ledgerBalanceAsOf(accountKey, cutoff) {
  const acc = ledgerAccounts.find(a => a.key === accountKey);
  if (!acc) return 0;
  const debitPos = !!LEDGER_DEBIT_POSITIVE[acc.type];
  let bal = 0;
  ledgerEntries.forEach(e => {
    if (e.accountKey !== accountKey || e.createdAt >= cutoff) return;
    bal += ((e.dir === 'debit') === debitPos ? 1 : -1) * e.amount;
  });
  return lgR2(bal);
}
// 生成最近 days 天的「每日每账户」余额快照(本地时区按天)
function buildBalanceSnapshots(days) {
  balanceSnapshots = [];
  const t = new Date();
  const today0 = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  for (let i = days - 1; i >= 0; i--) {
    const dayStart = today0 - i * 864e5;
    const day = isoDay(dayStart);
    ledgerAccounts.forEach(a => balanceSnapshots.push({ day, accountKey: a.key, balance: ledgerBalanceAsOf(a.key, dayStart + 864e5) }));
  }
}
// initSeed 末尾回填: 遍历种子交易重建账本(先数学模拟算期初, 再按时间序入账), 附快照与演示冻结余额
function rebuildLedgerSeed() {
  ledgerAccounts = []; ledgerEntries = []; balanceSnapshots = []; frozenBalances = [];
  ensureLedgerAccount('channel:usdt', 'channel', '渠道账户 · USDT 链上');
  ensureLedgerAccount('channel:fiat', 'channel', '渠道账户 · 法币银行');
  ensureLedgerAccount('fee', 'income', '平台手续费');
  ensureLedgerAccount('monthlyfee', 'income', '卡月费收入');
  ensureLedgerAccount('commission', 'expense', '平台佣金支出');
  ensureLedgerAccount('pointscost', 'expense', '积分成本');
  cards.forEach(ensureCardLedgerAccount);
  const txsAsc = [...transactions].sort((a, b) => a.createdAt - b.createdAt);
  // ① 纯数学模拟各卡流水增量 → 期初 = 当前卡余额 - 增量(先算后记, 让期初分录排在流水最前)
  const OPEN_TS = now() - 33 * 864e5; // 早于全部种子交易(30 天窗口)
  const sim = {}; cards.forEach(c => { sim[c.id] = 0; });
  txsAsc.forEach(t => {
    if (t.type === 'topup') sim[t.cardId] = lgR2(sim[t.cardId] + lgR2(lgR2(t.amount) - lgR2(t.fee)));
    else if (t.type === 'consume') sim[t.cardId] = lgR2(sim[t.cardId] - consumeLegSplit(t.amount, t.pointsUsed).cardLeg);
    else if (t.type === 'adjust') sim[t.cardId] = lgR2(sim[t.cardId] + lgR2(t.amount));
  });
  const jobs = [];
  cards.forEach(c => {
    const op = lgR2(c.balance - (sim[c.id] || 0));
    if (Math.abs(op) > 0.004) {
      jobs.push(op > 0
        ? { ts: OPEN_TS, run: () => postLedgerTx('OPEN' + c.id, '期初余额结转', OPEN_TS, [
            { key: 'channel:fiat', dir: 'debit', amount: op, memo: '期初渠道在途资金' },
            { key: 'card:' + c.id, dir: 'credit', amount: op, memo: '开卡以来累计结转(期初)' }]) }
        : { ts: OPEN_TS, run: () => postLedgerTx('OPEN' + c.id, '期初余额结转(负)', OPEN_TS, [
            { key: 'card:' + c.id, dir: 'debit', amount: -op, memo: '期初负余额结转' },
            { key: 'channel:fiat', dir: 'credit', amount: -op }]) });
    }
  });
  // ② 种子交易: 充值 / 消费(含标签 refunded 的历史消费, 当时已扣卡余额) / 调账
  txsAsc.forEach(t => {
    const card = cards.find(c => c.id === t.cardId);
    if (!card) return;
    if (t.type === 'topup') jobs.push({ ts: t.createdAt, run: () => ledgerForTopup(t, card) });
    else if (t.type === 'consume') jobs.push({ ts: t.createdAt, run: () => ledgerForConsume(t, card) });
    else if (t.type === 'adjust') jobs.push({ ts: t.createdAt, run: () => ledgerForAdjust(t, card) });
  });
  // ③ 在册卡月费计提(非挂失, 口径同财务报表) / 种子兑换订单履约成本 / 已结算佣金
  cards.filter(c => c.status !== 'lost').forEach(c => jobs.push({ ts: c.createdAt, run: () => ledgerForMonthlyFee(c, c.createdAt) }));
  orders.filter(o => o.status !== 'cancelled').forEach(o => {
    const pr = products.find(p => p.id === o.productId);
    if (pr) jobs.push({ ts: o.createdAt, run: () => ledgerForRedeem(o, pr, o.createdAt) });
  });
  commissions.filter(c => c.status === 'settled').forEach(c => {
    const ts = Math.min(c.createdAt + 3 * 864e5, now());
    jobs.push({ ts, run: () => ledgerForCommissionSettle(c, ts) });
  });
  jobs.sort((a, b) => a.ts - b.ts);
  jobs.forEach(j => j.run());
  // ④ 14 天每日余额快照
  buildBalanceSnapshots(14);
  // ⑤ 演示冻结余额: 一笔风控全额冻结 + 一笔部分冻结观察
  const fz = (key, amt, reason, d, jh) => frozenBalances.push({ id: nid(), accountKey: key, amount: lgR2(Math.max(0, amt)), reason, createdAt: daysAgo(d, jh), status: 'frozen' });
  const c11 = ledgerAccounts.find(a => a.key === 'card:11');
  if (c11) fz('card:11', c11.balance, '风控全额冻结 · 2 小时内跨国消费命中规则, 待人工处置', 1, 6);
  const c6 = ledgerAccounts.find(a => a.key === 'card:6');
  if (c6) fz('card:6', Math.min(300, c6.balance), '风控部分冻结 · 新设备大额充值观察池', 3, 2);
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
  amount = +(amount || 0).toFixed(2); // 金额量化到分, 保证账本分录与卡余额增量严格一致
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
  ledgerForTopup(tx, card); // P4.4: 渠道+amt / 卡+(amt-fee) / 平台手续费+fee
  return { tx, balance: card.balance };
}
function doPay(userId, amount, merchant, usePoints) {
  amount = +(amount || 0).toFixed(2); // 金额量化到分, 保证账本分录与卡余额增量严格一致
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
  ledgerForConsume(tx, card, payUsd); // P4.4: 卡-amt / 商户待结算+(amt-fee) / 手续费+fee, 积分抵扣计积分成本
  return { tx, balance: card.balance, pointsEarned: pts, pointsUsed };
}
function doRedeem(userId, productId) {
  const p = products.find(x => x.id === productId);
  const user = users.find(u => u.id === userId);
  if (!p || p.status !== 'on') return { error: '商品不可兑换' };
  if (p.stock <= 0) return { error: '库存不足' };
  const limit = productLimit(p);
  if (limit > 0) { // limitPerUser 默认 0=不限购; 演示部分商品在 PRODUCT_LIMITS 配置
    const mine = orders.filter(o => o.userId === userId && o.productId === p.id && o.status !== 'cancelled').length;
    if (mine >= limit) return { error: `该商品每人限兑 ${limit} 件, 你已兑换 ${mine} 件` };
  }
  if (user.points < p.points) return { error: `积分不足(还差 ${p.points - user.points} 分)` };
  p.stock--;
  const order = { id: nid(), userId, productId, pointsCost: p.points, status: p.category === '实物' ? 'pending' : 'redeemed', redeemCode: p.category !== '实物' ? 'UC-' + ri(1000, 9999) + '-' + ri(1000, 9999) : '', trackingNo: '', createdAt: now() };
  orders.unshift(order);
  addPointsLog(userId, -p.points, '商城兑换', order.id, now());
  ledgerForRedeem(order, p, now()); // P4.4: 积分成本 +pointsCost×$0.01
  return { order };
}

// ---------------- P2: 用户端扩展工具(模块级, 调用时才读冷数据) ----------------
// 演示限购配置(每人限兑件数); 商品自带 limitPerUser 字段优先, 缺省 0=不限
const PRODUCT_LIMITS = { 6: 1, 8: 2 };
const productLimit = (p) => p.limitPerUser || PRODUCT_LIMITS[p.id] || 0;
// 商品平均评分(来自已评价订单)
function productRating(productId) {
  const rs = orders.filter(o => o.productId === productId && o.review);
  if (!rs.length) return null;
  return { avg: +(rs.reduce((a, o) => a + o.review.stars, 0) / rs.length).toFixed(1), count: rs.length };
}
// 积分中心汇总: 可用/冻结(当月获得 10% 演示口径)/即将过期(每笔 90 天有效期, 30 天内到期)/来源分类/任务进度
function pointsSummary(uid) {
  const u = users.find(x => x.id === uid);
  const logs = pointsLogs.filter(l => l.userId === uid);
  const gain = logs.filter(l => l.delta > 0);
  const total = gain.reduce((a, l) => a + l.delta, 0);
  const d = new Date();
  const inMonth = (ts) => { const t = new Date(ts); return t.getFullYear() === d.getFullYear() && t.getMonth() === d.getMonth(); };
  const frozen = Math.round(gain.filter(l => inMonth(l.createdAt)).reduce((a, l) => a + l.delta, 0) * 0.1);
  const EXP = 90 * 864e5, SOON = 30 * 864e5;
  const expiringSoon = gain.filter(l => { const e = l.createdAt + EXP; return e > now() && e <= now() + SOON; }).reduce((a, l) => a + l.delta, 0);
  const bySource = { '消费返积分': 0, '充值奖励': 0, '签到': 0, '任务与其他': 0, '兑换与抵扣': 0 };
  logs.forEach(l => {
    const s = String(l.source);
    if (s === '消费返积分') bySource['消费返积分'] += l.delta;
    else if (s === '充值奖励') bySource['充值奖励'] += l.delta;
    else if (s === '每日签到') bySource['签到'] += l.delta;
    else if (s === '商城兑换' || s === '消费抵扣') bySource['兑换与抵扣'] += l.delta;
    else bySource['任务与其他'] += l.delta;
  });
  const day = new Date().toDateString();
  const signedToday = logs.some(l => l.source === '每日签到' && new Date(l.createdAt).toDateString() === day);
  const taskProgress = tasks.map(t => ({ id: t.id, title: t.title, type: t.type, points: t.points,
    done: t.type === 'daily' ? signedToday : logs.some(l => String(l.refNo) === 'TASK' + t.id) }));
  return { available: u ? u.points : 0, frozen, expiringSoon, total, bySource, signedToday, taskProgress,
    rules: { earnPerUsd: POINTS_PER_USD, pointsPerUsd: 100, maxOff: '30%', validityDays: 90 } };
}
// 消息通知: 种子+事件(交易/系统/营销 3 类), 已读状态按 uid 存内存(重启还原)
let notifRead = {};
function appNotificationsFor(uid) {
  const u = users.find(x => x.id === uid);
  if (!u) return { list: [], unread: 0 };
  const read = notifRead[uid] || (notifRead[uid] = {});
  const list = [];
  transactions.filter(t => t.userId === uid).slice(0, 3).forEach(t => {
    list.push(t.type === 'topup'
      ? { id: 'tx' + t.id, type: '交易', icon: '💰', title: '充值到账', body: `充值 $${t.amount} 已到账(手续费 $${t.fee}), 返还积分请在积分中心查看。`, createdAt: t.createdAt }
      : { id: 'tx' + t.id, type: '交易', icon: '🛍️', title: '消费交易提醒', body: `在 ${t.merchant} 消费 $${t.amount}, 本笔返还 ${t.pointsEarned} 积分。`, createdAt: t.createdAt });
  });
  const card = cards.find(c => c.userId === uid);
  list.push({ id: 'sys' + u.id + 'a', type: '系统', icon: '🛡️', title: '安全中心提醒', body: '如发现非本人交易, 请立即在「卡包 → 冻结挂失」冻结卡片并联系客服。', createdAt: daysAgo(2) });
  list.push({ id: 'sys' + u.id + 'b', type: '系统', icon: '🪪', title: 'KYC 等级通知', body: `当前 KYC L${u.kycLevel}, 单笔限额 $${KYC_LIMITS[u.kycLevel].perTx}, 升级认证可提升限额。`, createdAt: daysAgo(4) });
  if (card && card.status !== 'active') list.push({ id: 'sys' + u.id + 'c', type: '系统', icon: card.status === 'lost' ? '🚨' : '❄️', title: card.status === 'lost' ? '卡片已挂失' : '卡片已冻结', body: '卡片暂不可用于充值与消费, 恢复需联系客服或在运营后台处理。', createdAt: daysAgo(1) });
  list.push({ id: 'mkt1', type: '营销', icon: '🎁', title: '积分商城上新', body: 'AirPods 4 / 白金卡升级券等好礼已上架, 快去商城看看吧!', createdAt: daysAgo(1, 5) });
  list.push({ id: 'mkt2', type: '营销', icon: '⚡', title: '双倍积分周', body: '本周消费返积分加成, 金卡/白金卡可叠加等级倍率, 更快攒满好礼。', createdAt: daysAgo(3) });
  list.sort((a, b) => b.createdAt - a.createdAt);
  const out = list.map(n => ({ ...n, read: !!read[n.id] }));
  return { list: out, unread: out.filter(n => !n.read).length };
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

// 驾驶舱时间范围工具(模块级): ?range=today|week|month|quarter 的起点与趋势分桶
// today=按小时 / week=按天(周一起) / month=按天 / quarter=按周; 旧版固定 14 天, 现按所选范围聚合
function rangeStartTs(range) {
  const n = new Date();
  if (range === 'week') { const d0 = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime(); return d0 - ((new Date(d0).getDay() + 6) % 7) * 864e5; } // 本周一
  if (range === 'month') return new Date(n.getFullYear(), n.getMonth(), 1).getTime();
  if (range === 'quarter') return new Date(n.getFullYear(), Math.floor(n.getMonth() / 3) * 3, 1).getTime();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
}
function buildTrend(range, topups, consumes) {
  const rs = rangeStartTs(range);
  const stepMs = range === 'today' ? 36e5 : range === 'quarter' ? 7 * 864e5 : 864e5;
  const maxBuckets = range === 'today' ? 24 : range === 'quarter' ? 14 : 31;
  const buckets = [];
  for (let i = 0; i < 92 && buckets.length < maxBuckets; i++) {
    const t = rs + i * stepMs;
    if (t > now()) break; // 未来的分桶不画
    const d = new Date(t);
    buckets.push({ key: t, label: range === 'today' ? String(d.getHours()).padStart(2, '0') + ':00' : (d.getMonth() + 1) + '/' + d.getDate() });
  }
  const bktOf = (ts) => rs + Math.floor((ts - rs) / stepMs) * stepMs;
  const acc = {};
  buckets.forEach(b => { acc[b.key] = { topup: 0, consume: 0 }; });
  [...topups, ...consumes].forEach(t => {
    if (t.createdAt < rs) return;
    const cell = acc[bktOf(t.createdAt)];
    if (cell) cell[t.type] += t.amount;
  });
  return buckets.map(b => ({ date: b.label, topup: +acc[b.key].topup.toFixed(0), consume: +acc[b.key].consume.toFixed(0) }));
}

// ---------------- P1.5 风控 + P1.6 财务 视图工具(模块级, 依赖 initSeed 填充的冷数据) ----------------
const RISK_LEVEL_LABEL = { high: '高', mid: '中', low: '低' };
const RISK_STATUS_LABEL = { pending: '待处理', frozen: '已冻结', reviewed: '已复核', released: '已解除' };
const RISK_ACTION_LABEL = { block: '拦截', freeze: '冻结', review: '人工审核', mark: '标记' };
const maskCardNo = (no) => { const d = String(no || '').replace(/\s/g, ''); return d.length >= 4 ? '**** **** **** ' + d.slice(-4) : '—'; };
const pubRiskEvent = (e) => {
  const u = users.find(x => x.id === e.userId);
  const card = cards.find(c => c.id === e.cardId);
  const rule = riskRules.find(r => r.id === e.ruleId);
  return { ...e, levelLabel: RISK_LEVEL_LABEL[e.level] || e.level, statusLabel: RISK_STATUS_LABEL[e.status] || e.status,
    user: u ? u.name : '—', cardNoMask: card ? maskCardNo(card.cardNo) : '—', cardStatus: card ? card.status : '—',
    ruleName: rule ? rule.name : '已删除规则', ruleAction: rule ? rule.action : '', ruleExpr: rule ? rule.expr : '' };
};
// 对账: 三类交易按天(dayKey)分组; 应入账=平台口径, 实际=渠道回执(按 financeMeta.diffs 注入模拟差异), 差异=应入-实际
const RECON_DEFS = {
  topup:   { label: '充值对账', voucher: 'TP', tx: (t) => t.type === 'topup' && t.status === 'success' },
  consume: { label: '消费对账', voucher: 'CS', tx: (t) => t.type === 'consume' && t.status === 'success' },
  refund:  { label: '退款对账', voucher: 'RF', tx: (t) => t.type === 'consume' && t.status === 'refunded' },
};
function reconGroups(type) {
  const def = RECON_DEFS[type] || RECON_DEFS.topup;
  const byDay = {};
  transactions.filter(def.tx).forEach(t => {
    const k = dayKey(t.createdAt);
    const g = byDay[k] = byDay[k] || { day: k, count: 0, due: 0, fee: 0 };
    g.count++; g.due += t.amount; g.fee += t.fee;
  });
  return Object.values(byDay)
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    .map((g, i) => {
      const due = +g.due.toFixed(2);
      const d = (financeMeta.diffs[type] || {})[g.day];
      const actual = d ? +(due - d.delta).toFixed(2) : due;
      const diff = +(due - actual).toFixed(2);
      return { day: g.day, count: g.count, due, actual, fee: +g.fee.toFixed(2), diff,
        status: Math.abs(diff) < 0.01 ? '平' : '差异', reason: d ? d.reason : '',
        period: financeMeta.period[type] || 'T+1',
        voucher: def.voucher + '-' + g.day.replace('-', '') + '-' + String(i + 1).padStart(2, '0') };
    });
}
// 商户结算: 按消费商户汇总(平台手续费即消费交易 fee, 2%), 结算状态存 financeMeta.merchantSettled
function merchantRows() {
  const names = [...new Set(transactions.filter(t => t.type === 'consume' && t.merchant).map(t => t.merchant))];
  return names.map((name, i) => {
    const txs = transactions.filter(t => t.type === 'consume' && t.status === 'success' && t.merchant === name);
    const amt = +txs.reduce((s, t) => s + t.amount, 0).toFixed(2);
    const fee = +txs.reduce((s, t) => s + t.fee, 0).toFixed(2);
    const lastTxAt = txs.length ? Math.max(...txs.map(t => t.createdAt)) : null;
    return { merchant: name, txCount: txs.length, consumeAmt: amt, fee, net: +(amt - fee).toFixed(2),
      settled: !!financeMeta.merchantSettled[name], period: 'T+2',
      voucher: 'MC-' + String(i + 1).padStart(2, '0') + (lastTxAt ? '-' + dayKey(lastTxAt).replace('-', '') : ''),
      lastTxAt };
  }).sort((a, b) => b.consumeAmt - a.consumeAmt);
}

// ---------------- P3 系统管理工具(模块级, 依赖 initSeed 填充的冷数据) ----------------
// 权限树: 两级 模块 → 页面/操作, 覆盖后台全部模块; key 全局唯一
const PERM_TREE = [
  { key: 'dashboard', label: '驾驶舱', actions: [['dashboard.view', '查看'], ['dashboard.edit', '编辑']] },
  { key: 'goals', label: '目标管理', actions: [['goals.view', '查看'], ['goals.edit', '编辑目标']] },
  { key: 'cards', label: 'U卡管理', actions: [['cards.view', '查看'], ['cards.issue', '发卡'], ['cards.freeze', '冻结/解冻'], ['cards.adjust', '调额']] },
  { key: 'kyc', label: 'KYC 审核', actions: [['kyc.view', '查看'], ['kyc.review', '审核']] },
  { key: 'crm', label: '客户管理', actions: [['crm.view', '查看'], ['crm.edit', '编辑'], ['crm.create', '新增客户']] },
  { key: 'tx', label: '客户交易', actions: [['tx.view', '查看'], ['tx.refund', '退款']] },
  { key: 'perf', label: '业绩排行', actions: [['perf.view', '查看']] },
  { key: 'commission', label: '佣金管理', actions: [['commission.view', '查看'], ['commission.settle', '结算']] },
  { key: 'chain', label: '分销链路', actions: [['chain.view', '查看'], ['chain.sales', '新增销售账号']] },
  { key: 'points', label: '积分管理', actions: [['points.view', '查看'], ['points.grant', '积分发放']] },
  { key: 'shop', label: '商城管理', actions: [['shop.view', '查看'], ['shop.toggle', '上下架']] },
  { key: 'orders', label: '兑换订单', actions: [['orders.view', '查看'], ['orders.ship', '发货']] },
  { key: 'risk', label: '风险事件', actions: [['risk.view', '查看'], ['risk.handle', '处置']] },
  { key: 'riskRules', label: '风险规则', actions: [['riskRules.view', '查看'], ['riskRules.toggle', '启停']] },
  { key: 'riskLists', label: '黑白名单', actions: [['riskLists.view', '查看'], ['riskLists.remove', '移除']] },
  { key: 'riskTags', label: '风险标签', actions: [['riskTags.view', '查看']] },
  { key: 'recon', label: '对账中心', actions: [['recon.view', '查看'], ['recon.export', '导出']] },
  { key: 'financeDiff', label: '差异清单', actions: [['financeDiff.view', '查看']] },
  { key: 'merchant', label: '商户结算', actions: [['merchant.view', '查看'], ['merchant.settle', '结算']] },
  { key: 'financeReport', label: '财务报表', actions: [['financeReport.view', '查看'], ['financeReport.export', '导出']] },
  { key: 'sysAccounts', label: '账号管理', actions: [['sysAccounts.view', '查看'], ['sysAccounts.enable', '启禁用'], ['sysAccounts.resetPwd', '重置密码']] },
  { key: 'sysRoles', label: '角色管理', actions: [['sysRoles.view', '查看']] },
  { key: 'sysPerms', label: '权限配置', actions: [['sysPerms.view', '查看'], ['sysPerms.edit', '保存']] },
  { key: 'sysOrg', label: '组织架构', actions: [['sysOrg.view', '查看']] },
  { key: 'sysParams', label: '系统参数', actions: [['sysParams.view', '查看'], ['sysParams.edit', '编辑']] },
  { key: 'sysDicts', label: '字典管理', actions: [['sysDicts.view', '查看'], ['sysDicts.toggle', '启停字典项']] },
  { key: 'loginlogs', label: '登录日志', actions: [['loginlogs.view', '查看']] },
  { key: 'oplogs', label: '操作日志', actions: [['oplogs.view', '查看']] },
];
const ALL_PERM_KEYS = PERM_TREE.reduce((a, m) => a.concat(m.actions.map(x => x[0])), []);
// 各角色默认权限: 总监全勾; 销售角色仅 CRM 工作台相关页面(与前端 SALES_PAGES 口径一致)
const SALES_PERM_BASE = ['dashboard.view', 'crm.view', 'crm.edit', 'crm.create', 'tx.view', 'perf.view', 'commission.view', 'chain.view'];
const ROLE_PERM_DEFAULTS = {
  super: ALL_PERM_KEYS,
  director: ALL_PERM_KEYS,
  sales_l1: [...SALES_PERM_BASE, 'goals.view', 'goals.edit'],
  sales_l2: [...SALES_PERM_BASE, 'goals.view'],
  sales_l3: [...SALES_PERM_BASE, 'goals.view'],
  ops: ['dashboard.view', 'dashboard.edit', 'cards.view', 'cards.issue', 'cards.freeze', 'cards.adjust', 'kyc.view', 'kyc.review', 'points.view', 'points.grant', 'shop.view', 'shop.toggle', 'orders.view', 'orders.ship', 'crm.view'],
  finance: ['dashboard.view', 'recon.view', 'recon.export', 'financeDiff.view', 'merchant.view', 'merchant.settle', 'financeReport.view', 'financeReport.export', 'commission.view'],
  risk: ['dashboard.view', 'risk.view', 'risk.handle', 'riskRules.view', 'riskRules.toggle', 'riskLists.view', 'riskLists.remove', 'riskTags.view'],
};
// 组织架构树: 总监→一级→二级→三级, 每节点带名下客户数/卡量/团队人数
function sysOrgTree() {
  const node = (s) => {
    const kids = salesReps.filter(x => x.parentId === s.id).map(node);
    return { id: s.id, name: s.name, role: s.role, level: s.level, region: s.region,
      customers: customers.filter(c => c.ownerSalesId === s.id).length,
      cards: cards.filter(c => c.salesRepId === s.id).length,
      teamSize: kids.length ? subtreeIds(s.id).length - 1 : 0, children: kids };
  };
  return salesReps.filter(s => !s.parentId || !repById(s.parentId)).map(node);
}
// 登录日志种子: 近 50 条, 时间倒推分布, IP 段与 UA 摘要为演示模拟
function buildSysLoginLogs() {
  const IPS = ['37.106.', '94.56.', '185.93.', '5.42.', '45.12.', '78.95.'];
  const UAS = ['Chrome 131 · Windows 11', 'Safari 17 · iPhone 15 Pro', 'Chrome 130 · macOS Sonoma', 'Edge 129 · Windows 10', 'U-Card App 3.2 · Android 14', 'Chrome Mobile · Xiaomi 14'];
  const out = [];
  let ts = now();
  for (let i = 0; i < 50; i++) {
    ts -= ri(1, 4) * 36e5 + ri(0, 59) * 6e4; // 每条再往前推 1-4 小时
    const a = pick(sysAccounts);
    const ok = rnd() > 0.14;
    out.push({ id: 900001 + i, createdAt: ts, username: a.username, name: a.name, role: a.roleName,
      ip: pick(IPS) + ri(10, 240) + '.' + ri(1, 254), ua: pick(UAS),
      result: ok ? '成功' : pick(['失败 · 密码错误', '失败 · 验证码过期', '失败 · 账号已禁用']) });
  }
  return out;
}
// 操作日志种子: 近 100 条, 覆盖既有业务动作(KYC/退款/结算/发货/积分/风控/重置演示数据等)
function buildSysOpLogs() {
  const N = 'Noura Al-Faisal', L = 'Lina Haddad', Y = 'Yousef Barakat', M = 'Muna Al-Ali', A = 'Nasser Al-Kaabi';
  const consumes = transactions.filter(t => t.type === 'consume' && t.status === 'success');
  const pendU = users.filter(u => u.kycStatus !== 'approved');
  const kycU = () => pick(pendU.length ? pendU : users);
  const uName = (id) => (users.find(u => u.id === id) || {}).name || '—';
  const saleNames = salesReps.filter(s => s.level > 0).map(s => s.name);
  const shipped = orders.filter(o => o.status === 'shipped');
  const tpl = [ // [条数, 操作人(null=随机销售), 模块, 动作, 对象摘要函数, 结果(缺省成功)]
    [10, N, 'KYC 审核', '审核通过', () => { const u = kycU(); return u.name + ' · 升级 L' + Math.min(2, u.kycLevel + 1) + ' · 奖励 200 积分'; }],
    [2, N, 'KYC 审核', '驳回', () => kycU().name + ' · 证件信息不清晰'],
    [6, N, '交易管理', '退款', () => { const t = pick(consumes); return '#' + t.id + ' · ' + uName(t.userId) + ' · $' + t.amount.toFixed(2); }],
    [2, N, '交易管理', '退款', () => '#' + pick(consumes).id + ' · 已过退款时效', '失败'],
    [8, Y, '财务结算', '佣金结算', () => { const c = pick(commissions); return '佣金单 #' + c.id + ' · ' + ((repById(c.salesId) || {}).name || '—') + ' · $' + c.amount.toFixed(2); }],
    [4, Y, '财务结算', '商户结算', () => '商户 ' + pick(['Amazon', 'Apple Store', 'Noon', 'Careem', 'Starbucks', 'Talabat']) + ' · T+2 批次打款'],
    [5, Y, '财务结算', '对账导出', () => pick(['充值对账', '消费对账', '退款对账']) + ' CSV · 近 30 天'],
    [8, L, '兑换订单', '发货', () => { const o = pick(shipped.length ? shipped : orders); return '订单 #' + o.id + ' · ' + ((products.find(p => p.id === o.productId) || {}).name || '') + ' · ' + (o.trackingNo || '—'); }],
    [5, L, '积分管理', '积分发放', () => pick(users).name + ' · +500 分 · 活动奖励'],
    [4, L, '商城管理', '商品下架', () => { const p = pick(products); return p.name + ' · 库存 ' + p.stock; }],
    [4, L, '商城管理', '商品上架', () => pick(products).name],
    [6, M, '风控中心', '解除风控', () => { const e = pick(riskEvents); return '事件 #' + e.id + ' · ' + uName(e.userId) + ' · 复核通过'; }],
    [3, M, '风控中心', '人工复核', () => '事件 #' + pick(riskEvents).id + ' · 调取交易与设备信息'],
    [4, M, '风控中心', '规则启停', () => '规则 · ' + pick(riskRules).name],
    [3, M, '风控中心', '名单移除', () => pick(riskLists).target],
    [4, L, 'U卡管理', '冻结/解冻', () => { const c = pick(cards); return maskCardNo(c.cardNo) + ' · ' + uName(c.userId); }],
    [3, L, 'U卡管理', '调账', () => maskCardNo(pick(cards).cardNo) + ' · +' + pick([50, 100, 200]) + ' USD'],
    [5, null, '客户管理', '新增客户', () => pick(customers).name + ' · ' + pick(['自主注册', '销售开发', '推荐引流'])],
    [4, null, '客户管理', '阶段推进', () => { const c = pick(customers); return c.name + ' · ' + pick(['线索', '意向', '方案']) + ' → ' + pick(['方案', '开卡', '充值']); }],
    [3, N, '系统管理', '新增销售', () => pick(saleNames) + ' · 挂靠组织节点'],
    [2, N, '系统管理', '重置演示数据', () => '全部种子数据重建 · 清空现场操作'],
    [3, A, '系统管理', '参数修改', () => { const p = pick(sysParams); return p.label + ': ' + p.value + ' → ' + p.value; }],
    [2, A, '系统管理', '禁用账号', () => 'ops.faris · Faris Al-Otaibi'],
  ];
  const out = [];
  tpl.forEach(t => { for (let i = 0; i < t[0]; i++) out.push({ createdAt: daysAgo(ri(0, 13), 23), operator: t[1] || pick(saleNames), module: t[2], action: t[3], target: t[4](), result: t[5] || '成功' }); });
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out.map((o, i) => ({ id: 910001 + i, ...o }));
}

// ---------------- P4 平台层工具(模块级, 依赖 initSeed 填充的冷数据) ----------------
const TENANT_STATUS_LABEL = { pending: '待审核', trial: '试用', active: '正常', frozen: '冻结' };
const TENANT_PLAN_LABEL = { Basic: 'Basic 基础版', Pro: 'Pro 专业版', Enterprise: 'Enterprise 旗舰版' };
const pctStr = (v) => { const pc = v * 100; return (pc % 1 ? pc.toFixed(1) : pc) + '%'; };
const pubTenant = (t) => ({ ...t,
  statusLabel: TENANT_STATUS_LABEL[t.status] || t.status, planLabel: TENANT_PLAN_LABEL[t.plan] || t.plan,
  expireDaysLeft: Math.max(0, Math.ceil((t.expireAt - now()) / 864e5)),
  commissionDisplay: {
    topup: t.commission.topup.map(pctStr), consume: t.commission.consume.map(pctStr),
    card: t.commission.card.map(v => '$' + v),
  },
  users: t.isolation.users, cards: t.isolation.cards, gmv: t.isolation.gmv,
});
const maskSecret = (s) => 'sk-****' + String(s || '').slice(-4);
// 开放 API 日志种子: 近 100 条调用(状态码/耗时/IP 为演示模拟)
function buildOpenApiLogs() {
  const EPS = ['balance.query', 'transaction.query', 'user.create', 'topup.callback', 'consume.callback', 'points.query', 'order.query', 'card.issue', 'kyc.submit', 'refund.create'];
  const IPS = ['37.106.', '94.56.', '185.93.', '5.42.', '78.95.', '45.12.'];
  const keys = openApps.filter(a => a.enabled).map(a => a.appKey);
  const out = [];
  let ts = now();
  for (let i = 0; i < 100; i++) {
    ts -= ri(2, 26) * 6e4 + ri(0, 59) * 1e3;
    const ok = rnd() > 0.07;
    out.push({ id: 950001 + i, createdAt: ts, appKey: pick(keys), endpoint: '/api/open/' + pick(EPS),
      method: pick(['POST', 'POST', 'POST', 'GET']), status: ok ? 200 : pick([401, 429, 500]),
      ms: ri(16, 420), ip: pick(IPS) + ri(10, 240) + '.' + ri(1, 254) });
  }
  return out;
}
// 消息发送记录种子: 近 100 条(渠道/事件/接收人/模板/状态/耗时), 失败可重发
function buildNotifySends() {
  const CH = notifyChannels.filter(c => c.enabled).map(c => c.key);
  const maskMail = (m) => String(m).replace(/^(.).*(@.*)$/, '$1***$2');
  const maskPhone = (p) => String(p).replace(/\s/g, '').replace(/^(\+\d{3})\d+(\d{2})$/, '$1 *****$2');
  const out = [];
  let ts = now();
  for (let i = 0; i < 100; i++) {
    ts -= ri(3, 42) * 6e4;
    const channel = pick(CH);
    const tpl = pick(notifyTemplates.filter(t => t.channel === channel)) || notifyTemplates[0];
    const u = pick(users);
    // 用示例值填模板变量, 生成"内容摘要"预览
    const content = tpl.body.replace(/\{\{(\w+)\}\}/g, (m, k) => k === 'userName' ? u.name
      : k === 'amount' ? '$' + (ri(120, 260000) / 100).toFixed(2)
      : k === 'cardLast4' ? String(ri(1000, 9999))
      : k === 'transactionId' ? 'TX' + ri(100000, 999999)
      : k === 'createdAt' ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : m).replace(/\n/g, ' ').slice(0, 90);
    const sr = rnd();
    let st = sr < 0.87 ? 'success' : sr < 0.955 ? 'failed' : 'retrying';
    if (i === 2 || i === 23) st = 'failed';   // 保证演示/自测必有可重发记录
    if (i === 8 || i === 37) st = 'retrying';
    out.push({ id: 960001 + i, createdAt: ts, channel, event: tpl.event, eventLabel: tpl.eventLabel,
      userName: u.name,
      receiver: (channel === 'email' ? maskMail(u.email) : channel === 'webhook' ? 'https://biz.' + maskMail(u.email).split('@')[1] + '/notify' : maskPhone(u.phone)),
      templateId: tpl.id, content, status: st, attempts: st === 'success' ? (rnd() < 0.06 ? 2 : 1) : ri(1, 3), ms: ri(38, 2400) });
  }
  return out;
}
// mock 调用写入开放 API 日志(上限 200 条)
function logOpenApi(appKey, endpoint, method, status, ms, ip) {
  openApiLogs.unshift({ id: openApiLogs.length ? Math.max(...openApiLogs.map(l => l.id)) + 1 : 950001, createdAt: now(), appKey, endpoint, method, status, ms, ip: ip || '127.0.0.1' });
  if (openApiLogs.length > 200) openApiLogs.length = 200;
}
// P4.5 开放平台 mock 接口注册表: 供接口文档「在线调试」真实调用(只读模拟, 不动真实账本)
const OPEN_MOCKS = {
  'user.create': { label: '用户开户', data: (b) => ({ userId: ri(100, 999), name: b.name || 'OpenAPI User', kycLevel: 0, status: 'created', invitedBy: null, createdAt: now() }) },
  'kyc.submit': { label: 'KYC 提交', data: (b) => ({ kycId: 'KYC-' + ri(100000, 999999), applyLevel: Math.min(2, +b.applyLevel || 1), docs: ['passport.jpg', 'selfie.jpg'], status: 'pending_review', sla: '2 小时' }) },
  'card.issue': { label: '发卡', data: (b) => ({ cardId: ri(100, 999), cardNo: maskCardNo(genCardNo()), level: b.level || 'standard', status: 'active', balance: 0, expMonth: ri(1, 12), expYear: ri(28, 31) }) },
  'balance.query': { label: '查询余额', data: (b) => { const u = users.find(x => x.id === +b.userId) || users[0]; const c = cards.find(x => x.userId === u.id); return { userId: u.id, userName: u.name, currency: 'USD', balance: c ? +c.balance.toFixed(2) : 0, available: c ? +c.balance.toFixed(2) : 0, frozen: 0, asOf: now() }; } },
  'transaction.query': { label: '查询交易', data: (b) => ({ total: transactions.length, list: transactions.slice(0, 5).map(pubTx) }) },
  'topup.callback': { label: '充值回调', data: (b) => ({ accepted: true, txId: 'TX' + ri(100000, 999999), amount: +b.amount || 100, currency: 'USD', method: b.method || 'usdt', status: 'settled', receivedAt: now() }) },
  'consume.callback': { label: '消费回调', data: (b) => ({ accepted: true, txId: 'TX' + ri(100000, 999999), merchant: b.merchant || 'Amazon', amount: +b.amount || 58.4, fee: +(((+b.amount || 58.4) * 0.02)).toFixed(2), status: 'cleared', receivedAt: now() }) },
  'refund.create': { label: '退款', data: (b) => ({ refundId: 'RF' + ri(100000, 999999), txId: b.txId || 'TX' + ri(100000, 999999), amount: +b.amount || 45, status: 'processing', eta: 'T+1 到账' }) },
  'points.query': { label: '积分查询', data: (b) => { const u = users.find(x => x.id === +b.userId) || users[0]; const s = pointsSummary(u.id); return { userId: u.id, userName: u.name, available: s.available, frozen: s.frozen, expiringSoon: s.expiringSoon, totalEarned: s.total }; } },
  'order.query': { label: '订单查询', data: (b) => (b.orderId ? { order: pubOrder(orders.find(o => o.id === +b.orderId) || orders[0]) } : { total: orders.length, list: orders.slice(0, 5).map(pubOrder) }) },
};


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
      // P1.1 驾驶舱增强: ?range=today|week|month|quarter, GMV/充值/消费与趋势按范围统计(缺省 today)
      const range = ['today', 'week', 'month', 'quarter'].includes(q.range) ? q.range : 'today';
      const rs = rangeStartTs(range);
      const topups = transactions.filter(t => t.type === 'topup' && t.status === 'success' && scopedUserIds.includes(t.userId));
      const consumes = transactions.filter(t => t.type === 'consume' && t.status === 'success' && scopedUserIds.includes(t.userId));
      const rangeTx = [...topups, ...consumes].filter(t => t.createdAt >= rs);
      const topupTotal = +rangeTx.filter(t => t.type === 'topup').reduce((s, t) => s + t.amount, 0).toFixed(2);
      const consumeTotal = +rangeTx.filter(t => t.type === 'consume').reduce((s, t) => s + t.amount, 0).toFixed(2);
      const trend = buildTrend(range, topups, consumes);
      const myCommissions = commissions.filter(c => ids.includes(c.salesId));
      const scopedTx = transactions.filter(t => scopedUserIds.includes(t.userId)); // 含 refunded, 供风险口径统计
      return J({
        me: { id: me.id, name: me.name, role: me.role, level: me.level },
        stats: {
          range,
          gmv: +(topupTotal + consumeTotal).toFixed(2),
          topupTotal, consumeTotal,
          activeUsers: new Set(scopedTx.filter(t => t.createdAt >= now() - 30 * 864e5).map(t => t.userId)).size, // 近30天有交易
          riskCount: scopedTx.filter(t => t.status === 'refunded' || (t.type === 'consume' && t.amount > 400)).length, // 简单口径: 已退款 或 单笔>$400 消费
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
      ensureCardLedgerAccount(card); // P4.4: 新卡即建账本虚拟账户
      ledgerForMonthlyFee(card, now()); // P4.4: 开户计提一笔卡月费收入
      const cust = customers.find(c => c.userId === u.id); if (cust && ['线索', '意向', '方案'].includes(cust.stage)) cust.stage = '开卡';
      return J({ card });
    }
    if (p.startsWith('/api/admin/cards/') && method === 'PATCH') {
      if (sid !== 1) return J({ error: '仅运营总监可执行冻结/调账' }, 403);
      const card = cards.find(c => c.id === +p.split('/').pop()); if (!card) return J({ error: 'not found' }, 404);
      if (b.action === 'freeze') card.status = (card.status === 'frozen' || card.status === 'lost') ? 'active' : 'frozen'; // 冻结/解冻/解除挂失
      if (b.action === 'adjust') { // 调账: 卡余额与账本对向调整(delta 取卡余额实际增量, 保证账实一致)
        const before = card.balance;
        card.balance = +(card.balance + +b.amount).toFixed(2);
        const adjTx = { id: nid(), type: 'adjust', userId: card.userId, cardId: card.id, amount: +b.amount, fee: 0, method: 'adjust', ref: 'OP-' + ri(10000, 99999), pointsEarned: 0, status: 'success', createdAt: now() };
        transactions.unshift(adjTx);
        ledgerForAdjust(adjTx, card, +(card.balance - before).toFixed(2));
      }
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
      ledgerForRefund(t, now()); // P4.4: 退款反向流水(卡+amt / 商户待结算-(amt-fee) / 手续费-fee), 不冲销历史
      return J({ ok: true });
    }
    if (p === '/api/admin/customers' && method === 'GET') {
      if (q.id) { const c = customers.find(x => x.id === +q.id); return J(pubCustomer(c)); }
      return J(customers.filter(c => ids.includes(c.ownerSalesId)).map(pubCustomer));
    }
    if (p === '/api/admin/customers' && method === 'POST') {
      const dup = customers.find(c => c.contact === b.contact);
      if (dup) return J({ error: `查重: 已存在客户 ${dup.name}(${dup.stage})` }, 409);
      const c = { id: nid(), ...b, stage: '线索', userId: null, tags: [], createdAt: now(), nextFollowAt: now() + 3 * 864e5 };
      customers.unshift(c); return J(c);
    }
    // P1.2 客户全景: 基础资料 + 阶段 + 跟进时间轴 + 关联卡 + 充值/消费 + 积分 + KYC + 佣金贡献(客户不在 scope 子树内 403)
    const mOv = p.match(/^\/api\/admin\/customers\/(\d+)\/overview$/);
    if (mOv) {
      const c = customers.find(x => x.id === +mOv[1]);
      if (!c) return J({ error: '客户不存在' }, 404);
      if (!ids.includes(c.ownerSalesId)) return J({ error: '无权查看该客户(不在你的数据范围内)' }, 403);
      const u = c.userId ? users.find(x => x.id === c.userId) : null;
      const myCards = u ? cards.filter(x => x.userId === u.id).map(x => ({ id: x.id, cardNo: x.cardNo, level: x.level, levelLabel: CARD_LEVELS[x.level].label, balance: x.balance, status: x.status, createdAt: x.createdAt })) : [];
      const txs = u ? transactions.filter(t => t.userId === u.id) : [];
      const topups = txs.filter(t => t.type === 'topup');
      const consumes = txs.filter(t => t.type === 'consume');
      const sumTx = (list) => +list.reduce((a, t) => a + t.amount, 0).toFixed(2);
      const txIdSet = new Set(txs.map(t => t.id));
      const comms = commissions.filter(x => txIdSet.has(x.refId)).sort((a, b) => b.createdAt - a.createdAt);
      return J({
        customer: { ...c, owner: repById(c.ownerSalesId)?.name },
        user: u ? { id: u.id, name: u.name, phone: u.phone, email: u.email, points: u.points, kycLevel: u.kycLevel, kycStatus: u.kycStatus, createdAt: u.createdAt } : null,
        followups: followups.filter(f => f.customerId === c.id).sort((a, b) => b.createdAt - a.createdAt).map(f => ({ ...f, sales: repById(f.salesId)?.name })),
        cards: myCards,
        topup: { total: sumTx(topups), count: topups.length, list: topups.slice(0, 10) },
        consume: { total: sumTx(consumes), count: consumes.length, list: consumes.slice(0, 10) },
        points: { current: u ? u.points : 0, list: u ? pointsLogs.filter(l => l.userId === u.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 10) : [] },
        commission: { total: +comms.reduce((a, x) => a + x.amount, 0).toFixed(2), count: comms.length, list: comms.slice(0, 5).map(pubCommission) },
      });
    }
    if (p === '/api/admin/followups' && method === 'POST') {
      const f = { id: nid(), customerId: +b.customerId, salesId: +b.salesId || sid, type: b.type, content: b.content, nextPlan: b.nextPlan || '', createdAt: now() };
      followups.unshift(f);
      if (b.nextStage) { const c = customers.find(x => x.id === +b.customerId); if (c) c.stage = b.nextStage; }
      return J(f);
    }
    if (p === '/api/admin/performance') return J(perfRows(ids).sort((a, b) => (b.topup + b.consume) - (a.topup + a.consume)));
    if (p === '/api/admin/commissions') return J([...commissions].filter(c => ids.includes(c.salesId) || ids.includes(c.fromSalesId)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 300).map(pubCommission));
    if (p === '/api/admin/commissions/settle' && method === 'POST') { if (sid !== 1) return J({ error: '仅运营总监可结算佣金' }, 403); commissions.forEach(c => { if (c.id === +b.id) { if (c.status !== 'settled') ledgerForCommissionSettle(c, now()); c.status = 'settled'; } }); return J({ ok: true }); }
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
      // P1.4 链路增强: 来源用户/来源卡号(掩码后4位)/每级结算状态/关联单号/路径佣金合计
      const chains = recentChains(ids).map(ch => {
        const tx = transactions.find(t => t.id === ch.txId);
        const card = tx ? cards.find(c => c.id === tx.cardId) : null;
        const no = card ? String(card.cardNo).replace(/\s/g, '') : '';
        const path = commissions.filter(x => x.refId === ch.txId).sort((a, b) => a.tier - b.tier)
          .map(x => ({ salesId: x.salesId, sales: repById(x.salesId)?.name, tier: x.tier, tierLabel: x.tierLabel, rate: x.rate, amount: x.amount, status: x.status, refId: x.refId }));
        return { ...ch, userId: tx?.userId, cardNoMask: no ? '**** **** **** ' + no.slice(-4) : '', path,
          total: +path.reduce((s, x) => s + x.amount, 0).toFixed(2) };
      });
      return J({ rules: COMMISSION, tierLabels: TIER_LABELS, nodes, chains });
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
          ensureCardLedgerAccount(card); // P4.4: 开户即建卡账本账户并计提月费
          ledgerForMonthlyFee(card, now());
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
    // P1.3 目标管理: 四类目标(发卡/充值/消费/积分发放) × 维度(个人/团队子树) × 周期(月/季/年, 目标按倍数放大)
    if (p === '/api/admin/goals') {
      const dim = q.dim === 'team' ? 'team' : 'personal';
      const period = ['month', 'quarter', 'year'].includes(q.period) ? q.period : 'month';
      const mult = period === 'year' ? 12 : period === 'quarter' ? 3 : 1;
      const nD = new Date();
      const periodStart = period === 'year' ? new Date(nD.getFullYear(), 0, 1).getTime()
        : period === 'quarter' ? new Date(nD.getFullYear(), Math.floor(nD.getMonth() / 3) * 3, 1).getTime()
        : new Date(nD.getFullYear(), nD.getMonth(), 1).getTime();
      const inPeriod = (ts) => ts >= periodStart;
      const rate = (done, tgt) => tgt > 0 ? +(done / tgt * 100).toFixed(1) : 0;
      const rows = salesReps.filter(s => ids.includes(s.id) && s.level > 0).map(s => {
        const teamIds = subtreeIds(s.id);
        const aggIds = dim === 'team' ? teamIds : [s.id];
        const uids = users.filter(u => aggIds.includes(u.salesRepId)).map(u => u.id);
        const myTx = transactions.filter(t => uids.includes(t.userId) && t.status === 'success' && inPeriod(t.createdAt));
        const done = {
          cards: cards.filter(c => aggIds.includes(c.salesRepId) && inPeriod(c.createdAt)).length,
          topup: +myTx.filter(t => t.type === 'topup').reduce((a, t) => a + t.amount, 0).toFixed(2),
          consume: +myTx.filter(t => t.type === 'consume').reduce((a, t) => a + t.amount, 0).toFixed(2),
          points: pointsLogs.filter(l => uids.includes(l.userId) && l.delta > 0 && inPeriod(l.createdAt)).reduce((a, l) => a + l.delta, 0),
        };
        const base = s.target || (s.level === 1 ? 120000 : s.level === 2 ? 60000 : 25000);
        const targets = {
          cards: (s.level === 1 ? 20 : s.level === 2 ? 12 : 6) * mult,
          topup: Math.round(base * 0.7 * mult),
          consume: Math.round(base * 0.3 * mult),
          points: Math.round(base * 0.3 * mult * 10),
        };
        const rates = { cards: rate(done.cards, targets.cards), topup: rate(done.topup, targets.topup), consume: rate(done.consume, targets.consume), points: rate(done.points, targets.points) };
        return { id: s.id, name: s.name, role: s.role, level: s.level, region: s.region, teamSize: teamIds.length - 1, baseTarget: base,
          dim, period, targets, done, rates,
          overall: +((rates.cards + rates.topup + rates.consume + rates.points) / 4).toFixed(1) };
      }).sort((a, b) => b.overall - a.overall);
      rows.forEach((r, i) => { r.rank = i + 1; });
      const sumDone = (k) => rows.reduce((a, r) => a + r.done[k], 0);
      const sumTgt = (k) => rows.reduce((a, r) => a + r.targets[k], 0);
      const catRates = ['cards', 'topup', 'consume', 'points'].map(k => rate(sumDone(k), sumTgt(k)));
      return J({
        dim, period, mult, periodStart,
        summary: {
          repCount: rows.length,
          overall: +(catRates.reduce((a, b) => a + b, 0) / catRates.length).toFixed(1),
          rates: { cards: catRates[0], topup: catRates[1], consume: catRates[2], points: catRates[3] },
          done: { cards: sumDone('cards'), topup: +sumDone('topup').toFixed(2), consume: +sumDone('consume').toFixed(2), points: sumDone('points') },
          targets: { cards: sumTgt('cards'), topup: sumTgt('topup'), consume: sumTgt('consume'), points: sumTgt('points') },
          top: rows[0] ? { id: rows[0].id, name: rows[0].name, overall: rows[0].overall } : null,
        },
        rows,
      });
    }
    // ============ P1.5 风控模拟中心 + P1.6 财务对账中心(均总监专属, 其他角色一律 403 防越权) ============
    if (p === '/api/admin/risk' || p.startsWith('/api/admin/risk/') || p.startsWith('/api/admin/finance')) {
      if (sid !== 1) return J({ error: '仅运营总监可访问风控与财务中心' }, 403);
      if (p === '/api/admin/risk') { // ?level=&status= 筛选
        const list = riskEvents.filter(e => (!q.level || e.level === q.level) && (!q.status || e.status === q.status))
          .sort((a, b) => b.createdAt - a.createdAt).map(pubRiskEvent);
        const cnt = (st) => riskEvents.filter(e => e.status === st).length;
        return J({ list, summary: { total: riskEvents.length, pending: cnt('pending'), frozen: cnt('frozen'), reviewed: cnt('reviewed'), released: cnt('released') } });
      }
      const mRiskAct = p.match(/^\/api\/admin\/risk\/(\d+)\/action$/);
      if (mRiskAct && method === 'POST') { // 处置: review=人工复核 / release=解除风控(解冻关联卡) / freeze=自动冻结演示
        const ev = riskEvents.find(e => e.id === +mRiskAct[1]);
        if (!ev) return J({ error: '事件不存在' }, 404);
        const card = cards.find(c => c.id === ev.cardId);
        if (b.action === 'review') {
          ev.status = 'reviewed';
          ev.timeline.push({ ts: now(), node: 'review', label: '人工复核', note: '总监已人工复核本事件', operator: me.name });
        } else if (b.action === 'release') {
          ev.status = 'released';
          if (card && card.status === 'frozen') card.status = 'active'; // 解除风控=解冻关联卡(挂失卡不自动恢复)
          ev.timeline.push({ ts: now(), node: 'release', label: '解除风控', note: '复核通过, 风险解除' + (card && card.status === 'active' ? ', 关联卡已解冻' : ''), operator: me.name });
        } else if (b.action === 'freeze') {
          ev.status = 'frozen';
          if (card && card.status === 'active') card.status = 'frozen';
          ev.timeline.push({ ts: now(), node: 'freeze', label: '自动冻结', note: '手动触发自动冻结动作, 关联卡已冻结', operator: me.name });
        } else return J({ error: '无效动作, 支持 review / release / freeze' }, 400);
        return J({ event: pubRiskEvent(ev) });
      }
      if (p === '/api/admin/risk/rules') {
        return J({ list: riskRules.map(r => ({ ...r, actionLabel: RISK_ACTION_LABEL[r.action] || r.action, levelLabel: RISK_LEVEL_LABEL[r.level] || r.level, hitEvents: riskEvents.filter(e => e.ruleId === r.id).length })) });
      }
      const mRule = p.match(/^\/api\/admin\/risk\/rules\/(\d+)$/);
      if (mRule && method === 'PATCH') { // 规则启停
        const r = riskRules.find(x => x.id === +mRule[1]);
        if (!r) return J({ error: '规则不存在' }, 404);
        if (typeof b.enabled === 'boolean') r.enabled = b.enabled;
        return J({ rule: { ...r, actionLabel: RISK_ACTION_LABEL[r.action] || r.action, levelLabel: RISK_LEVEL_LABEL[r.level] || r.level, hitEvents: riskEvents.filter(e => e.ruleId === r.id).length } });
      }
      if (p === '/api/admin/risk/lists') return J({ list: [...riskLists].sort((a, b) => b.createdAt - a.createdAt) });
      const mList = p.match(/^\/api\/admin\/risk\/lists\/(\d+)\/remove$/);
      if (mList && (method === 'POST' || method === 'DELETE')) { // 名单移除
        const i = riskLists.findIndex(l => l.id === +mList[1]);
        if (i < 0) return J({ error: '名单项不存在' }, 404);
        riskLists.splice(i, 1);
        return J({ ok: true, remain: riskLists.length });
      }
      if (p === '/api/admin/risk/tags') return J({ list: riskTags });
      if (p === '/api/admin/finance/recon') { // ?type=topup|consume|refund 按天分组对账
        const type = RECON_DEFS[q.type] ? q.type : 'topup';
        const groups = reconGroups(type);
        const s = (k) => +groups.reduce((a, g) => a + g[k], 0).toFixed(2);
        return J({ type, typeLabel: RECON_DEFS[type].label, period: financeMeta.period[type], groups,
          summary: { days: groups.length, count: groups.reduce((a, g) => a + g.count, 0), due: s('due'), actual: s('actual'), fee: s('fee'), diff: s('diff'), diffDays: groups.filter(g => g.status === '差异').length } });
      }
      if (p === '/api/admin/finance/diff') { // 差异清单(三类对账中有差异的分组)
        const rows = [];
        Object.keys(RECON_DEFS).forEach(tp => reconGroups(tp).forEach(g => { if (g.status === '差异') rows.push({ type: tp, typeLabel: RECON_DEFS[tp].label, ...g }); }));
        rows.sort((a, b) => (a.day < b.day ? 1 : -1));
        return J({ list: rows, summary: { count: rows.length, totalDiff: +rows.reduce((a, r) => a + r.diff, 0).toFixed(2) } });
      }
      if (p === '/api/admin/finance/merchant') { // 商户结算汇总
        const list = merchantRows();
        const pend = list.filter(r => !r.settled);
        return J({ feeRate: 0.02, period: 'T+2',
          summary: { merchants: list.length, consumeAmt: +list.reduce((a, r) => a + r.consumeAmt, 0).toFixed(2), fee: +list.reduce((a, r) => a + r.fee, 0).toFixed(2), net: +list.reduce((a, r) => a + r.net, 0).toFixed(2), pending: pend.length, pendingNet: +pend.reduce((a, r) => a + r.net, 0).toFixed(2) },
          list });
      }
      const mMer = p.match(/^\/api\/admin\/finance\/merchant\/(.+)$/);
      if (mMer && method === 'PATCH') { // 标记已结算 / 取消结算
        const name = decodeURIComponent(mMer[1]);
        const row = merchantRows().find(r => r.merchant === name);
        if (!row) return J({ error: '商户不存在: ' + name }, 404);
        financeMeta.merchantSettled[name] = b.settled !== false;
        return J({ row: { ...row, settled: financeMeta.merchantSettled[name] } });
      }
      if (p === '/api/admin/finance/report') { // 月度汇总报表
        const nD = new Date();
        const ms = new Date(nD.getFullYear(), nD.getMonth(), 1).getTime();
        const inM = (t) => t.createdAt >= ms;
        const topups = transactions.filter(t => t.type === 'topup' && t.status === 'success' && inM(t));
        const consumes = transactions.filter(t => t.type === 'consume' && t.status === 'success' && inM(t));
        const refunds = transactions.filter(t => t.type === 'consume' && t.status === 'refunded' && inM(t));
        const topupFee = +topups.reduce((s, t) => s + t.fee, 0).toFixed(2);
        const consumeFee = +consumes.reduce((s, t) => s + t.fee, 0).toFixed(2);
        const commissionPaid = +commissions.filter(c => inM(c)).reduce((s, c) => s + c.amount, 0).toFixed(2); // 与交易同口径: 仅当月产生的佣金
        const monthlyFeeIncome = +cards.filter(c => c.status !== 'lost').reduce((s, c) => s + ((CARD_LEVELS[c.level] || {}).monthlyFee || 0), 0).toFixed(2); // 在册卡月费收入
        const reconSummary = Object.keys(RECON_DEFS).map(tp => {
          const gs = reconGroups(tp); const ds = gs.filter(g => g.status === '差异');
          return { type: tp, typeLabel: RECON_DEFS[tp].label, days: gs.length, diffDays: ds.length, diffTotal: +ds.reduce((s, g) => s + g.diff, 0).toFixed(2) };
        });
        const mrs = merchantRows(); const pend = mrs.filter(r => !r.settled);
        return J({ month: nD.getFullYear() + '-' + d2(nD.getMonth() + 1),
          topup: { amount: +topups.reduce((s, t) => s + t.amount, 0).toFixed(2), count: topups.length },
          consume: { amount: +consumes.reduce((s, t) => s + t.amount, 0).toFixed(2), count: consumes.length },
          refund: { amount: +refunds.reduce((s, t) => s + t.amount, 0).toFixed(2), count: refunds.length },
          feeIncome: { topup: topupFee, consume: consumeFee, monthlyFee: monthlyFeeIncome, total: +(topupFee + consumeFee + monthlyFeeIncome).toFixed(2) },
          commissionPaid, netIncome: +(topupFee + consumeFee + monthlyFeeIncome - commissionPaid).toFixed(2),
          recon: reconSummary,
          merchant: { total: mrs.length, pending: pend.length, pendingNet: +pend.reduce((s, r) => s + r.net, 0).toFixed(2) } });
      }
    }
    // ============ P3 系统管理(总监专属, 其他角色一律 403) ============
    if (p.startsWith('/api/admin/sys/')) {
      if (sid !== 1) return J({ error: '仅运营总监可访问系统管理' }, 403);
      const sysOp = (module, action, target, result = '成功') => { // 系统管理自身操作也写入操作日志
        opLogs.unshift({ id: opLogs.length ? Math.max(...opLogs.map(o => o.id)) + 1 : 910100, createdAt: now(), operator: me.name, module, action, target, result });
        if (opLogs.length > 150) opLogs.length = 150;
      };
      if (p === '/api/admin/sys/accounts' && method === 'GET') {
        return J(sysAccounts.map(a => ({ ...a })));
      }
      const mAcct = p.match(/^\/api\/admin\/sys\/accounts\/(\d+)$/);
      if (mAcct && method === 'PATCH') { // 启用/禁用 或 重置密码(演示)
        const a = sysAccounts.find(x => x.id === +mAcct[1]);
        if (!a) return J({ error: '账号不存在' }, 404);
        if (b.resetPwd) {
          sysOp('系统管理', '重置密码', a.username + ' · ' + a.name);
          return J({ ok: true, account: { ...a }, initPwd: 'Ucard@' + String(1000 + a.id).slice(-4) });
        }
        if (typeof b.enabled === 'boolean') {
          a.enabled = b.enabled;
          sysOp('系统管理', b.enabled ? '启用账号' : '禁用账号', a.username + ' · ' + a.name);
          return J({ ok: true, account: { ...a } });
        }
        return J({ error: '无效的修改字段, 支持 enabled / resetPwd' }, 400);
      }
      if (p === '/api/admin/sys/roles' && method === 'GET') {
        return J({ list: sysRoles.map(r => ({ ...r, memberCount: sysAccounts.filter(a => a.roleCode === r.code).length, permCount: (sysPerms[r.code] || []).length })) });
      }
      if (p === '/api/admin/sys/perms' && method === 'GET') { // ?role=角色编码 → 该角色权限树
        const role = sysRoles.find(r => r.code === q.role);
        if (!role) return J({ error: '角色不存在: ' + (q.role || '(未指定)') }, 400);
        return J({ role: { code: role.code, name: role.name, desc: role.desc }, tree: PERM_TREE, checked: sysPerms[role.code] || [], totalKeys: ALL_PERM_KEYS.length });
      }
      if (p === '/api/admin/sys/perms' && method === 'PATCH') { // 保存勾选(内存生效)
        const role = sysRoles.find(r => r.code === b.role);
        if (!role) return J({ error: '角色不存在: ' + (b.role || '(未指定)') }, 400);
        const valid = new Set(ALL_PERM_KEYS);
        const checked = Array.isArray(b.checked) ? b.checked.filter(k => valid.has(k)) : [];
        sysPerms[role.code] = checked;
        sysOp('系统管理', '保存权限', role.name + ' · ' + checked.length + ' 项权限');
        return J({ ok: true, role: role.code, checked, total: ALL_PERM_KEYS.length });
      }
      if (p === '/api/admin/sys/org' && method === 'GET') { // 组织树(含每节点客户数/卡量)
        const lv = (l) => salesReps.filter(s => s.level === l).length;
        return J({ summary: { total: salesReps.length, l1: lv(1), l2: lv(2), l3: lv(3), customers: customers.length, cards: cards.length }, tree: sysOrgTree() });
      }
      if (p === '/api/admin/sys/params' && method === 'GET') {
        return J({ list: sysParams.map(x => ({ ...x })) });
      }
      const mParam = p.match(/^\/api\/admin\/sys\/params\/(.+)$/);
      if (mParam && method === 'PATCH') { // 行内编辑保存
        const key = decodeURIComponent(mParam[1]);
        const prm = sysParams.find(x => x.key === key);
        if (!prm) return J({ error: '参数不存在: ' + key }, 404);
        const v = String(b.value == null ? '' : b.value).trim();
        if (!v) return J({ error: '参数值不能为空' }, 400);
        const oldV = String(prm.value);
        prm.value = v; prm.updatedAt = now();
        sysOp('系统管理', '参数修改', prm.label + ': ' + oldV + ' → ' + v);
        return J({ ok: true, param: { ...prm } });
      }
      if (p === '/api/admin/sys/dicts' && method === 'GET') {
        return J({ list: sysDicts.map(d => ({ ...d, items: d.items.map(i => ({ ...i })) })) });
      }
      const mDict = p.match(/^\/api\/admin\/sys\/dicts\/(\d+)$/);
      if (mDict && method === 'PATCH') { // 字典项启停
        let item = null, owner = null;
        sysDicts.forEach(d => d.items.forEach(i => { if (i.id === +mDict[1]) { item = i; owner = d; } }));
        if (!item) return J({ error: '字典项不存在' }, 404);
        if (typeof b.enabled === 'boolean') {
          item.enabled = b.enabled;
          sysOp('系统管理', b.enabled ? '启用字典项' : '停用字典项', owner.typeLabel + ' / ' + item.value);
        }
        return J({ ok: true, dictType: owner.type, item: { ...item } });
      }
      if (p === '/api/admin/sys/loginlogs' && method === 'GET') {
        return J({ list: [...sysLogs].sort((a, b2) => b2.createdAt - a.createdAt),
          summary: { total: sysLogs.length, ok: sysLogs.filter(l => l.result === '成功').length, fail: sysLogs.filter(l => l.result !== '成功').length, accounts: new Set(sysLogs.map(l => l.username)).size } });
      }
      if (p === '/api/admin/sys/oplogs' && method === 'GET') {
        return J({ list: [...opLogs].sort((a, b2) => b2.createdAt - a.createdAt).slice(0, 100),
          summary: { total: opLogs.length, ok: opLogs.filter(o => o.result === '成功').length, fail: opLogs.filter(o => o.result !== '成功').length } });
      }
      return J({ error: 'not found: ' + p }, 404);
    }
    // ============ P4.1 多租户 / P4.5 开放平台 / P4.6 消息中心 (平台管理员=总监专属, 其余角色一律 403) ============
    if (p.startsWith('/api/admin/tenants')) {
      if (sid !== 1) return J({ error: '仅平台管理员(总监)可访问多租户管理' }, 403);
      if (p === '/api/admin/tenants') {
        const cnt = (st) => tenants.filter(t => t.status === st).length;
        return J({ list: tenants.map(pubTenant),
          summary: { total: tenants.length, active: cnt('active'), trial: cnt('trial'), pending: cnt('pending'), frozen: cnt('frozen'),
            gmv: +tenants.reduce((s, t) => s + t.isolation.gmv, 0).toFixed(2), users: tenants.reduce((s, t) => s + t.isolation.users, 0) } });
      }
      const mTn = p.match(/^\/api\/admin\/tenants\/(\d+)$/);
      if (mTn && method === 'PATCH') { // 状态流转(审核/冻结/解冻) 或 租户配置字段保存
        const t = tenants.find(x => x.id === +mTn[1]);
        if (!t) return J({ error: '租户不存在' }, 404);
        if (b.status) {
          if (!TENANT_STATUS_LABEL[b.status]) return J({ error: '无效的租户状态: ' + b.status }, 400);
          if (t.isMain && b.status !== 'active') return J({ error: '主租户不可冻结或变更状态' }, 400);
          t.status = b.status;
        }
        ['domain', 'currency', 'locale', 'timezone', 'brandColor'].forEach(k => { if (b[k] != null) t[k] = String(b[k]).slice(0, 120); });
        if (b.commission) ['topup', 'consume', 'card'].forEach(k => {
          const arr = b.commission[k];
          if (Array.isArray(arr) && arr.length === 3) t.commission[k] = arr.map(v => Math.max(0, +v || 0));
        });
        return J({ tenant: pubTenant(t) });
      }
      return J({ error: 'not found: ' + p }, 404);
    }
    if (p.startsWith('/api/admin/open/')) {
      if (sid !== 1) return J({ error: '仅平台管理员(总监)可访问开放平台' }, 403);
      if (p === '/api/admin/open/apps') {
        return J({ list: openApps.map(a => ({ ...a,
          keyCount: openKeys.filter(k => k.appId === a.id && k.status === 'active').length,
          hookCount: openWebhooks.filter(w => w.appId === a.id).length })) });
      }
      const mApp = p.match(/^\/api\/admin\/open\/apps\/(\d+)$/);
      if (mApp && method === 'PATCH') { // 应用启停
        const a = openApps.find(x => x.id === +mApp[1]);
        if (!a) return J({ error: '应用不存在' }, 404);
        if (typeof b.enabled === 'boolean') a.enabled = b.enabled;
        return J({ app: { ...a } });
      }
      if (p === '/api/admin/open/keys') { // 密钥列表(Secret 服务端掩码, 不回传明文)
        return J({ list: openKeys.map(k => ({ id: k.id, appId: k.appId, appName: (openApps.find(a => a.id === k.appId) || {}).name || '—',
          secretMask: maskSecret(k.appSecret), scopes: k.scopes, status: k.status, lastUsedAt: k.lastUsedAt, expireAt: k.expireAt, createdAt: k.createdAt })) });
      }
      const mKey = p.match(/^\/api\/admin\/open\/keys\/(\d+)\/revoke$/);
      if (mKey && method === 'POST') { // 密钥吊销
        const k = openKeys.find(x => x.id === +mKey[1]);
        if (!k) return J({ error: '密钥不存在' }, 404);
        if (k.status === 'revoked') return J({ error: '该密钥已处于吊销状态' }, 400);
        k.status = 'revoked';
        return J({ ok: true, key: { ...k, secretMask: maskSecret(k.appSecret) } });
      }
      if (p === '/api/admin/open/webhooks') {
        return J({ list: openWebhooks.map(w => ({ ...w, appName: (openApps.find(a => a.id === w.appId) || {}).name || '—' })) });
      }
      const mWh = p.match(/^\/api\/admin\/open\/webhooks\/(\d+)\/test$/);
      if (mWh && method === 'POST') { // 测试推送: 追加一条成功推送记录
        const w = openWebhooks.find(x => x.id === +mWh[1]);
        if (!w) return J({ error: 'Webhook 配置不存在' }, 404);
        const push = { id: (w.pushes.length ? Math.max(...w.pushes.map(x => x.id)) : 0) + 1, at: now(), status: 'success', httpCode: 200, ms: ri(60, 420) };
        w.pushes.unshift(push);
        if (w.pushes.length > 20) w.pushes.length = 20;
        w.lastPush = { status: 'success', httpCode: 200, at: now() };
        w.pushCount++;
        return J({ ok: true, webhook: { ...w, appName: (openApps.find(a => a.id === w.appId) || {}).name || '—' }, push });
      }
      if (p === '/api/admin/open/apilogs') { // 近 100 条调用日志
        const list = [...openApiLogs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
        const ok = openApiLogs.filter(l => l.status === 200).length;
        return J({ list, summary: { total: openApiLogs.length, ok, fail: openApiLogs.length - ok,
          avgMs: Math.round(openApiLogs.reduce((s, l) => s + l.ms, 0) / Math.max(1, openApiLogs.length)) } });
      }
      return J({ error: 'not found: ' + p }, 404);
    }
    if (p.startsWith('/api/admin/notify/')) {
      if (sid !== 1) return J({ error: '仅平台管理员(总监)可访问消息中心' }, 403);
      if (p === '/api/admin/notify/templates') {
        return J({ list: notifyTemplates.map(t => ({ ...t, channelName: (notifyChannels.find(c => c.key === t.channel) || {}).name || t.channel })),
          channels: notifyChannels.map(c => ({ key: c.key, name: c.name })) });
      }
      const mTpl = p.match(/^\/api\/admin\/notify\/templates\/(\d+)$/);
      if (mTpl && method === 'PATCH') { // 模板启停
        const t = notifyTemplates.find(x => x.id === +mTpl[1]);
        if (!t) return J({ error: '模板不存在' }, 404);
        if (typeof b.enabled === 'boolean') { t.enabled = b.enabled; t.updatedAt = now(); }
        return J({ template: { ...t } });
      }
      if (p === '/api/admin/notify/sends') { // 近 100 条发送记录
        const list = [...notifySends].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
          .map(s => ({ ...s, channelName: (notifyChannels.find(c => c.key === s.channel) || {}).name || s.channel }));
        const cnt = (st) => notifySends.filter(s => s.status === st).length;
        const okN = cnt('success'), totalN = notifySends.length;
        return J({ list, summary: { total: totalN, success: okN, failed: cnt('failed'), retrying: cnt('retrying'), rate: totalN ? Math.round(okN / totalN * 1000) / 10 : 0 } });
      }
      const mSnd = p.match(/^\/api\/admin\/notify\/sends\/(\d+)\/retry$/);
      if (mSnd && method === 'POST') { // 失败重发: 状态翻成功
        const s = notifySends.find(x => x.id === +mSnd[1]);
        if (!s) return J({ error: '发送记录不存在' }, 404);
        if (s.status !== 'failed' && s.status !== 'retrying') return J({ error: '仅失败/重试中的记录可重发' }, 400);
        s.status = 'success'; s.attempts = (s.attempts || 1) + 1; s.ms = ri(60, 900); s.retriedAt = now();
        return J({ ok: true, send: { ...s, channelName: (notifyChannels.find(c => c.key === s.channel) || {}).name || s.channel } });
      }
      if (p === '/api/admin/notify/channels') {
        return J({ list: notifyChannels.map(c => ({ ...c, sends: notifySends.filter(s => s.channel === c.key).length })) });
      }
      const mCh = p.match(/^\/api\/admin\/notify\/channels\/([a-z]+)$/);
      if (mCh && method === 'PATCH') { // 渠道启停 / 配置编辑(内存)
        const c = notifyChannels.find(x => x.key === mCh[1]);
        if (!c) return J({ error: '渠道不存在: ' + mCh[1] }, 404);
        if (typeof b.enabled === 'boolean') c.enabled = b.enabled;
        if (b.config && typeof b.config === 'object') Object.keys(b.config).forEach(k => { c.config[k] = String(b.config[k]).slice(0, 160); });
        return J({ channel: { ...c } });
      }
      return J({ error: 'not found: ' + p }, 404);
    }
    // ============ P4.4 资金账本(总监专属, 其他角色一律 403) ============
    if (p.startsWith('/api/admin/ledger')) {
      if (sid !== 1) return J({ error: '仅运营总监可访问资金账本' }, 403);
      const frozenOf = (key) => lgR2(frozenBalances.filter(f => f.accountKey === key && f.status === 'frozen').reduce((s, f) => s + f.amount, 0));
      if (p === '/api/admin/ledger/accounts') {
        const TYPE_ORDER = ['channel', 'card', 'merchant', 'income', 'expense'];
        const list = ledgerAccounts.map(a => {
          const es = ledgerEntries.filter(e => e.accountKey === a.key);
          return { key: a.key, type: a.type, typeLabel: LEDGER_TYPE_LABEL[a.type] || a.type, name: a.name, balance: a.balance,
            frozen: frozenOf(a.key), entryCount: es.length, recentCount: es.filter(e => e.createdAt >= now() - 7 * 864e5).length,
            lastEntryAt: es.length ? Math.max(...es.map(e => e.createdAt)) : null };
        }).sort((a, b) => (TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)) || (b.balance - a.balance));
        const byType = {};
        ledgerAccounts.forEach(a => { byType[a.type] = lgR2((byType[a.type] || 0) + a.balance); });
        return J({ list, summary: { accounts: ledgerAccounts.length, entries: ledgerEntries.length, byType,
          frozenTotal: lgR2(frozenBalances.filter(f => f.status === 'frozen').reduce((s, f) => s + f.amount, 0)) } });
      }
      if (p === '/api/admin/ledger/entries') { // ?account=&type=&days=
        const days = parseInt(q.days, 10) || 0;
        const since = days > 0 ? now() - days * 864e5 : 0;
        const accByKey = new Map(ledgerAccounts.map(a => [a.key, a]));
        const list = ledgerEntries
          .filter(e => {
            const a = accByKey.get(e.accountKey);
            return (!q.account || e.accountKey === q.account) && (!q.type || (a && a.type === q.type)) && e.createdAt >= since;
          })
          .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
          .slice(0, 500)
          .map(e => { const a = accByKey.get(e.accountKey); return { ...e, accountName: a ? a.name : e.accountKey, accountType: a ? a.type : '', typeLabel: a ? (LEDGER_TYPE_LABEL[a.type] || a.type) : '' }; });
        return J({ list, summary: { count: list.length,
          debitTotal: lgR2(list.filter(e => e.dir === 'debit').reduce((s, e) => s + e.amount, 0)),
          creditTotal: lgR2(list.filter(e => e.dir === 'credit').reduce((s, e) => s + e.amount, 0)),
          filters: { account: q.account || '', type: q.type || '', days: days || 'all' } } });
      }
      if (p === '/api/admin/ledger/snapshots') { // 14 天每日每账户快照聚合 + 今日实时重算 + 冻结余额
        const accByKey = new Map(ledgerAccounts.map(a => [a.key, a]));
        const daysArr = [...new Set(balanceSnapshots.map(s => s.day))].sort();
        const aggRow = (day, m) => {
          const row = { day, channel: 0, card: 0, merchant: 0, income: 0, expense: 0 };
          m.forEach((bal, key) => { const a = accByKey.get(key); if (a) row[a.type] = lgR2(row[a.type] + bal); });
          row.total = lgR2(row.channel + row.card + row.merchant + row.income + row.expense);
          return row;
        };
        const rows = daysArr.map(day => {
          const m = new Map();
          balanceSnapshots.filter(s => s.day === day).forEach(s => m.set(s.accountKey, s.balance));
          return aggRow(day, m);
        });
        const curMap = new Map(ledgerAccounts.map(a => [a.key, a.balance]));
        const cur = aggRow(isoDay(now()), curMap);
        const ti = rows.findIndex(r => r.day === cur.day);
        if (ti >= 0) rows[ti] = cur; else rows.push(cur);
        return J({ rows, current: cur,
          frozen: frozenBalances.map(f => ({ ...f, accountName: (accByKey.get(f.accountKey) || {}).name || f.accountKey })),
          frozenTotal: lgR2(frozenBalances.filter(f => f.status === 'frozen').reduce((s, f) => s + f.amount, 0)),
          detailToday: balanceSnapshots.filter(s => s.day === isoDay(now())) });
      }
      if (p === '/api/admin/ledger/verify') return J(verifyLedger());
      return J({ error: 'not found: ' + p }, 404);
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
    if (p === '/api/app/products') { // P2.3: 返回商品(含限购/评分) + 分类列表
      const on = products.filter(pr => pr.status === 'on').map(pr => ({ ...pr, limitPerUser: productLimit(pr), rating: productRating(pr.id) }));
      return J({ products: on, categories: ['全部', ...new Set(on.map(pr => pr.category))] });
    }
    if (p === '/api/app/redeem' && method === 'POST') return J(doRedeem(uid, +b.id));
    if (p === '/api/app/orders') { const u = me(); if (!u) return J({ error: '未登录' }, 401); return J(orders.filter(o => o.userId === uid).map(pubOrder)); }
    // P2.3 订单动作: 取消(退分+回补库存) / 售后 / 评价
    if (p === '/api/app/orders/cancel' && method === 'POST') {
      const u = me(); if (!u) return J({ error: '未登录' }, 401);
      const o = orders.find(x => x.id === +b.id && x.userId === uid); if (!o) return J({ error: '订单不存在' }, 404);
      if (o.status !== 'pending') return J({ error: '仅待发货的实物订单可取消' }, 400);
      o.status = 'cancelled';
      const pr = products.find(x => x.id === o.productId); if (pr) pr.stock++; // 库存回补
      addPointsLog(uid, o.pointsCost, '订单取消退回', o.id, now()); // 积分退回
      return J({ ok: true, order: pubOrder(o) });
    }
    if (p === '/api/app/orders/aftersale' && method === 'POST') {
      const u = me(); if (!u) return J({ error: '未登录' }, 401);
      const o = orders.find(x => x.id === +b.id && x.userId === uid); if (!o) return J({ error: '订单不存在' }, 404);
      if (o.status !== 'shipped' && o.status !== 'redeemed') return J({ error: '当前状态的订单不可申请售后' }, 400);
      o.status = 'aftersale';
      o.aftersale = { no: 'AS-' + ri(100000, 999999), type: b.type || '退货退款', reason: String(b.reason || '').slice(0, 200), appliedAt: now() };
      return J({ ok: true, order: pubOrder(o) });
    }
    if (p === '/api/app/orders/review' && method === 'POST') {
      const u = me(); if (!u) return J({ error: '未登录' }, 401);
      const o = orders.find(x => x.id === +b.id && x.userId === uid); if (!o) return J({ error: '订单不存在' }, 404);
      if (o.status !== 'redeemed') return J({ error: '订单完成后才能评价' }, 400);
      if (o.review) return J({ error: '该订单已评价过' }, 400);
      const stars = Math.min(5, Math.max(1, Math.round(+b.stars) || 5));
      o.review = { stars, text: String(b.text || '').slice(0, 200), createdAt: now() };
      return J({ ok: true, order: pubOrder(o) });
    }
    if (p === '/api/app/points') { const u = me(); if (!u) return J({ error: '未登录' }, 401); return J(pointsLogs.filter(l => l.userId === uid).slice(0, 50)); }
    if (p === '/api/app/points/summary') { const u = me(); if (!u) return J({ error: '未登录' }, 401); return J(pointsSummary(uid)); }
    if (p === '/api/app/invite') { const u = me(); if (!u) return J({ error: '未登录' }, 401);
      const invited = users.filter(x => x.invitedBy === uid);
      return J({ code: 'UC' + String(uid).padStart(4, '0') + String(ri(100, 999)), link: `https://u-card.app/i/UC${String(uid).padStart(4, '0')}`, invited: invited.map(x => ({ name: x.name, at: x.createdAt, reward: 800 })), totalReward: invited.length * 800 });
    }
    if (p === '/api/app/kyc' && method === 'POST') { const u = me(); u.kycStatus = 'pending_upgrade'; return J({ ok: true }); }
    // P2.1 安全设置: 修改密码 Demo(仅校验非空+两次一致, 不真鉴权)
    if (p === '/api/app/password' && method === 'POST') {
      const u = me(); if (!u) return J({ error: '未登录' }, 401);
      const oldP = String(b.oldPassword || ''), n1 = String(b.newPassword || ''), n2 = String(b.newPassword2 || '');
      if (!oldP || !n1) return J({ error: '请填写旧密码与新密码' }, 400);
      if (n1 !== n2) return J({ error: '两次输入的新密码不一致' }, 400);
      return J({ ok: true });
    }
    // P2.1 消息通知: 种子+事件通知(交易/系统/营销), 点击标记已读
    if (p === '/api/app/notifications') { const u = me(); if (!u) return J({ error: '未登录' }, 401); return J(appNotificationsFor(uid)); }
    if (p === '/api/app/notifications/read' && method === 'POST') {
      const u = me(); if (!u) return J({ error: '未登录' }, 401);
      const read = notifRead[uid] || (notifRead[uid] = {});
      const r = appNotificationsFor(uid);
      if (b.all) r.list.forEach(n => { read[n.id] = true; });
      else if (b.id) read[b.id] = true;
      const after = appNotificationsFor(uid);
      return J({ ok: true, unread: after.unread });
    }
    return J({ error: 'not found' }, 404);
  }

  // ============ P4.5 开放平台 mock 接口(接口文档「在线调试」真实可调; AppKey 鉴权, 不动真实账本) ============
  if (p.startsWith('/api/open/')) {
    const appKey = h['x-app-key'] || h['X-App-Key'] || '';
    const app = openApps.find(a => a.appKey === appKey);
    if (!app) return J({ error: '401 Unauthorized: 无效的 x-app-key, 请在「开放平台 → 应用管理」获取启用的 AppKey' }, 401);
    if (!app.enabled) return J({ error: '403 Forbidden: 应用已停用, 拒绝访问' }, 403);
    const mock = p.slice('/api/open/'.length);
    const def = OPEN_MOCKS[mock];
    if (!def) {
      logOpenApi(app.appKey, p, method, 404, ri(4, 18), h['x-forwarded-for']);
      return J({ error: '404 Not Found: 未知的开放接口: /api/open/' + mock, available: Object.keys(OPEN_MOCKS) }, 404);
    }
    const data = def.data(b || {});
    const ms = ri(16, 180);
    app.todayCalls++; app.totalCalls++;
    logOpenApi(app.appKey, p, method, 200, ms, h['x-forwarded-for']);
    return J({ ok: true, endpoint: mock, label: def.label, app: app.name, latencyHint: ms + 'ms', data });
  }
  return null; // 非 API
}
