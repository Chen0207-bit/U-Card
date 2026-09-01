/**
 * 优卡 U-Card Demo — 业务核心 (node 本地 / Cloudflare Worker 共用, ESM)
 * 数据模型 + 种子数据 + 业务动作 + legacy API 路由；运行壳层负责持久化快照。
 */
import { createVersionedSnapshot, validateVersionedSnapshot } from './src/state/snapshot-codec.js';
import { transitionCardStatus } from './src/domain/card/card-state-machine.js';
import { createTenantService } from './src/domain/tenant/tenant-service.js';
import { createOpenPlatformService } from './src/domain/open-platform/open-platform-service.js';
import { createNotificationService } from './src/domain/notification/notification-service.js';
import { createSystemService } from './src/domain/system/system-service.js';
import { createOpsManagementService } from './src/domain/ops/ops-management-service.js';
import { createMerchantPortalService } from './src/domain/merchant/merchant-portal-service.js';
import { createAppUserService } from './src/domain/app/app-user-service.js';
import { createOpenApiMockService } from './src/domain/open-api/open-api-mock-service.js';
import { createFinanceReconciliationService } from './src/domain/finance/finance-reconciliation-service.js';
import { createLedgerService } from './src/domain/ledger/ledger-service.js';
import { createBasicOperationsService } from './src/domain/admin/basic-operations-service.js';
import { createCrmService } from './src/domain/crm/crm-service.js';
import { createAdminShopService } from './src/domain/shop/admin-shop-service.js';
import { createComplianceService } from './src/domain/compliance/compliance-service.js';
import { createBiService } from './src/domain/bi/bi-service.js';
import { createMerchantAdminPlatformService } from './src/domain/merchant/merchant-admin-platform-service.js';
import { createApprovalService } from './src/domain/approval/approval-service.js';
import { createRiskEngineService } from './src/domain/risk/risk-engine-service.js';
import { createEnterpriseService } from './src/domain/enterprise/enterprise-service.js';
import { createPaymentOrchestrationService } from './src/domain/orchestration/payment-orchestration-service.js';
import { createClassicRiskService } from './src/domain/risk/classic-risk-service.js';

/**
 * 创建一个彼此隔离的业务状态容器。
 * 所有数组、计数器和业务函数都封闭在实例内，Node、测试和每个 Durable Object
 * 必须显式持有自己的 runtime，避免模块单例导致跨实例串数据。
 */
export function createCoreRuntime() {

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
let approvals; // P4.2 审批中心: 5 类流程实例(发卡/KYC升级/退款/佣金结算/调账), 节点支持或签/会签
let engineRules, engineHits, engineVersions; // P4.3 风控规则引擎: 结构化规则 / 命中记录 / 策略版本
let orchAdapters, orchTxs, orchHealthLog, orchWebhookLogs, orchReconFixed; // P5.1 支付编排: 适配器注册表 / 编排交易 / 健康探测日志 / 出站通知记录 / 对账已处理差异
let kybCases, sanctions, peps, strReports, userDocs, compCases, countryRules; // P5.2 合规中心: KYB / 制裁名单 / PEP / STR / 证件 / 合规案件 / 国家政策
let entAccounts, entMembers, entDepts, entCards, entTxApprovals, entBills, entDeptLogs; // P5.3 企业服务: 企业 / 成员 / 部门成本中心 / 企业卡 / 消费审批 / 账单发票 / 预算变更历史
let mchAccounts, mchOrders, mchRefunds, mchSettles, mchSplits, mchRisk; // P5.4 商户平台: 收单商户 / 收款订单 / 退款单 / 结算批次 / 订单分账 / 商户风控
let ffFlags, opsRateCfg, rlBuckets; // P5.6 运维中心: Feature Flag 开关 / 限流配置 / 内存令牌桶(演示级限流计数器)
let inited = false;
let demoSeededAt = 0, demoRestoreCount = 0, demoLastAction = 'cold_start', demoSeedReason = 'cold_start';
function initSeed() {
  seed = 42;
  idSeq = 1000;
  notifRead = {};
  demoSeededAt = now();
  demoRestoreCount += 1;
  demoLastAction = demoSeedReason;
  demoSeedReason = 'cold_start';
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

// ---------------- P4.2 审批中心种子: 5 类流程 × 混合状态 ----------------
// 节点 mode: '或签'=任一审批人通过即过 / '会签'=全部审批人都通过才过; acts 记录审批动作(含代签演示)
const apNode = (name, mode, approvers, state, acts) => ({ key: name, name, mode: mode || '或签', approvers, state: state || 'waiting', acts: acts || [] });
const apAct = (name, verdict, note, ts) => ({ name, verdict, note: note || '', ts });
const AP_TYPES = {
  card_issue:       '发卡申请', kyc_upgrade: 'KYC 升级', refund: '退款申请',
  commission_settle: '佣金结算', adjust: '调账申请',
};
const doneNodes = (defs) => defs.map(d => apNode(d[0], d[1], d[2], 'done', d[3] || []));
const refTx = (pred) => transactions.find(pred); // 取一笔种子交易做退款申请载体
approvals = [];
// 发卡申请 ×4: 待办(超时) / 待办(新) / 已通过 / 已驳回
approvals.push(
  { id: nid(), type: 'card_issue', title: 'Aisha Abdullah 增发 Platinum 白金卡', bizRef: '客户持有 Gold 卡, 因商旅需求申请增发', amount: 15,
    payload: { userId: 4, level: 'platinum' }, applicant: 'Layla Al-Saad', applicantId: 20, applyNote: '客户月均消费 $4,200, 已补充收入证明',
    status: 'pending', nodes: [apNode('运营审核', '或签', ['Noura Al-Faisal'], 'active', [])],
    createdAt: daysAgo(3, 4), updatedAt: daysAgo(3, 4), finishedAt: null, resultNote: '' },
  { id: nid(), type: 'card_issue', title: 'Hassan Ali 首卡 Gold 金卡', bizRef: '新开户客户首卡(KYC L0 → 提交升级材料中)', amount: 5,
    payload: { userId: 7, level: 'gold' }, applicant: 'Majed Al-Ghamdi', applicantId: 36, applyNote: '随 KYC 升级一并申请首卡',
    status: 'pending', nodes: [apNode('运营审核', '或签', ['Noura Al-Faisal'], 'active', [])],
    createdAt: daysAgo(0, 5), updatedAt: daysAgo(0, 5), finishedAt: null, resultNote: '' },
  { id: nid(), type: 'card_issue', title: 'Ali Al-Mansouri 增发 Standard 标准卡', bizRef: '客户申请副卡给家属使用', amount: 1,
    payload: { userId: 9, level: 'standard' }, applicant: 'Iman Fathi', applicantId: 38, applyNote: '主卡使用正常, 副卡限额消费',
    status: 'approved', nodes: doneNodes([['运营审核', '或签', ['Noura Al-Faisal'], [apAct('Noura Al-Faisal', 'approve', '资料齐全, 同意发卡', daysAgo(6, 2))]]]),
    createdAt: daysAgo(6, 5), updatedAt: daysAgo(6, 2), finishedAt: daysAgo(6, 2), resultNote: '已发卡(Standard), 发卡佣金已计入, 月费已计提' },
  { id: nid(), type: 'card_issue', title: 'Zainab Ibrahim 增发 Gold 金卡', bizRef: '申请主体与客户资料姓名不一致', amount: 5,
    payload: { userId: 10, level: 'gold' }, applicant: 'Bakr Al-Marri', applicantId: 39, applyNote: '客户自称代亲属申请',
    status: 'rejected', nodes: doneNodes([['运营审核', '或签', ['Noura Al-Faisal'], [apAct('Noura Al-Faisal', 'reject', '申请主体与客户资料不符, 驳回后请补充授权书', daysAgo(4, 1))]]]),
    createdAt: daysAgo(4, 6), updatedAt: daysAgo(4, 1), finishedAt: daysAgo(4, 1), resultNote: '驳回于「运营审核」: 申请主体与客户资料不符' }
);
// KYC 升级 ×2: 待办 / 已驳回
approvals.push(
  { id: nid(), type: 'kyc_upgrade', title: 'Mohammed Al-Mutairi KYC L1 → L2', bizRef: '护照 + 地址证明 + 银行流水', amount: null,
    payload: { userId: 3, toLevel: 2 }, applicant: 'Saad Al-Dosari', applicantId: 32, applyNote: '客户提额需求: 单笔限额 $1,000 → $10,000',
    status: 'pending', nodes: [apNode('风控审核', '或签', ['Noura Al-Faisal'], 'active', [])],
    createdAt: daysAgo(1, 3), updatedAt: daysAgo(1, 3), finishedAt: null, resultNote: '' },
  { id: nid(), type: 'kyc_upgrade', title: 'Omar Farouk KYC L0 → L1', bizRef: '国民 ID + 自拍照', amount: null,
    payload: { userId: 11, toLevel: 1 }, applicant: 'Bakr Al-Marri', applicantId: 40, applyNote: 'L0 限额过低, 客户申请升级',
    status: 'rejected', nodes: doneNodes([['风控审核', '或签', ['Noura Al-Faisal'], [apAct('Noura Al-Faisal', 'reject', '证件照片模糊无法核验, 请重传', daysAgo(2, 2))]]]),
    createdAt: daysAgo(2, 8), updatedAt: daysAgo(2, 2), finishedAt: daysAgo(2, 2), resultNote: '驳回于「风控审核」: 证件照片模糊无法核验' }
);
// 退款申请 ×3: 待办 / 已通过(历史退款) / 已撤回
approvals.push(
  (() => { const t = refTx(x => x.type === 'consume' && x.status === 'success' && x.userId === 1); return {
    id: nid(), type: 'refund', title: 'Ahmed Al-Rashid 退款 · ' + ((t || {}).merchant || '商户'), bizRef: '交易 #' + ((t || {}).id || '—') + ' · 与商户协商未果申请平台退款',
    amount: (t || {}).amount || 0, payload: { txId: (t || {}).id }, applicant: 'Tariq Al-Harbi', applicantId: 30, applyNote: '客户称重复扣款, 提供了商户回复截图',
    status: 'pending', nodes: [apNode('财务审核', '或签', ['Noura Al-Faisal'], 'active', [])],
    createdAt: daysAgo(0, 8), updatedAt: daysAgo(0, 8), finishedAt: null, resultNote: '' }; })(),
  (() => { const t = refTx(x => x.type === 'consume' && x.status === 'refunded'); return {
    id: nid(), type: 'refund', title: (users[(t || {}).userId - 1] || { name: '客户' }).name + ' 退款 · ' + ((t || {}).merchant || '商户'), bizRef: '交易 #' + ((t || {}).id || '—') + ' · 商品未按约定发货',
    amount: (t || {}).amount || 0, payload: { txId: (t || {}).id }, applicant: 'Rania Sameer', applicantId: 33, applyNote: '商户超期未发货, 客户提供聊天记录',
    status: 'approved', nodes: doneNodes([['财务审核', '或签', ['Noura Al-Faisal'], [apAct('Noura Al-Faisal', 'approve', '证据充分, 同意全额退款', daysAgo(7, 3))]]]),
    createdAt: daysAgo(7, 6), updatedAt: daysAgo(7, 3), finishedAt: daysAgo(7, 3), resultNote: '交易已全额退款, 反向分录已入账' }; })(),
  { id: nid(), type: 'refund', title: 'Mariam Al-Zahrani 退款 · Namshi', bizRef: '交易退货申请 · 客户撤回', amount: 89.9,
    payload: { txId: null }, applicant: 'Dalia Kamel', applicantId: 37, applyNote: '客户申请尺码不对退货退款',
    status: 'cancelled', nodes: [apNode('财务审核', '或签', ['Noura Al-Faisal'], 'waiting', [])],
    createdAt: daysAgo(5, 2), updatedAt: daysAgo(4, 9), finishedAt: daysAgo(4, 9), resultNote: '发起人撤回: 客户与商户自行协商解决' }
);
// 佣金结算 ×2: 待办 / 已通过
approvals.push(
  (() => { const pend = commissions.filter(c => c.salesId === 20 && c.status === 'pending'); return {
    id: nid(), type: 'commission_settle', title: 'Layla Al-Saad 团队半月佣金打款', bizRef: '待结算佣金 ' + pend.length + ' 笔(直属+团队)',
    amount: +pend.reduce((s, c) => s + c.amount, 0).toFixed(2), payload: { salesId: 20 }, applicant: 'Layla Al-Saad', applicantId: 20, applyNote: '2026-09 上半月佣金, 请财务确认打款',
    status: 'pending', nodes: [apNode('财务确认', '或签', ['Noura Al-Faisal'], 'active', [])],
    createdAt: daysAgo(0, 3), updatedAt: daysAgo(0, 3), finishedAt: null, resultNote: '' }; })(),
  { id: nid(), type: 'commission_settle', title: 'Omar Hassan 团队半月佣金打款', bizRef: 'T+3 佣金账期已到',
    amount: 286.4, payload: { salesId: 10 }, applicant: 'Omar Hassan', applicantId: 10, applyNote: '8 月下半月佣金, 已与业绩核对一致',
    status: 'approved', nodes: doneNodes([['财务确认', '或签', ['Noura Al-Faisal'], [apAct('Noura Al-Faisal', 'approve', '与业绩报表核对一致, 同意打款', daysAgo(9, 1))]]]),
    createdAt: daysAgo(9, 4), updatedAt: daysAgo(9, 1), finishedAt: daysAgo(9, 1), resultNote: '待结算佣金已批量打款, 渠道出金分录已入账' }
);
// 调账申请 ×3: 待办(或签多级) / 待办(会签, 已批 1/2) / 已通过 —— 或签/会签对照演示
approvals.push(
  { id: nid(), type: 'adjust', title: '卡账户补偿 +$200 · 重复扣款', bizRef: '客户卡 ' + (cards[2] ? maskCardNo(cards[2].cardNo) : '—') + ' · 系统重复扣款补偿',
    amount: 200, payload: { cardId: 3, amount: 200, ref: '重复扣款补偿' }, applicant: 'Saad Al-Dosari', applicantId: 31, applyNote: '渠道对账发现重复扣款一笔, 申请补偿入卡',
    status: 'pending', nodes: [
      apNode('运营初审', '或签', ['Noura Al-Faisal'], 'done', [apAct('Noura Al-Faisal', 'approve', '对账差异清单已核实, 属渠道重复扣款', daysAgo(1, 5))]),
      apNode('财务复审', '或签', ['Khalid Al-Suwaidi', 'Sara Ahmed'], 'active', []),
    ],
    createdAt: daysAgo(1, 8), updatedAt: daysAgo(1, 5), finishedAt: null, resultNote: '' },
  { id: nid(), type: 'adjust', title: '卡账户追回 -$150 · 优惠券重复核销', bizRef: '客户卡 ' + (cards[7] ? maskCardNo(cards[7].cardNo) : '—') + ' · 营销优惠重复享受需追回',
    amount: -150, payload: { cardId: 8, amount: -150, ref: '优惠券重复核销追回' }, applicant: 'Dalia Kamel', applicantId: 37, applyNote: '客户分两次使用同一张满减券, 需追回多享优惠',
    status: 'pending', nodes: [
      apNode('风控合规会签', '会签', ['Noura Al-Faisal', 'Mona Sharif'], 'active', [apAct('Noura Al-Faisal', 'approve', '核实为系统漏洞导致重复核销, 同意追回', daysAgo(2, 3))]),
    ],
    createdAt: daysAgo(2, 6), updatedAt: daysAgo(2, 3), finishedAt: null, resultNote: '' },
  { id: nid(), type: 'adjust', title: '卡账户补偿 +$120 · 退款未到账', bizRef: '商户已退款但卡账户未入账',
    amount: 120, payload: { cardId: 5, amount: 120, ref: '退款未到账补偿' }, applicant: 'Amira Zaki', applicantId: 35, applyNote: '商户回执已退款, 卡账户漏入账',
    status: 'approved', nodes: doneNodes([
      ['运营初审', '或签', ['Noura Al-Faisal'], [apAct('Noura Al-Faisal', 'approve', '商户回执核实无误', daysAgo(8, 4))]],
      ['财务复审', '或签', ['Khalid Al-Suwaidi', 'Sara Ahmed'], [apAct('Khalid Al-Suwaidi', 'approve', '同意补偿, 或签节点一人通过即生效', daysAgo(8, 1))]],
    ]),
    createdAt: daysAgo(8, 6), updatedAt: daysAgo(8, 1), finishedAt: daysAgo(8, 1), resultNote: '调账已执行 +$120.00, 卡余额与资金账本已同步(ADJ 分录)' }
);
// 佣金结算待办金额随种子浮动修正(上面 286.4 为演示值, 不参与计算)
approvals.forEach(a => { a.typeLabel = AP_TYPES[a.type] || a.type; });

// ---------------- P4.3 风控规则引擎种子: 结构化规则(条件/动作/优先级/启停/权重) ----------------
// 阈值演示口径: 内置规则不干扰日常演示动线(拦截阈值 $1,000 高于常规操作金额), 现场可改阈值/动作触发
engineRules = [
  { id: 201, name: '大额交易拦截', priority: 10, enabled: true, action: 'block', level: 'high', weight: 40, scene: ['pay', 'topup'],
    condOp: 'and', conditions: [{ field: 'amount', op: '>', value: 1000 }],
    desc: '单笔交易金额超过 $1,000 直接拦截(充值/消费均生效), 阈值现场可调', hits: 23, createdAt: daysAgo(45), updatedAt: daysAgo(18) },
  { id: 202, name: '高风险地区交易', priority: 20, enabled: true, action: 'review', level: 'high', weight: 30, scene: ['pay', 'topup'],
    condOp: 'and', conditions: [{ field: 'country', op: 'not_in', value: ['SA', 'AE', 'QA', 'KW', 'EG', 'BH', 'OM', 'US', 'GB'] }],
    desc: '交易发起国不在允许清单(海湾区+英美), 转人工审核', hits: 6, createdAt: daysAgo(45), updatedAt: daysAgo(45) },
  { id: 203, name: '24 小时高频交易', priority: 30, enabled: true, action: 'review', level: 'mid', weight: 20, scene: ['pay', 'topup'],
    condOp: 'and', conditions: [{ field: 'txCount24h', op: '>', value: 10 }],
    desc: '同一用户 24 小时内交易(含本笔)超过 10 笔, 转人工审核', hits: 11, createdAt: daysAgo(45), updatedAt: daysAgo(45) },
  { id: 204, name: '连续支付失败保护', priority: 40, enabled: true, action: 'freeze', level: 'mid', weight: 25, scene: ['pay'],
    condOp: 'and', conditions: [{ field: 'payFailStreak', op: '>=', value: 3 }],
    desc: '连续 3 笔支付失败(挂失/冻结/限额/余额不足)后再次支付, 本笔放行但保护性冻结卡片', hits: 4, createdAt: daysAgo(30), updatedAt: daysAgo(30) },
  { id: 205, name: '新设备大额充值', priority: 50, enabled: false, action: 'mark', level: 'low', weight: 10, scene: ['topup'],
    condOp: 'and', conditions: [{ field: 'deviceAgeHours', op: '<', value: 24 }, { field: 'amount', op: '>', value: 300 }],
    desc: '新绑定设备(注册 < 24h)首充超过 $300, 仅标记观察(演示停用状态)', hits: 2, createdAt: daysAgo(30), updatedAt: daysAgo(6) },
];
// 命中记录种子: [userIdx, ruleId, scene, amount, result, daysAgo] — 规则名/等级快照自规则
const EHS = [
  [11, 201, '充值', 1500, 'blocked', 4],
  [11, 204, '消费', 60, 'frozen', 2],
  [5, 203, '消费', 30, 'review', 5],
  [6, 201, '消费', 1200, 'blocked', 8],
  [2, 203, '消费', 45, 'review', 3],
  [9, 205, '充值', 600, 'marked', 12],
  [4, 203, '消费', 80, 'review', 6],
];
engineHits = EHS.map(([ui, ruleId, scene, amount, result, d]) => {
  const u = users[ui]; const rule = engineRules.find(r => r.id === ruleId); const card = cards.find(c => c.userId === u.id);
  return { id: nid(), ruleId, ruleName: rule.name, action: rule.action, level: rule.level,
    userId: u.id, user: u.name, cardId: card ? card.id : null, cardNoMask: card ? maskCardNo(card.cardNo) : '—',
    scene, merchant: scene === '消费' ? pick(['Noon', 'Amazon', 'Talabat']) : '', amount, result,
    txId: result === 'blocked' ? null : nid(), createdAt: daysAgo(d, ri(1, 20)) };
}).sort((a, b) => b.createdAt - a.createdAt);
// 策略版本种子: 每次规则增删改自动追加小版本
engineVersions = [
  { ver: 'v1.0', at: daysAgo(45), by: 'Noura Al-Faisal', note: '初始策略上线: 5 条内置规则覆盖 拦截/审核/冻结/标记 四类动作', changes: ['创建规则: 大额交易拦截 / 高风险地区交易 / 24 小时高频交易 / 连续支付失败保护 / 新设备大额充值'] },
  { ver: 'v1.1', at: daysAgo(18), by: 'Noura Al-Faisal', note: '收紧大额拦截口径', changes: ['规则「大额交易拦截」条件 amount > 2000 → amount > 1000'] },
  { ver: 'v1.2', at: daysAgo(6), by: 'Noura Al-Faisal', note: '停用新设备观察规则', changes: ['规则「新设备大额充值」启用 → 停用'] },
];

// ---------------- P5.1 支付编排种子: 适配器注册表 / 编排交易(覆盖状态机全边) / 健康日志 / 出站通知 ----------------
orchAdapters = [
  { id: 301, kind: 'fiat_gateway', name: 'Visanet-ME (mock)', status: 'healthy', priority: 10, enabled: true, manual: false,
    feeRate: 0.018, feeFixed: 0.3, latencyMs: 420, successRate: 99.2, mttdMs: 8000,
    caps: { currencies: ['USD', 'AED', 'SAR', 'QAR', 'KWD', 'EGP'], scenes: ['topup_fiat', 'pay'], binRanges: [], note: '中东 Visa 收单主力通道, 支持法币充值与卡消费授权' } },
  { id: 302, kind: 'fiat_gateway', name: 'MEPS (mock)', status: 'healthy', priority: 20, enabled: true, manual: false,
    feeRate: 0.012, feeFixed: 0.8, latencyMs: 650, successRate: 97.8, mttdMs: 12000,
    caps: { currencies: ['USD', 'SAR', 'AED'], scenes: ['topup_fiat', 'pay'], binRanges: [], note: '本地借记网络, 费率更低但成功率略低, 天然备选' } },
  { id: 303, kind: 'crypto_gateway', name: 'USDT-TRC20 Gateway', status: 'healthy', priority: 10, enabled: true, manual: false,
    feeRate: 0.005, feeFixed: 1, latencyMs: 1800, successRate: 98.6, mttdMs: 30000,
    caps: { currencies: ['USD', 'USDT'], scenes: ['topup_crypto'], binRanges: [], note: 'TRC20 链上入金, 6 确认后回调, 单独的 30s 超时补偿窗口' } },
  { id: 304, kind: 'card_issuer', name: 'IssueCo (mock)', status: 'healthy', priority: 10, enabled: true, manual: false,
    feeRate: 0, feeFixed: 3, latencyMs: 300, successRate: 99.6, mttdMs: 6000,
    caps: { currencies: ['USD'], scenes: ['pay', 'issue_card'], binRanges: ['5533', '5299'], note: '主发卡行, 5533/5299 BIN 段发卡与实时授权' } },
  { id: 305, kind: 'card_issuer', name: 'CardWorks (mock)', status: 'degraded', priority: 20, enabled: true, manual: false,
    feeRate: 0, feeFixed: 5, latencyMs: 950, successRate: 94.1, mttdMs: 9000,
    caps: { currencies: ['USD'], scenes: ['pay', 'issue_card'], binRanges: ['4571'], note: '备用发卡行(4571 BIN), 当前授权延迟升高处于降级' } },
  { id: 306, kind: 'kyc', name: 'IdentityGuard KYC (mock)', status: 'healthy', priority: 10, enabled: true, manual: false,
    feeRate: 0, feeFixed: 0.9, latencyMs: 2400, successRate: 99.0, mttdMs: 15000,
    caps: { currencies: [], scenes: ['kyc'], binRanges: [], note: '证件 OCR + 活体检测, 每次核验 $0.9, 不参与资金路由表' } },
  { id: 307, kind: 'fx', name: 'GulfFX Desk (mock)', status: 'healthy', priority: 10, enabled: true, manual: false,
    feeRate: 0.003, feeFixed: 0, latencyMs: 220, successRate: 99.9, mttdMs: 5000,
    caps: { currencies: ['USD', 'AED', 'SAR', 'QAR', 'KWD'], scenes: ['fx'], binRanges: [], note: 'USD↔AED/SAR/QAR/KWD 换汇报价, 点差 0.3%' } },
  { id: 308, kind: 'settlement', name: 'Payout Rails (mock)', status: 'healthy', priority: 10, enabled: true, manual: false,
    feeRate: 0.001, feeFixed: 1.5, latencyMs: 3000, successRate: 99.3, mttdMs: 60000,
    caps: { currencies: ['USD', 'AED', 'SAR'], scenes: ['settle'], binRanges: [], note: '佣金/商户出金打款, T+0/T+1 轨道' } },
];
orchHealthLog = [
  { id: 980001, adapterId: 305, at: daysAgo(2, 8), type: 'probe', from: 'healthy', to: 'degraded', latencyMs: 940, successRate: 95.8, note: '探测: 授权 P95 超阈值, 自动降级(降权路由)' },
  { id: 980002, adapterId: 304, at: daysAgo(2, 8), type: 'probe', from: 'healthy', to: 'healthy', latencyMs: 310, successRate: 99.6, note: '探测: 正常' },
  { id: 980003, adapterId: 301, at: daysAgo(1, 20), type: 'probe', from: 'healthy', to: 'healthy', latencyMs: 435, successRate: 99.1, note: '探测: 正常' },
  { id: 980004, adapterId: 303, at: daysAgo(1, 6), type: 'probe', from: 'healthy', to: 'healthy', latencyMs: 1760, successRate: 98.5, note: '探测: 链上确认正常' },
];
orchWebhookLogs = [
  { id: 980101, orchTxId: null, event: 'heartbeat', payload: { ok: true }, url: 'https://biz.alrashid.example/webhook/ucard', status: 200, at: daysAgo(1, 4) },
];
orchReconFixed = [];
const refTxId = (pred) => { const t = refTx(pred); return t ? t.id : null; }; // 取一笔种子交易 id 做编排单本地账务关联
// 编排交易种子: 覆盖状态机每条边 created→pending→processing→success|failed|reversed|refunded
orchTxs = [];
// topup_fiat ×3: success / failed / pending
mkOrchTx({ scene: 'topup_fiat', amount: 500, currency: 'USD', adapterId: 301, state: 'success', key: 'idem-topup-5001', ageD: 6, localRef: refTxId(t => t.type === 'topup' && t.status === 'success' && t.userId === 1), channelStatus: 'success' });
mkOrchTx({ scene: 'topup_fiat', amount: 300, currency: 'SAR', adapterId: 302, state: 'success', key: 'idem-topup-5002', ageD: 5, localRef: refTxId(t => t.type === 'topup' && t.status === 'success' && t.userId === 4), channelStatus: 'success' });
mkOrchTx({ scene: 'topup_fiat', amount: 1000, currency: 'AED', adapterId: 301, state: 'failed', failNote: '渠道返回 05-Do Not Honor', ageD: 4, key: 'idem-topup-5003' });
mkOrchTx({ scene: 'topup_fiat', amount: 200, currency: 'USD', adapterId: 301, state: 'pending', ageD: 0, hoursAgo: 1, key: 'idem-topup-5004', channelStatus: null });
// topup_crypto ×3: success / success(对账差异1: 渠道成功本地缺账) / processing
mkOrchTx({ scene: 'topup_crypto', amount: 800, currency: 'USD', adapterId: 303, state: 'success', key: 'idem-crypto-6001', ageD: 5, localRef: refTxId(t => t.type === 'topup' && t.status === 'success' && t.userId === 2), channelStatus: 'success' });
mkOrchTx({ scene: 'topup_crypto', amount: 650, currency: 'USDT', adapterId: 303, state: 'success', key: 'idem-crypto-6002', ageD: 3, localRef: null, channelStatus: 'success', userId: 3, reconSeed: 'channel_success_local_missing' }); // 对账差异: 渠道成功/本地缺账
mkOrchTx({ scene: 'topup_crypto', amount: 400, currency: 'USDT', adapterId: 303, state: 'processing', ageD: 0, hoursAgo: 2, key: 'idem-crypto-6003', channelStatus: null });
// pay ×5: success ×2 / failed / success→reversed / success→refunded
mkOrchTx({ scene: 'pay', amount: 128.4, currency: 'USD', adapterId: 304, state: 'success', key: 'idem-pay-7001', ageD: 4, localRef: refTxId(t => t.type === 'consume' && t.status === 'success' && t.userId === 1), channelStatus: 'success' });
mkOrchTx({ scene: 'pay', amount: 89.9, currency: 'USD', adapterId: 304, state: 'success', key: 'idem-pay-7002', ageD: 3, localRef: refTxId(t => t.type === 'consume' && t.status === 'success' && t.userId === 4), channelStatus: 'success' });
mkOrchTx({ scene: 'pay', amount: 220, currency: 'USD', adapterId: 305, state: 'failed', failNote: '发卡行授权超时(降级渠道)', ageD: 3, key: 'idem-pay-7003' });
mkOrchTx({ scene: 'pay', amount: 76.2, currency: 'USD', adapterId: 304, state: 'reversed', key: 'idem-pay-7004', ageD: 2, localRef: null, channelStatus: 'reversed' });
mkOrchTx({ scene: 'pay', amount: 45, currency: 'USD', adapterId: 304, state: 'refunded', key: 'idem-pay-7005', ageD: 2, localRef: null, channelStatus: 'refunded' });
// pay: local-success-channel-timeout 对账差异(本地已入账, 渠道一直未回调)
const reconLocalTx = { id: nid(), type: 'consume', userId: 1, cardId: 1, amount: 158.6, fee: 3.17, method: 'card', merchant: 'Noon', pointsEarned: 0, pointsUsed: 0, status: 'success', ref: 'ORCH-CH-TIMEOUT', createdAt: daysAgo(1, 5) };
transactions.push(reconLocalTx);
transactions.sort((a, b) => b.createdAt - a.createdAt);
mkOrchTx({ scene: 'pay', amount: 158.6, currency: 'USD', adapterId: 305, state: 'processing', ageD: 1, hoursAgo: 5, key: 'idem-pay-7006', channelStatus: 'timeout', userId: 1, localRef: reconLocalTx.id, reconSeed: 'local_success_channel_timeout' });
// issue_card ×3: success / created / failed
mkOrchTx({ scene: 'issue_card', amount: 5, currency: 'USD', adapterId: 304, state: 'success', key: 'idem-card-8001', ageD: 8, channelStatus: 'success' });
mkOrchTx({ scene: 'issue_card', amount: 15, currency: 'USD', adapterId: 304, state: 'created', ageD: 0, hoursAgo: 0, key: 'idem-card-8002', channelStatus: null });
mkOrchTx({ scene: 'issue_card', amount: 1, currency: 'USD', adapterId: 305, state: 'failed', failNote: '备用发卡行 4571 BIN 段库存不足', ageD: 6, key: 'idem-card-8003' });
// fx ×2: success / pending
mkOrchTx({ scene: 'fx', amount: 10000, currency: 'AED', adapterId: 307, state: 'success', key: 'idem-fx-9001', ageD: 4, channelStatus: 'success' });
mkOrchTx({ scene: 'fx', amount: 5000, currency: 'SAR', adapterId: 307, state: 'pending', ageD: 0, hoursAgo: 1, key: 'idem-fx-9002', channelStatus: null });
// settle ×2: success / pending + pay 1 笔渠道成功本地缺账(对账差异2)
mkOrchTx({ scene: 'settle', amount: 286.4, currency: 'USD', adapterId: 308, state: 'success', key: 'idem-stl-10001', ageD: 9, channelStatus: 'success' });
mkOrchTx({ scene: 'settle', amount: 420.7, currency: 'AED', adapterId: 308, state: 'pending', ageD: 0, hoursAgo: 3, key: 'idem-stl-10002', channelStatus: null });
mkOrchTx({ scene: 'pay', amount: 95.4, currency: 'USD', adapterId: 304, state: 'success', key: 'idem-pay-7007', ageD: 2, localRef: null, channelStatus: 'success', userId: 2, reconSeed: 'channel_success_local_missing' });
// 幂等演示固定单: 相同 key 重复提交返回同一订单
mkOrchTx({ scene: 'topup_fiat', amount: 999, currency: 'USD', adapterId: 301, state: 'success', key: 'DEMO-IDEM-KEY-001', ageD: 1, channelStatus: 'success' });

// ---------------- P5.2 合规中心种子 ----------------
// 制裁名单 ×25(OFAC/EU/UN), 其中「Ali Al-Mansouri」与持卡人 #9 同名(演示筛查命中)
sanctions = [
  ['Ali Al-Mansouri', ['A. Al-Mansouri', 'Ali Mansouri'], 'individual', 'AE', 'OFAC', 'SDN 名单 · 涉恐融资关联'],
  ['Yousef Al-Anzi', ['Yusuf Al-Anzi', 'Yousef Anzi'], 'individual', 'KW', 'UN', '联合国安理会综合名单'],
  ['Mahmoud Al-Jabr', ['M. Al-Jabr'], 'individual', 'IQ', 'OFAC', 'SDN 名单 · 武器采购网络'],
  ['Hassan Nasrallah Group', ['HNG Trading'], 'entity', 'LB', 'OFAC', 'SDN 名单 · 实体制裁'],
  ['Islamic Revolutionary Wallet Corp', ['IRWC'], 'entity', 'IR', 'EU', '欧盟综合制裁名单'],
  ['Kim Chol-su', ['Kim Chol Su'], 'individual', 'KP', 'UN', '大规模杀伤性武器扩散'],
  ['Omar Al-Baghdadi Estate', [], 'entity', 'SY', 'OFAC', 'SDN 名单 · 资产冻结'],
  ['Fatima Al-Zahra Foundation', ['FZF Charity'], 'entity', 'SY', 'EU', '欧盟综合制裁名单'],
  ['Abdul Rahman Al-Sudais Trading', ['ARAS Trading'], 'entity', 'YE', 'OFAC', 'SDN 名单 · 资金转移'],
  ['Walid Makled Garcia', ['W. Makled'], 'individual', 'VE', 'OFAC', 'SDN 名单 · 毒品走私'],
  ['Sergei Ivanov Corp', ['SIC Holdings'], 'entity', 'RU', 'EU', '欧盟制裁 · 侵乌相关'],
  ['Viktor Zolotov', ['V. Zolotov Jr.'], 'individual', 'RU', 'OFAC', 'SDN 名单 · 特别指定国民'],
  ['Hafiz Muhammad Saeed', ['H. M. Saeed'], 'individual', 'PK', 'UN', '联合国安理会综合名单'],
  ['Abd al-Nasr Ghali', [], 'individual', 'LY', 'UN', '资产冻结名单'],
  ['Khalid Al-Masri Network', ['KAM Network'], 'entity', 'EG', 'OFAC', 'SDN 名单 · 汇款网络'],
  ['Nasr Al-Din Lijun', [], 'individual', 'SD', 'OFAC', 'SDN 名单 · 军火中间人'],
  ['Al-Salam Exchange House', ['ASEH'], 'entity', 'QA', 'OFAC', 'SDN 名单 · 非正式价值转移'],
  ['Rida Al-Khouja', ['R. Khouja'], 'individual', 'TN', 'EU', '欧盟综合制裁名单'],
  ['Mohammed Dahlan Holdings', ['MDH Group'], 'entity', 'PS', 'EU', '欧盟制裁名单'],
  ['Faisal Al-Maliki', ['F. Al-Maliki'], 'individual', 'BH', 'OFAC', 'SDN 名单 · 融资中介'],
  ['Zaher Al-Husseini', [], 'individual', 'JO', 'OFAC', 'SDN 名单 · 贸易洗钱'],
  ['Gulf Shadow Shipping LLC', ['GSS LLC'], 'entity', 'AE', 'UN', '违反石油禁运'],
  ['Abu Zayd Al-Kuwaiti', ['A. Z. Kuwaiti'], 'individual', 'KW', 'UN', '安理会综合名单'],
  ['Nadia Al-Amin Trust', ['NAT Trust'], 'entity', 'SD', 'OFAC', 'SDN 名单 · 慈善掩护实体'],
  ['Tariq Bin Ziyad Brigade Fund', ['TBZ Fund'], 'entity', 'LY', 'EU', '欧盟综合制裁名单'],
].map((r, i) => ({ id: 7001 + i, name: r[0], aliases: r[1], type: r[2], country: r[3], listSource: r[4], note: r[5] }));
// PEP 名单 ×15, 其中「Fatima Hassan」与持卡人 #2 同名(演示筛查命中)
peps = [
  ['Fatima Hassan', '议会财政委员会成员', 'AE', 'high'],
  ['Mohammed Al-Ghannashi', '国企石油公司董事', 'LY', 'high'],
  ['Salman Al-Mahmoud', '王室办公室顾问', 'QA', 'high'],
  ['Nasser Al-Kaabi', '市政采购负责人', 'QA', 'medium'],
  ['Ayman Al-Zahrani', '海关副署长', 'SA', 'high'],
  ['Rashid Al-Maktoum Jr.', '自贸区管理局副局长', 'AE', 'medium'],
  ['Huda Al-Mutairi', '央行监管官员', 'KW', 'high'],
  ['Yousef Al-Anzi', '国有企业董事会主席', 'KW', 'high'],
  ['Sami Al-Banna', '国防部采购官', 'JO', 'medium'],
  ['Laila Al-Sabah', '主权基金投资经理', 'KW', 'medium'],
  ['Faisal Al-Shammari', '司法部顾问', 'SA', 'low'],
  ['Mona Al-Rahman', '国有电视台台长', 'EG', 'low'],
  ['Karim Al-Nassrallah', '驻外使馆参赞', 'LB', 'medium'],
  ['Adel Al-Hamdan', '国有企业财务总监', 'BH', 'medium'],
  ['Zainab Al-Moussawi', '石油部合同官', 'IQ', 'high'],
].map((r, i) => ({ id: 7101 + i, name: r[0], position: r[1], country: r[2], level: r[3] }));
// 企业 KYB ×6(待审×2 / 通过×2 / 驳回×1 / 补充材料×1), UBO 1-3 人/单
kybCases = [
  { id: 7201, company: 'Emirates Tech Trading LLC', regNo: 'AE-DXB-774102', country: 'AE', businessLicense: { no: 'BL-AE-88214', expiry: daysAgo(-400) }, articles: true,
    bankAccount: { bank: 'Emirates NBD', iban: 'AE** **** **** **** 4821' }, status: 'pending',
    ubos: [{ name: 'Ahmed Bin Zayed', ownershipPct: 60, nationality: 'AE', pep: false }, { name: 'Yousef Al-Anzi', ownershipPct: 40, nationality: 'KW', pep: true }],
    submittedBy: '客户自助提交', createdAt: daysAgo(6, 4), reviewedAt: null, timeline: [{ ts: daysAgo(6, 4), node: '提交申请', note: '营业执照 / 公司章程 / 银行账户证明已上传', operator: '客户' }] },
  { id: 7202, company: 'Doha Logistics W.L.L.', regNo: 'QA-DOH-55318', country: 'QA', businessLicense: { no: 'BL-QA-61022', expiry: daysAgo(-180) }, articles: true,
    bankAccount: { bank: 'Qatar National Bank', iban: 'QA** **** **** **** 7734' }, status: 'pending',
    ubos: [{ name: 'Mansour Al-Hail', ownershipPct: 100, nationality: 'QA', pep: false }],
    submittedBy: '销售 Layla Al-Saad 协助', createdAt: daysAgo(3, 2), reviewedAt: null, timeline: [{ ts: daysAgo(3, 2), node: '提交申请', note: '独资企业, UBO 1 人', operator: 'Layla Al-Saad' }] },
  { id: 7203, company: 'Riyadh Contracting Co.', regNo: 'SA-RUH-33024', country: 'SA', businessLicense: { no: 'BL-SA-45501', expiry: daysAgo(-260) }, articles: true,
    bankAccount: { bank: 'Al Rajhi Bank', iban: 'SA** **** **** **** 2091' }, status: 'approved',
    ubos: [{ name: 'Faisal Al-Otaibi', ownershipPct: 55, nationality: 'SA', pep: false }, { name: 'Maha Al-Qahtani', ownershipPct: 30, nationality: 'SA', pep: false }, { name: 'Sultan Al-Dossary', ownershipPct: 15, nationality: 'SA', pep: false }],
    submittedBy: '客户自助提交', createdAt: daysAgo(20, 6), reviewedAt: daysAgo(17, 1),
    timeline: [{ ts: daysAgo(20, 6), node: '提交申请', note: '建筑承包企业, UBO 3 人', operator: '客户' }, { ts: daysAgo(17, 1), node: '合规初审', note: 'UBO 链条完整, 无制裁/PEP 命中', operator: 'Noura Al-Faisal' }, { ts: daysAgo(17, 1), node: '终审通过', note: '批准开通企业钱包与批量发卡', operator: 'Noura Al-Faisal' }] },
  { id: 7204, company: 'Kuwait Foodstuff Trading Est.', regNo: 'KW-KWC-91837', country: 'KW', businessLicense: { no: 'BL-KW-30988', expiry: daysAgo(-90) }, articles: true,
    bankAccount: { bank: 'National Bank of Kuwait', iban: 'KW** **** **** **** 5512' }, status: 'approved',
    ubos: [{ name: 'Huda Al-Amin', ownershipPct: 70, nationality: 'KW', pep: false }, { name: 'Bader Al-Kandari', ownershipPct: 30, nationality: 'KW', pep: false }],
    submittedBy: '客户自助提交', createdAt: daysAgo(35, 8), reviewedAt: daysAgo(31, 3),
    timeline: [{ ts: daysAgo(35, 8), node: '提交申请', note: '食品贸易企业', operator: '客户' }, { ts: daysAgo(31, 3), node: '终审通过', note: '材料齐全, 无制裁/PEP 命中', operator: 'Noura Al-Faisal' }] },
  { id: 7205, company: 'Cairo Digital Media S.A.E.', regNo: 'EG-CAI-12904', country: 'EG', businessLicense: { no: 'BL-EG-77410', expiry: daysAgo(-15) }, articles: false,
    bankAccount: { bank: 'Banque Misr', iban: 'EG** **** **** **** 0388' }, status: 'rejected',
    ubos: [{ name: 'Karim Al-Nasser', ownershipPct: 80, nationality: 'LB', pep: false }, { name: 'Nour Al-Hoda', ownershipPct: 20, nationality: 'EG', pep: false }],
    submittedBy: '客户自助提交', createdAt: daysAgo(12, 5), reviewedAt: daysAgo(9, 2),
    timeline: [{ ts: daysAgo(12, 5), node: '提交申请', note: '数字媒体公司', operator: '客户' }, { ts: daysAgo(9, 2), node: '合规初审', note: '缺少公司章程, 营业执照 15 天后到期', operator: 'Noura Al-Faisal' }, { ts: daysAgo(9, 2), node: '终审驳回', note: '章程缺失且 UBO 尽调无法完成, 驳回', operator: 'Noura Al-Faisal' }] },
  { id: 7206, company: 'Manama Fintech Labs BSC', regNo: 'BH-MNM-20456', country: 'BH', businessLicense: { no: 'BL-BH-66120', expiry: daysAgo(-330) }, articles: true,
    bankAccount: { bank: 'Bank of Bahrain and Kuwait', iban: 'BH** **** **** **** 9104' }, status: 'info_required',
    ubos: [{ name: 'Adel Al-Fahim', ownershipPct: 50, nationality: 'BH', pep: false }, { name: 'Zainab Al-Moussawi', ownershipPct: 50, nationality: 'IQ', pep: false }],
    submittedBy: '客户自助提交', createdAt: daysAgo(2, 7), reviewedAt: daysAgo(0, 6),
    timeline: [{ ts: daysAgo(2, 7), node: '提交申请', note: '金融科技实验室', operator: '客户' }, { ts: daysAgo(0, 6), node: '合规初审', note: 'UBO Zainab Al-Moussawi 国籍为 IQ, 请补充资金来源证明与简历', operator: 'Noura Al-Faisal' }] },
];
// STR 可疑交易报告 ×5(draft×2 / submitted×2 / closed×1)
strReports = [
  { id: 7301, refNo: 'STR-2026-0041', userId: 11, triggerRule: 'R201 大额交易拦截', triggerEventId: null, amount: 1500, status: 'submitted',
    note: '单笔充值 $1,500 触发大额拦截后转人工, 资金来源说明与收入不匹配', createdAt: daysAgo(10, 4), submittedAt: daysAgo(8, 2), closedAt: null },
  { id: 7302, refNo: 'STR-2026-0042', userId: 7, triggerRule: 'R203 24 小时高频交易', triggerEventId: null, amount: 640, status: 'submitted',
    note: 'KYC L0 用户新开户后 24 小时内 11 笔小额充值后集中消费', createdAt: daysAgo(7, 6), submittedAt: daysAgo(5, 1), closedAt: null },
  { id: 7303, refNo: 'STR-2026-0043', userId: 6, triggerRule: 'R202 高风险地区交易', triggerEventId: null, amount: 890, status: 'closed',
    note: '交易发起国不在允许清单, 人工核实为客户出差, 关闭并留档', createdAt: daysAgo(30, 8), submittedAt: daysAgo(28, 3), closedAt: daysAgo(24, 5) },
  { id: 7304, refNo: 'STR-2026-0044', userId: 11, triggerRule: 'R204 连续支付失败保护', triggerEventId: null, amount: 60, status: 'draft',
    note: '连续 3 笔支付失败后再次尝试, 疑似卡片信息泄露测试', createdAt: daysAgo(2, 3), submittedAt: null, closedAt: null },
  { id: 7305, refNo: 'STR-2026-0045', userId: 6, triggerRule: 'R201 大额交易拦截', triggerEventId: null, amount: 1200, status: 'draft',
    note: '单笔消费 $1,200 被拦截, 商户为高风险 MCC, 待补充分析后报送', createdAt: daysAgo(1, 5), submittedAt: null, closedAt: null },
];
// 证件管理: 每持卡人 1-2 件, 2 件临期(12 天/5 天), 1 件 90 天档
userDocs = [];
const DOC_TYPES = { passport: '护照', national_id: '国民 ID', driver_license: '驾驶证' };
for (let i = 0; i < users.length; i++) {
  const u = users[i];
  const mainType = i % 3 === 0 ? 'passport' : (i % 3 === 1 ? 'national_id' : 'driver_license');
  const expDays = i === 0 ? 12 : i === 6 ? 5 : i === 3 ? 85 : ri(200, 900); // 2 件临期 + 1 件 90 天档, 其余正常
  userDocs.push({ id: 7401 + i * 2, userId: u.id, userName: u.name, country: u.country, type: mainType, typeLabel: DOC_TYPES[mainType], number: maskDocNo('UC' + ri(100000, 999999)), expiry: daysAgo(-expDays), createdAt: daysAgo(ri(100, 400)) });
  if (i % 2 === 0) { // 一半用户有第二证件
    const sub = mainType === 'passport' ? 'national_id' : 'passport';
    userDocs.push({ id: 7402 + i * 2, userId: u.id, userName: u.name, country: u.country, type: sub, typeLabel: DOC_TYPES[sub], number: maskDocNo('UC' + ri(100000, 999999)), expiry: daysAgo(-ri(300, 1000)), createdAt: daysAgo(ri(100, 400)) });
  }
}
// 合规案件 ×4(aml/kyc/kyb/str 各一)
compCases = [
  { id: 7501, type: 'aml', title: '持卡人 Ali Al-Mansouri 制裁名单命中', linkedRef: '筛查命中 OFAC SDN · 用户 #9', status: 'investigating', owner: 'Noura Al-Faisal',
    createdAt: daysAgo(4, 6), timeline: [
      { ts: daysAgo(4, 6), node: '立案', note: 'AML 全量筛查命中 OFAC 制裁名单(精确匹配), 立即限制出金', operator: '系统' },
      { ts: daysAgo(3, 2), node: '调查中', note: '调取开户证件与近 30 天交易流水, 比对名单生日/证件号字段', operator: 'Noura Al-Faisal' }] },
  { id: 7502, type: 'kyc', title: 'Mohammed Al-Mutairi L2 升级材料存疑', linkedRef: 'KYC 案例 · 用户 #3 · 审批单联动', status: 'open', owner: 'Noura Al-Faisal',
    createdAt: daysAgo(1, 4), timeline: [{ ts: daysAgo(1, 4), node: '立案', note: '银行流水与收入证明金额差异较大, 转合规复核', operator: '系统' }] },
  { id: 7503, type: 'kyb', title: 'Emirates Tech Trading UBO 为 PEP', linkedRef: 'KYB #7201 · UBO Yousef Al-Anzi', status: 'open', owner: 'Noura Al-Faisal',
    createdAt: daysAgo(5, 3), timeline: [{ ts: daysAgo(5, 3), node: '立案', note: 'KYB 尽调发现 40% UBO 为高敏感 PEP, 需加强尽调后决定', operator: '系统' }] },
  { id: 7504, type: 'str', title: 'STR-2026-0042 报送后跟进', linkedRef: 'STR #7302 · 用户 #7', status: 'closed', owner: 'Noura Al-Faisal',
    createdAt: daysAgo(6, 8), timeline: [
      { ts: daysAgo(6, 8), node: '立案', note: '高频充值疑似拆分交易, 跟进 STR 报送', operator: '系统' },
      { ts: daysAgo(5, 1), node: '报送监管', note: 'STR 已通过监管门户报送, 案件转跟进', operator: 'Noura Al-Faisal' },
      { ts: daysAgo(2, 6), node: '结案', note: '监管回执无进一步行动, 账户维持限额监控, 结案', operator: 'Noura Al-Faisal' }] },
];
// 国家/地区政策限制(仅展示, 不接入交易链路)
countryRules = [
  { cc: 'SA', country: '沙特阿拉伯', level: 'allowed', notes: '本地监管友好, 支持全量产品' },
  { cc: 'AE', country: '阿联酋', level: 'allowed', notes: '需 CBUAE 牌照口径展示' },
  { cc: 'QA', country: '卡塔尔', level: 'allowed', notes: '正常开放' },
  { cc: 'KW', country: '科威特', level: 'allowed', notes: '正常开放' },
  { cc: 'EG', country: '埃及', level: 'restricted', notes: '外汇管制: 月累计充值 ≤ $2,000, 需补充资金来源' },
  { cc: 'BH', country: '巴林', level: 'allowed', notes: '正常开放' },
  { cc: 'OM', country: '阿曼', level: 'allowed', notes: '正常开放' },
  { cc: 'TR', country: '土耳其', level: 'restricted', notes: '高通胀法币拒收, 仅开放 USDT 充值' },
  { cc: 'JO', country: '约旦', level: 'restricted', notes: '发卡白名单城市: 安曼/扎尔卡' },
  { cc: 'IR', country: '伊朗', level: 'prohibited', notes: '全面制裁, 禁止开户/入金/出金' },
  { cc: 'SY', country: '叙利亚', level: 'prohibited', notes: '全面制裁, 禁止一切交易' },
  { cc: 'KP', country: '朝鲜', level: 'prohibited', notes: '全面制裁, 禁止一切交易' },
  { cc: 'IQ', country: '伊拉克', level: 'restricted', notes: '仅 KYC L2 可入金, 单月 ≤ $5,000' },
];

rebuildLedgerSeed(); // P4.4: 为种子交易回填复式账本(与卡余额自洽) + 14 天余额快照 + 演示冻结余额
initEntMchSeeds(); // P5.3/P5.4: 企业服务 + 商户平台种子(企业期初/收单回填/结算分录直接入账本, 末尾重算余额快照)
initOpsSeeds(); // P5.6 运维中心: Feature Flag 12 开关 + 限流配置 + 内存令牌桶
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
//           ent=企业主账户(P5.3, 平台负债, 贷增借减: 充值贷增, 员工消费/账单服务费借减)
// 恒等式: ①任一业务单(txId) sum(借)===sum(贷) ②账户余额===流水重放===末条流水 balanceAfter ③卡账户余额===卡实际余额
// 流水只追加、永不修改/删除; 退款走反向分录, 不冲销历史。
let ledgerAccounts, ledgerEntries, balanceSnapshots, frozenBalances;
const LEDGER_DEBIT_POSITIVE = { channel: true, expense: true, card: false, merchant: false, income: false, ent: false };
const LEDGER_TYPE_LABEL = { channel: '资金渠道', card: '用户卡账户', merchant: '商户待结算', income: '平台收入', expense: '平台支出', ent: '企业主账户(负债)' };
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
function ensureEntLedgerAccount(e) { return ensureLedgerAccount('ent:' + e.id, 'ent', '企业主账户 · ' + e.name); } // P5.3: 企业预存主账户(负债)
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
const scopeOf = (headers, actorId = null) => { // 数据范围: 身份已由适配器解析; 直调测试兼容 x-sales
  const sid = actorId || parseInt(headers['x-sales'] || headers['x-Sales'] || '0', 10);
  if (sid === 1) return { sid: 1, ids: salesReps.map(s => s.id) };
  if (!sid) return { sid: 0, ids: [] };
  return { sid, ids: subtreeIds(sid) };
};

// ---------------- 业务动作 ----------------
function doTopup(userId, amount, method) {
  amount = +(amount || 0).toFixed(2); // 金额量化到分, 保证账本分录与卡余额增量严格一致
  if (!(amount > 0)) return { error: '充值金额必须大于 $0' };
  if (amount > 100000) return { error: '单笔充值不能超过 $100,000' };
  const rkGate = riskGateForTx(userId, 'topup', { amount, method }); // P4.3 规则引擎前置: 拦截类规则直接拒绝(保持原返回结构)
  if (!rkGate.ok) return { error: rkGate.error };
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
  afterRiskGate(rkGate, userId, tx, card); // P4.3 后置: 冻结/审核/标记动作(不改返回结构)
  return { tx, balance: card.balance };
}
function doPay(userId, amount, merchant, usePoints) {
  amount = +(amount || 0).toFixed(2); // 金额量化到分, 保证账本分录与卡余额增量严格一致
  if (!(amount > 0)) return { error: '消费金额必须大于 $0' };
  const rkGate = riskGateForTx(userId, 'pay', { amount, merchant, usePoints }); // P4.3 规则引擎前置: 拦截类规则直接拒绝(保持原返回结构)
  if (!rkGate.ok) return { error: rkGate.error };
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
  afterRiskGate(rkGate, userId, tx, card); // P4.3 后置: 冻结/审核/标记动作(不改返回结构)
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
  const rule = riskRules.find(r => r.id === e.ruleId) || (engineRules || []).find(r => r.id === e.ruleId); // P4.3: 引擎命中的事件 ruleId 在 201+ 段
  return { ...e, levelLabel: RISK_LEVEL_LABEL[e.level] || e.level, statusLabel: RISK_STATUS_LABEL[e.status] || e.status,
    user: u ? u.name : '—', cardNoMask: card ? maskCardNo(card.cardNo) : '—', cardStatus: card ? card.status : '—',
    ruleName: rule ? rule.name : '已删除规则', ruleAction: rule ? rule.action : '', ruleExpr: rule ? (rule.expr || (rule.conditions ? engineCondStr(rule) : '')) : '' };
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

// ---------------- P4.3 风控规则引擎(模块级): 结构化规则求值 / 命中记录 / 评分 / 版本 ----------------
// 规则 = 条件组(字段+操作符+阈值, 且/或) → 动作(block 拦截 / freeze 冻结 / review 人工审核 / mark 标记)
const ENGINE_FIELDS = {
  amount:         { label: '交易金额(USD)', type: 'number' },
  country:        { label: '交易发起国家码', type: 'list' },
  txCount24h:     { label: '24h 交易笔数(含本笔)', type: 'number' },
  payFailStreak:  { label: '连续支付失败次数', type: 'number' },
  deviceAgeHours: { label: '设备绑定时长(小时)', type: 'number' },
  kycLevel:       { label: '用户 KYC 等级', type: 'number' },
  balance:        { label: '卡当前余额(USD)', type: 'number' },
};
const ENGINE_OPS = { '>': '大于', '>=': '大于等于', '<': '小于', '<=': '小于等于', '==': '等于', '!=': '不等于', 'in': '属于', 'not_in': '不属于' };
const ENGINE_ACTION_LABEL = { block: '拦截', freeze: '冻结', review: '人工审核', mark: '标记' };
const ENGINE_RESULT_LABEL = { blocked: '拦截', frozen: '冻结', review: '人工审核', marked: '标记' };
const AP_TYPE_LABEL = { card_issue: '发卡申请', kyc_upgrade: 'KYC 升级', refund: '退款申请', commission_settle: '佣金结算', adjust: '调账申请' };
const AP_STATUS_LABEL = { pending: '审批中', approved: '已通过', rejected: '已驳回', cancelled: '已撤回' };
function condMatch(c, ctx) {
  const v = ctx[c.field]; const t = c.value;
  if (v == null || t == null) return false;
  switch (c.op) {
    case '>': return v > t; case '>=': return v >= t; case '<': return v < t; case '<=': return v <= t;
    case '==': return v == t; case '!=': return v != t; // eslint-disable-line eqeqeq
    case 'in': case 'not_in': {
      const list = (Array.isArray(t) ? t : [t]).map(String);
      const hit = list.includes(String(v));
      return c.op === 'in' ? hit : !hit;
    }
    default: return false;
  }
}
function ruleMatch(rule, ctx) {
  const conds = rule.conditions || [];
  if (!conds.length) return false;
  return rule.condOp === 'or' ? conds.some(c => condMatch(c, ctx)) : conds.every(c => condMatch(c, ctx));
}
// 交易前置求值: doPay/doTopup 开头调用; 返回按优先级排序的命中规则 + 最高严重度动作
function runRiskRules(userId, tx) {
  if (!engineRules) return { hits: [], action: null, ctx: {} };
  const user = users.find(u => u.id === userId);
  const card = cards.find(c => c.userId === userId);
  const scene = tx.type === 'topup' ? 'topup' : 'pay';
  const ctx = {
    amount: +(tx.amount || 0),
    country: user ? user.cc : '',
    txCount24h: transactions.filter(t => t.userId === userId && t.createdAt >= now() - 864e5).length + 1,
    payFailStreak: user ? (user.payFailStreak || 0) : 0,
    deviceAgeHours: user ? +((now() - user.createdAt) / 36e5).toFixed(1) : 0,
    kycLevel: user ? user.kycLevel : 0,
    balance: card ? card.balance : 0,
  };
  const hits = engineRules
    .filter(r => r.enabled && (r.scene || ['pay', 'topup']).includes(scene) && ruleMatch(r, ctx))
    .sort((a, b) => (a.priority || 99) - (b.priority || 99));
  const RANK = { block: 0, freeze: 1, review: 2, mark: 3 };
  const action = hits.length ? hits.slice().sort((a, b) => RANK[a.action] - RANK[b.action])[0].action : null;
  return { hits, action, ctx };
}
// 与 doPay 内校验同口径的成败预判(仅用于连续失败计数, 不改业务行为)
function predictPayFail(user, card, amount, usePoints) {
  if (!card || card.status !== 'active') return true;
  const lim = KYC_LIMITS[user ? user.kycLevel : 0] || KYC_LIMITS[0];
  if (amount > lim.perTx) return true;
  let pointsUsed = 0;
  if (usePoints && user) pointsUsed = Math.min(user.points, Math.floor(amount * 0.3 * 100));
  return +(amount - pointsUsed / 100).toFixed(2) > card.balance;
}
// 前置门: 拦截类规则命中 → 返回原样错误结构(由 doPay/doTopup 直接 return)
function riskGateForTx(userId, scene, tx) {
  if (!engineRules) return { ok: true, rk: null };
  const user = users.find(u => u.id === userId);
  const rk = runRiskRules(userId, Object.assign({ type: scene }, tx));
  const willFail = scene === 'pay' && user
    ? predictPayFail(user, cards.find(c => c.userId === userId), +(tx.amount || 0), tx.usePoints)
    : false;
  const applyStreak = () => { if (user) user.payFailStreak = willFail ? (user.payFailStreak || 0) + 1 : 0; };
  const blocker = rk.hits.find(r => r.action === 'block');
  if (blocker) {
    logEngineHit(blocker, userId, Object.assign({ type: scene }, tx), 'blocked', null);
    riskEvents.unshift(engineEvent(blocker, userId, tx, 'pending', 'blocked'));
    applyStreak();
    return { ok: false, rk, error: '风控拦截: 命中规则「' + blocker.name + '」, 本笔交易已拒绝; 如需放行请让风控总监调整规则阈值' };
  }
  applyStreak();
  return { ok: true, rk };
}
// 后置钩: 交易成功入账后执行 冻结/审核/标记 类动作(不改 doPay/doTopup 返回结构)
function afterRiskGate(gate, userId, tx, card) {
  const rk = gate && gate.rk;
  if (!rk || !rk.hits || !rk.hits.length) return;
  rk.hits.forEach(r => {
    if (r.action === 'block') return; // 拦截已在门内返回, 不会走到这
    if (r.action === 'freeze') {
      logEngineHit(r, userId, tx, 'frozen', tx.id);
      riskEvents.unshift(engineEvent(r, userId, tx, 'frozen', 'frozen', card));
      if (card && card.status === 'active') {
        card.status = 'frozen';
        ensureCardLedgerAccount(card);
        frozenBalances.push({ id: nid(), accountKey: 'card:' + card.id, amount: lgR2(card.balance),
          reason: '规则引擎冻结 · 命中「' + r.name + '」· 交易 #' + tx.id + ' 入账后保护性冻结(待结算余额全额冻结)',
          createdAt: now(), status: 'frozen', eventId: null });
      }
    } else if (r.action === 'review') {
      logEngineHit(r, userId, tx, 'review', tx.id);
      riskEvents.unshift(engineEvent(r, userId, tx, 'pending', 'review', card));
    } else {
      logEngineHit(r, userId, tx, 'marked', tx.id);
      riskEvents.unshift(engineEvent(r, userId, tx, 'pending', 'marked', card));
    }
  });
}
function logEngineHit(rule, userId, tx, result, txId) {
  const u = users.find(x => x.id === userId);
  const card = cards.find(c => c.userId === userId);
  engineHits.unshift({ id: nid(), ruleId: rule.id, ruleName: rule.name, action: rule.action, level: rule.level,
    userId, user: u ? u.name : '—', cardId: card ? card.id : null, cardNoMask: card ? maskCardNo(card.cardNo) : '—',
    scene: tx.type === 'topup' ? '充值' : '消费', merchant: tx.merchant || '',
    amount: +(tx.amount || 0), result, txId: txId != null ? txId : null, createdAt: now() });
  rule.hits = (rule.hits || 0) + 1;
}
// 引擎命中生成 P1.5 风险事件(进入风控中心统一处置; ruleId 引擎规则段 201+, pubRiskEvent 会回查引擎规则)
function engineEvent(rule, userId, tx, status, resultLabel, card) {
  const c = card || cards.find(x => x.userId === userId);
  const TAIL = { blocked: ', 交易已拒绝', frozen: ', 交易已入账, 卡片保护性冻结', review: ', 交易已放行, 转人工处置', marked: ', 交易已放行, 已标记观察' };
  return { id: nid(), userId, cardId: c ? c.id : null, ruleId: rule.id, level: rule.level,
    reason: '规则引擎命中「' + rule.name + '」(' + engineCondStr(rule) + ') → ' + (ENGINE_RESULT_LABEL[resultLabel] || rule.action) + (TAIL[resultLabel] || ''),
    status, amount: +(tx.amount || 0),
    scene: (tx.type === 'topup' ? '充值' : '消费') + ' $' + (+(tx.amount || 0)).toFixed(2) + (tx.merchant ? ' · ' + tx.merchant : ''),
    deviceId: 'DEV-engine', createdAt: now(),
    timeline: [{ ts: now(), node: 'created', label: '事件产生', note: '规则引擎实时求值命中「' + rule.name + '」(' + (engineVersions[engineVersions.length - 1] || {}).ver + ')', operator: '风控规则引擎' }] };
}
function engineCondStr(rule) {
  return (rule.conditions || []).map(c => {
    const f = ENGINE_FIELDS[c.field] || { label: c.field };
    const v = Array.isArray(c.value) ? ('[' + c.value.join(' / ') + ']') : c.value;
    return f.label + ' ' + (ENGINE_OPS[c.op] || c.op) + ' ' + v;
  }).join(rule.condOp === 'or' ? ' 或 ' : ' 且 ');
}
function serializeEngineRule(r) {
  return { ...r, actionLabel: ENGINE_ACTION_LABEL[r.action] || r.action, levelLabel: RISK_LEVEL_LABEL[r.level] || r.level,
    sceneLabel: (r.scene || []).map(s => (s === 'pay' ? '消费' : '充值')).join(' / '), condStr: engineCondStr(r),
    hitCount: engineHits.filter(h => h.ruleId === r.id).length };
}
// 风险评分: 近 30 天命中权重合计 + 历史风险事件扣分(high 12 / mid 6 / low 2), 上限 100
function engineScoreAll() {
  const EV_DEDUCT = { high: 12, mid: 6, low: 2 };
  const cutoff = now() - 30 * 864e5;
  return users.map(u => {
    const hits = engineHits.filter(h => h.userId === u.id && h.createdAt >= cutoff);
    const hitScore = hits.reduce((s, h) => { const r = engineRules.find(x => x.id === h.ruleId); return s + ((r && r.weight) || 10); }, 0);
    const evs = riskEvents.filter(e => e.userId === u.id);
    const evScore = evs.reduce((s, e) => s + (EV_DEDUCT[e.level] || 2), 0);
    const score = Math.min(100, hitScore + evScore);
    const card = cards.find(c => c.userId === u.id);
    return { userId: u.id, user: u.name, cc: u.cc, country: u.country, kycLevel: u.kycLevel,
      cardId: card ? card.id : null, cardNoMask: card ? maskCardNo(card.cardNo) : '—', cardStatus: card ? card.status : '—',
      hits30d: hits.length, riskEvents: evs.length, hitScore, evScore, score,
      grade: score >= 60 ? 'high' : score >= 30 ? 'mid' : 'low' };
  }).sort((a, b) => b.score - a.score);
}
// 规则增删改自动追加策略小版本(v1.x)
function bumpEngineVersion(by, note, changes) {
  const cur = engineVersions[engineVersions.length - 1] || { ver: 'v1.0' };
  const m = /^v(\d+)\.(\d+)$/.exec(cur.ver) || [null, '1', '0'];
  const ver = 'v' + m[1] + '.' + (parseInt(m[2], 10) + 1);
  engineVersions.push({ ver, at: now(), by, note, changes: changes || [] });
  return ver;
}

// ---------------- P4.2 审批中心(模块级): 视图 / 业务联动执行 ----------------
const apTimeout = (a) => a.status === 'pending' && (now() - (a.updatedAt || a.createdAt)) > 48 * 36e5;
function pubApproval(a) {
  const cur = a.nodes.find(n => n.state === 'active') || null;
  const idx = a.nodes.indexOf(cur);
  return { ...a,
    statusLabel: AP_STATUS_LABEL[a.status] || a.status,
    currentNode: cur ? {
      name: cur.name, mode: cur.mode, approvers: cur.approvers,
      approvedNames: cur.acts.filter(x => x.verdict === 'approve').map(x => x.name),
      remaining: cur.approvers.filter(n => !cur.acts.some(x => x.verdict === 'approve' && x.name === n)),
    } : null,
    step: cur ? idx + 1 : a.nodes.length + 1, steps: a.nodes.length,
    flowLabel: a.nodes.map(n => (n.state === 'done' ? '✓ ' : n === cur ? '▶ ' : '') + n.name + '(' + n.mode + ')').join(' → ') + (a.status === 'approved' ? ' → ✓ 执行' : ''),
    timeout: apTimeout(a) };
}
// 审批全部通过后的业务联动(与后台对应手工接口同一套逻辑; 驳回/撤回不触达业务数据)
function executeApprovalBiz(a) {
  const pl = a.payload || {};
  if (a.type === 'card_issue') {
    const u = users.find(x => x.id === pl.userId);
    if (!u) return '用户不存在, 未发卡';
    const card = { id: nid(), userId: u.id, cardNo: genCardNo(), cvv: String(ri(100, 999)), expMonth: ri(1, 12), expYear: 30,
      level: pl.level || 'standard', status: 'active', balance: 0, salesRepId: u.salesRepId, createdAt: now() };
    cards.push(card);
    addCommissions(card.salesRepId, 'card', 1, card.id, now());
    ensureCardLedgerAccount(card);
    ledgerForMonthlyFee(card, now());
    const cust = customers.find(c => c.userId === u.id);
    if (cust && ['线索', '意向', '方案'].includes(cust.stage)) cust.stage = '开卡';
    return '已发卡 ' + maskCardNo(card.cardNo) + '(' + ((CARD_LEVELS[card.level] || {}).label || card.level) + '), 发卡佣金已计入, 首月月费已计提';
  }
  if (a.type === 'kyc_upgrade') {
    const u = users.find(x => x.id === pl.userId);
    if (!u) return '用户不存在, 未调整 KYC';
    u.kycLevel = Math.max(0, Math.min(2, pl.toLevel != null ? +pl.toLevel : u.kycLevel + 1));
    u.kycStatus = 'approved';
    addPointsLog(u.id, 200, 'KYC 认证奖励', 'KYC', now());
    return u.name + ' KYC 已生效为 L' + u.kycLevel + ', 认证奖励 200 积分已发放';
  }
  if (a.type === 'refund') {
    const t = transactions.find(x => x.id === pl.txId);
    if (!t || t.type !== 'consume') return '交易不存在, 未执行退款';
    if (t.status === 'refunded') return '交易 #' + t.id + ' 此前已退款, 无需重复执行';
    t.status = 'refunded';
    const card = cards.find(c => c.id === t.cardId);
    if (card) card.balance = +(card.balance + t.amount).toFixed(2);
    ledgerForRefund(t, now());
    return '交易 #' + t.id + ' 已全额退款 $' + lgR2(t.amount).toFixed(2) + ', 卡余额已回补, 反向分录已入账';
  }
  if (a.type === 'commission_settle') {
    if (!pl.salesId) return '未指定销售, 未打款';
    let n = 0, sum = 0;
    commissions.forEach(c => {
      if (c.salesId === +pl.salesId && c.status !== 'settled') { ledgerForCommissionSettle(c, now()); c.status = 'settled'; n++; sum += c.amount; }
    });
    const rep = repById(+pl.salesId);
    return (rep ? rep.name : '销售#' + pl.salesId) + ' 待结算佣金 ' + n + ' 笔共 $' + lgR2(sum).toFixed(2) + ' 已打款, 渠道出金分录已入账';
  }
  if (a.type === 'adjust') {
    const card = cards.find(c => c.id === pl.cardId);
    if (!card) return '卡不存在, 未执行调账';
    const delta = +pl.amount || 0;
    const before = card.balance;
    card.balance = +(card.balance + delta).toFixed(2);
    const adjTx = { id: nid(), type: 'adjust', userId: card.userId, cardId: card.id, amount: delta, fee: 0, method: 'adjust',
      ref: 'AP-' + a.id + ' · ' + (pl.ref || '审批调账'), pointsEarned: 0, status: 'success', createdAt: now() };
    transactions.unshift(adjTx);
    ledgerForAdjust(adjTx, card, +(card.balance - before).toFixed(2));
    return '调账已执行 ' + (delta >= 0 ? '+' : '') + delta.toFixed(2) + ', 卡余额 $' + before.toFixed(2) + ' → $' + card.balance.toFixed(2) + ', ADJ 分录已入账';
  }
  if (a.type === 'ent_card_issue') { // P5.3 企业批量发卡备案单: 卡已在发卡动作中即时生成, 备案通过仅作联动确认
    const ent = entAccounts.find(e => e.id === pl.entId);
    return '企业「' + (ent ? ent.name : '#' + pl.entId) + '」批量发卡 ×' + (pl.count || 1) + ' 备案确认, 卡已随发卡动作生效, 无需重复执行';
  }
  return '已归档';
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
// ---------------- P5.1 支付编排: 模块级模型与工具(routeFor 供后续波次复用) ----------------
const ORCH_SCENE_KIND = { topup_fiat: 'fiat_gateway', topup_crypto: 'crypto_gateway', pay: 'card_issuer', issue_card: 'card_issuer', fx: 'fx', settle: 'settlement' };
const ORCH_SCENE_LABEL = { topup_fiat: '法币充值', topup_crypto: '加密充值', pay: '卡消费授权', issue_card: '发卡', fx: '换汇', settle: '结算打款' };
const ORCH_KIND_LABEL = { fiat_gateway: '法币收单网关', crypto_gateway: '加密支付网关', card_issuer: '发卡机构', kyc: 'KYC 认证', fx: '汇率/换汇', settlement: '结算打款' };
const ORCH_STATE_LABEL = { created: '已创建', pending: '待受理', processing: '处理中', success: '成功', failed: '失败', reversed: '已冲正', refunded: '已退款' };
// 状态机: created → pending → processing → success(├ failed ├ reversed └ refunded); failed 可重放回 pending/processing
const ORCH_NEXT = { created: ['pending', 'failed'], pending: ['processing', 'failed', 'success'], processing: ['success', 'failed'], success: ['reversed', 'refunded'], failed: ['pending', 'processing'], reversed: [], refunded: [] };
const ORCH_STATE_PATHS = {
  created: ['created'], pending: ['created', 'pending'], processing: ['created', 'pending', 'processing'],
  success: ['created', 'pending', 'processing', 'success'], failed: ['created', 'pending', 'failed'],
  reversed: ['created', 'pending', 'processing', 'success', 'reversed'], refunded: ['created', 'pending', 'processing', 'success', 'refunded'],
};
const ORCH_TL_NOTES = { created: '编排单创建, 路由决策完成', pending: '已提交渠道, 等待渠道受理回执', processing: '渠道受理中, 执行扣款/授权', success: '渠道确认成功, 终态', failed: '渠道返回失败, 终态(可重放)', reversed: '渠道侧冲正, 撤销已授权交易', refunded: '原路退款成功' };
function maskDocNo(no) { const s = String(no || ''); return s.length <= 4 ? s : s.slice(0, 2) + '***' + s.slice(-3); }
function orchFeeOf(a, amount) { return +(((a.feeRate || 0) * (+amount || 0) + (a.feeFixed || 0)).toFixed(2)); }
function orchEffPriority(a) { return (a.priority || 99) + (a.status === 'degraded' ? 100 : 0); } // 降级渠道降权 100, 仍可被路由(无更优备选时)
function orchById(id) { return orchAdapters.find(a => a.id === +id); }
// 渠道路由决策(模块级, 供编排 API 与后续波次调用): 场景×币种 → 选中渠道 + 备选 + 决策原因
function routeFor(scene, currency) {
  const BASE = 1000; // 费率比较基数 $1000
  const kind = ORCH_SCENE_KIND[scene];
  if (!kind) return { scene, currency: currency || '', adapter: null, backup: null, reason: '未知场景: ' + scene, candidates: [] };
  const all = orchAdapters.filter(a => a.enabled !== false && a.kind === kind
    && (a.caps.scenes || []).includes(scene)
    && (!currency || !(a.caps.currencies || []).length || (a.caps.currencies || []).includes(currency)));
  const usable = all.filter(a => a.status !== 'down').sort((a, b) => orchEffPriority(a) - orchEffPriority(b) || orchFeeOf(a, BASE) - orchFeeOf(b, BASE));
  const head = [...all].sort((a, b) => (a.priority || 99) - (b.priority || 99))[0] || null;
  if (!usable.length) return { scene, currency: currency || '', adapter: null, backup: null,
    reason: all.length ? '该场景全部渠道宕机, 暂不可路由(自动熔断)' : '无支持 场景=' + scene + (currency ? ' / 币种=' + currency : '') + ' 的渠道', candidates: [] };
  const adapter = usable[0], backup = usable[1] || null;
  let reason = '健康检查通过, 按渠道优先级路由';
  if (head && head.id !== adapter.id) reason = head.status === 'down'
    ? '首选渠道 ' + head.name + ' 宕机, 自动故障切换至 ' + adapter.name
    : '首选渠道 ' + head.name + ' 降级降权, 路由至 ' + adapter.name;
  else if (adapter.status === 'degraded') reason = '首选渠道 ' + adapter.name + ' 降级中且无更优备选, 继续使用(降权提示)';
  const cheaper = usable.slice(1).filter(x => orchFeeOf(x, BASE) < orchFeeOf(adapter, BASE));
  if (cheaper.length) reason += '; 备选 ' + cheaper[0].name + ' 千美元成本更低, 可下调其优先级切换';
  return { scene, currency: currency || '', adapter, backup, reason, candidates: usable };
}
// 种子编排单构造(initSeed 调用; attempts/callbacks/timeline 按目标状态回溯生成)
function mkOrchTx(o) {
  const t = {
    id: nid(), scene: o.scene, sceneLabel: ORCH_SCENE_LABEL[o.scene] || o.scene,
    amount: +(+o.amount || 0).toFixed(2), currency: o.currency || 'USD',
    adapterId: o.adapterId, state: o.state, idempotencyKey: o.key || null,
    timeoutMs: o.timeoutMs || (o.scene === 'topup_crypto' ? 30000 : 15000),
    attempts: [], callbacks: [], timeline: [],
    userId: o.userId != null ? o.userId : null, localRef: o.localRef != null ? o.localRef : null,
    channelStatus: o.channelStatus || null, note: o.failNote || '', reconSeed: o.reconSeed || null, reconFixed: null,
    createdAt: o.hoursAgo != null ? now() - o.hoursAgo * 36e5 : daysAgo(o.ageD != null ? o.ageD : 1, 6),
    updatedAt: now(),
  };
  const steps = ORCH_STATE_PATHS[o.state] || ['created'];
  const gap = Math.max(20000, Math.floor((t.timeoutMs * 1.5) / Math.max(1, steps.length)));
  steps.forEach((s, i) => {
    t.timeline.push({ ts: t.createdAt + i * gap, from: i ? steps[i - 1] : null, to: s, note: s === 'failed' ? (o.failNote || '渠道返回失败') : (ORCH_TL_NOTES[s] || '') });
  });
  t.updatedAt = t.timeline[t.timeline.length - 1].ts;
  if (steps.includes('pending')) {
    const a = orchById(o.adapterId);
    t.attempts.push({ no: 1, adapterId: o.adapterId, at: t.createdAt + gap, latencyMs: a ? a.latencyMs + ri(-40, 60) : ri(200, 900),
      result: o.state === 'failed' ? 'fail' : 'accepted', note: o.state === 'failed' ? (o.failNote || '渠道拒绝/超时') : '渠道已受理' });
  }
  if (['success', 'failed', 'reversed', 'refunded'].includes(o.state)) {
    t.callbacks.push({ at: t.updatedAt - 4000, type: o.state === 'failed' ? 'fail' : o.state, receipt: 'RCPT-' + ri(100000, 999999), source: 'channel-async-callback', note: '渠道异步回调(种子回放)' });
  }
  orchTxs.push(t);
  return t;
}
function pubOrchTx(t) {
  const a = orchById(t.adapterId);
  return { ...t, stateLabel: ORCH_STATE_LABEL[t.state] || t.state, sceneLabel: ORCH_SCENE_LABEL[t.scene] || t.scene,
    adapterName: a ? a.name : '—', kindLabel: a ? ORCH_KIND_LABEL[a.kind] : '', adapterStatus: a ? a.status : 'unknown' };
}
// 状态迁移: 校验状态机合法性, 追加时间轴, 终态时补发出站 webhook 通知
function orchTransit(t, to, note) {
  if (!(ORCH_NEXT[t.state] || []).includes(to)) return false;
  const from = t.state;
  t.state = to;
  t.timeline.push({ ts: now(), from, to, note: note || ORCH_TL_NOTES[to] || '' });
  t.updatedAt = now();
  if (['success', 'failed', 'reversed', 'refunded'].includes(to)) orchNotify(t, to);
  return true;
}
function orchNotify(t, event) {
  orchWebhookLogs.unshift({
    id: orchWebhookLogs.length ? Math.max(...orchWebhookLogs.map(w => w.id)) + 1 : 981000,
    orchTxId: t.id, event, payload: { orchTxId: t.id, scene: t.scene, sceneLabel: ORCH_SCENE_LABEL[t.scene] || t.scene, state: t.state, amount: t.amount, currency: t.currency, idempotencyKey: t.idempotencyKey },
    url: 'https://biz.example.com/webhook/orch/' + t.id, status: 200, ms: ri(20, 240), at: now(),
  });
  if (orchWebhookLogs.length > 100) orchWebhookLogs.length = 100;
}
// 对账: 编排单(渠道口径) vs 交易流水(本地口径) vs 资金账本(记账口径) 三方比对
function orchReconDiffs() {
  const items = [];
  orchTxs.forEach(t => {
    if (!t.reconSeed || t.reconFixed) return;
    const local = t.localRef != null ? transactions.find(x => x.id === t.localRef) : null;
    const ledgerOk = t.localRef != null ? ledgerEntries.some(e => e.txId === t.localRef) : false;
    const base = { id: 790000 + t.id, orchTxId: t.id, scene: t.scene, sceneLabel: ORCH_SCENE_LABEL[t.scene] || t.scene, amount: t.amount, currency: t.currency, state: t.state };
    if (t.reconSeed === 'channel_success_local_missing') {
      items.push({ ...base, type: 'channel_success_local_missing', typeLabel: '渠道成功 · 本地缺账', severity: 'high',
        channelStatus: 'success(有回执)', localStatus: 'missing(无流水)', ledgerStatus: 'missing(未记账)',
        suggest: '补单: 按渠道回执补录交易流水并记入资金账本' });
    } else if (t.reconSeed === 'local_success_channel_timeout') {
      items.push({ ...base, type: 'local_success_channel_timeout', typeLabel: '本地已入账 · 渠道超时', severity: 'medium',
        channelStatus: 'timeout(未回执)', localStatus: local ? 'success(流水 #' + local.id + ')' : 'success', ledgerStatus: ledgerOk ? 'posted(已记账)' : 'missing',
        suggest: '补单: 超时补偿重查渠道回执, 关闭在途编排单' });
    }
  });
  return items;
}
// 补单: channel_success_local_missing → 补录交易 + 复式记账(与卡余额自洽); local_success_channel_timeout → 超时补偿关闭在途单
function orchFixDiff(item, byName) {
  const t = orchTxs.find(x => x.id === item.orchTxId);
  if (!t) return { error: '编排单不存在' };
  if (item.type === 'channel_success_local_missing') {
    const u = users.find(x => x.id === (t.userId || 1)) || users[0];
    const card = cards.find(c => c.userId === u.id);
    if (!card) return { error: '用户无在册卡, 无法补单' };
    let txNew;
    if (t.scene === 'topup_fiat' || t.scene === 'topup_crypto') {
      const fee = +(t.amount * 0.01).toFixed(2);
      txNew = { id: nid(), type: 'topup', userId: u.id, cardId: card.id, amount: t.amount, fee, method: t.scene === 'topup_crypto' ? 'usdt' : 'fiat', ref: 'ORCH' + t.id, pointsEarned: 0, status: 'success', createdAt: now() };
      card.balance = +(card.balance + t.amount - fee).toFixed(2);
      transactions.unshift(txNew);
      ledgerForTopup(txNew, card);
    } else {
      const fee = +(t.amount * 0.02).toFixed(2);
      txNew = { id: nid(), type: 'consume', userId: u.id, cardId: card.id, amount: t.amount, fee, method: 'card', merchant: 'Orch 补单入账', pointsEarned: 0, pointsUsed: 0, status: 'success', ref: 'ORCH' + t.id, createdAt: now() };
      card.balance = +(card.balance - t.amount).toFixed(2);
      transactions.unshift(txNew);
      ledgerForConsume(txNew, card);
    }
    t.localRef = txNew.id;
    t.reconFixed = { at: now(), by: byName, note: '已补录交易流水 #' + txNew.id + ' 并复式记账(渠道回执为成功)' };
    return { ok: true, localTxId: txNew.id, note: t.reconFixed.note };
  }
  if (item.type === 'local_success_channel_timeout') {
    if (!orchTransit(t, 'success', '对账补单: 超时补偿重查渠道回执, 渠道确认成功, 关闭在途单')) {
      if (t.state === 'success') return { error: '该编排单已处理过' };
      return { error: '当前状态 ' + t.state + ' 不可执行超时补偿' };
    }
    t.channelStatus = 'success';
    t.reconFixed = { at: now(), by: byName, note: '超时补偿完成: 渠道回执确认成功, 在途单已关闭' };
    return { ok: true, note: t.reconFixed.note };
  }
  return { error: '未知差异类型' };
}

// ---------------- P5.2 合规中心: 模块级工具 ----------------
// 模糊筛查: 姓名精确/包含/别名/词元匹配 + 同国家加成 → 命中明细 + 风险分
function screenName(name, country) {
  const q = String(name || '').toLowerCase().trim();
  const hits = [];
  const matchOne = (target, aliases) => {
    const s = String(target || '').toLowerCase();
    if (q && s === q) return { score: 60, basis: ['姓名精确匹配'] };
    if (q && s.length >= 6 && (s.includes(q) || q.includes(s))) return { score: 40, basis: ['姓名包含匹配'] };
    for (const al of (aliases || [])) {
      const a = String(al).toLowerCase();
      if (a.length >= 6 && (a === q || a.includes(q) || q.includes(a))) return { score: 35, basis: ['别名命中: ' + al] };
    }
    return null;
  };
  sanctions.forEach(s => {
    const m = q ? matchOne(s.name, s.aliases) : null;
    if (!m) return;
    if (country && s.country === country) { m.score += 15; m.basis.push('同国家/地区加成'); }
    hits.push({ kind: 'sanction', listLabel: s.listSource + ' 制裁名单', target: s.name, type: s.type, country: s.country, detail: s.note, aliases: s.aliases, score: Math.min(100, m.score), basis: m.basis });
  });
  peps.forEach(p => {
    const m = q ? matchOne(p.name, []) : null;
    if (!m) return;
    if (country && p.country === country) { m.score += 10; m.basis.push('同国家/地区加成'); }
    hits.push({ kind: 'pep', listLabel: 'PEP 政治公众人物名单', target: p.name, type: 'individual', country: p.country, detail: p.position + ' · 敏感级 ' + p.level, level: p.level, score: Math.min(100, m.score + (p.level === 'high' ? 10 : 0)), basis: m.basis });
  });
  hits.sort((a, b) => b.score - a.score);
  const riskScore = hits.length ? Math.min(100, hits[0].score + (hits.length - 1) * 5) : 0;
  const grade = riskScore >= 60 ? 'high' : riskScore >= 30 ? 'mid' : hits.length ? 'low' : 'clean';
  return { name: String(name || ''), country: country || '', hits, riskScore, grade, checkedAt: now() };
}
// 全量筛查: 12 名持卡人 + 全部 KYB UBO(演示 2-3 处命中)
function complianceScreenings() {
  const out = [];
  users.forEach(u => {
    const r = screenName(u.name, u.cc);
    out.push({ subjectType: 'user', subject: u.name, subjectRef: '用户 #' + u.id, country: u.country, cc: u.cc, ...r, grade: r.grade === 'clean' ? 'clean' : r.grade });
  });
  kybCases.forEach(k => {
    (k.ubos || []).forEach(ub => {
      const r = screenName(ub.name, ub.nationality);
      out.push({ subjectType: 'kyb_ubo', subject: ub.name, subjectRef: 'KYB #' + k.id + ' ' + k.company + ' · 持股 ' + ub.ownershipPct + '%', country: ub.nationality, cc: ub.nationality, ...r, pepFlag: ub.pep, grade: r.grade === 'clean' ? 'clean' : r.grade });
    });
  });
  return out;
}
function docTier(daysLeft) {
  if (daysLeft < 0) return { key: 'expired', label: '已过期', cls: 'red' };
  if (daysLeft <= 7) return { key: 'd7', label: '7 天内到期', cls: 'red' };
  if (daysLeft <= 30) return { key: 'd30', label: '30 天内到期', cls: 'amber' };
  if (daysLeft <= 90) return { key: 'd90', label: '90 天内到期', cls: 'amber' };
  return { key: 'ok', label: '有效', cls: 'green' };
}
const KYB_STATUS_LABEL = { pending: '待审核', approved: '已通过', rejected: '已驳回', info_required: '需补充材料' };
const STR_STATUS_LABEL = { draft: '草稿', submitted: '已报送', closed: '已结案' };
const COMP_CASE_TYPE_LABEL = { aml: 'AML 反洗钱', kyc: 'KYC 尽调', kyb: 'KYB 企业尽调', str: 'STR 报送跟进' };
const COUNTRY_LEVEL_LABEL = { prohibited: '禁止', restricted: '限制', allowed: '允许' };

// ---------------- P5.3 企业服务 + P5.4 商户平台: 模块级模型 / 工具 / 种子(initSeed 末尾调用) ----------------
// P5.3 企业服务模型: 企业(entAccounts) → 成员(entMembers, 5 类角色) → 部门/成本中心(entDepts, 月度预算) → 企业卡(entCards, 卡段 5311*)
//   消费审批(entTxApprovals): 员工卡消费「超部门剩余预算 或 超卡单笔限额」→ 需审批人批准; 通过后复式记账+扣部门预算
//   账单(entBills): 月度账单 = 当月已入账消费汇总 + 0.5% 账单服务费; 支付 = 从企业主账户扣服务费(借 ent 贷 fee)
const ENT_STATUS_LABEL = { active: '正常', frozen: '已冻结', pending: '待开户' };
const ENT_LEVEL_LABEL = { business: '商务版', enterprise: '旗舰版' };
const ENT_MEMBER_ROLE_LABEL = { admin: '企业管理员', finance: '财务人员', approver: '审批人', employee: '普通员工', cardholder: '持卡员工' };
const ENT_MEMBER_STATUS_LABEL = { active: '在职', suspended: '已停用' };
const ENT_AP_STATUS_LABEL = { pending: '待审批', approved: '已通过', rejected: '已驳回', auto: '免审入账' };
const ENT_BILL_STATUS_LABEL = { pending: '待支付', paid: '已支付' };
const ENT_CARD_PRESET = { standard: { single: 500, daily: 1500, monthly: 20000 }, gold: { single: 2000, daily: 6000, monthly: 80000 }, platinum: { single: 10000, daily: 30000, monthly: 400000 } };
const genEntCardNo = () => '5311 ' + String(ri(1000, 9999)) + ' ' + String(ri(1000, 9999)) + ' ' + String(ri(1000, 9999)); // 企业卡专属卡段 5311*
const ENT_BILL_FEE_RATE = 0.005; // 账单服务费率(按当月消费汇总)
const ENT_CONSUME_FEE_RATE = 0.015; // 企业卡收单手续费率
const entById = (id) => entAccounts.find(e => e.id === +id);
const entDeptById = (id) => entDepts.find(d => d.id === +id);
const entCardById = (id) => entCards.find(c => c.id === +id);
const entMembersOf = (entId) => entMembers.filter(m => m.entId === +entId);
const entDeptsOf = (entId) => entDepts.filter(d => d.entId === +entId);
const entCardsOf = (entId) => entCards.filter(c => c.entId === +entId);
const entDeptRemaining = (dept) => lgR2((dept.monthlyBudget || 0) - (dept.used || 0));
const kybOf = (holder) => holder && holder.kybCaseId ? kybCases.find(k => k.id === holder.kybCaseId) : null;
function entTimelineAdd(ent, node, note, operator, ts) { ent.timeline.unshift({ ts: ts || now(), node, note, operator: operator || '系统' }); }
function entConsumePost(appr) { // 企业卡消费入账(免审通过 / 审批通过共用): 借企业主账户 / 贷商户待结算净额 / 贷平台手续费, 并扣部门预算
  const ent = entById(appr.entId), dept = entDeptById(appr.deptId);
  const A = lgR2(appr.amount), F = lgR2(A * ENT_CONSUME_FEE_RATE);
  ensureEntLedgerAccount(ent);
  ensureMerchantLedgerAccount(appr.merchant);
  postLedgerTx('ENTX' + appr.id, '企业卡消费 · ' + ent.name + ' · ' + appr.memberName + ' @ ' + appr.merchant, now(), [
    { key: 'ent:' + ent.id, dir: 'debit', amount: A, memo: '企业主账户扣款 · ' + appr.memberName + ' · ' + appr.merchant },
    { key: 'merchant:' + appr.merchant, dir: 'credit', amount: lgR2(A - F), memo: '商户待结算净额(扣 1.5% 收单手续费)' },
    { key: 'fee', dir: 'credit', amount: F, memo: '企业卡收单手续费 $' + F.toFixed(2) },
  ]);
  ent.balance = lgR2(ent.balance - A);
  if (dept) dept.used = lgR2((dept.used || 0) + A);
  return F;
}
function pubEntCard(c) {
  const ent = entAccounts.find(e => e.id === c.entId) || {};
  const dept = entDepts.find(d => d.id === c.deptId) || {};
  return { ...c, entName: ent.name || '—', deptName: dept.name || '未分配', ccNo: dept.ccNo || '—',
    holderName: c.holderName || (entMembers.find(m => m.id === c.memberId) || {}).name || '—',
    levelLabel: ((CARD_LEVELS[c.level] || {}).label) || ENT_LEVEL_LABEL[c.level] || c.level,
    statusLabel: c.status === 'active' ? '使用中' : c.status === 'frozen' ? '已冻结' : c.status };
}
function pubEntApproval(a) {
  const ent = entAccounts.find(e => e.id === a.entId) || {};
  const dept = entDepts.find(d => d.id === a.deptId) || {};
  const card = entCards.find(c => c.id === a.cardId) || {};
  return { ...a, entName: ent.name || '—', deptName: dept.name || '—', cardNo: card.cardNo ? maskCardNo(card.cardNo) : '—',
    statusLabel: ENT_AP_STATUS_LABEL[a.status] || a.status };
}
function pubEntBill(b) {
  const ent = entAccounts.find(e => e.id === b.entId) || {};
  return { ...b, entName: ent.name || '—', statusLabel: ENT_BILL_STATUS_LABEL[b.status] || b.status,
    invoiced: !!b.invoiceNo, payable: lgR2(b.total != null ? b.total : b.serviceFee) };
}
function pubEnt(e) { // 列表行(含 KYB 联动 / 成员卡数 / 部门预算汇总)
  const kyb = kybOf(e);
  const depts = entDeptsOf(e.id);
  return { ...e, levelLabel: ENT_LEVEL_LABEL[e.level] || e.level, statusLabel: ENT_STATUS_LABEL[e.status] || e.status,
    kybCaseId: e.kybCaseId, kybCompany: kyb ? kyb.company : '', kybStatus: kyb ? kyb.status : null,
    kybStatusLabel: kyb ? (KYB_STATUS_LABEL[kyb.status] || kyb.status) : '未提交',
    memberCount: entMembersOf(e.id).length, deptCount: depts.length, cardCount: entCardsOf(e.id).length,
    pendingApprovals: entTxApprovals.filter(a => a.entId === e.id && a.status === 'pending').length,
    pendingBills: entBills.filter(x => x.entId === e.id && x.status === 'pending').length,
    deptBudgetTotal: lgR2(depts.reduce((s, d) => s + (d.monthlyBudget || 0), 0)), deptUsedTotal: lgR2(depts.reduce((s, d) => s + (d.used || 0), 0)) };
}

// P5.4 商户平台模型: 收单商户(mchAccounts, 费率/封顶/T+N) → 收款订单(mchOrders) → 退款(mchRefunds, 反向分录)
//   → 结算批次(mchSettles, STL- 复式分录 + 分账拆付) / 分账规则(mchSplits, 订单级) / 商户风控(mchRisk)
const MCC_LABEL = { '5411': '商超百货 / 电商', '5651': '服装电商', '4121': '运输出行服务', '5812': '餐饮外卖', '5045': '计算机设备批发', '4215': '货运物流', '7372': '数字媒体服务' };
const MCH_STATUS_LABEL = { pending: '待审核', active: '已开通', rejected: '已驳回' };
const MCH_ORDER_STATUS_LABEL = { paid: '已支付', refunded: '已退款', disputed: '拒付处理中' };
const MCH_PAY_LABEL = { credit: '贷记卡', debit: '借记卡' };
const MCH_REFUND_STATUS_LABEL = { pending: '待审核', approved: '已退款', rejected: '已驳回' };
const MCH_SETTLE_STATUS_LABEL = { pending: '待结算', settled: '已结算' };
const SPLIT_TYPE_LABEL = { sub: '子商户', partner: '合作服务商', platform: '平台服务费' };
const MCH_RISK_THRESHOLD = { score: 70, chargeback: 1.5, refundRate: 3 }; // 超阈值标红
const mchById = (id) => mchAccounts.find(m => m.id === +id);
const mchOrderById = (id) => mchOrders.find(o => o.id === +id);
const mchOrdersOf = (mchId) => mchOrders.filter(o => o.mchId === +mchId);
const mchFeeOf = (mch, amount, method) => method === 'debit'
  ? lgR2(Math.min(lgR2(amount) * (mch.rate.debit || 0), mch.rate.debitCap || 99))
  : lgR2(lgR2(amount) * (mch.rate.credit || 0));
const genMchNo = () => 'M' + ri(80000000, 89999999);
const genMchApiKey = () => { const hx = '0123456789abcdef'; let s = ''; for (let i = 0; i < 18; i++) s += hx[ri(0, 15)]; return 'mk_live_' + s; };
function mchTimelineAdd(m, node, note, operator, ts) { m.timeline.unshift({ ts: ts || now(), node, note, operator: operator || '系统' }); }
// 收款订单入账(种子回填): 借收单渠道清算入金 / 贷商户待结算净额 / 贷平台手续费
function mchOrderLedgerPost(o, ts) {
  ensureMerchantLedgerAccount(o.merchant);
  postLedgerTx('MO' + o.id, '收单入账 · ' + o.merchant + ' · ' + o.orderNo, ts, [
    { key: 'channel:fiat', dir: 'debit', amount: lgR2(o.amount), memo: '卡组织清算入金 · ' + o.channel + ' · ' + o.orderNo },
    { key: 'merchant:' + o.merchant, dir: 'credit', amount: lgR2(o.net), memo: '商户待结算净额(扣收单费率)' },
    { key: 'fee', dir: 'credit', amount: lgR2(o.fee), memo: '收单手续费 $' + lgR2(o.fee).toFixed(2) },
  ]);
}
// 商户退款反向分录: 借商户待结算净额 + 借手续费冲回 / 贷渠道原路退回
function mchRefundLedgerPost(rf, ts) {
  const o = mchOrderById(rf.orderId);
  ensureMerchantLedgerAccount(o.merchant);
  postLedgerTx('MRFD' + rf.id, '商户退款 · ' + o.merchant + ' · 订单 ' + o.orderNo, ts, [
    { key: 'merchant:' + o.merchant, dir: 'debit', amount: lgR2(o.net), memo: '冲回商户待结算净额 · ' + o.orderNo },
    { key: 'fee', dir: 'debit', amount: lgR2(o.fee), memo: '冲回收单手续费 $' + lgR2(o.fee).toFixed(2) },
    { key: 'channel:fiat', dir: 'credit', amount: lgR2(o.amount), memo: '原路退回付款人 · ' + o.orderNo },
  ]);
}
// 结算打款(STL- 模式, 与 P4.4 商户结算同一记账口径): 借商户待结算 / [贷分账接收方×N] / 贷渠道出金(净额-分账)
function mchSettleLedgerPost(batch, ts) {
  const mch = mchById(batch.mchId);
  ensureMerchantLedgerAccount(mch.name);
  const splits = mchSplits.filter(s => (batch.orderIds || []).includes(s.orderId));
  const splitSum = lgR2(splits.reduce((s, x) => s + x.amount, 0));
  const legs = [{ key: 'merchant:' + mch.name, dir: 'debit', amount: lgR2(batch.net), memo: '结算出金 · ' + (batch.orderIds || []).length + ' 笔订单净额 · T+' + (mch.settleDays || 0) }];
  splits.forEach(s => {
    ensureMerchantLedgerAccount(s.receiver);
    const o = mchOrderById(s.orderId);
    legs.push({ key: 'merchant:' + s.receiver, dir: 'credit', amount: lgR2(s.amount), memo: '分账拆付 · ' + (SPLIT_TYPE_LABEL[s.receiverType] || s.receiverType) + ' ' + Math.round((s.pct || 0) * 10000) / 100 + '% · 订单 ' + (o ? o.orderNo : s.orderId) });
  });
  legs.push({ key: 'channel:fiat', dir: 'credit', amount: lgR2(lgR2(batch.net) - splitSum), memo: '渠道出金支付商户结算款' + (splits.length ? '(已扣分账 $' + splitSum.toFixed(2) + ')' : '') });
  const voucher = 'STL-' + mch.name + '-' + isoDay(ts);
  postLedgerTx(voucher, '商户结算打款 · ' + mch.name, ts, legs);
  batch.status = 'settled'; batch.settledAt = ts; batch.voucherNo = voucher;
  batch.paidOut = lgR2(lgR2(batch.net) - splitSum);
  batch.splitSum = splitSum;
  batch.splitDetail = splits.map(s => { const o = mchOrderById(s.orderId); return { ...s, receiverTypeLabel: SPLIT_TYPE_LABEL[s.receiverType] || s.receiverType, orderNo: o ? o.orderNo : '—' }; });
  return { voucher, splitSum, payout: batch.paidOut, splitCount: splits.length };
}
// 结算批次按 orderIds 重算金额(退款冲回后联动)
function mchBatchRecompute(batch) {
  const orders = (batch.orderIds || []).map(mchOrderById).filter(Boolean);
  batch.orderCount = orders.length;
  batch.gross = lgR2(orders.reduce((s, o) => s + o.amount, 0));
  batch.fee = lgR2(orders.reduce((s, o) => s + o.fee, 0));
  batch.net = lgR2(orders.reduce((s, o) => s + o.net, 0));
  if (batch.status === 'settled') batch.net = lgR2(batch.net); // 已结算批次金额为历史快照, 不重算(此处不会出现)
}
function pubMchAccount(m) {
  const kyb = kybOf(m);
  const pend = mchOrdersOf(m.id).filter(o => o.status === 'paid');
  return { ...m, mccLabel: MCC_LABEL[m.mcc] || m.mcc, statusLabel: MCH_STATUS_LABEL[m.status] || m.status,
    kybCaseId: m.kybCaseId, kybCompany: kyb ? kyb.company : '', kybStatus: kyb ? kyb.status : null,
    kybStatusLabel: kyb ? (KYB_STATUS_LABEL[kyb.status] || kyb.status) : '—',
    rateLabel: '贷记 ' + (m.rate.credit * 100).toFixed(2) + '% / 借记 ' + (m.rate.debit * 100).toFixed(2) + '% / 换汇 ' + (m.rate.fx * 100).toFixed(2) + '%',
    settleLabel: 'T+' + m.settleDays,
    orderCount: mchOrdersOf(m.id).length, paidVolume: lgR2(pend.reduce((s, o) => s + o.amount, 0)),
    pendingSettles: mchSettles.filter(b => b.mchId === m.id && b.status === 'pending').length };
}
function pubMchOrder(o) {
  const mch = mchAccounts.find(m => m.id === o.mchId) || {};
  return { ...o, merchantName: o.merchant, mccLabel: mch.mccLabel || (MCC_LABEL[mch.mcc] || ''), methodLabel: MCH_PAY_LABEL[o.method] || o.method,
    statusLabel: MCH_ORDER_STATUS_LABEL[o.status] || o.status,
    splits: mchSplits.filter(s => s.orderId === o.id).map(s => ({ ...s, receiverTypeLabel: SPLIT_TYPE_LABEL[s.receiverType] || s.receiverType })) };
}
function pubMchRefund(r) {
  const o = mchOrderById(r.orderId) || {};
  return { ...r, orderNo: o.orderNo || '—', amount: o.amount != null ? o.amount : r.amount, merchant: o.merchant || '—', merchantId: o.mchId,
    statusLabel: MCH_REFUND_STATUS_LABEL[r.status] || r.status, orderStatus: o.status };
}
function pubMchSettle(b) {
  const mch = mchAccounts.find(m => m.id === b.mchId) || {};
  return { ...b, merchant: mch.name || '—', mccLabel: mch.mccLabel || '', settleLabel: 'T+' + (mch.settleDays || 0),
    statusLabel: MCH_SETTLE_STATUS_LABEL[b.status] || b.status, splitSum: b.splitSum || 0, paidOut: b.paidOut != null ? b.paidOut : (b.status === 'pending' ? b.net : b.paidOut) };
}
function mchReportRows(dim) { // 商户维度经营报表: dim=day|month → 交易量/笔数/成功率/平均客单/退款率
  const rows = [];
  mchAccounts.filter(m => m.status === 'active').forEach(m => {
    const orders = mchOrdersOf(m.id);
    const groups = new Map();
    orders.forEach(o => {
      const d = new Date(o.createdAt);
      const key = dim === 'month' ? d.getFullYear() + '-' + d2(d.getMonth() + 1) : isoDay(o.createdAt);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(o);
    });
    groups.forEach((list, key) => {
      const total = list.length, paid = list.filter(o => o.status === 'paid').length, refunded = list.filter(o => o.status === 'refunded').length, disputed = list.filter(o => o.status === 'disputed').length;
      const amount = lgR2(list.reduce((s, o) => s + o.amount, 0));
      rows.push({ mchId: m.id, merchant: m.name, mccLabel: MCC_LABEL[m.mcc] || m.mcc, period: key, dim,
        amount, count: total, successRate: total ? +(100 * (paid + refunded) / total).toFixed(1) : 100,
        refundRate: total ? +(100 * refunded / total).toFixed(1) : 0, disputeRate: total ? +(100 * disputed / total).toFixed(1) : 0,
        avgOrder: total ? lgR2(amount / total) : 0, fee: lgR2(list.reduce((s, o) => s + o.fee, 0)), net: lgR2(list.reduce((s, o) => s + o.net, 0)) });
    });
  });
  return rows.sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : a.merchant.localeCompare(b.merchant)));
}

// ---- P5.3 / P5.4 种子(initSeed 在 rebuildLedgerSeed 之后调用: 企业期初 / 收单回填 / 结算分录直接入账本) ----
function initEntMchSeeds() {
  // ===== 企业 ×4(3 active + 1 pending) =====
  entAccounts = [
    { id: 8101, name: 'Gulf Logistics LLC', regNo: 'AE-DXB-882910', country: 'AE', kybCaseId: 7203, openAmt: 260000, balance: 0, creditLimit: 150000, level: 'enterprise', status: 'active', contact: 'Khalid Al-Mutawa · +971 50 ***8821', createdAt: daysAgo(186, 4), timeline: [] },
    { id: 8102, name: 'Desert Tech Solutions FZ-LLC', regNo: 'AE-DXB-901255', country: 'AE', kybCaseId: 7204, openAmt: 95000, balance: 0, creditLimit: 60000, level: 'business', status: 'active', contact: 'Laila Al-Fahim · +971 55 ***1042', createdAt: daysAgo(122, 7), timeline: [] },
    { id: 8103, name: 'ME Retail Group', regNo: 'SA-RUH-77103', country: 'SA', kybCaseId: 7206, openAmt: 410000, balance: 0, creditLimit: 250000, level: 'enterprise', status: 'active', contact: 'Maha Al-Qahtani · +966 55 ***3390', createdAt: daysAgo(230, 2), timeline: [] },
    { id: 8104, name: 'Oasis Foods Trading', regNo: 'KW-KWC-88432', country: 'KW', kybCaseId: null, openAmt: 0, balance: 0, creditLimit: 40000, level: 'business', status: 'pending', contact: 'Bader Al-Kandari · +965 55 ***7716', createdAt: daysAgo(2, 6), timeline: [] },
  ];
  // ===== 成员(每企业 3-6 人, 覆盖 5 类角色) =====
  entMembers = [
    { id: 8201, entId: 8101, name: 'Khalid Al-Mutawa', role: 'admin', status: 'active', title: '财务总监' },
    { id: 8202, entId: 8101, name: 'Faisal Al-Harbi', role: 'finance', status: 'active', title: '资金经理' },
    { id: 8203, entId: 8101, name: 'Noura Al-Sabah', role: 'approver', status: 'active', title: '运营副总 · 消费审批人' },
    { id: 8204, entId: 8101, name: 'Omar Bin Rashid', role: 'cardholder', status: 'active', title: '运营经理' },
    { id: 8205, entId: 8101, name: 'Salem Al-Marri', role: 'cardholder', status: 'active', title: '仓储主管' },
    { id: 8206, entId: 8102, name: 'Laila Al-Fahim', role: 'admin', status: 'active', title: 'CEO' },
    { id: 8207, entId: 8102, name: 'Yousef Karim', role: 'finance', status: 'active', title: '财务主管' },
    { id: 8208, entId: 8102, name: 'Dana Al-Suwaidi', role: 'approver', status: 'active', title: 'COO · 消费审批人' },
    { id: 8209, entId: 8102, name: 'Ahmed Nasser', role: 'cardholder', status: 'active', title: '运维工程师' },
    { id: 8210, entId: 8102, name: 'Reem Al-Hashimi', role: 'employee', status: 'active', title: '市场专员' },
    { id: 8211, entId: 8103, name: 'Maha Al-Qahtani', role: 'admin', status: 'active', title: '集团 CFO' },
    { id: 8212, entId: 8103, name: 'Tariq Al-Otaibi', role: 'finance', status: 'active', title: '资金结算经理' },
    { id: 8213, entId: 8103, name: 'Hessa Al-Shammari', role: 'approver', status: 'active', title: '运营总监 · 消费审批人' },
    { id: 8214, entId: 8103, name: 'Saad Al-Dosari', role: 'cardholder', status: 'active', title: '门店运营经理' },
    { id: 8215, entId: 8103, name: 'Amina Al-Zahrani', role: 'cardholder', status: 'active', title: '采购主管' },
    { id: 8216, entId: 8103, name: 'Jassim Al-Harbi', role: 'cardholder', status: 'active', title: '市场经理' },
    { id: 8217, entId: 8104, name: 'Bader Al-Kandari', role: 'admin', status: 'active', title: '总经理' },
    { id: 8218, entId: 8104, name: 'Maryam Al-Sager', role: 'finance', status: 'active', title: '会计' },
    { id: 8219, entId: 8104, name: 'Hamad Al-Ajmi', role: 'employee', status: 'active', title: '业务员' },
  ];
  // ===== 部门 / 成本中心(每企业 1-4 个, 月度预算) =====
  entDepts = [
    { id: 8401, entId: 8101, name: '总经办', ccNo: 'CC-GL-01', monthlyBudget: 40000, used: 0, owner: 'Khalid Al-Mutawa' },
    { id: 8402, entId: 8101, name: '运营部', ccNo: 'CC-GL-02', monthlyBudget: 15000, used: 0, owner: 'Noura Al-Sabah' },
    { id: 8403, entId: 8101, name: '仓储运输部', ccNo: 'CC-GL-03', monthlyBudget: 20000, used: 0, owner: 'Salem Al-Marri' },
    { id: 8404, entId: 8101, name: '市场部', ccNo: 'CC-GL-04', monthlyBudget: 12000, used: 0, owner: 'Faisal Al-Harbi' },
    { id: 8405, entId: 8102, name: '技术部', ccNo: 'CC-DT-01', monthlyBudget: 18000, used: 0, owner: 'Ahmed Nasser' },
    { id: 8406, entId: 8102, name: '市场部', ccNo: 'CC-DT-02', monthlyBudget: 10000, used: 0, owner: 'Reem Al-Hashimi' },
    { id: 8407, entId: 8102, name: '人事行政部', ccNo: 'CC-DT-03', monthlyBudget: 6000, used: 0, owner: 'Laila Al-Fahim' },
    { id: 8408, entId: 8103, name: '采购部', ccNo: 'CC-MR-01', monthlyBudget: 45000, used: 0, owner: 'Amina Al-Zahrani' },
    { id: 8409, entId: 8103, name: '门店运营部', ccNo: 'CC-MR-02', monthlyBudget: 50000, used: 0, owner: 'Saad Al-Dosari' },
    { id: 8410, entId: 8103, name: '市场部', ccNo: 'CC-MR-03', monthlyBudget: 80000, used: 0, owner: 'Jassim Al-Harbi' },
    { id: 8411, entId: 8103, name: '电商事业部', ccNo: 'CC-MR-04', monthlyBudget: 30000, used: 0, owner: 'Hessa Al-Shammari' },
    { id: 8412, entId: 8104, name: '综合办公室', ccNo: 'CC-OF-01', monthlyBudget: 15000, used: 0, owner: 'Maryam Al-Sager' },
  ];
  // ===== 企业卡 ×8(卡段 5311*, 限额 = 单笔/日/月, 归属部门) =====
  const mkCard = (id, entId, memberName, deptId, level, status, ageD) => {
    const m = entMembers.find(x => x.entId === entId && x.name === memberName) || entMembersOf(entId)[0];
    return { id, entId, memberId: m ? m.id : null, holderName: m ? m.name : '—', deptId, cardNo: genEntCardNo(), level,
      limits: { ...(ENT_CARD_PRESET[level] || ENT_CARD_PRESET.standard) }, status, issuedAt: daysAgo(ageD != null ? ageD : 60, 6) };
  };
  entCards = [
    mkCard(8501, 8101, 'Omar Bin Rashid', 8402, 'gold', 'active', 92),
    mkCard(8502, 8101, 'Salem Al-Marri', 8403, 'standard', 'active', 88),
    mkCard(8503, 8101, 'Faisal Al-Harbi', 8404, 'standard', 'active', 75),
    mkCard(8504, 8102, 'Ahmed Nasser', 8405, 'gold', 'active', 61),
    mkCard(8505, 8102, 'Yousef Karim', 8406, 'standard', 'frozen', 47),
    mkCard(8506, 8103, 'Saad Al-Dosari', 8409, 'platinum', 'active', 120),
    mkCard(8507, 8103, 'Amina Al-Zahrani', 8408, 'gold', 'active', 110),
    mkCard(8508, 8103, 'Jassim Al-Harbi', 8410, 'gold', 'active', 96),
  ];
  // ===== 账本期初: 借渠道 / 贷企业主账户(企业预存) =====
  entAccounts.forEach(e => {
    if (!(e.openAmt > 0)) return;
    ensureEntLedgerAccount(e);
    postLedgerTx('ENTOPEN' + e.id, '企业期初充值结转 · ' + e.name, daysAgo(31, 4), [
      { key: 'channel:fiat', dir: 'debit', amount: lgR2(e.openAmt), memo: '企业对公转账预存(期初结转)' },
      { key: 'ent:' + e.id, dir: 'credit', amount: lgR2(e.openAmt), memo: '企业主账户预存入账' },
    ]);
    e.balance = lgR2(e.openAmt);
    entTimelineAdd(e, '企业开户', '企业账户开通, 预存 $' + lgR2(e.openAmt).toLocaleString('en-US') + ' 入企业主账户', 'Noura Al-Faisal', daysAgo(31, 4));
  });
  // ===== 部门历史消费汇总(近 30 天, 一次性入账; 口径与卡消费分录一致) =====
  const entHistSeed = [
    [8403, 17600, 'ADNOC', 'ADNOC 燃油与仓储耗材采购汇总', 22], [8404, 11000, 'Google Ads', 'Google Ads / 本地媒体投放汇总', 18],
    [8405, 15600, 'AWS', 'AWS / Datadog 云资源与监控汇总', 20], [8406, 4200, 'LinkedIn Ads', '行业展会与线索投放汇总', 15], [8407, 1500, 'Office One', '办公用品与团建汇总', 12],
    [8408, 42000, 'Almarai Industrial', '冷链设备与包装耗材采购汇总', 19], [8409, 46500, 'Jotun Paints', '门店租金能耗与促销汇总', 16], [8410, 48800, 'TikTok Ads', '品牌营销与 KOL 投放汇总', 13], [8411, 12200, 'Noon Marketplace', '电商平台运营费汇总', 9],
  ];
  entHistSeed.forEach(([deptId, amt, merchant, memo, ageD]) => {
    const dept = entDeptById(deptId);
    const ent = entById(dept.entId);
    const F = lgR2(amt * ENT_CONSUME_FEE_RATE);
    ensureEntLedgerAccount(ent);
    ensureMerchantLedgerAccount(merchant);
    postLedgerTx('ENTH' + deptId, '部门消费汇总 · ' + ent.name + ' ' + dept.name, daysAgo(ageD, 8), [
      { key: 'ent:' + ent.id, dir: 'debit', amount: lgR2(amt), memo: dept.name + ' · ' + memo },
      { key: 'merchant:' + merchant, dir: 'credit', amount: lgR2(lgR2(amt) - F), memo: '商户待结算净额(扣 1.5% 收单手续费)' },
      { key: 'fee', dir: 'credit', amount: F, memo: '企业卡收单手续费 $' + F.toFixed(2) },
    ]);
    dept.used = lgR2(amt);
    ent.balance = lgR2(ent.balance - amt);
  });
  // ===== 消费审批 ×8(5 pending / 2 approved / 1 rejected) =====
  entTxApprovals = [
    { id: 8601, entId: 8101, cardId: 8501, memberId: 8204, memberName: 'Omar Bin Rashid', deptId: 8402, merchant: 'Emirates Airline', amount: 2350,
      note: '团队赴利雅得现场协调航班', trigger: '超卡单笔限额($2,000)', status: 'approved', createdAt: daysAgo(8, 3), actedAt: daysAgo(7, 9), actNote: '差旅必需, 批准并计入运营部预算', actedBy: 'Noura Al-Sabah' },
    { id: 8602, entId: 8101, cardId: 8502, memberId: 8205, memberName: 'Salem Al-Marri', deptId: 8403, merchant: 'ADNOC', amount: 3800,
      note: '旺季车队燃油预付(月度框架)', trigger: '超部门剩余预算($2,400)', status: 'pending', createdAt: daysAgo(0, 6), actedAt: null, actNote: '', actedBy: '' },
    { id: 8603, entId: 8101, cardId: 8503, memberId: 8202, memberName: 'Faisal Al-Harbi', deptId: 8404, merchant: 'Google Ads', amount: 1850,
      note: 'Q4 获客campaign加投', trigger: '超部门剩余预算($1,000)', status: 'pending', createdAt: daysAgo(0, 4), actedAt: null, actNote: '', actedBy: '' },
    { id: 8604, entId: 8102, cardId: 8504, memberId: 8209, memberName: 'Ahmed Nasser', deptId: 8405, merchant: 'AWS', amount: 4200,
      note: '云资源预留实例年付', trigger: '超部门剩余预算 且 超卡单笔限额', status: 'rejected', createdAt: daysAgo(5, 7), actedAt: daysAgo(4, 8), actNote: '年付折价诱人但超预算, 改按月付并纳入下季规划', actedBy: 'Dana Al-Suwaidi' },
    { id: 8605, entId: 8102, cardId: 8504, memberId: 8209, memberName: 'Ahmed Nasser', deptId: 8405, merchant: 'Datadog', amount: 2900,
      note: '可观测性平台年度订阅', trigger: '超卡单笔限额($2,000)', status: 'pending', createdAt: daysAgo(0, 5), actedAt: null, actNote: '', actedBy: '' },
    { id: 8606, entId: 8103, cardId: 8508, memberId: 8216, memberName: 'Jassim Al-Harbi', deptId: 8410, merchant: 'TikTok Ads', amount: 5600,
      note: '斋月档期品牌投放', trigger: '超卡单笔限额($2,000)', status: 'approved', createdAt: daysAgo(6, 2), actedAt: daysAgo(5, 6), actNote: '档期投放窗口紧, 批准', actedBy: 'Hessa Al-Shammari' },
    { id: 8607, entId: 8103, cardId: 8506, memberId: 8214, memberName: 'Saad Al-Dosari', deptId: 8409, merchant: 'Jotun Paints', amount: 6150,
      note: '旗舰店翻新首期款', trigger: '超部门剩余预算($3,500)', status: 'pending', createdAt: daysAgo(1, 5), actedAt: null, actNote: '', actedBy: '' },
    { id: 8608, entId: 8103, cardId: 8507, memberId: 8215, memberName: 'Amina Al-Zahrani', deptId: 8408, merchant: 'Almarai Industrial', amount: 4300,
      note: '冷链设备采购定金', trigger: '超部门剩余预算($3,000)', status: 'pending', createdAt: daysAgo(0, 8), actedAt: null, actNote: '', actedBy: '' },
  ];
  // 已通过的两笔回填入账(借企业主账户/贷商户/贷手续费 + 扣部门预算)
  entTxApprovals.filter(a => a.status === 'approved').forEach(a => {
    const ent = entById(a.entId), dept = entDeptById(a.deptId), F = lgR2(a.amount * ENT_CONSUME_FEE_RATE);
    ensureEntLedgerAccount(ent);
    ensureMerchantLedgerAccount(a.merchant);
    postLedgerTx('ENTX' + a.id, '企业卡消费 · ' + ent.name + ' · ' + a.memberName + ' @ ' + a.merchant, a.actedAt, [
      { key: 'ent:' + ent.id, dir: 'debit', amount: lgR2(a.amount), memo: '审批通过扣款 · ' + a.memberName + ' · ' + a.merchant },
      { key: 'merchant:' + a.merchant, dir: 'credit', amount: lgR2(lgR2(a.amount) - F), memo: '商户待结算净额(扣 1.5% 收单手续费)' },
      { key: 'fee', dir: 'credit', amount: F, memo: '企业卡收单手续费 $' + F.toFixed(2) },
    ]);
    ent.balance = lgR2(ent.balance - a.amount);
    dept.used = lgR2((dept.used || 0) + a.amount);
  });
  // ===== 部门预算变更历史 ×3 =====
  entDeptLogs = [
    { id: 8801, deptId: 8403, from: 16000, to: 20000, delta: 4000, note: '旺季运输量上调, 追加燃油预算', by: 'Khalid Al-Mutawa', at: daysAgo(12, 3) },
    { id: 8802, deptId: 8410, from: 60000, to: 80000, delta: 20000, note: '斋月档期营销预算追加', by: 'Maha Al-Qahtani', at: daysAgo(9, 6) },
    { id: 8803, deptId: 8405, from: 20000, to: 18000, delta: -2000, note: '云资源优化节约, 削减技术部预算', by: 'Laila Al-Fahim', at: daysAgo(6, 2) },
  ];
  // ===== 企业账单 ×4(上月口径: 消费汇总 + 0.5% 账单服务费; 2 paid / 2 pending) =====
  const pm = new Date(now() - 26 * 864e5);
  const pmLabel = pm.getFullYear() + '-' + d2(pm.getMonth() + 1);
  const pm7 = new Date(now() - 56 * 864e5);
  const pm7Label = pm7.getFullYear() + '-' + d2(pm7.getMonth() + 1);
  const mkBill = (id, entId, period, consumption, status, inv, paidD) => {
    const fee = lgR2(consumption * ENT_BILL_FEE_RATE);
    return { id, entId, period, consumptionTotal: lgR2(consumption), serviceFee: fee, total: fee, status,
      invoiceNo: inv ? 'INV-' + String(period).replace('-', '') + '-' + ri(1000, 9999) : null,
      invoiceTitle: inv ? entById(entId).name : null, taxNo: inv ? 'TAX-' + ri(10000000, 99999999) : null, issuedAt: inv ? daysAgo(paidD != null ? paidD + 2 : 3, 5) : null,
      paidAt: paidD != null ? daysAgo(paidD, 4) : null, voucherNo: paidD != null ? 'PB-' + ri(100000, 999999) : null,
      items: [{ label: '当月企业卡消费汇总(已实时扣企业主账户)', amount: lgR2(consumption) }, { label: '账单服务费(消费 × 0.5%)', amount: fee }],
      createdAt: daysAgo(paidD != null ? paidD + 3 : 3, 6) };
  };
  entBills = [
    mkBill(8701, 8101, pmLabel, entDeptsOf(8101).reduce((s, d) => s + d.used, 0), 'paid', true, 2),
    mkBill(8702, 8102, pmLabel, entDeptsOf(8102).reduce((s, d) => s + d.used, 0), 'pending', false, null),
    mkBill(8703, 8103, pmLabel, entDeptsOf(8103).reduce((s, d) => s + d.used, 0), 'pending', false, null),
    mkBill(8704, 8103, pm7Label, 138000, 'paid', true, 30),
  ];
  // 已支付账单回填: 借企业主账户 / 贷平台手续费(账单服务费)
  entBills.filter(b => b.status === 'paid').forEach(b => {
    const ent = entById(b.entId);
    ensureEntLedgerAccount(ent);
    postLedgerTx('ENTBILL' + b.id, '企业账单支付 · ' + ent.name + ' · ' + b.period, b.paidAt, [
      { key: 'ent:' + ent.id, dir: 'debit', amount: lgR2(b.total), memo: '账单服务费 · ' + b.period + ' · 凭证 ' + b.voucherNo },
      { key: 'fee', dir: 'credit', amount: lgR2(b.total), memo: '企业账单服务费收入 $' + lgR2(b.total).toFixed(2) },
    ]);
    ent.balance = lgR2(ent.balance - b.total);
    entTimelineAdd(ent, '账单支付', b.period + ' 账单服务费 $' + lgR2(b.total).toFixed(2) + ' 已从企业主账户扣款' + (b.invoiceNo ? ', 发票 ' + b.invoiceNo : ''), 'Tariq Al-Otaibi', b.paidAt);
  });

  // ===== P5.4 商户 ×6(2 pending / 3 active / 1 rejected) =====
  mchAccounts = [
    { id: 8301, name: 'Noon', mchNo: 'M80120366', mcc: '5411', country: 'AE', kybCaseId: null, status: 'active',
      settleAccount: { bank: 'Emirates NBD', iban: 'AE** **** **** **** 6602' }, rate: { credit: 0.024, debit: 0.012, fx: 0.010, debitCap: 3.5 }, settleDays: 2,
      contact: '供应商管理部 · vendors@noon.example', appliedAt: daysAgo(420, 3), reviewedAt: daysAgo(415, 5), rejectReason: '', apiKey: genMchApiKey(), timeline: [] },
    { id: 8302, name: 'Namshi', mchNo: 'M80455129', mcc: '5651', country: 'AE', kybCaseId: null, status: 'active',
      settleAccount: { bank: 'Mashreq Bank', iban: 'AE** **** **** **** 3348' }, rate: { credit: 0.026, debit: 0.013, fx: 0.012, debitCap: 3.0 }, settleDays: 2,
      contact: '财务部 · finance@namshi.example', appliedAt: daysAgo(380, 6), reviewedAt: daysAgo(376, 2), rejectReason: '', apiKey: genMchApiKey(), timeline: [] },
    { id: 8303, name: 'Careem', mchNo: 'M80778310', mcc: '4121', country: 'AE', kybCaseId: null, status: 'active',
      settleAccount: { bank: 'ADCB', iban: 'AE** **** **** **** 9017' }, rate: { credit: 0.021, debit: 0.011, fx: 0.008, debitCap: 2.5 }, settleDays: 1,
      contact: '结算组 · settlement@careem.example', appliedAt: daysAgo(350, 2), reviewedAt: daysAgo(346, 8), rejectReason: '', apiKey: genMchApiKey(), timeline: [] },
    { id: 8304, name: 'Emirates Tech Trading LLC', mchNo: null, mcc: '5045', country: 'AE', kybCaseId: 7201, status: 'pending',
      settleAccount: { bank: 'Emirates NBD', iban: 'AE** **** **** **** 4821' }, rate: { credit: 0.028, debit: 0.014, fx: 0.012, debitCap: 4.0 }, settleDays: 3,
      contact: 'Ahmed Bin Zayed · ops@ett.example', appliedAt: daysAgo(5, 3), reviewedAt: null, rejectReason: '', apiKey: null, timeline: [] },
    { id: 8305, name: 'Doha Logistics W.L.L.', mchNo: null, mcc: '4215', country: 'QA', kybCaseId: 7202, status: 'pending',
      settleAccount: { bank: 'Qatar National Bank', iban: 'QA** **** **** **** 7734' }, rate: { credit: 0.025, debit: 0.013, fx: 0.010, debitCap: 3.0 }, settleDays: 3,
      contact: 'Mansour Al-Hail · pay@dohalog.example', appliedAt: daysAgo(3, 2), reviewedAt: null, rejectReason: '', apiKey: null, timeline: [] },
    { id: 8306, name: 'Cairo Digital Media S.A.E.', mchNo: null, mcc: '7372', country: 'EG', kybCaseId: 7205, status: 'rejected',
      settleAccount: { bank: 'Banque Misr', iban: 'EG** **** **** **** 0388' }, rate: { credit: 0.030, debit: 0.015, fx: 0.015, debitCap: 5.0 }, settleDays: 3,
      contact: 'Karim Al-Nasser · info@cdm.example', appliedAt: daysAgo(12, 5), reviewedAt: daysAgo(9, 2), rejectReason: 'KYB 被驳回(公司章程缺失且 UBO 尽调无法完成), 6 个月后可重新申请', apiKey: null, timeline: [] },
  ];
  mchAccounts.forEach(m => {
    m.mccLabel = MCC_LABEL[m.mcc] || m.mcc;
    if (m.status === 'active') mchTimelineAdd(m, '商户开通', '入驻审核通过, 商户号 ' + m.mchNo + ' · 结算 T+' + m.settleDays, 'Noura Al-Faisal', m.reviewedAt);
    else if (m.status === 'pending') mchTimelineAdd(m, '提交入驻申请', 'MCC ' + m.mcc + ' · 联动 KYB #' + m.kybCaseId + ' 尽调中', '商户自助', m.appliedAt);
    else mchTimelineAdd(m, '入驻驳回', m.rejectReason, 'Noura Al-Faisal', m.reviewedAt);
  });
  // ===== 收款订单 ×34(3 个 active 商户, 近 14 天; 2 refunded / 2 disputed) =====
  mchOrders = [];
  const ACTIVE_MCH = [8301, 8302, 8303];
  const REFUND_IDX = [9, 22], DISPUTE_IDX = [15, 27];
  for (let i = 0; i < 34; i++) {
    const mch = mchById(ACTIVE_MCH[i % 3]);
    const isR = REFUND_IDX.includes(i), isD = DISPUTE_IDX.includes(i);
    const amount = lgR2(ri(18, 940) + rnd());
    const method = rnd() < 0.72 ? 'credit' : 'debit';
    const fee = mchFeeOf(mch, amount, method);
    const ageD = isR || isD ? ri(1, 2) : (i < 19 ? ri(4, 13) : (i % 5 < 2 ? 0 : ri(1, 3))); // 19-33 为近 3 日单; i%5<2 固定为「今日」单(8-340 分钟前, 商户端看板有数据)
    const isToday = ageD === 0 && !isR && !isD;
    const payer = users[(i * 5 + 3) % users.length];
    const o = { id: 47201 + i, orderNo: 'PO' + (9123450 + i * 7), mchId: mch.id, merchant: mch.name,
      amount, currency: 'USD', method, channel: i % 3 === 0 ? 'Visa' : 'Mastercard', payer: payer.name, cardMask: maskCardNo(genCardNo()),
      fee, net: lgR2(amount - fee), status: isR ? 'refunded' : isD ? 'disputed' : 'paid',
      createdAt: isToday ? now() - ri(8, 340) * 6e4 : daysAgo(ageD, ri(0, 22)), refundedAt: isR ? daysAgo(Math.max(0, ageD - 1), 6) : null };
    mchOrders.push(o);
    mchOrderLedgerPost(o, o.createdAt);
  }
  // ===== 退款单 ×4(1 pending 待审 / 2 approved 已回填反向分录 / 1 rejected) =====
  const refTarget = mchOrders.find(o => o.mchId === 8301 && o.status === 'paid' && o.createdAt >= now() - 3 * 864e5) || mchOrdersOf(8301).find(o => o.status === 'paid');
  const rejTarget = mchOrders.find(o => o.mchId === 8302 && o.status === 'paid' && o.id !== refTarget.id);
  mchRefunds = [
    { id: 48201, orderId: refTarget.id, mchId: refTarget.mchId, reason: '客户称重复扣款, 申请全额退款', status: 'pending', appliedAt: daysAgo(0, 3), appliedBy: '商户门户', approvedAt: null, approvedBy: '', actNote: '' },
    { id: 48204, orderId: rejTarget.id, mchId: rejTarget.mchId, reason: '超过 30 天退款时限的售后申请', status: 'rejected', appliedAt: daysAgo(4, 6), appliedBy: '商户门户', approvedAt: daysAgo(3, 7), approvedBy: 'Noura Al-Faisal', actNote: '超出退款时限且商品已使用, 驳回' },
  ];
  mchOrders.filter(o => o.status === 'refunded').forEach((o, i) => {
    const rf = { id: 48202 + i, orderId: o.id, mchId: o.mchId,
      reason: i === 0 ? '客户重复下单, 商户核实后全额退款' : '商品缺货, 商户主动退款', status: 'approved',
      appliedAt: o.refundedAt, appliedBy: '商户门户', approvedAt: o.refundedAt, approvedBy: 'Noura Al-Faisal', actNote: '核实无误, 同意全额退款(反向分录已入账)' };
    mchRefundLedgerPost(rf, o.refundedAt);
    mchRefunds.push(rf);
  });
  // ===== 分账规则 ×5(订单级; Careem 出行场景: 子商户车队 + 平台服务费) =====
  mchSplits = [];
  const careemPaid = mchOrdersOf(8303).filter(o => o.status === 'paid');
  const careemOld = careemPaid.filter(o => o.createdAt < now() - 3 * 864e5).slice(0, 1);
  const careemNew = careemPaid.filter(o => o.createdAt >= now() - 3 * 864e5).slice(0, 2);
  careemOld.concat(careemNew).forEach((o, i) => {
    const subPct = 0.8, platPct = 0.05;
    mchSplits.push({ id: 50201 + i * 2, orderId: o.id, mchId: 8303, receiver: 'Careem Fleet Partners', receiverType: 'sub', pct: subPct, amount: lgR2(o.net * subPct), createdAt: daysAgo(10, 4) });
    mchSplits.push({ id: 50202 + i * 2, orderId: o.id, mchId: 8303, receiver: 'U-Card 收单服务', receiverType: 'platform', pct: platPct, amount: lgR2(o.net * platPct), createdAt: daysAgo(10, 4) });
  });
  // ===== 结算批次: 每商户 一批已结算(>3 天订单) + 近 3 天按日待结算 =====
  mchSettles = [];
  let settleSeq = 49201;
  mchAccounts.filter(m => m.status === 'active').forEach(m => {
    const olds = mchOrdersOf(m.id).filter(o => o.status === 'paid' && o.createdAt < now() - 3 * 864e5);
    if (olds.length) {
      const batch = { id: settleSeq++, mchId: m.id, day: isoDay(olds[0].createdAt), orderIds: olds.map(o => o.id), orderCount: olds.length,
        gross: lgR2(olds.reduce((s, o) => s + o.amount, 0)), fee: lgR2(olds.reduce((s, o) => s + o.fee, 0)), net: lgR2(olds.reduce((s, o) => s + o.net, 0)),
        status: 'pending', settledAt: null, voucherNo: null, paidOut: null, splitSum: 0, splitDetail: [] };
      mchSettleLedgerPost(batch, Math.min(now(), olds[olds.length - 1].createdAt + (m.settleDays || 2) * 864e5)); // 种子回填: 直接落 STL 分录
      mchSettles.push(batch);
    }
    const recents = mchOrdersOf(m.id).filter(o => o.status === 'paid' && o.createdAt >= now() - 3 * 864e5);
    const byDay = new Map();
    recents.forEach(o => { const k = isoDay(o.createdAt); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(o); });
    byDay.forEach((list, day) => {
      mchSettles.push({ id: settleSeq++, mchId: m.id, day, orderIds: list.map(o => o.id), orderCount: list.length,
        gross: lgR2(list.reduce((s, o) => s + o.amount, 0)), fee: lgR2(list.reduce((s, o) => s + o.fee, 0)), net: lgR2(list.reduce((s, o) => s + o.net, 0)),
        status: 'pending', settledAt: null, voucherNo: null, paidOut: null, splitSum: 0, splitDetail: [] });
    });
  });
  // ===== 商户风控 ×6 =====
  mchRisk = [
    { mchId: 8301, score: 42, chargebackRate: 0.6, refundRate: 1.8, disputeCount: 2, flags: [], updatedAt: daysAgo(0, 8) },
    { mchId: 8302, score: 57, chargebackRate: 1.1, refundRate: 2.6, disputeCount: 4, flags: ['退款率偏高'], updatedAt: daysAgo(0, 6) },
    { mchId: 8303, score: 76, chargebackRate: 1.9, refundRate: 3.1, disputeCount: 9, flags: ['拒付率超阈值(≥1.5%)', '晚高峰支付失败率上升', '分账接收方变更待确认'], updatedAt: daysAgo(0, 2) },
    { mchId: 8304, score: 24, chargebackRate: 0, refundRate: 0, disputeCount: 0, flags: ['新入网商户 · 待开户'], updatedAt: daysAgo(0, 5) },
    { mchId: 8305, score: 31, chargebackRate: 0, refundRate: 0, disputeCount: 0, flags: ['新入网商户 · 待开户'], updatedAt: daysAgo(0, 4) },
    { mchId: 8306, score: 88, chargebackRate: 2.4, refundRate: 4.2, disputeCount: 3, flags: ['KYB 已驳回', 'MCC 高风险类目'], updatedAt: daysAgo(1, 3) },
  ];
  // 企业主账户余额与账本对齐(全部种子分录完成后) + 快照重算(覆盖新增企业/商户账户)
  entAccounts.forEach(e => {
    const acc = ledgerAccounts.find(a => a.key === 'ent:' + e.id);
    if (acc) e.balance = lgR2(acc.balance);
  });
  buildBalanceSnapshots(14);
}

// ---------------- P5.5 BI 数据中心 + P5.6 运维中心(模块级工具, 依赖 initSeed 填充的数据) ----------------
// ===== P5.5 BI: 指标清单 / 维度清单(自定义报表勾选, 也可供其他模块复用) =====
const BI_METRICS = {
  txCount: { label: '交易笔数', unit: '笔' },
  gmv: { label: 'GMV', unit: '$' },
  topup: { label: '充值总额', unit: '$' },
  consume: { label: '消费总额', unit: '$' },
  fee: { label: '手续费收入', unit: '$' },
  commission: { label: '佣金成本', unit: '$' },
  pointsCost: { label: '积分成本', unit: '$' },
  netIncome: { label: '净收入', unit: '$' },
  users: { label: '覆盖用户数', unit: '人' },
  activeUsers: { label: '活跃用户数', unit: '人' },
  avgTicket: { label: '笔均金额', unit: '$' },
  refundRate: { label: '退款率', unit: '%' },
  riskRate: { label: '风险交易率', unit: '%' },
};
const BI_DIMS = {
  day: { label: '按日' }, hour: { label: '按时段(小时)' }, channel: { label: '按渠道' }, level: { label: '按卡等级' },
  merchant: { label: '按商户' }, rep: { label: '按销售' },
};
// 解析多维筛选: ?range=today|7d|30d & level=卡等级 & merchant=商户 & rep=销售(含 subtree)
function biParseQ(q) {
  const range = ['today', '7d', '30d'].includes(q.range) ? q.range : '30d';
  const startTs = range === 'today' ? rangeStartTs('today') : now() - (range === '7d' ? 7 : 30) * 864e5;
  return {
    range, startTs, endTs: now(),
    level: CARD_LEVELS[q.level] ? q.level : '',
    merchant: String(q.merchant || '').trim(),
    rep: parseInt(q.rep, 10) || 0,
  };
}
// 应用全部筛选 → 窗口交易集 + 用户/卡片索引 + 范围内用户(scope: rep subtree; 维度: 卡等级/商户)
function biCtx(f) {
  const repIds = f.rep ? subtreeIds(f.rep) : null;
  const userById = new Map(users.map(u => [u.id, u]));
  const cardById = new Map(cards.map(c => [c.id, c]));
  const txs = transactions.filter(t => {
    if (t.createdAt < f.startTs || t.createdAt > f.endTs) return false;
    const u = userById.get(t.userId);
    if (!u || (repIds && !repIds.includes(u.salesRepId))) return false;
    const card = cardById.get(t.cardId);
    if (f.level && (!card || card.level !== f.level)) return false;
    if (f.merchant && t.merchant !== f.merchant) return false;
    return true;
  });
  const scopedUsers = users.filter(u => !repIds || repIds.includes(u.salesRepId))
    .filter(u => !f.level || cards.some(c => c.userId === u.id && c.level === f.level));
  return { txs, repIds, userById, cardById, scopedUsers };
}
// ---- 指标纯函数(可复用, 输入为任意交易子集; GMV/风险口径与驾驶舱一致) ----
const biSucc = (txs) => txs.filter(t => t.status === 'success');
const biGmv = (txs) => +biSucc(txs).filter(t => t.type === 'topup' || t.type === 'consume').reduce((s, t) => s + t.amount, 0).toFixed(2);
const biTopup = (txs) => +biSucc(txs).filter(t => t.type === 'topup').reduce((s, t) => s + t.amount, 0).toFixed(2);
const biConsume = (txs) => +biSucc(txs).filter(t => t.type === 'consume').reduce((s, t) => s + t.amount, 0).toFixed(2);
const biFee = (txs) => +biSucc(txs).filter(t => t.type === 'topup' || t.type === 'consume').reduce((s, t) => s + (t.fee || 0), 0).toFixed(2);
const biAvgTicket = (txs) => { const s = biSucc(txs).filter(t => t.type === 'topup' || t.type === 'consume'); return s.length ? +(biGmv(txs) / s.length).toFixed(2) : 0; };
const biRefundRate = (txs) => { const cs = txs.filter(t => t.type === 'consume'); return cs.length ? +(100 * cs.filter(t => t.status === 'refunded').length / cs.length).toFixed(2) : 0; };
const biRiskRate = (txs) => txs.length ? +(100 * txs.filter(t => t.status === 'refunded' || (t.type === 'consume' && t.amount > 400)).length / txs.length).toFixed(2) : 0; // 与驾驶舱 riskCount 同口径
const biActiveUsers = (txs) => new Set(txs.map(t => t.userId)).size;
// 一组交易的指标行(维度分组行 / 自定义报表行共用)
function biRowMetrics(txs) {
  return {
    txCount: txs.length, gmv: biGmv(txs), topup: biTopup(txs), consume: biConsume(txs), fee: biFee(txs),
    pointsCost: +(biSucc(txs).filter(t => t.type === 'consume').reduce((s, t) => s + (t.pointsEarned || 0), 0) * 0.01).toFixed(2), // 消费返积分 × $0.01
    users: biActiveUsers(txs), activeUsers: biActiveUsers(biSucc(txs)),
    avgTicket: biAvgTicket(txs), refundRate: biRefundRate(txs), riskRate: biRiskRate(txs),
  };
}
// 交易 → 维度值(维度分组器; dim ∈ BI_DIMS)
function biDimValue(dim, t, ctx) {
  if (dim === 'day') return isoDay(t.createdAt);
  if (dim === 'hour') return d2(new Date(t.createdAt).getHours()) + ':00';
  if (dim === 'channel') return t.type === 'topup' ? (t.method === 'usdt' ? 'USDT 链上充值' : '银行卡充值') : 'U 卡消费';
  if (dim === 'level') { const c = ctx.cardById.get(t.cardId); return c ? (CARD_LEVELS[c.level] || {}).label || c.level : '未知'; }
  if (dim === 'merchant') return t.merchant || '(充值/无商户)';
  if (dim === 'rep') { const u = ctx.userById.get(t.userId); return u ? (repById(u.salesRepId) || { name: '#' + u.salesRepId }).name : '未知'; }
  return '全部';
}
function biGroupTxs(txs, dim, ctx) {
  const groups = new Map();
  txs.forEach(t => { const k = biDimValue(dim, t, ctx); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });
  return groups;
}
// 窗口佣金成本(卡等级/商户筛选时仅统计交易关联佣金, 与分组口径一致)
function biCommissionScoped(f, ctx) {
  const txIds = new Set(ctx.txs.map(t => t.id));
  const dimOn = !!(f.level || f.merchant);
  return +commissions.filter(c => c.createdAt >= f.startTs && c.createdAt <= f.endTs
    && (!ctx.repIds || ctx.repIds.includes(c.salesId))
    && (!dimOn || (c.type !== 'card' && txIds.has(c.refId))))
    .reduce((s, c) => s + c.amount, 0).toFixed(2);
}
// 积分成本(pointsLogs 发放口径: Σ正变动 × $0.01, 与账本 pointscost 账户单价一致)
function biPointsCost(f, ctx) {
  const uids = new Set(ctx.scopedUsers.map(u => u.id));
  const pts = pointsLogs.filter(l => l.delta > 0 && l.createdAt >= f.startTs && l.createdAt <= f.endTs && uids.has(l.userId)).reduce((s, l) => s + l.delta, 0);
  return { points: pts, usd: +(pts * 0.01).toFixed(2) };
}
// 在管卡月费收入(财务口径: 非挂失卡 × 等级月费)
function biMonthlyFee(f, ctx) {
  return +cards.filter(c => c.status !== 'lost' && (!ctx.repIds || ctx.repIds.includes(c.salesRepId)) && (!f.level || c.level === f.level))
    .reduce((s, c) => s + CARD_LEVELS[c.level].monthlyFee, 0).toFixed(2);
}
// 总览指标(DAU/MAU 用真实 distinct userId 近似; 净收入复用财务口径)
function biOverviewData(f, ctx) {
  const txs = ctx.txs, gmv = biGmv(txs), fee = biFee(txs);
  const commission = biCommissionScoped(f, ctx);
  const monthlyFee = biMonthlyFee(f, ctx);
  const pc = biPointsCost(f, ctx);
  const inScope = (t) => !ctx.repIds || ctx.repIds.includes((ctx.userById.get(t.userId) || {}).salesRepId);
  return {
    dau: biActiveUsers(transactions.filter(t => t.createdAt >= rangeStartTs('today') && inScope(t))),
    mau: biActiveUsers(transactions.filter(t => t.createdAt >= now() - 30 * 864e5 && inScope(t))),
    activeUsers: biActiveUsers(txs), users: ctx.scopedUsers.length, txCount: txs.length,
    gmv, topup: biTopup(txs), consume: biConsume(txs), fee, monthlyFee, commission,
    pointsCost: pc.usd, pointsIssued: pc.points,
    netIncome: +(fee + monthlyFee - commission).toFixed(2),
    refundRate: biRefundRate(txs), riskRate: biRiskRate(txs), avgTicket: biAvgTicket(txs),
  };
}
// 趋势: today 按小时, 7d/30d 按日(GMV + 笔数)
function biTrend(f, ctx) {
  const succ = biSucc(ctx.txs).filter(t => t.type === 'topup' || t.type === 'consume');
  const today00 = rangeStartTs('today');
  const out = [];
  if (f.range === 'today') {
    for (let h = 0; h < 24; h++) {
      const s = today00 + h * 36e5; if (s > now()) break;
      const cell = succ.filter(t => t.createdAt >= s && t.createdAt < s + 36e5);
      out.push({ label: d2(h) + ':00', gmv: +cell.reduce((a, t) => a + t.amount, 0).toFixed(0), count: cell.length });
    }
    return out;
  }
  const days = f.range === '7d' ? 7 : 30;
  for (let i = days - 1; i >= 0; i--) {
    const s = today00 - i * 864e5;
    const cell = succ.filter(t => t.createdAt >= s && t.createdAt < s + 864e5);
    out.push({ label: isoDay(s).slice(5), gmv: +cell.reduce((a, t) => a + t.amount, 0).toFixed(0), count: cell.length });
  }
  return out;
}
// 用户分析: 转化漏斗指标 + 分群(交易频次+金额三分位: 高价值/成长/沉睡)
function biUsersData(f, ctx) {
  const us = ctx.scopedUsers, gmv = biGmv(ctx.txs);
  const ov = { fee: biFee(ctx.txs), commission: biCommissionScoped(f, ctx), monthlyFee: biMonthlyFee(f, ctx) };
  const netIncome = +(ov.fee + ov.monthlyFee - ov.commission).toFixed(2);
  const succ = biSucc(ctx.txs);
  const topUsers = new Set(succ.filter(t => t.type === 'topup').map(t => t.userId));
  const payUsers = new Set(succ.filter(t => t.type === 'consume').map(t => t.userId));
  const hasCard = (u) => cards.some(c => c.userId === u.id);
  // 留存(7 日窗口近似): 7~14 天前活跃用户中, 最近 7 天仍活跃的比例
  const winA = now() - 7 * 864e5, winB = now() - 14 * 864e5;
  const prior = new Set(transactions.filter(t => t.createdAt >= winB && t.createdAt < winA).map(t => t.userId));
  const recent = new Set(transactions.filter(t => t.createdAt >= winA).map(t => t.userId));
  const retained = [...prior].filter(id => recent.has(id)).length;
  const pct = (a, b) => b ? +(100 * a / b).toFixed(1) : 0;
  // 分群: 窗口内成功交易金额+频次排序后三分位
  const per = us.map(u => {
    const mine = succ.filter(t => t.userId === u.id);
    return { user: u, count: mine.length, amount: +mine.reduce((s, t) => s + t.amount, 0).toFixed(2) };
  }).sort((a, b) => b.amount - a.amount || b.count - a.count);
  const cut1 = Math.ceil(per.length / 3), cut2 = Math.ceil(per.length * 2 / 3);
  const segDef = [['vip', '高价值', per.slice(0, cut1)], ['growth', '成长', per.slice(cut1, cut2)], ['dormant', '沉睡', per.slice(cut2)]];
  const segments = segDef.map(([key, label, list]) => ({
    key, label, users: list.length,
    avgCount: list.length ? +(list.reduce((s, x) => s + x.count, 0) / list.length).toFixed(1) : 0,
    avgAmount: list.length ? +(list.reduce((s, x) => s + x.amount, 0) / list.length).toFixed(2) : 0,
    gmv: +list.reduce((s, x) => s + x.amount, 0).toFixed(2),
    gmvShare: pct(list.reduce((s, x) => s + x.amount, 0), gmv),
    members: list.slice(0, 6).map(x => x.user.name),
  }));
  return {
    metrics: {
      users: us.length,
      cardUsers: us.filter(hasCard).length,
      openRate: pct(us.filter(hasCard).length, us.length), // 开卡转化率 = 领卡用户 / 总用户
      kycPassed: us.filter(u => u.kycStatus === 'approved').length,
      kycRate: pct(us.filter(u => u.kycStatus === 'approved').length, us.length), // KYC 通过率
      firstTopupUsers: us.filter(u => topUsers.has(u.id)).length,
      firstTopupRate: pct(us.filter(u => topUsers.has(u.id)).length, us.length), // 首充率(窗口内有成功充值)
      consumeUsers: us.filter(u => payUsers.has(u.id)).length,
      consumeRate: pct(us.filter(u => payUsers.has(u.id)).length, us.length), // 消费率(窗口内有成功消费)
      retained, priorUsers: prior.size,
      retentionRate: pct(retained, prior.size), // 留存率(7 日窗口近似)
      gmv, netIncome,
      ltv: us.length ? +(gmv / us.length).toFixed(2) : 0, // 用户 LTV = 人均 GMV
      arpu: us.length ? +(netIncome / us.length).toFixed(2) : 0, // ARPU(净收入口径)
      cac: 12, // CAC: 营销获客成本种子常数 $12/人
      marketingSpend: +(12 * us.length).toFixed(2),
    },
    segments,
    note: 'CAC 为营销种子常数($12/人); 留存率为 7 日窗口近似口径; LTV=GMV/用户数。',
  };
}
// 销售分析: 团队行(窗口 GMV / 佣金 / 佣金效率 / 人均单产)
function biSalesData(f, ctx) {
  return salesReps.filter(s => !ctx.repIds || ctx.repIds.includes(s.id)).map(s => {
    const team = subtreeIds(s.id);
    const teamUids = new Set(users.filter(u => team.includes(u.salesRepId)).map(u => u.id));
    const teamTx = ctx.txs.filter(t => teamUids.has(t.userId)); // 已含窗口/卡等级/商户筛选
    const gmv = biGmv(teamTx);
    const comm = +commissions.filter(c => c.salesId === s.id && c.createdAt >= f.startTs && c.createdAt <= f.endTs).reduce((s2, c) => s2 + c.amount, 0).toFixed(2);
    return {
      id: s.id, name: s.name, role: s.role, level: s.level, region: s.region, parentId: s.parentId,
      users: users.filter(u => u.salesRepId === s.id).length,
      cards: cards.filter(c => c.salesRepId === s.id).length,
      teamSize: team.length - 1,
      gmv, commission: comm,
      eff: gmv > 0 ? +(100 * comm / gmv).toFixed(2) : 0, // 佣金效率 = 佣金 / GMV
      perCapita: team.length ? +(gmv / team.length).toFixed(2) : 0, // 人均单产(含本人)
    };
  }).sort((a, b) => b.gmv - a.gmv);
}
// CRM 阶段漏斗(7 阶段分布合计 = 客户数; 前 6 阶段为递进漏斗, 沉睡单列)
function biFunnelData(ctx) {
  const ST = ['线索', '意向', '方案', '开卡', '充值', '活跃', '沉睡'];
  const cs = customers.filter(c => !ctx.repIds || ctx.repIds.includes(c.ownerSalesId));
  const list = ST.map((st, i) => ({
    stage: st, order: i + 1,
    count: cs.filter(c => c.stage === st).length,
    pct: cs.length ? +(100 * cs.filter(c => c.stage === st).length / cs.length).toFixed(1) : 0,
  }));
  const funnel = ST.slice(0, 6).map((st, i) => ({ stage: st, value: cs.filter(c => ST.indexOf(c.stage) >= i && c.stage !== '沉睡').length }));
  return { list, funnel, total: cs.length, stages: ST, note: '漏斗总数 = CRM 客户数; 「沉睡」为流失口径不计入递进漏斗。' };
}
// ===== P5.6 运维中心: Feature Flag / 限流 / 审计 / 监控 / 告警 / 链路追踪 / 备份 =====
function initOpsSeeds() {
  ffFlags = [
    ['dashboardFlag', '驾驶舱', true, 100, '驾驶舱与业绩排行模块总开关'],
    ['approvalsFlag', '审批中心', true, 100, 'P4.2 审批中心(真实生效: 关闭后审批页显示「功能已下线」横幅)'],
    ['engineFlag', '风控规则引擎', true, 100, 'P4.3 风控规则引擎命中检测'],
    ['complianceFlag', '合规中心', true, 100, 'P5.2 合规中心(KYC/KYB/AML/制裁筛查)'],
    ['entFlag', '企业服务', true, 100, 'P5.3 企业账户与企业卡'],
    ['mchFlag', '商户平台', true, 100, 'P5.4 商户收单与结算平台'],
    ['biFlag', 'BI 数据中心', true, 100, 'P5.5 BI 数据中心(本模块)'],
    ['opsFlag', '运维中心', true, 100, 'P5.6 生产运维中心(本页)'],
    ['shopFlag', '积分商城', true, 100, '用户端积分商城(真实生效: 关闭后 /api/app/products 返回 503 降级)'],
    ['notifyFlag', '消息通知中心', true, 100, 'P4.6 消息通知中心外发渠道'],
    ['openFlag', '开放平台', true, 100, 'P4.5 开放 API 平台'],
    ['grayPayFlag', '新支付编排灰度', true, 30, '新支付编排路由灰度发布(按 30% 流量逐步放量)'],
  ].map(([key, label, enabled, rollout, desc], i) => ({ id: i + 1, key, label, enabled, rollout, desc, updatedAt: daysAgo(ri(2, 20), ri(0, 20)) }));
  opsRateCfg = {
    enabled: true, // 全局限流总开关
    defaultQps: 5, defaultBurst: 10,
    rules: [
      { key: '/api/app/topup', qps: 2, burst: 5, desc: '用户端充值(防重放/防连点)' },
      { key: '/api/app/pay', qps: 3, burst: 6, desc: '用户端消费(防重复下单)' },
      { key: '/api/admin/ops/ratelimit/test', qps: 1, burst: 4, desc: '限流演示端点: 连打第 5 次触发 429' },
      { key: '/api/open/*', qps: 10, burst: 20, desc: '开放 API 按 key 限流(演示)' },
    ],
  };
  rlBuckets = new Map();
}
const ffOn = (key) => (ffFlags || []).some(f => f.key === key && f.enabled);
// 内存令牌桶(演示级: 单实例; 生产预留 Redis + 滑动窗口, 按网关维度聚合)
function rlAllow(key, qps, burst) {
  if (!opsRateCfg.enabled) return { ok: true, tokens: null, seq: 0, disabled: true };
  const bt = rlBuckets.get(key) || { tokens: burst, ts: now(), seq: 0 };
  bt.tokens = Math.min(burst, bt.tokens + (now() - bt.ts) / 1000 * qps); // 按耗时补充令牌
  bt.seq = (bt.seq || 0) + 1; bt.ts = now();
  if (bt.tokens >= 1) { bt.tokens -= 1; rlBuckets.set(key, bt); return { ok: true, tokens: +bt.tokens.toFixed(2), seq: bt.seq }; }
  rlBuckets.set(key, bt);
  return { ok: false, tokens: +bt.tokens.toFixed(2), seq: bt.seq, retryAfterMs: Math.max(250, Math.ceil((1 - bt.tokens) / qps * 1000)) };
}
// 架构总览: 生产部署拓扑(每层 demo 现状 vs 生产预留) + 能力对照表 + 容灾卡
function opsArchData() {
  return {
    layers: [
      { name: '用户接入', demo: 'app.html / app-pc.html 直连本地 server / Workers', prod: 'CDN + WAF + DDoS 清洗(Cloudflare 边缘)', nodes: ['App H5', 'PC 门户', '管理后台', '小程序(预留)'] },
      { name: '网关 / BFF', demo: 'server.js 单进程 HTTP 壳(静态文件 + /api 转发)', prod: 'API 网关(鉴权/路由/限流) + BFF 聚合层', nodes: ['api.ucard.io', '限流', '鉴权'] },
      { name: '应用服务', demo: 'core.js 单模块承载全部业务域(内存态)', prod: '按域拆分微服务: 用户/卡/交易/风控/账本/编排/BI', nodes: ['用户服务', '交易服务', '风控服务', '账本服务', '编排服务'] },
      { name: '编排 / 异步', demo: 'orchTxs 内存状态机 + 模拟渠道回调', prod: '消息队列(Kafka/RabbitMQ) + 定时任务(Cron) + 分布式锁(Redis)', nodes: ['MQ', 'Cron', '分布式锁'] },
      { name: '持久层', demo: '内存 JS 对象, 冷启动 initSeed() 重建种子', prod: 'MySQL/PostgreSQL 主从 + Redis 缓存 + R2/S3 对象存储', nodes: ['MySQL', 'Redis', '对象存储'] },
      { name: '可观测', demo: 'sysLogs/opLogs 内存数组 + 运维中心模拟面板', prod: '日志(ELK) + 指标(Prometheus) + 链路追踪(OpenTelemetry) + 告警联动消息中心', nodes: ['Log', 'Metric', 'Trace', 'Alert'] },
    ],
    table: [
      { item: 'MySQL/PostgreSQL 持久化', demo: '内存对象(冷启动重建)', prod: '主从 + 读写分离 + 每日备份', ok: false },
      { item: 'Redis 缓存', demo: '无(直接读内存对象)', prod: '热点缓存 / 分布式锁 / 限流计数器', ok: false },
      { item: '消息队列', demo: '同步调用 + 模拟回调', prod: 'Kafka: 交易/佣金/通知异步解耦', ok: false },
      { item: '对象存储', demo: '无(证件等仅存脱敏字段)', prod: 'R2/S3: 证件影像 / 账单归档', ok: false },
      { item: '定时任务', demo: '请求触发式懒初始化', prod: '对账 / 结算 / 快照 Cron 任务', ok: false },
      { item: '分布式锁', demo: '无(单实例无竞争)', prod: 'Redis Redlock: 结算/对账互斥', ok: false },
      { item: '审计日志', demo: '已实现: 运维中心 → 审计日志(sysLogs+opLogs 合流)', prod: 'WORM 追加写 + 独立审计库', ok: true },
      { item: '服务监控', demo: '已实现: 运维中心 → 服务监控(24h 模拟打点)', prod: 'Prometheus + Grafana 大盘', ok: true },
      { item: '链路追踪', demo: '已实现: 运维中心 → 链路追踪(交易贯穿时间线)', prod: 'OpenTelemetry 全链路 span', ok: true },
      { item: '错误告警', demo: '已实现: 运维中心 → 告警规则(联动消息中心渠道)', prod: 'Alertmanager 多级告警值班', ok: true },
      { item: '数据备份', demo: '已实现: 备份导出(全量内存 JSON 下载)', prod: '全量 dump + binlog 增量 + 对象存储归档', ok: true },
      { item: '灾备恢复', demo: 'POST /api/demo/reset 一键重建(演示专用)', prod: '同城双活 + 异地冷备, RPO≤5min / RTO≤30min', ok: false },
      { item: '灰度发布', demo: '已实现: Feature Flag 灰度百分比(grayPayFlag 30%)', prod: '按用户/地区灰度 + 金丝雀集群 + 一键回滚', ok: true },
      { item: 'Feature Flag', demo: '已实现: 12 个模块开关, 2 个真实生效点', prod: '接入配置中心, 支持AB实验', ok: true },
      { item: 'API 限流', demo: '已实现: 内存令牌桶, 演示端点可触发 429', prod: '网关级 Redis 滑动窗口, 按 key/租户', ok: true },
      { item: '数据脱敏', demo: '已实现: 卡号/证件/手机号掩码, 备份导出脱敏', prod: '字段级加密 + KMS 密钥管理', ok: true },
    ],
    resilience: [
      { title: '数据备份', demo: '内存态全量数据, 点击「备份导出」下载 JSON(含脱敏)', prod: '每日全量 dump + binlog 增量 + 对象存储归档, 保留 30 天' },
      { title: '灾备恢复', demo: 'POST /api/demo/reset 重建种子数据(演示环境专用)', prod: '同城双活 + 异地冷备, RPO ≤ 5min / RTO ≤ 30min, 季度灾备演练' },
      { title: '灰度发布', demo: 'Feature Flag grayPayFlag 按 30% 放量演示', prod: '按用户/地区百分比灰度 + 金丝雀集群 + 一键回滚' },
    ],
    note: 'demo 为纯内存单实例架构, 本页展示生产化改造的拓扑与预留方案, 不引入真实中间件。',
  };
}
// 审计日志: 登录日志 + 操作日志 合流统一视图(支持 人/模块/动作/时间 筛选)
function opsAuditData(q) {
  const who = String(q.who || '').trim().toLowerCase();
  const mod = String(q.module || '').trim();
  const act = String(q.action || '').trim();
  const hours = parseInt(q.hours, 10) || 0;
  const since = hours > 0 ? now() - hours * 36e5 : 0;
  const all = [
    ...sysLogs.map(l => ({ id: 'L' + l.id, source: 'login', sourceLabel: '登录日志', at: l.createdAt,
      actor: l.name + '(' + l.username + ')', module: '登录认证', action: '登录' + (l.result === '成功' ? '' : '失败'),
      target: l.ip + ' · ' + l.ua, result: l.result })),
    ...opLogs.map(o => ({ id: 'O' + o.id, source: 'op', sourceLabel: '操作日志', at: o.createdAt,
      actor: o.operator, module: o.module, action: o.action, target: o.target, result: o.result })),
  ];
  const rows = all.filter(r => r.at >= since)
    .filter(r => !who || r.actor.toLowerCase().includes(who))
    .filter(r => !mod || r.module.includes(mod))
    .filter(r => !act || r.action.includes(act))
    .sort((a, b) => b.at - a.at).slice(0, 200);
  return {
    list: rows,
    summary: {
      total: rows.length, logins: rows.filter(r => r.source === 'login').length, ops: rows.filter(r => r.source === 'op').length,
      actors: new Set(rows.map(r => r.actor)).size, modules: [...new Set(all.map(r => r.module))],
    },
    note: '审计口径: 登录日志(认证事件) + 操作日志(业务/配置变更)双流合一; 完整性说明: 关键资金动作(发卡/调账/结算/开关切换)均强制落 opLogs。生产预留: WORM 追加写 + 独立审计库 + 安全审计员只读。',
  };
}
// 服务监控: 各模块 24h 响应时间 / 成功率(可实时推导的用真实数据, 其余确定性模拟)
function opsMonitorData() {
  const okLogins = sysLogs.filter(l => l.result === '成功').length;
  const txAll = transactions.length || 1;
  const txOkRate = +(100 * transactions.filter(t => t.status === 'success').length / txAll).toFixed(2);
  const orchAvg = orchAdapters.length ? +(orchAdapters.reduce((s, a) => s + (a.successRate || 100), 0) / orchAdapters.length).toFixed(2) : 100;
  const ledOk = verifyLedger().balanced;
  const defs = [
    { key: 'auth', name: '登录 / 认证', path: 'POST /api/login', baseMs: 120, ok: sysLogs.length ? +(100 * okLogins / sysLogs.length).toFixed(2) : 100, src: 'sysLogs 实时推导' },
    { key: 'app', name: '用户端交易', path: '/api/app/topup · /api/app/pay', baseMs: 210, ok: txOkRate, src: 'transactions 实时推导' },
    { key: 'risk', name: '风控规则引擎', path: '/api/admin/risk-engine/hits', baseMs: 65, ok: 99.4, src: '模拟打点' },
    { key: 'orch', name: '支付编排渠道', path: '/api/admin/orch/txs', baseMs: 640, ok: orchAvg, src: 'orchAdapters 实时推导' },
    { key: 'ledger', name: '复式账本', path: '/api/admin/ledger/verify', baseMs: 95, ok: ledOk ? 100 : 97.2, src: 'ledger/verify 实时推导' },
    { key: 'approvals', name: '审批中心', path: '/api/admin/approvals', baseMs: 150, ok: 99.8, src: '模拟打点' },
    { key: 'bi', name: 'BI 数据中心', path: '/api/admin/bi/*', baseMs: 320, ok: 99.95, src: '模拟打点' },
    { key: 'notify', name: '消息通知外发', path: '/api/admin/notify/*', baseMs: 380, ok: 99.1, src: '模拟打点' },
  ];
  const modules = defs.map((m, i) => {
    const series = [];
    for (let h = 23; h >= 0; h--) {
      const peak = h >= 19 && h <= 22; // 晚高峰
      series.push({
        h: d2(h),
        ms: Math.max(20, Math.round(m.baseMs * (peak ? 1.6 : 1) + 25 * Math.abs(Math.sin((h + i * 2) / 3.1)))),
        ok: +Math.min(100, Math.max(90, m.ok - (peak ? 1.2 : 0.3) * Math.abs(Math.cos((h + i) / 2.7)))).toFixed(2),
      });
    }
    const avgMs = Math.round(series.reduce((s, x) => s + x.ms, 0) / series.length);
    const minOk = +Math.min(...series.map(x => x.ok)).toFixed(2);
    return { ...m, series, avgMs, minOk, status: minOk >= 99 ? 'healthy' : minOk >= 97 ? 'degraded' : 'down',
      statusLabel: minOk >= 99 ? '健康' : minOk >= 97 ? '降级' : '异常' };
  });
  return {
    modules,
    summary: { total: modules.length, healthy: modules.filter(m => m.status === 'healthy').length, degraded: modules.filter(m => m.status === 'degraded').length, down: modules.filter(m => m.status === 'down').length },
    note: '响应时间/成功率为演示级打点(可推导项取自真实数据); 生产接入 Prometheus 指标采集 + Grafana 大盘。',
  };
}
// 错误告警规则(阈值可触发判定, 通知渠道联动消息中心)
function opsAlertsData() {
  const degraded = orchAdapters.filter(a => a.status === 'degraded');
  const led = verifyLedger();
  const txAll = transactions.length || 1;
  const riskRate = biRiskRate(transactions);
  const timeOuts = approvals.filter(apTimeout).length;
  const diffCnt = Object.values(financeMeta.diffs).reduce((s, d) => s + Object.keys(d).length, 0);
  const chName = (keys) => keys.map(k => (notifyChannels.find(c => c.key === k) || { name: k }).name).join(' / ');
  const rules = [
    { id: 1, name: '渠道成功率跌破 97%', metric: 'orch.adapter.successRate', op: '<', threshold: '97%', level: 'critical', levelLabel: '严重', channels: ['sms', 'webhook'], enabled: true, status: degraded.length ? 'firing' : 'normal', detail: degraded.length ? '触发中: ' + degraded.map(a => a.name + ' ' + a.successRate + '%').join('、') : '全部渠道正常' },
    { id: 2, name: '复式账本不平衡', metric: 'ledger.balanced', op: '=', threshold: 'false', level: 'critical', levelLabel: '严重', channels: ['inapp', 'sms'], enabled: true, status: led.balanced ? 'normal' : 'firing', detail: led.balanced ? '账本重放校验通过' : '账本不平衡: ' + (led.errors || []).slice(0, 2).join('; ') },
    { id: 3, name: '风险交易率 > 5%', metric: 'bi.riskRate(30d)', op: '>', threshold: '5%', level: 'warn', levelLabel: '警告', channels: ['inapp', 'email'], enabled: true, status: riskRate > 5 ? 'firing' : 'normal', detail: '当前 ' + riskRate + '%' },
    { id: 4, name: '审批单超时积压 > 5', metric: 'approvals.timeout', op: '>', threshold: '5 单', level: 'warn', levelLabel: '警告', channels: ['inapp'], enabled: true, status: timeOuts > 5 ? 'firing' : 'normal', detail: '当前超时 ' + timeOuts + ' 单' },
    { id: 5, name: '对账差异未处理 > 3', metric: 'finance.openDiffs', op: '>', threshold: '3 笔', level: 'warn', levelLabel: '警告', channels: ['email'], enabled: true, status: diffCnt > 3 ? 'firing' : 'normal', detail: '当前待处理差异 ' + diffCnt + ' 笔' },
    { id: 6, name: 'DAU 环比下跌 > 20%', metric: 'bi.dau.wow', op: '>', threshold: '20%', level: 'info', levelLabel: '提示', channels: ['inapp'], enabled: false, status: 'normal', detail: '演示停用中' },
  ];
  return {
    rules: rules.map(r => ({ ...r, channelsLabel: chName(r.channels) })),
    channels: notifyChannels.filter(c => c.enabled).map(c => ({ key: c.key, name: c.name, icon: c.icon })),
    summary: { total: rules.length, firing: rules.filter(r => r.status === 'firing' && r.enabled).length, enabled: rules.filter(r => r.enabled).length },
    note: '告警触发后按渠道联动消息中心外发(演示环境仅记录, 不真实发送)。',
  };
}
// 链路追踪: 取一笔交易, 用既有数据拼贯穿时间线(用户端 → 风控 → 编排 → 账本 → 积分/佣金)
function opsTraceCandidates() {
  return orchTxs.filter(o => o.localRef != null).map(o => {
    const t = transactions.find(x => x.id === o.localRef);
    if (!t) return null;
    const u = users.find(x => x.id === t.userId);
    return { txId: t.id, traceId: 'TRC-' + String(t.id).padStart(8, '0'), type: t.type, status: t.status, amount: t.amount,
      createdAt: t.createdAt, user: u ? u.name : '—', orchState: o.state, sceneLabel: o.sceneLabel };
  }).filter(Boolean).slice(0, 10);
}
function opsTraceData(txId) {
  const tx = transactions.find(t => t.id === +txId);
  if (!tx) return { error: 'not found' };
  const u = users.find(x => x.id === tx.userId);
  const card = cards.find(c => c.id === tx.cardId);
  const steps = [];
  steps.push({ layer: '用户端', ts: tx.createdAt, title: tx.type === 'topup' ? '发起充值' : '发起消费',
    note: (u ? u.name : '用户#' + tx.userId) + ' · ' + (tx.type === 'topup' ? (tx.method === 'usdt' ? 'USDT 链上' : '银行卡') : '商户 ' + (tx.merchant || '—')) + ' · $' + (+tx.amount).toFixed(2) + (card ? ' · 尾号 ' + String(card.cardNo).replace(/\s/g, '').slice(-4) : '') });
  // 风控: 引擎命中(按 txId 关联) + 该用户事件时间轴(±24h 邻近片段)
  engineHits.filter(h2 => h2.txId === tx.id).forEach(h2 => steps.push({ layer: '风控', ts: h2.createdAt, title: '规则引擎命中: ' + h2.ruleName, note: '动作 ' + h2.action + ' · 处理结果 ' + h2.result + ' · 场景 ' + h2.scene }));
  riskEvents.filter(e => e.userId === tx.userId).forEach(e => e.timeline
    .filter(x => Math.abs(x.ts - tx.createdAt) < 864e5)
    .forEach(x => steps.push({ layer: '风控', ts: x.ts, title: '风险事件 #' + e.id + ' · ' + x.label, note: (x.note || '') + (x.operator ? ' · ' + x.operator : '') })));
  // 编排: localRef 关联的编排单状态机
  const o = orchTxs.find(x => x.localRef === tx.id);
  if (o) o.timeline.forEach(x => steps.push({ layer: '编排', ts: x.ts, title: o.sceneLabel + ' · ' + (x.from ? x.from + ' → ' + x.to : '进入 ' + x.to), note: (x.note || '') + ' · idem=' + (o.idempotencyKey || '—') }));
  // 账本: 该交易的复式分录
  ledgerEntries.filter(e => e.txId === tx.id).forEach(e => {
    const acc = ledgerAccounts.find(a => a.key === e.accountKey);
    steps.push({ layer: '账本', ts: e.createdAt, title: (acc ? acc.name : e.accountKey) + ' ' + (e.dir === 'debit' ? '借方' : '贷方') + ' $' + (+e.amount).toFixed(2), note: (e.memo || '') + ' · 分录后余额 $' + (+e.balanceAfter).toFixed(2) });
  });
  // 积分 / 佣金
  pointsLogs.filter(l => l.refNo == tx.id && l.userId === tx.userId).forEach(l => steps.push({ layer: '积分', ts: l.createdAt, title: (l.delta > 0 ? '+' : '') + l.delta + ' 分 · ' + l.source, note: '积分余额 ' + l.balanceAfter + ' 分' }));
  commissions.filter(c => c.refId === tx.id).forEach(c => steps.push({ layer: '佣金', ts: c.createdAt, title: c.typeLabel + ' · ' + c.tierLabel + '(' + (repById(c.salesId) || { name: '#' + c.salesId }).name + ')', note: '基数 $' + (+c.baseAmt).toFixed(2) + ' × ' + c.rate + ' = $' + (+c.amount).toFixed(2) + ' · ' + (c.status === 'settled' ? '已结算' : '待结算') }));
  steps.sort((a, b) => a.ts - b.ts);
  return {
    traceId: 'TRC-' + String(tx.id).padStart(8, '0'),
    tx: { id: tx.id, type: tx.type, status: tx.status, amount: tx.amount, method: tx.method || '', merchant: tx.merchant || '', createdAt: tx.createdAt, user: u ? u.name : '—', cardNoMask: card ? maskCardNo(card.cardNo) : '—' },
    steps, stepCount: steps.length,
    layers: ['用户端', '风控', '编排', '账本', '积分', '佣金'],
    note: 'traceId 按交易号生成; 时间线由既有数据(交易/引擎命中/风险事件/编排单/账本分录/积分/佣金)拼装; 生产接入 OpenTelemetry 全链路 span。',
  };
}
// 数据备份: 全量内存集合导出(卡号/CVV/手机号脱敏 — 数据脱敏演示)
function opsBackupData() {
  const data = {
    users: users.map(u => ({ ...u, phone: u.phone ? u.phone.slice(0, 6) + ' ****' + u.phone.slice(-2) : '' })),
    cards: cards.map(c => ({ ...c, cardNo: maskCardNo(c.cardNo), cvv: '***' })),
    transactions, pointsLogs, commissions, customers, orders, products, tasks,
    riskEvents, riskRules, approvals, engineRules, engineHits,
    ledgerAccounts, ledgerEntries,
    orchAdapters, orchTxs,
    entAccounts, entCards, mchAccounts, mchOrders, mchSettles,
    ffFlags, tenants,
  };
  const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length]));
  return {
    exportedAt: now(), version: 'demo-memory-1.0',
    note: '演示环境为纯内存数据, 本导出即全量备份(卡号/CVV/手机号已脱敏)。生产预留: MySQL 每日全量 dump + binlog 增量 + 对象存储归档, 保留 30 天, 恢复演练季度一次。',
    counts, data,
  };
}

function appendOpsLog(module, action, target, operator = 'Noura Al-Faisal', result = '成功') {
  opLogs.unshift({ id: opLogs.length ? Math.max(...opLogs.map(o => o.id)) + 1 : 910100, createdAt: now(), operator, module, action, target, result });
}

// 数据恢复控制台只暴露状态摘要, 不回显备份中的敏感字段
function opsDataState() {
  const counts = {
    users: users.length, cards: cards.length, transactions: transactions.length,
    pointsLogs: pointsLogs.length, commissions: commissions.length, customers: customers.length,
    orders: orders.length, products: products.length, approvals: approvals.length,
    riskEvents: riskEvents.length, ledgerEntries: ledgerEntries.length, orchTxs: orchTxs.length,
    kybCases: kybCases.length, compCases: compCases.length, entAccounts: entAccounts.length,
    entCards: entCards.length, mchAccounts: mchAccounts.length, mchOrders: mchOrders.length,
  };
  return {
    mode: 'memory', persistence: 'none', seededAt: demoSeededAt, lastAction: demoLastAction,
    restoreCount: demoRestoreCount, counts,
    totalRecords: Object.values(counts).reduce((sum, n) => sum + n, 0),
    restartBehavior: '进程重启后内存清空, 首次请求重新执行 initSeed() 生成演示种子',
    restoreBehavior: '控制台恢复会立即重建全部演示种子, 清空当前现场操作',
    backupBehavior: '备份导出为当前内存快照 JSON, 字段已脱敏; 当前 demo 不支持把快照回灌为业务数据',
  };
}

function ensureSeeded() { if (!inited) initSeed(); }
function getOpsDataState() { ensureSeeded(); return opsDataState(); }
function exportOpsBackup() {
  ensureSeeded();
  const backup = opsBackupData();
  appendOpsLog('运维中心', '数据备份导出', '全量内存 JSON · ' + Object.keys(backup.counts).length + ' 个集合 / ' + Object.values(backup.counts).reduce((sum, n) => sum + n, 0) + ' 条');
  return backup;
}
function restoreOpsSeed(reason = 'console_restore') {
  demoSeedReason = reason;
  inited = false;
  initSeed();
  appendOpsLog('运维中心', reason === 'console_restore' ? '恢复演示数据' : '重置演示数据', '全量重建初始种子');
  return { ok: true, at: now(), state: opsDataState() };
}

// 内部运行快照: 未脱敏，仅供受控 Repository/DO storage 使用，不能直接下载给前端。
function exportInternalSnapshot() {
  ensureSeeded();
  return createVersionedSnapshot({
    counters: { seed, idSeq, demoSeededAt, demoRestoreCount, demoLastAction, demoSeedReason },
    metadata: { persistence: 'runtime-internal' },
    data: {
      salesReps, users, cards, transactions, pointsLogs, commissions, customers, followups, products, orders, tasks,
      riskEvents, riskRules, riskLists, riskTags, financeMeta,
      sysAccounts, sysRoles, sysPerms, sysLogs, opLogs, sysParams, sysDicts,
      tenants, openApps, openKeys, openWebhooks, openApiLogs,
      notifyTemplates, notifySends, notifyChannels, approvals,
      engineRules, engineHits, engineVersions,
      orchAdapters, orchTxs, orchHealthLog, orchWebhookLogs, orchReconFixed,
      kybCases, sanctions, peps, strReports, userDocs, compCases, countryRules,
      entAccounts, entMembers, entDepts, entCards, entTxApprovals, entBills, entDeptLogs,
      mchAccounts, mchOrders, mchRefunds, mchSettles, mchSplits, mchRisk,
      ffFlags, opsRateCfg, rlBuckets: [...rlBuckets.entries()],
      ledgerAccounts, ledgerEntries, balanceSnapshots, frozenBalances, notifRead,
    },
  });
}

function importInternalSnapshot(input) {
  const snapshot = validateVersionedSnapshot(input);
  const d = structuredClone(snapshot.data);
  ({
    salesReps, users, cards, transactions, pointsLogs, commissions, customers, followups, products, orders, tasks,
    riskEvents, riskRules, riskLists, riskTags, financeMeta,
    sysAccounts, sysRoles, sysPerms, sysLogs, opLogs, sysParams, sysDicts,
    tenants, openApps, openKeys, openWebhooks, openApiLogs,
    notifyTemplates, notifySends, notifyChannels, approvals,
    engineRules, engineHits, engineVersions,
    orchAdapters, orchTxs, orchHealthLog, orchWebhookLogs, orchReconFixed,
    kybCases, sanctions, peps, strReports, userDocs, compCases, countryRules,
    entAccounts, entMembers, entDepts, entCards, entTxApprovals, entBills, entDeptLogs,
    mchAccounts, mchOrders, mchRefunds, mchSettles, mchSplits, mchRisk,
    ffFlags, opsRateCfg, ledgerAccounts, ledgerEntries, balanceSnapshots, frozenBalances, notifRead,
  } = d);
  rlBuckets = new Map(d.rlBuckets || []);
  ({ seed, idSeq, demoSeededAt, demoRestoreCount, demoLastAction, demoSeedReason } = snapshot.counters);
  inited = true;
  return opsDataState();
}

function getAdminAccountChoices() {
  if (!inited) initSeed();
  return salesReps.map(s => ({
    id: s.id, name: s.name, role: s.role, level: s.level, region: s.region,
    parentId: s.parentId, parentName: repById(s.parentId)?.name || '—',
    teamSize: subtreeIds(s.id).length - 1,
  }));
}

function getAppAccountChoices() {
  if (!inited) initSeed();
  return users.map(u => ({ id: u.id, name: u.name, phone: u.phone, kycLevel: u.kycLevel, points: u.points }));
}

function getMerchantAccountChoices() {
  if (!inited) initSeed();
  return {
    list: mchAccounts.filter(m => m.status === 'active').map(m => ({
      id: m.id, name: m.name, mchNo: m.mchNo, mcc: m.mcc,
      mccLabel: MCC_LABEL[m.mcc] || m.mcc, country: m.country, settleDays: m.settleDays,
    })),
  };
}

function changeAppCardStatus(userId, action) {
  if (!inited) initSeed();
  if (!users.some(u => u.id === userId)) return { status: 401, json: { error: '未登录', code: 'AUTH_REQUIRED' } };
  const card = cards.find(c => c.userId === userId);
  if (!card) return { status: 404, json: { error: '未找到卡' } };
  const transition = transitionCardStatus(card.status, action);
  if (!transition.ok) return { status: 400, json: { error: transition.error } };
  card.status = transition.status;
  return { status: 200, json: { status: card.status } };
}

// ---------------- API 路由(同步, 壳层负责 body 解析与响应写出) ----------------
// 返回 {status, json}; p=pathname, q=query, b=body, h=headers
function handleApi(method, p, q = {}, b = {}, h = {}, context = {}) {
  if (!inited) initSeed(); // 懒初始化: 首个请求时生成种子(此时 Date.now() 为真实时间)
  const J = (data, status = 200) => ({ status, json: data });
  // 演示数据一键重置: 重建全部种子, 清空现场操作产生的数据(须在 J 声明后)
  if (p === '/api/demo/reset' && method === 'POST') { demoSeedReason = 'header_reset'; inited = false; initSeed(); return J({ ok: true, at: now(), state: opsDataState() }); }

  // ============ 运营后台 / 销售工作台 ============
  if (p.startsWith('/api/admin')) {
    if (p === '/api/admin/accounts') { // demo 登录账号列表(匿名可见)
      return J(getAdminAccountChoices());
    }
    const actorSid = context.actor?.type === 'sales' ? context.actor.id : parseInt(h['x-sales'] || h['x-Sales'] || '0', 10);
    if (!repById(actorSid)) return J({ error: '请先选择运营后台账号', code: 'AUTH_REQUIRED' }, 401);
    const { sid, ids } = scopeOf(h, actorSid);
    const me = repById(sid);
    const scopedUserIds = users.filter(u => ids.includes(u.salesRepId)).map(u => u.id);
    const today = new Date().toDateString();
    const isToday = (ts) => new Date(ts).toDateString() === today;

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
          // P4.4 收尾: 解除风控时同步移除本事件产生的待结算冻结余额记录
          const fzKey = card ? 'card:' + card.id : '';
          for (let i = frozenBalances.length - 1; i >= 0; i--) {
            const f = frozenBalances[i];
            if (f.status !== 'frozen') continue;
            if (f.eventId === ev.id || (fzKey && f.accountKey === fzKey && (String(f.reason || '').startsWith('风控') || String(f.reason || '').startsWith('规则引擎冻结')))) frozenBalances.splice(i, 1);
          }
          ev.timeline.push({ ts: now(), node: 'release', label: '解除风控', note: '复核通过, 风险解除' + (card && card.status === 'active' ? ', 关联卡已解冻, 冻结余额已释放' : ''), operator: me.name });
        } else if (b.action === 'freeze') {
          ev.status = 'frozen';
          if (card && card.status === 'active') {
            card.status = 'frozen';
            // P4.4 收尾: 冻结=卡待结算余额全额冻结, 记入冻结余额台账(事件维度可回溯)
            ensureCardLedgerAccount(card);
            frozenBalances.push({ id: nid(), accountKey: 'card:' + card.id, amount: lgR2(card.balance),
              reason: '风控冻结 · 事件 #' + ev.id + ' · ' + String(ev.reason || '').slice(0, 60),
              createdAt: now(), status: 'frozen', eventId: ev.id });
          }
          ev.timeline.push({ ts: now(), node: 'freeze', label: '自动冻结', note: '手动触发自动冻结动作, 关联卡已冻结, 待结算余额已全额冻结', operator: me.name });
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
        const wasSettled = financeMeta.merchantSettled[name] === true;
        financeMeta.merchantSettled[name] = b.settled !== false;
        // P4.4 收尾: 标记结算时, 按未打款净额生成「商户待结算 → 渠道出金」转账分录(复式, 借贷平衡)
        let stlPosted = 0, stlTxId = '';
        if (b.settled !== false && !wasSettled) {
          const paid = +(financeMeta.merchantSettledAmt || {})[name] || 0;
          const due = +lgR2(row.net - paid);
          if (due > 0.005) {
            stlTxId = 'STL-' + name + '-' + isoDay(now());
            ensureMerchantLedgerAccount(name);
            postLedgerTx(stlTxId, '商户结算打款 · ' + name + ' · T+2', now(), [
              { key: 'merchant:' + name, dir: 'debit', amount: due, memo: '结算出金 · 净额(扣 2% 手续费) · 凭证 ' + row.voucher },
              { key: 'channel:fiat', dir: 'credit', amount: due, memo: '渠道出金支付商户结算款 · ' + name },
            ]);
            stlPosted = due;
            financeMeta.merchantSettledAmt = financeMeta.merchantSettledAmt || {};
            financeMeta.merchantSettledAmt[name] = row.net;
          }
        }
        return J({ row: { ...row, settled: financeMeta.merchantSettled[name], stlPosted, stlTxId } });
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
    // ============ P4.2 审批中心(总监专属, 其他角色一律 403) ============
    if (p === '/api/admin/approvals' || p.startsWith('/api/admin/approvals/')) {
      if (sid !== 1) return J({ error: '仅运营总监可访问审批中心' }, 403);
      if (p === '/api/admin/approvals' && method === 'GET') { // ?box=todo|mine|all & type= 流程类型
        const ffAp = ffFlags ? ffFlags.find(x => x.key === 'approvalsFlag') : null; // P5.6 Feature Flag 生效点
        if (ffAp && !ffAp.enabled) return J({ disabled: true, flag: 'approvalsFlag',
          notice: '审批中心功能已通过 Feature Flag 下线(approvalsFlag=off), 业务数据保留, 可在「运维中心 → Feature Flag」恢复',
          box: ['todo', 'mine', 'all'].indexOf(q.box) >= 0 ? q.box : 'todo', types: Object.keys(AP_TYPE_LABEL).map(k => ({ key: k, label: AP_TYPE_LABEL[k] })),
          summary: { todo: 0, mine: 0, approved: 0, rejected: 0, cancelled: 0, timeout: 0, total: approvals.length }, list: [] });
        const box = ['todo', 'mine', 'all'].indexOf(q.box) >= 0 ? q.box : 'todo';
        let list = [...approvals];
        if (box === 'todo') list = list.filter(a => a.status === 'pending');
        if (box === 'mine') list = list.filter(a => a.applicantId === sid);
        if (q.type) list = list.filter(a => a.type === q.type);
        list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        const cnt = (st) => approvals.filter(a => a.status === st).length;
        return J({ box,
          summary: { todo: cnt('pending'), mine: approvals.filter(a => a.applicantId === sid && a.status === 'pending').length,
            approved: cnt('approved'), rejected: cnt('rejected'), cancelled: cnt('cancelled'),
            timeout: approvals.filter(apTimeout).length, total: approvals.length },
          types: Object.keys(AP_TYPE_LABEL).map(k => ({ key: k, label: AP_TYPE_LABEL[k] })),
          list: list.map(pubApproval) });
      }
      const mApAct = p.match(/^\/api\/admin\/approvals\/(\d+)\/action$/);
      if (mApAct && method === 'POST') { // 动作: approve / reject(需原因) / transfer(转交) / cancel(发起人撤回)
        const a = approvals.find(x => x.id === +mApAct[1]);
        if (!a) return J({ error: '审批单不存在' }, 404);
        if (a.status !== 'pending') return J({ error: '该审批单已' + (AP_STATUS_LABEL[a.status] || a.status) + ', 不能再操作' }, 400);
        const node = a.nodes.find(n => n.state === 'active');
        if (b.action === 'cancel') {
          if (a.applicantId !== sid) return J({ error: '仅发起人可撤回审批单' }, 403);
          a.status = 'cancelled';
          a.nodes.forEach(n => { if (n.state === 'active') n.state = 'waiting'; });
          a.resultNote = '发起人撤回' + (b.reason ? ': ' + String(b.reason).slice(0, 120) : '') + ' (业务数据未变动)';
          a.finishedAt = a.updatedAt = now();
          return J({ approval: pubApproval(a) });
        }
        if (!node) return J({ error: '该审批单没有待办节点' }, 400);
        if (b.action === 'transfer') {
          const toName = String(b.toName || '').trim();
          if (!toName) return J({ error: '请填写转交给谁(审批人姓名)' }, 400);
          node.acts.push({ name: me.name, verdict: 'transfer', note: '转交给 ' + toName + (b.reason ? ' · ' + String(b.reason).slice(0, 120) : ''), ts: now() });
          node.approvers = [toName]; // 转交后由被转交人审批(或签/会签模式保持)
          a.updatedAt = now();
          return J({ approval: pubApproval(a) });
        }
        if (b.action === 'reject') {
          const reason = String(b.reason || '').trim();
          if (!reason) return J({ error: '驳回必须填写原因' }, 400);
          node.acts.push({ name: me.name, verdict: 'reject', note: reason.slice(0, 200), ts: now() });
          node.state = 'done';
          a.nodes.forEach(n => { if (n.state === 'active' || n.state === 'waiting') n.state = 'done'; });
          a.status = 'rejected';
          a.resultNote = '驳回于「' + node.name + '」: ' + reason.slice(0, 120) + ' (业务数据未变动)';
          a.finishedAt = a.updatedAt = now();
          return J({ approval: pubApproval(a) });
        }
        if (b.action === 'approve') {
          // 会签演示: b.as 可指定以节点内某审批人身份签批(默认总监本人); 或签=任一人通过即过, 会签=全部通过才过
          const acting = (b.as && node.approvers.indexOf(String(b.as)) >= 0) ? String(b.as) : me.name;
          if (node.acts.some(x => x.name === acting && x.verdict === 'approve')) return J({ error: acting + ' 在本节点已审批通过, 不能重复审批' }, 400);
          node.acts.push({ name: acting, verdict: 'approve', note: String(b.reason || '').slice(0, 200), ts: now() });
          const okNames = node.acts.filter(x => x.verdict === 'approve').map(x => x.name);
          const passed = node.mode === '会签' ? node.approvers.every(n => okNames.indexOf(n) >= 0) : true;
          if (passed) {
            node.state = 'done';
            const next = a.nodes.find(n => n.state === 'waiting');
            if (next) {
              next.state = 'active';
              a.updatedAt = now();
              return J({ approval: pubApproval(a), advanced: true, nextNode: next.name });
            }
            a.status = 'approved';
            a.finishedAt = a.updatedAt = now();
            a.resultNote = executeApprovalBiz(a); // 业务联动: 发卡/退款冲正/佣金打款/调账/KYC 生效
          } else a.updatedAt = now();
          return J({ approval: pubApproval(a), executed: a.status === 'approved', bizNote: a.resultNote || '' });
        }
        return J({ error: '无效动作, 支持 approve / reject / transfer / cancel' }, 400);
      }
      return J({ error: 'not found: ' + p }, 404);
    }
    // ============ P4.3 风控规则引擎(总监专属, 其他角色一律 403) ============
    if (p.startsWith('/api/admin/risk-engine')) {
      if (sid !== 1) return J({ error: '仅运营总监可访问风控规则引擎' }, 403);
      const normalizeConds = (raw) => {
        if (!Array.isArray(raw)) return null;
        const out = [];
        for (const c of raw) {
          const field = String(c.field || '');
          const op = String(c.op || '');
          if (!ENGINE_FIELDS[field] || !ENGINE_OPS[op]) return null;
          let v = c.value;
          if (op === 'in' || op === 'not_in') {
            const arr = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,，\s]+/);
            v = arr.map(String).map(s => s.trim()).filter(Boolean);
            if (!v.length) return null;
          } else {
            v = +(v || 0);
            if (!isFinite(v)) return null;
          }
          out.push({ field, op, value: v });
        }
        return out.length ? out : null;
      };
      if (p === '/api/admin/risk-engine/rules' && method === 'GET') {
        return J({ fields: ENGINE_FIELDS, ops: ENGINE_OPS,
          list: [...engineRules].sort((a, b) => (a.priority || 99) - (b.priority || 99)).map(serializeEngineRule),
          version: (engineVersions[engineVersions.length - 1] || {}).ver || 'v1.0' });
      }
      if (p === '/api/admin/risk-engine/rules' && method === 'POST') { // 新建规则
        const name = String(b.name || '').trim();
        if (!name) return J({ error: '请填写规则名' }, 400);
        if (engineRules.some(r => r.name === name)) return J({ error: '规则名已存在: ' + name }, 409);
        const conditions = normalizeConds(b.conditions);
        if (!conditions) return J({ error: '条件不合法: 需至少 1 条「字段+操作符+阈值」且字段/操作符受支持' }, 400);
        const scene = Array.isArray(b.scene) ? b.scene.filter(s => s === 'pay' || s === 'topup') : [];
        if (!scene.length) return J({ error: '请选择适用场景(消费/充值 至少一项)' }, 400);
        const action = ENGINE_ACTION_LABEL[b.action] ? b.action : 'review';
        const level = ['high', 'mid', 'low'].indexOf(b.level) >= 0 ? b.level : 'mid';
        const rule = { id: nid(), name, priority: +b.priority || 100, enabled: b.enabled !== false,
          action, level, weight: Math.max(0, Math.min(100, +b.weight || 15)), scene,
          condOp: b.condOp === 'or' ? 'or' : 'and', conditions,
          desc: String(b.desc || '').slice(0, 160), hits: 0, createdAt: now(), updatedAt: now() };
        engineRules.push(rule);
        const ver = bumpEngineVersion(me.name, '新增规则「' + name + '」', ['新增: ' + name + ' · ' + engineCondStr(rule) + ' → ' + ENGINE_ACTION_LABEL[action]]);
        return J({ rule: serializeEngineRule(rule), version: ver });
      }
      const mER = p.match(/^\/api\/admin\/risk-engine\/rules\/(\d+)$/);
      if (mER && method === 'PATCH') { // 编辑规则; 仅传 {enabled} 时为轻量启停
        const r = engineRules.find(x => x.id === +mER[1]);
        if (!r) return J({ error: '规则不存在' }, 404);
        if (Object.keys(b).length === 1 && typeof b.enabled === 'boolean') {
          r.enabled = b.enabled; r.updatedAt = now();
          const ver = bumpEngineVersion(me.name, (b.enabled ? '启用' : '停用') + '规则「' + r.name + '」', ['规则「' + r.name + '」' + (b.enabled ? '停用 → 启用' : '启用 → 停用')]);
          return J({ rule: serializeEngineRule(r), version: ver });
        }
        const changes = [];
        if (b.name != null) { const name = String(b.name).trim(); if (!name) return J({ error: '规则名不能为空' }, 400); if (name !== r.name) { changes.push('名称 ' + r.name + ' → ' + name); r.name = name; } }
        if (Array.isArray(b.conditions)) {
          const conditions = normalizeConds(b.conditions);
          if (!conditions) return J({ error: '条件不合法: 需至少 1 条「字段+操作符+阈值」' }, 400);
          const before = engineCondStr(r);
          r.conditions = conditions;
          const after = engineCondStr(r);
          if (before !== after) changes.push('条件 ' + before + ' → ' + after);
        }
        if (Array.isArray(b.scene)) { const scene = b.scene.filter(s => s === 'pay' || s === 'topup'); if (!scene.length) return J({ error: '适用场景不能为空' }, 400); if (scene.join() !== (r.scene || []).join()) { changes.push('场景 → ' + scene.join('/')); r.scene = scene; } }
        if (b.action != null && ENGINE_ACTION_LABEL[b.action] && b.action !== r.action) { changes.push('动作 ' + (ENGINE_ACTION_LABEL[r.action] || r.action) + ' → ' + ENGINE_ACTION_LABEL[b.action]); r.action = b.action; }
        if (b.level != null && ['high', 'mid', 'low'].indexOf(b.level) >= 0 && b.level !== r.level) { changes.push('等级 → ' + b.level); r.level = b.level; }
        if (b.priority != null && isFinite(+b.priority) && +b.priority !== r.priority) { changes.push('优先级 ' + r.priority + ' → ' + (+b.priority)); r.priority = +b.priority; }
        if (b.weight != null && isFinite(+b.weight)) { const w = Math.max(0, Math.min(100, +b.weight)); if (w !== r.weight) { changes.push('权重 ' + r.weight + ' → ' + w); r.weight = w; } }
        if (b.condOp != null) { const co = b.condOp === 'or' ? 'or' : 'and'; if (co !== r.condOp) { changes.push('条件关系 → ' + (co === 'or' ? '或' : '且')); r.condOp = co; } }
        if (b.desc != null) r.desc = String(b.desc).slice(0, 160);
        if (typeof b.enabled === 'boolean' && b.enabled !== r.enabled) { changes.push(b.enabled ? '停用 → 启用' : '启用 → 停用'); r.enabled = b.enabled; }
        r.updatedAt = now();
        const ver = bumpEngineVersion(me.name, '编辑规则「' + r.name + '」', changes.length ? changes : ['编辑规则「' + r.name + '」(元数据更新)']);
        return J({ rule: serializeEngineRule(r), version: ver });
      }
      if (mER && method === 'DELETE') {
        const i = engineRules.findIndex(x => x.id === +mER[1]);
        if (i < 0) return J({ error: '规则不存在' }, 404);
        const removed = engineRules.splice(i, 1)[0];
        const ver = bumpEngineVersion(me.name, '删除规则「' + removed.name + '」', ['删除: ' + removed.name + ' · ' + engineCondStr(removed) + ' (历史命中记录保留)']);
        return J({ ok: true, removed: removed.name, version: ver });
      }
      if (p === '/api/admin/risk-engine/scores') {
        const list = engineScoreAll();
        const cnt = (g) => list.filter(x => x.grade === g).length;
        return J({ list, summary: { users: list.length, high: cnt('high'), mid: cnt('mid'), low: cnt('low'),
          avg: list.length ? Math.round(list.reduce((s, x) => s + x.score, 0) / list.length) : 0 },
          version: (engineVersions[engineVersions.length - 1] || {}).ver || 'v1.0' });
      }
      if (p === '/api/admin/risk-engine/hits') {
        return J({ list: engineHits.slice(0, 200), summary: { total: engineHits.length,
          blocked: engineHits.filter(h => h.result === 'blocked').length, frozen: engineHits.filter(h => h.result === 'frozen').length,
          review: engineHits.filter(h => h.result === 'review').length, marked: engineHits.filter(h => h.result === 'marked').length } });
      }
      if (p === '/api/admin/risk-engine/versions') {
        return J({ current: (engineVersions[engineVersions.length - 1] || {}).ver || 'v1.0',
          list: [...engineVersions].sort((a, b) => b.at - a.at) });
      }
      return J({ error: 'not found: ' + p }, 404);
    }
    // ============ P5.1 支付和发卡编排(总监专属, 其他角色一律 403) ============
    if (p.startsWith('/api/admin/orch')) {
      if (sid !== 1) return J({ error: '仅运营总监可访问支付编排中心' }, 403);
      const logHealth = (adapterId, type, from, to, latencyMs, successRate, note) => {
        orchHealthLog.unshift({ id: orchHealthLog.length ? Math.max(...orchHealthLog.map(l => l.id)) + 1 : 980005, adapterId, at: now(), type, from, to, latencyMs, successRate, note });
        if (orchHealthLog.length > 120) orchHealthLog.length = 120;
      };
      const pubAdapter = (a) => ({ ...a, kindLabel: ORCH_KIND_LABEL[a.kind], fee1000: orchFeeOf(a, 1000) });
      // -- 适配器注册表
      if (p === '/api/admin/orch/adapters' && method === 'GET') {
        const cnt = (s) => orchAdapters.filter(a => a.status === s).length;
        return J({ list: orchAdapters.map(pubAdapter),
          kinds: [...new Set(orchAdapters.map(a => a.kind))].map(k => ({ key: k, label: ORCH_KIND_LABEL[k] })),
          summary: { total: orchAdapters.length, healthy: cnt('healthy'), degraded: cnt('degraded'), down: cnt('down'), disabled: orchAdapters.filter(a => a.enabled === false).length } });
      }
      const mAda = p.match(/^\/api\/admin\/orch\/adapters\/(\d+)$/);
      if (mAda && method === 'PATCH') { // 人工标记健康状态 / 调优先级 / 启停
        const a = orchById(mAda[1]);
        if (!a) return J({ error: '适配器不存在' }, 404);
        const changes = [];
        if (b.status != null && ['healthy', 'degraded', 'down'].includes(b.status) && b.status !== a.status) {
          const from = a.status;
          a.status = b.status;
          a.manual = b.status !== 'healthy'; // 人工标记异常后, 探测不自动恢复; 人工恢复健康即清除标记
          logHealth(a.id, 'manual', from, a.status, a.latencyMs, a.successRate, '人工标记: ' + String(b.note || (b.status === 'down' ? '演示故障切换' : '演示降权')) + (a.manual ? '(探测不改状态)' : ''));
          changes.push('状态 ' + from + ' → ' + a.status + (a.manual ? '(人工标记, 自动探测不改状态)' : '(人工恢复)'));
        }
        if (b.priority != null && isFinite(+b.priority) && +b.priority > 0 && +b.priority !== a.priority) {
          changes.push('优先级 ' + a.priority + ' → ' + (+b.priority));
          a.priority = +b.priority;
        }
        if (typeof b.enabled === 'boolean' && b.enabled !== a.enabled) { a.enabled = b.enabled; changes.push(b.enabled ? '启用适配器' : '停用适配器(路由不再选中)'); }
        if (!changes.length) return J({ error: '无可更新字段: status(healthy/degraded/down) / priority / enabled' }, 400);
        return J({ adapter: pubAdapter(a), changes });
      }
      // -- 渠道路由表: 场景 × 币种 → 选中渠道 + 备选 + 决策原因(实时计算, 标记宕机后自动切换)
      if (p === '/api/admin/orch/routes' && method === 'GET') {
        const scenes = Object.keys(ORCH_SCENE_KIND);
        const currencies = ['USD', 'AED', 'SAR'];
        const brief = (a, amt) => a ? { id: a.id, name: a.name, kindLabel: ORCH_KIND_LABEL[a.kind], priority: a.priority, effPriority: orchEffPriority(a), status: a.status, latencyMs: a.latencyMs, successRate: a.successRate, feeRate: a.feeRate, feeFixed: a.feeFixed, fee100: orchFeeOf(a, amt) } : null;
        const table = [];
        scenes.forEach(sc => currencies.forEach(cc => {
          const r = routeFor(sc, cc);
          table.push({ scene: sc, sceneLabel: ORCH_SCENE_LABEL[sc], currency: cc,
            adapter: brief(r.adapter, 100), backup: brief(r.backup, 100), reason: r.reason });
        }));
        return J({ table, scenes: scenes.map(k => ({ key: k, label: ORCH_SCENE_LABEL[k] })), currencies,
          note: '路由实时计算: 标记渠道 down/degraded 后刷新即可看到故障切换' });
      }
      if (p === '/api/admin/orch/routes/simulate' && method === 'GET') { // 模拟一次路由决策(不下单)
        const scene = String(q.scene || 'topup_fiat');
        const currency = String(q.currency || 'USD').toUpperCase();
        const amount = Math.max(1, +q.amount || 1000);
        if (!ORCH_SCENE_KIND[scene]) return J({ error: '未知场景: ' + scene + ', 支持: ' + Object.keys(ORCH_SCENE_KIND).join(' / ') }, 400);
        const r = routeFor(scene, currency);
        if (!r.adapter) return J({ error: '无可路由渠道: ' + r.reason }, 409);
        const est = orchFeeOf(r.adapter, amount);
        return J({ scene, sceneLabel: ORCH_SCENE_LABEL[scene], currency, amount,
          decision: { adapterId: r.adapter.id, adapterName: r.adapter.name, priority: r.adapter.priority, status: r.adapter.status, latencyMs: r.adapter.latencyMs, successRate: r.adapter.successRate, estimatedFee: est, totalCost: +(amount + est).toFixed(2) },
          backup: r.backup ? { id: r.backup.id, name: r.backup.name, priority: r.backup.priority, estimatedFee: orchFeeOf(r.backup, amount) } : null,
          candidates: r.candidates.map(x => ({ id: x.id, name: x.name, status: x.status, effPriority: orchEffPriority(x), estimatedFee: orchFeeOf(x, amount) })),
          reason: r.reason });
      }
      // -- 健康检查: 时间线 + 一键全量探测
      if (p === '/api/admin/orch/health' && method === 'GET') {
        return J({ list: orchHealthLog.slice(0, 100),
          adapters: orchAdapters.map(a => ({ id: a.id, name: a.name, kindLabel: ORCH_KIND_LABEL[a.kind], status: a.status, manual: a.manual, latencyMs: a.latencyMs, successRate: a.successRate, mttdMs: a.mttdMs })),
          summary: { healthy: orchAdapters.filter(a => a.status === 'healthy').length, degraded: orchAdapters.filter(a => a.status === 'degraded').length, down: orchAdapters.filter(a => a.status === 'down').length, probes: orchHealthLog.filter(l => l.type === 'probe').length, manual: orchHealthLog.filter(l => l.type === 'manual').length } });
      }
      if (p === '/api/admin/orch/health/check' && method === 'POST') { // 一键全量探测(人工标记的状态不被覆盖)
        const results = orchAdapters.map(a => {
          const latency = Math.max(30, a.latencyMs + ri(-60, 80));
          const sr = +Math.min(99.9, Math.max(80, a.successRate + (rnd() < 0.5 ? -0.2 : 0.3))).toFixed(1);
          const from = a.status;
          let to = a.status;
          let note = '探测: 延迟 ' + latency + 'ms / 成功率 ' + sr + '%';
          if (a.manual) note += '(人工标记 ' + a.status + ', 探测不改状态)';
          else if (a.status === 'degraded') { to = 'healthy'; note += ', 探活恢复, 自动解除降级'; }
          a.latencyMs = latency; a.successRate = sr;
          if (from !== to) a.status = to;
          logHealth(a.id, 'probe', from, to, latency, sr, note);
          return { id: a.id, name: a.name, from, to, latencyMs: latency, successRate: sr, manual: a.manual };
        });
        const snap = routeFor('pay', 'USD');
        return J({ results, routing: { scene: 'pay', currency: 'USD', adapter: snap.adapter ? snap.adapter.name : null, reason: snap.reason },
          note: '全量健康探测完成: ' + results.length + ' 个适配器(降级渠道探活成功自动恢复, 人工标记不动)' });
      }
      // -- 费率比较: 按场景分组, $1000 样本总成本排名
      if (p === '/api/admin/orch/compare' && method === 'GET') {
        const amount = Math.max(1, +q.amount || 1000);
        const groups = Object.keys(ORCH_SCENE_KIND).map(sc => {
          const kind = ORCH_SCENE_KIND[sc];
          const list = orchAdapters.filter(a => a.kind === kind && (a.caps.scenes || []).includes(sc))
            .map(a => ({ id: a.id, name: a.name, status: a.status, enabled: a.enabled !== false, priority: a.priority, feeRate: a.feeRate, feeFixed: a.feeFixed, fee1000: orchFeeOf(a, 1000), total: orchFeeOf(a, amount), note: (a.caps && a.caps.note) || '' }))
            .sort((x, y) => x.total - y.total);
          const r = routeFor(sc, 'USD');
          return { scene: sc, sceneLabel: ORCH_SCENE_LABEL[sc], kindLabel: ORCH_KIND_LABEL[kind], sampleAmount: amount, list, routed: r.adapter ? r.adapter.id : null };
        });
        return J({ amount, groups });
      }
      // -- 编排交易列表(含出站 webhook 通知记录)
      if (p === '/api/admin/orch/txs' && method === 'GET') {
        let list = orchTxs;
        if (q.state) list = list.filter(t => t.state === String(q.state));
        if (q.scene) list = list.filter(t => t.scene === String(q.scene));
        const cnt = (s) => orchTxs.filter(t => t.state === s).length;
        return J({ list: [...list].sort((a, b) => b.createdAt - a.createdAt).map(pubOrchTx),
          webhooks: orchWebhookLogs.slice(0, 50),
          summary: { total: orchTxs.length, created: cnt('created'), pending: cnt('pending'), processing: cnt('processing'), success: cnt('success'), failed: cnt('failed'), reversed: cnt('reversed'), refunded: cnt('refunded'), callbacks: orchTxs.reduce((s, t) => s + t.callbacks.length, 0) },
          scenes: Object.keys(ORCH_SCENE_KIND).map(k => ({ key: k, label: ORCH_SCENE_LABEL[k] })),
          states: Object.keys(ORCH_STATE_LABEL).map(k => ({ key: k, label: ORCH_STATE_LABEL[k] })) });
      }
      // -- 新建编排单: 幂等控制(相同 idempotencyKey 返回同一订单, 不重复提交渠道)
      if (p === '/api/admin/orch/txs' && method === 'POST') {
        const scene = String(b.scene || '');
        if (!ORCH_SCENE_KIND[scene]) return J({ error: '不支持的场景: ' + (scene || '(空)') + ', 支持: ' + Object.keys(ORCH_SCENE_KIND).join(' / ') }, 400);
        const amount = +b.amount;
        if (!(amount > 0)) return J({ error: '金额必须大于 0' }, 400);
        const currency = String(b.currency || 'USD').toUpperCase();
        const key = String(b.idempotencyKey || '').trim();
        if (key) {
          const exist = orchTxs.find(t => t.idempotencyKey === key);
          if (exist) return J({ idempotent: true, tx: pubOrchTx(exist), note: '幂等命中: 相同 idempotencyKey(' + key + ')不重复下单, 返回同一订单 #' + exist.id });
        }
        const r = routeFor(scene, currency);
        if (!r.adapter) return J({ error: '无可路由渠道: ' + r.reason }, 409);
        const t = { id: nid(), scene, sceneLabel: ORCH_SCENE_LABEL[scene], amount: +amount.toFixed(2), currency,
          adapterId: r.adapter.id, state: 'created', idempotencyKey: key || null,
          timeoutMs: scene === 'topup_crypto' ? 30000 : 15000,
          attempts: [], callbacks: [], timeline: [{ ts: now(), from: null, to: 'created', note: '编排单创建, 路由决策: ' + r.adapter.name + '(' + r.reason + ')' }],
          userId: +b.userId || null, localRef: null, channelStatus: null, note: '', reconSeed: null, reconFixed: null,
          createdAt: now(), updatedAt: now() };
        orchTxs.push(t);
        orchTransit(t, 'pending', '已提交 ' + r.adapter.name + '(尝试 #1), 等待渠道异步回调');
        t.attempts.push({ no: 1, adapterId: r.adapter.id, at: now(), latencyMs: r.adapter.latencyMs, result: 'accepted', note: '渠道已受理' });
        return J({ idempotent: false, tx: pubOrchTx(t), routing: { adapter: r.adapter.name, backup: r.backup ? r.backup.name : null, reason: r.reason } });
      }
      const mTx = p.match(/^\/api\/admin\/orch\/tx\/(\d+)$/);
      if (mTx && method === 'GET') {
        const t = orchTxs.find(x => x.id === +mTx[1]);
        if (!t) return J({ error: '编排单不存在' }, 404);
        const local = t.localRef != null ? transactions.find(x => x.id === t.localRef) : null;
        const a = orchById(t.adapterId);
        return J({ tx: pubOrchTx(t), adapter: a ? pubAdapter(a) : null,
          localTx: local ? { id: local.id, type: local.type, status: local.status, amount: local.amount, createdAt: local.createdAt } : null,
          nextStates: ORCH_NEXT[t.state] || [] });
      }
      const mAct = p.match(/^\/api\/admin\/orch\/tx\/(\d+)\/(callback|replay|compensate|reverse|refund)$/);
      if (mAct && method === 'POST') {
        const t = orchTxs.find(x => x.id === +mAct[1]);
        if (!t) return J({ error: '编排单不存在' }, 404);
        const act = mAct[2];
        if (act === 'callback') { // 异步回调模拟: 渠道回执 success/fail → 驱动状态机至终态
          if (!['pending', 'processing'].includes(t.state)) return J({ error: '仅待受理/处理中状态可接收渠道回调, 当前: ' + ORCH_STATE_LABEL[t.state] }, 409);
          const type = b.result === 'fail' ? 'fail' : 'success';
          if (t.state === 'pending') orchTransit(t, 'processing', '渠道受理回执到达');
          t.callbacks.push({ at: now(), type, receipt: String(b.receipt || 'RCPT-' + ri(100000, 999999)), source: 'channel-async-callback', note: String(b.note || (type === 'success' ? '渠道确认成功' : '渠道返回失败')) });
          orchTransit(t, type === 'success' ? 'success' : 'failed', '渠道异步回调: ' + type + ' 回执');
          t.channelStatus = type;
          return J({ tx: pubOrchTx(t), note: '回调已受理, 编排单进入终态并已发出站 webhook 通知' });
        }
        if (act === 'replay') { // 重放: failed/created → 重新路由提交
          if (!['failed', 'created'].includes(t.state)) return J({ error: '仅失败/已创建的编排单可重放, 当前: ' + ORCH_STATE_LABEL[t.state] }, 409);
          const r = routeFor(t.scene, t.currency);
          if (!r.adapter) return J({ error: '无可路由渠道: ' + r.reason }, 409);
          if (!orchTransit(t, 'pending', '人工重放: 重新路由至 ' + r.adapter.name + '(' + r.reason + ')')) return J({ error: '状态机不允许该迁移' }, 409);
          t.adapterId = r.adapter.id;
          t.attempts.push({ no: t.attempts.length + 1, adapterId: r.adapter.id, at: now(), latencyMs: r.adapter.latencyMs, result: 'accepted', note: '重放尝试 #' + (t.attempts.length) });
          return J({ tx: pubOrchTx(t), note: '已重放至 ' + r.adapter.name + ', 等待渠道回调' });
        }
        if (act === 'compensate') { // 超时补偿: 超过 timeoutMs 重查渠道回执(默认成功, 可指定 outcome=fail)
          if (!['pending', 'processing'].includes(t.state)) return J({ error: '仅待受理/处理中可执行超时补偿, 当前: ' + ORCH_STATE_LABEL[t.state] }, 409);
          const age = now() - t.updatedAt;
          if (age < t.timeoutMs && b.force !== true) return J({ error: '未到超时阈值: 需 ' + t.timeoutMs + 'ms, 已等待 ' + age + 'ms(可传 force: true 强制)' }, 409);
          const outcome = b.outcome === 'fail' ? 'failed' : 'success';
          t.attempts.push({ no: t.attempts.length + 1, adapterId: t.adapterId, at: now(), latencyMs: ri(120, 400), result: outcome === 'success' ? 'success' : 'fail', note: '超时补偿: 重查渠道回执 → ' + outcome });
          if (t.state === 'pending') orchTransit(t, 'processing', '超时补偿: 转处理中并重查回执');
          orchTransit(t, outcome, '超时补偿: 渠道回执重查结果为 ' + outcome);
          t.channelStatus = outcome;
          return J({ tx: pubOrchTx(t), note: '超时补偿完成: 渠道回执 ' + outcome });
        }
        if (act === 'reverse') { // 冲正演示: success → reversed
          if (t.state !== 'success') return J({ error: '仅成功单可冲正, 当前: ' + ORCH_STATE_LABEL[t.state] }, 409);
          orchTransit(t, 'reversed', String(b.note || '人工冲正: 撤销渠道侧已授权交易'));
          t.channelStatus = 'reversed';
          return J({ tx: pubOrchTx(t), note: '已冲正: 渠道侧授权撤销, 编排单终态 reversed' });
        }
        if (act === 'refund') { // 退款演示: success → refunded
          if (t.state !== 'success') return J({ error: '仅成功单可退款, 当前: ' + ORCH_STATE_LABEL[t.state] }, 409);
          orchTransit(t, 'refunded', String(b.note || '原路退款(演示)'));
          t.channelStatus = 'refunded';
          return J({ tx: pubOrchTx(t), note: '已退款: 原路退回, 编排单终态 refunded' });
        }
      }
      // -- 对账: 编排单(渠道) vs 交易流水(本地) vs 资金账本 三方比对
      if (p === '/api/admin/orch/recon' && method === 'GET') {
        const diffs = orchReconDiffs();
        return J({ ranAt: now(), diffs, fixed: orchReconFixed,
          summary: { checked: orchTxs.length, matched: orchTxs.filter(t => !t.reconSeed || t.reconFixed).length, open: diffs.length, fixedCount: orchReconFixed.length,
            channelSuccessLocalMissing: diffs.filter(d => d.type === 'channel_success_local_missing').length,
            localSuccessChannelTimeout: diffs.filter(d => d.type === 'local_success_channel_timeout').length },
          note: '三方比对: 编排单(渠道口径) × 交易流水(本地口径) × 资金账本(记账口径)' });
      }
      const mFix = p.match(/^\/api\/admin\/orch\/diff\/(\d+)\/fix$/);
      if (mFix && method === 'POST') { // 补单
        const item = orchReconDiffs().find(d => d.id === +mFix[1]);
        if (!item) return J({ error: '差异不存在或已处理' }, 404);
        const r = orchFixDiff(item, me.name);
        if (r.error) return J(r, 409);
        orchReconFixed.unshift({ ...item, fixedAt: now(), by: me.name, fixNote: r.note });
        return J({ ok: true, note: r.note, remaining: orchReconDiffs().length });
      }
      return J({ error: 'not found: ' + p }, 404);
    }
    // ============ P5.2 合规中心(总监专属, 其他角色一律 403) ============
    if (p.startsWith('/api/admin/compliance')) {
      if (sid !== 1) return J({ error: '仅运营总监可访问合规中心' }, 403);
      // -- C 端 KYC 案例: 12 持卡人KYC 档案 + 证件 + 审核轨迹(联动审批中心 kyc_upgrade)
      if (p === '/api/admin/compliance/kyc' && method === 'GET') {
        const list = users.map(u => {
          const docs = userDocs.filter(d => d.userId === u.id);
          const linked = approvals.filter(a => a.type === 'kyc_upgrade' && a.payload && a.payload.userId === u.id)
            .map(a => ({ id: a.id, title: a.title, status: a.status, statusLabel: { pending: '审批中', approved: '已通过', rejected: '已驳回', cancelled: '已撤回' }[a.status] || a.status, createdAt: a.createdAt }));
          const lim = KYC_LIMITS[u.kycLevel] || { perTx: 0, perDay: 0 };
          const trail = [{ ts: u.createdAt, node: '开户建档', note: '初始 KYC L' + u.kycLevel + ' · ' + (u.kycLevel === 0 ? '基础档(免证件, 低限额)' : '证件已核验'), operator: '系统' }];
          docs.forEach(d => trail.push({ ts: d.createdAt, node: '证件提交', note: d.typeLabel + ' ' + d.number + ' · 有效期至 ' + isoDay(d.expiry), operator: '客户' }));
          if (u.kycStatus === 'pending_upgrade') trail.push({ ts: daysAgo(2, 6), node: '申请升级', note: '提交升级材料, 已转审批中心「KYC 升级」流程', operator: '客户' });
          linked.forEach(a => trail.push({ ts: a.createdAt, node: '审批流转', note: a.title + ' · ' + a.statusLabel, operator: '审批中心' }));
          return { userId: u.id, name: u.name, country: u.country, cc: u.cc, city: u.city,
            kycLevel: u.kycLevel, kycLevelLabel: ['L0 基础档', 'L1 初级', 'L2 高级'][u.kycLevel] || ('L' + u.kycLevel),
            kycStatus: u.kycStatus, statusLabel: u.kycStatus === 'approved' ? '已认证' : '升级审核中',
            levelBand: u.kycLevel === 2 ? 'high' : u.kycLevel === 1 ? 'mid' : 'low',
            perTxLimit: lim.perTx, perDayLimit: lim.perDay,
            docs: docs.map(d => ({ ...d, expiryDay: isoDay(d.expiry), daysLeft: Math.ceil((d.expiry - now()) / 864e5) })),
            trail, linkedApprovals: linked };
        });
        const band = (b2) => list.filter(x => x.levelBand === b2).length;
        return J({ list, summary: { total: list.length, low: band('low'), mid: band('mid'), high: band('high'), pendingUpgrade: list.filter(x => x.kycStatus === 'pending_upgrade').length },
          note: 'KYC 升级审批在「审批中心 → kyc_upgrade」流程中处理, 通过后等级与限额自动生效' });
      }
      // -- B 端 KYB
      if (p === '/api/admin/compliance/kyb' && method === 'GET') {
        const cnt = (s) => kybCases.filter(k => k.status === s).length;
        return J({ list: kybCases.map(k => ({ ...k, statusLabel: KYB_STATUS_LABEL[k.status], uboCount: (k.ubos || []).length })),
          summary: { total: kybCases.length, pending: cnt('pending'), approved: cnt('approved'), rejected: cnt('rejected'), info_required: cnt('info_required'), ubos: kybCases.reduce((s, k) => s + (k.ubos || []).length, 0), pepUbos: kybCases.reduce((s, k) => s + (k.ubos || []).filter(u => u.pep).length, 0) } });
      }
      const mKyb = p.match(/^\/api\/admin\/compliance\/kyb\/(\d+)\/action$/);
      if (mKyb && method === 'POST') { // approve / reject / request_info
        const k = kybCases.find(x => x.id === +mKyb[1]);
        if (!k) return J({ error: 'KYB 案件不存在' }, 404);
        const action = String(b.action || '');
        const ALLOWED = { pending: ['approve', 'reject', 'request_info'], info_required: ['approve', 'reject'], approved: [], rejected: [] };
        if (!(ALLOWED[k.status] || []).includes(action)) {
          const names = { approve: '通过', reject: '驳回', request_info: '要求补充材料' };
          return J({ error: '当前状态「' + KYB_STATUS_LABEL[k.status] + '」不允许' + (names[action] || action) + ', 允许: ' + ((ALLOWED[k.status] || []).join(' / ') || '无(已终态)') }, 409);
        }
        const reason = String(b.reason || '').trim();
        if ((action === 'reject' || action === 'request_info') && !reason) return J({ error: (action === 'reject' ? '驳回' : '要求补充材料') + '必须填写原因' }, 400);
        const NODE = { approve: '终审通过', reject: '终审驳回', request_info: '要求补充材料' };
        const NOTE = { approve: 'KYB 审核通过, 开通企业钱包与批量发卡资格', reject: '驳回: ' + reason, request_info: '补充材料: ' + reason };
        k.status = { approve: 'approved', reject: 'rejected', request_info: 'info_required' }[action];
        k.reviewedAt = now();
        k.timeline.push({ ts: now(), node: NODE[action], note: NOTE[action], operator: me.name });
        return J({ case: { ...k, statusLabel: KYB_STATUS_LABEL[k.status], uboCount: (k.ubos || []).length } });
      }
      // -- AML 筛查: 单个姓名模糊筛查(制裁 + PEP)
      if (p === '/api/admin/compliance/screen' && method === 'POST') {
        const name = String(b.name || '').trim();
        if (!name) return J({ error: '请填写筛查姓名' }, 400);
        return J(screenName(name, String(b.country || '').toUpperCase()));
      }
      // -- 全量筛查结果: 12 持卡人 + 全部 KYB UBO
      if (p === '/api/admin/compliance/screenings' && method === 'GET') {
        const list = complianceScreenings();
        const hit = list.filter(x => x.hits.length);
        return J({ list, summary: { total: list.length, hit: hit.length, clean: list.length - hit.length,
            sanctionHits: hit.filter(x => x.hits.some(h2 => h2.kind === 'sanction')).length,
            pepHits: hit.filter(x => x.hits.some(h2 => h2.kind === 'pep')).length,
            high: hit.filter(x => x.grade === 'high').length, mid: hit.filter(x => x.grade === 'mid').length, low: hit.filter(x => x.grade === 'low').length },
          note: '模糊匹配口径: 精确/包含/别名/词元 + 同国家加成' });
      }
      if (p === '/api/admin/compliance/sanctions' && method === 'GET') {
        const kw = String(q.kw || '').toLowerCase();
        const list = kw ? sanctions.filter(s => s.name.toLowerCase().includes(kw) || (s.aliases || []).some(a => a.toLowerCase().includes(kw)) || s.country.toLowerCase() === kw || s.listSource.toLowerCase() === kw) : sanctions;
        return J({ list, summary: { total: sanctions.length, individual: sanctions.filter(s => s.type === 'individual').length, entity: sanctions.filter(s => s.type === 'entity').length, ofac: sanctions.filter(s => s.listSource === 'OFAC').length, eu: sanctions.filter(s => s.listSource === 'EU').length, un: sanctions.filter(s => s.listSource === 'UN').length } });
      }
      if (p === '/api/admin/compliance/peps' && method === 'GET') {
        const kw = String(q.kw || '').toLowerCase();
        const list = kw ? peps.filter(p => p.name.toLowerCase().includes(kw) || p.position.toLowerCase().includes(kw) || p.country.toLowerCase() === kw) : peps;
        const cnt = (l) => peps.filter(p => p.level === l).length;
        return J({ list, summary: { total: peps.length, high: cnt('high'), medium: cnt('medium'), low: cnt('low') } });
      }
      // -- STR 可疑交易报告
      if (p === '/api/admin/compliance/str' && method === 'GET') {
        const cnt = (s) => strReports.filter(r => r.status === s).length;
        return J({ list: [...strReports].sort((a, b) => b.createdAt - a.createdAt).map(r => {
          const u = users.find(x => x.id === r.userId);
          return { ...r, statusLabel: STR_STATUS_LABEL[r.status], userName: u ? u.name : '用户 #' + r.userId, userCountry: u ? u.country : '—' };
        }), summary: { total: strReports.length, draft: cnt('draft'), submitted: cnt('submitted'), closed: cnt('closed') } });
      }
      if (p === '/api/admin/compliance/str' && method === 'POST') { // 一键从风险事件生成 STR 草稿
        const ev = b.riskEventId != null ? riskEvents.find(x => x.id === +b.riskEventId) : null;
        if (!ev) return J({ error: '风险事件不存在: ' + (b.riskEventId == null ? '(未传 riskEventId)' : b.riskEventId) + ', 请在「风控中心 → 风险事件」选择' }, 404);
        const rule = engineRules.find(r => r.id === ev.ruleId);
        const rep = { id: nid(), refNo: 'STR-' + new Date().getFullYear() + '-' + String(41 + strReports.length).padStart(4, '0'),
          userId: ev.userId, triggerRule: rule ? 'R' + rule.id + ' ' + rule.name : (ev.reason || '风控规则'), triggerEventId: ev.id,
          amount: ev.amount || 0, status: 'draft',
          note: '由风险事件 #' + ev.id + ' 一键生成: ' + (ev.reason || '') + ' · 待合规补充分析后报送',
          createdAt: now(), submittedAt: null, closedAt: null };
        strReports.push(rep);
        return J({ report: rep, note: '已生成 STR 草稿 ' + rep.refNo + ', 可在列表中一键报送' });
      }
      const mStr = p.match(/^\/api\/admin\/compliance\/str\/(\d+)\/submit$/);
      if (mStr && method === 'POST') {
        const r = strReports.find(x => x.id === +mStr[1]);
        if (!r) return J({ error: 'STR 不存在' }, 404);
        if (r.status !== 'draft') return J({ error: '仅草稿状态可报送, 当前: ' + STR_STATUS_LABEL[r.status] }, 409);
        r.status = 'submitted'; r.submittedAt = now();
        return J({ report: r, note: r.refNo + ' 已通过监管门户报送(模拟)' });
      }
      // -- 证件管理: 有效期 90/30/7 天三档提醒
      if (p === '/api/admin/compliance/docs' && method === 'GET') {
        const list = userDocs.map(d => {
          const daysLeft = Math.ceil((d.expiry - now()) / 864e5);
          const tier = docTier(daysLeft);
          return { ...d, expiryDay: isoDay(d.expiry), daysLeft, tier: tier.key, tierLabel: tier.label };
        }).sort((a, b) => a.daysLeft - b.daysLeft);
        const cnt = (k) => list.filter(d => d.tier === k).length;
        return J({ list, summary: { total: list.length, expired: cnt('expired'), d7: cnt('d7'), d30: cnt('d30'), d90: cnt('d90'), ok: cnt('ok') },
          tiers: [{ key: 'd7', label: '7 天内', color: 'red' }, { key: 'd30', label: '30 天内', color: 'amber' }, { key: 'd90', label: '90 天内', color: 'amber' }] });
      }
      // -- 合规案件
      if (p === '/api/admin/compliance/cases' && method === 'GET') {
        const cnt = (s) => compCases.filter(c => c.status === s).length;
        return J({ list: [...compCases].sort((a, b) => b.createdAt - a.createdAt).map(c => ({ ...c, typeLabel: COMP_CASE_TYPE_LABEL[c.type] })),
          summary: { total: compCases.length, open: cnt('open'), investigating: cnt('investigating'), closed: cnt('closed') } });
      }
      const mCs = p.match(/^\/api\/admin\/compliance\/cases\/(\d+)\/action$/);
      if (mCs && method === 'POST') { // investigate / close / reopen
        const c = compCases.find(x => x.id === +mCs[1]);
        if (!c) return J({ error: '合规案件不存在' }, 404);
        const action = String(b.action || '');
        const FLOW = { open: ['investigate', 'close'], investigating: ['close'], closed: ['reopen'] };
        if (!(FLOW[c.status] || []).includes(action)) return J({ error: '当前状态(' + c.status + ')不允许该操作, 允许: ' + (FLOW[c.status] || []).join(' / ') || '无' }, 409);
        const NODE = { investigate: '开始调查', close: '结案', reopen: '重新立案' };
        const DEF_NOTE = { investigate: '调取关联 KYC/交易/筛查记录, 进入调查', close: '调查完毕, 结案归档', reopen: '有新线索, 重新立案调查' };
        if (action === 'investigate') c.status = 'investigating';
        else if (action === 'close') c.status = 'closed';
        else c.status = 'investigating';
        c.timeline.push({ ts: now(), node: NODE[action], note: String(b.note || '').trim() || DEF_NOTE[action], operator: me.name });
        return J({ case: { ...c, typeLabel: COMP_CASE_TYPE_LABEL[c.type] } });
      }
      // -- 国家/地区政策限制(仅展示, 不接入交易链路)
      if (p === '/api/admin/compliance/countries' && method === 'GET') {
        const cnt = (l) => countryRules.filter(c => c.level === l).length;
        return J({ list: [...countryRules].sort((a, b) => ({ prohibited: 0, restricted: 1, allowed: 2 }[a.level] ?? 3) - ({ prohibited: 0, restricted: 1, allowed: 2 }[b.level] ?? 3)),
          summary: { total: countryRules.length, prohibited: cnt('prohibited'), restricted: cnt('restricted'), allowed: cnt('allowed') },
          note: '政策清单仅作合规展示, 未接入交易链路(演示)' });
      }
      return J({ error: 'not found: ' + p }, 404);
    }

    // ============ P5.3 企业服务(总监专属) ============
    if (p.startsWith('/api/admin/ent/')) {
      if (sid !== 1) return J({ error: '企业服务为运营总监专属功能' }, 403);
      // -- 企业列表 + 演示流程指引
      if (p === '/api/admin/ent/accounts' && method === 'GET') {
        const list = entAccounts.map(pubEnt);
        const cnt = (s) => entAccounts.filter(e => e.status === s).length;
        return J({ list,
          summary: { total: entAccounts.length, active: cnt('active'), frozen: cnt('frozen'), pending: cnt('pending'),
            balanceTotal: lgR2(entAccounts.reduce((s, e) => s + e.balance, 0)), creditTotal: lgR2(entAccounts.reduce((s, e) => s + (e.creditLimit || 0), 0)),
            cards: entCards.length, members: entMembers.length, depts: entDepts.length,
            pendingApprovals: entTxApprovals.filter(a => a.status === 'pending').length, pendingBills: entBills.filter(x => x.status === 'pending').length },
          flow: ['企业充值', '分配部门预算', '员工消费', '部门审批', '企业结算'] });
      }
      // -- 企业详情抽屉(成员 / 部门 / 卡 / 审批 / 账单 / 预算变更历史 / 账本余额)
      const mEnt = p.match(/^\/api\/admin\/ent\/accounts\/(\d+)$/);
      if (mEnt && method === 'GET') {
        const e = entById(mEnt[1]); if (!e) return J({ error: '企业不存在' }, 404);
        const acct = ledgerAccounts.find(a => a.key === 'ent:' + e.id);
        return J({ ent: pubEnt(e),
          members: entMembersOf(e.id).map(m => ({ ...m, roleLabel: ENT_MEMBER_ROLE_LABEL[m.role] || m.role, statusLabel: ENT_MEMBER_STATUS_LABEL[m.status] || m.status,
            cards: entCards.filter(c => c.memberId === m.id).length })),
          depts: entDeptsOf(e.id).map(d => ({ ...d, remaining: entDeptRemaining(d),
            usage: d.monthlyBudget ? +(100 * (d.used || 0) / d.monthlyBudget).toFixed(1) : 0, cardCount: entCards.filter(c => c.deptId === d.id).length })),
          cards: entCardsOf(e.id).map(pubEntCard),
          approvals: entTxApprovals.filter(a => a.entId === e.id).slice(0, 30).map(pubEntApproval),
          bills: entBills.filter(x => x.entId === e.id).map(pubEntBill),
          budgetLogs: entDeptLogs.filter(l => entDeptsOf(e.id).some(d => d.id === l.deptId)),
          ledger: acct ? { key: acct.key, balance: acct.balance, typeLabel: LEDGER_TYPE_LABEL[acct.type] || acct.type } : null });
      }
      // -- 企业充值: routeFor 选 Fiat/Crypto 适配器 → postLedgerTx 借渠道 / 贷企业主账户(负债)
      if (p === '/api/admin/ent/topup' && method === 'POST') {
        const ent = entById(b.entId); if (!ent) return J({ error: '企业不存在' }, 404);
        if (ent.status !== 'active') return J({ error: '企业状态「' + (ENT_STATUS_LABEL[ent.status] || ent.status) + '」不可充值' }, 409);
        const amount = lgR2(+b.amount); if (!(amount > 0)) return J({ error: '请填写正确的充值金额' }, 400);
        const payWay = b.method === 'usdt' ? 'usdt' : 'fiat';
        const scene = payWay === 'usdt' ? 'topup_crypto' : 'topup_fiat';
        const route = routeFor(scene, 'USD');
        if (!route.adapter) return J({ error: '渠道路由失败: ' + route.reason }, 409);
        ensureEntLedgerAccount(ent);
        const chKey = payWay === 'usdt' ? 'channel:usdt' : 'channel:fiat';
        ensureLedgerAccount(chKey, 'channel', payWay === 'usdt' ? '渠道 · 加密网关' : '渠道 · 法币网关');
        postLedgerTx('ENTT' + nid(), '企业充值 · ' + ent.name, now(), [
          { key: chKey, dir: 'debit', amount, memo: '企业对公渠道收款 · 路由 ' + route.adapter.name },
          { key: 'ent:' + ent.id, dir: 'credit', amount, memo: '充值入企业主账户(' + (payWay === 'usdt' ? 'USDT' : '法币') + ')' },
        ]);
        ent.balance = lgR2(ent.balance + amount);
        entTimelineAdd(ent, '企业充值', '$' + amount.toFixed(2) + ' 经 ' + route.adapter.name + '(' + (payWay === 'usdt' ? '加密网关' : '法币网关') + ') 入企业主账户 · 路由决策: ' + route.reason, me && me.name);
        return J({ ok: true, ent: pubEnt(ent), balance: ent.balance,
          route: { adapter: route.adapter.name, scene: ORCH_SCENE_LABEL[scene] || scene, reason: route.reason, backup: route.backup ? route.backup.name : '无' },
          note: '复式分录: 借 ' + chKey + ' / 贷 ent:' + ent.id });
      }
      // -- 部门预算调整(记录变更历史 entDeptLogs)
      const mDept = p.match(/^\/api\/admin\/ent\/depts\/(\d+)\/budget$/);
      if (mDept && method === 'POST') {
        const d = entDeptById(mDept[1]); if (!d) return J({ error: '部门不存在' }, 404);
        const delta = lgR2(+b.delta); if (!delta) return J({ error: '调整幅度不能为 0' }, 400);
        const from = lgR2(d.monthlyBudget), to = lgR2(from + delta);
        if (to < 0) return J({ error: '调整后预算不能为负(当前 $' + from.toFixed(2) + ', 已用 $' + (d.used || 0).toFixed(2) + ')' }, 400);
        d.monthlyBudget = to;
        const log = { id: nid(), deptId: d.id, from, to, delta, note: String(b.note || '').trim() || (delta > 0 ? '预算追加' : '预算削减'), by: (me && me.name) || '总监', at: now() };
        entDeptLogs.unshift(log);
        entTimelineAdd(entById(d.entId), '部门预算调整', d.name + '(' + d.ccNo + ') $' + from.toFixed(2) + ' → $' + to.toFixed(2) + (log.note ? ' · ' + log.note : ''), me && me.name);
        return J({ ok: true, dept: { ...d, remaining: entDeptRemaining(d), usage: to ? +(100 * (d.used || 0) / to).toFixed(1) : 0 }, log,
          note: '变更已记入预算调整历史(变更前 $' + from.toFixed(2) + ' → 变更后 $' + to.toFixed(2) + ')' });
      }
      // -- 批量发卡: 直接生成企业卡 + 审批中心 ent_card_issue 备案单(不阻塞)
      if (p === '/api/admin/ent/cards/issue' && method === 'POST') {
        const ent = entById(b.entId); if (!ent) return J({ error: '企业不存在' }, 404);
        if (ent.status !== 'active') return J({ error: '企业状态「' + (ENT_STATUS_LABEL[ent.status] || ent.status) + '」不可发卡' }, 409);
        const dept = entDeptById(b.deptId); if (!dept || dept.entId !== ent.id) return J({ error: '部门不存在或不属于该企业' }, 404);
        const count = Math.min(20, Math.max(1, +b.count || 1));
        const level = ENT_CARD_PRESET[b.level] ? b.level : 'standard';
        const members = entMembersOf(ent.id).filter(m => m.status === 'active');
        if (!members.length) return J({ error: '该企业没有在职成员可持卡' }, 409);
        const newCards = [];
        for (let i = 0; i < count; i++) {
          const m = members[(entCardsOf(ent.id).length + i) % members.length];
          const card = { id: nid(), entId: ent.id, memberId: m.id, holderName: m.name, deptId: dept.id,
            cardNo: genEntCardNo(), level, limits: { ...ENT_CARD_PRESET[level] }, status: 'active', issuedAt: now() };
          entCards.push(card); newCards.push(card);
        }
        const admin = members.find(m => m.role === 'admin') || members[0];
        const apNo = nid();
        approvals.unshift({ id: apNo, type: 'ent_card_issue', typeLabel: '企业批量发卡',
          title: ent.name + ' 批量发卡 ×' + count + '(' + ((CARD_LEVELS[level] || {}).label || level) + ')',
          bizRef: '企业服务模块已直接发 ' + count + ' 张企业卡(部门: ' + dept.name + ' · 成本中心 ' + dept.ccNo + '), 本单为审批中心备案归档, 不阻塞发卡',
          amount: null, payload: { entId: ent.id, deptId: dept.id, count, level, cardIds: newCards.map(c => c.id) },
          applicant: (me && me.name) || '总监', applicantId: sid, applyNote: '批量发卡备案: 卡段 5311* · 成本中心 ' + dept.ccNo,
          status: 'pending', nodes: [{ key: '企业管理员确认', name: '企业管理员确认', mode: '或签', approvers: [admin.name], state: 'active', acts: [] }],
          createdAt: now(), updatedAt: now(), finishedAt: null, resultNote: '' });
        entTimelineAdd(ent, '批量发卡', dept.name + '(' + dept.ccNo + ')新发 ' + count + ' 张企业卡(' + level + '), 已生成审批中心备案单 #' + apNo, me && me.name);
        return J({ ok: true, cards: newCards.map(pubEntCard), count: newCards.length, approvalNo: apNo,
          note: '已发 ' + count + ' 张企业卡(卡段 5311*), 并生成审批中心「企业批量发卡」备案单(不阻塞, 可在审批中心归档)' });
      }
      // -- 员工卡限额设置(单笔/日/月)
      if (p === '/api/admin/ent/cards/limits' && method === 'POST') {
        const card = entCardById(b.cardId); if (!card) return J({ error: '企业卡不存在' }, 404);
        const single = lgR2(+b.single), daily = lgR2(+b.daily), monthly = lgR2(+b.monthly);
        if (!(single > 0 && daily > 0 && monthly > 0)) return J({ error: '单笔 / 日 / 月限额必须大于 0' }, 400);
        if (single > daily || daily > monthly) return J({ error: '限额需满足: 单笔 ≤ 日 ≤ 月' }, 400);
        const from = { ...card.limits };
        card.limits = { single, daily, monthly };
        entTimelineAdd(entById(card.entId), '卡限额调整', (card.holderName || '员工卡') + ' ' + maskCardNo(card.cardNo) + ' 单笔 $' + from.single.toFixed(2) + '→$' + single.toFixed(2) + ' / 日 $' + from.daily.toFixed(2) + '→$' + daily.toFixed(2) + ' / 月 $' + from.monthly.toFixed(2) + '→$' + monthly.toFixed(2), me && me.name);
        return J({ ok: true, card: pubEntCard(card), from, note: '限额已更新(次日生效口径, 演示即时生效)' });
      }
      // -- 员工消费模拟: 超部门剩余预算 或 超卡单笔限额 → 生成待审批单; 额度内免审直接入账
      if (p === '/api/admin/ent/consume' && method === 'POST') {
        const ent = entById(b.entId); if (!ent) return J({ error: '企业不存在' }, 404);
        const card = entCardById(b.cardId); if (!card || card.entId !== ent.id) return J({ error: '企业卡不存在或不属于该企业' }, 404);
        if (ent.status !== 'active') return J({ error: '企业状态「' + (ENT_STATUS_LABEL[ent.status] || ent.status) + '」不可消费' }, 409);
        if (card.status !== 'active') return J({ error: '该卡已冻结/停用, 不可消费' }, 409);
        const amount = lgR2(+b.amount); if (!(amount > 0)) return J({ error: '请填写正确的消费金额' }, 400);
        if (amount > ent.balance) return J({ error: '企业主账户余额不足($' + ent.balance.toFixed(2) + '), 请先充值' }, 409);
        const merchant = String(b.merchant || '').trim() || '企业采购';
        const dept = entDeptById(card.deptId);
        const reasons = [];
        if (amount > (card.limits || {}).single) reasons.push('超卡单笔限额 $' + lgR2(card.limits.single).toFixed(2));
        if (dept && amount > entDeptRemaining(dept)) reasons.push('超部门剩余预算 $' + entDeptRemaining(dept).toFixed(2));
        const rec = { id: nid(), entId: ent.id, cardId: card.id, memberId: card.memberId, memberName: card.holderName || '—',
          deptId: card.deptId, merchant, amount, note: String(b.note || '员工企业卡消费').slice(0, 200),
          trigger: reasons.join(' 且 '), status: reasons.length ? 'pending' : 'auto',
          createdAt: now(), actedAt: reasons.length ? null : now(), actedBy: '', actNote: reasons.length ? '' : '额度与预算内, 免审直接入账' };
        entTxApprovals.unshift(rec);
        if (reasons.length) return J({ needApproval: true, approval: pubEntApproval(rec),
          note: '触发审批(' + rec.trigger + '), 已生成待审批单 → 企业服务 · 消费审批 处理' });
        entConsumePost(rec);
        return J({ ok: true, auto: true, approval: pubEntApproval(rec), balance: ent.balance, deptUsed: dept ? dept.used : null,
          note: '额度与预算内免审入账: 借企业主账户 / 贷商户净额 / 贷手续费(1.5%), 并已扣减部门预算' });
      }
      // -- 消费审批列表
      if (p === '/api/admin/ent/approvals' && method === 'GET') {
        let list = entTxApprovals.map(pubEntApproval);
        if (q.status) list = list.filter(a => a.status === q.status);
        const cnt = (s) => entTxApprovals.filter(a => a.status === s).length;
        return J({ list: list.sort((x, y) => y.createdAt - x.createdAt),
          summary: { total: entTxApprovals.length, pending: cnt('pending'), approved: cnt('approved') + cnt('auto'), rejected: cnt('rejected'),
            pendingAmount: lgR2(entTxApprovals.filter(a => a.status === 'pending').reduce((s, a) => s + a.amount, 0)) },
          rule: '超部门剩余预算 或 超卡单笔限额的消费需审批人批准; 通过 → 复式记账+扣部门预算, 驳回 → 不记账不动预算' });
      }
      // -- 消费审批动作: approve → entConsumePost 记账+扣预算 / reject → 只留痕
      const mAp = p.match(/^\/api\/admin\/ent\/approvals\/(\d+)\/action$/);
      if (mAp && method === 'POST') {
        const a = entTxApprovals.find(x => x.id === +mAp[1]); if (!a) return J({ error: '审批单不存在' }, 404);
        if (a.status !== 'pending') return J({ error: '仅待审批单可操作, 当前状态: ' + (ENT_AP_STATUS_LABEL[a.status] || a.status) }, 409);
        const action = String(b.action || '');
        const note = String(b.note || '').trim();
        const ent = entById(a.entId);
        const approver = (entMembersOf(a.entId).find(m => m.role === 'approver') || {}).name || (me && me.name) || '审批人';
        if (action === 'approve') {
          if (a.amount > ent.balance) return J({ error: '企业主账户余额不足($' + ent.balance.toFixed(2) + '), 无法入账' }, 409);
          const fee = entConsumePost(a);
          a.status = 'approved'; a.actedAt = now(); a.actedBy = approver; a.actNote = note || '审批人批准, 已入账';
          entTimelineAdd(ent, '消费审批通过', a.memberName + ' @ ' + a.merchant + ' $' + lgR2(a.amount).toFixed(2) + ' 已入账(手续费 $' + fee.toFixed(2) + '), 部门预算已扣减', approver);
          return J({ ok: true, approval: pubEntApproval(a), entBalance: ent.balance, ledgerTxId: 'ENTX' + a.id, fee,
            note: '已复式记账(借 ent:' + ent.id + ' / 贷 merchant:' + a.merchant + ' / 贷 fee)并扣减部门预算' });
        }
        if (action === 'reject') {
          if (!note) return J({ error: '驳回必须填写原因' }, 400);
          a.status = 'rejected'; a.actedAt = now(); a.actedBy = approver; a.actNote = note;
          entTimelineAdd(ent, '消费审批驳回', a.memberName + ' @ ' + a.merchant + ' $' + lgR2(a.amount).toFixed(2) + ' · ' + note + '(未记账, 未扣预算)', approver);
          return J({ ok: true, approval: pubEntApproval(a), note: '已驳回: 未记账、未扣部门预算' });
        }
        return J({ error: '未知 action: ' + action }, 400);
      }
      // -- 企业账单列表
      if (p === '/api/admin/ent/bills' && method === 'GET') {
        let list = entBills.map(pubEntBill);
        if (q.status) list = list.filter(x => x.status === q.status);
        const cnt = (s) => entBills.filter(x => x.status === s).length;
        return J({ list: list.sort((a, b) => b.period < a.period ? -1 : 1),
          summary: { total: entBills.length, pending: cnt('pending'), paid: cnt('paid'),
            pendingTotal: lgR2(entBills.filter(x => x.status === 'pending').reduce((s, x) => s + (x.total != null ? x.total : x.serviceFee), 0)) },
          rule: '月度账单 = 当月已入账消费汇总 + ' + (ENT_BILL_FEE_RATE * 100).toFixed(1) + '% 账单服务费; 开票生成发票号, 支付从企业主账户扣服务费(借 ent / 贷 fee)' });
      }
      // -- 开票
      const mInv = p.match(/^\/api\/admin\/ent\/bills\/(\d+)\/invoice$/);
      if (mInv && method === 'POST') {
        const bl = entBills.find(x => x.id === +mInv[1]); if (!bl) return J({ error: '账单不存在' }, 404);
        if (bl.invoiceNo) return J({ error: '该账单已开票: ' + bl.invoiceNo }, 409);
        bl.invoiceNo = 'INV-' + bl.period.replace('-', '') + '-' + String(ri(10000, 99999));
        bl.invoicedAt = now();
        entTimelineAdd(entById(bl.entId), '账单开票', bl.period + ' 月度账单 $' + lgR2(bl.total != null ? bl.total : bl.serviceFee).toFixed(2) + ' → 发票号 ' + bl.invoiceNo, me && me.name);
        return J({ ok: true, bill: pubEntBill(bl), note: '发票号已生成(电子发票, 演示)' });
      }
      // -- 支付账单: 从企业主账户扣 0.5% 服务费(消费已在发生时实时入账, 不重复扣款)
      const mPay = p.match(/^\/api\/admin\/ent\/bills\/(\d+)\/pay$/);
      if (mPay && method === 'POST') {
        const bl = entBills.find(x => x.id === +mPay[1]); if (!bl) return J({ error: '账单不存在' }, 404);
        if (bl.status === 'paid') return J({ error: '该账单已支付(' + isoDay(bl.paidAt) + ')' }, 409);
        const ent = entById(bl.entId);
        const payable = lgR2(bl.total != null ? bl.total : bl.serviceFee);
        if (payable > ent.balance) return J({ error: '企业主账户余额不足($' + ent.balance.toFixed(2) + '), 需 $' + payable.toFixed(2) + ', 请先充值' }, 409);
        ensureEntLedgerAccount(ent);
        postLedgerTx('ENTB' + bl.id + '-' + nid(), '企业账单支付 · ' + ent.name + ' · ' + bl.period, now(), [
          { key: 'ent:' + ent.id, dir: 'debit', amount: payable, memo: bl.period + ' 账单服务费 0.5%(消费款已在发生时实时入账)' },
          { key: 'fee', dir: 'credit', amount: payable, memo: '账单服务费收入 · 账单 #' + bl.id },
        ]);
        ent.balance = lgR2(ent.balance - payable);
        bl.status = 'paid'; bl.paidAt = now(); bl.paidBy = (me && me.name) || '总监';
        if (!bl.invoiceNo) { bl.invoiceNo = 'INV-' + bl.period.replace('-', '') + '-' + String(ri(10000, 99999)); bl.invoicedAt = now(); }
        entTimelineAdd(ent, '账单支付', bl.period + ' 账单已支付 $' + payable.toFixed(2) + '(服务费) · 发票 ' + bl.invoiceNo, me && me.name);
        return J({ ok: true, bill: pubEntBill(bl), entBalance: ent.balance,
          note: '已支付并记账(借 ent:' + ent.id + ' / 贷 fee), 消费本金已在发生时实时入账不重复扣款' });
      }
      // -- 部门报表(预算使用率排行)
      if (p === '/api/admin/ent/report' && method === 'GET') {
        const rows = entDepts.map(d => {
          const ent = entById(d.entId);
          const dCards = entCards.filter(c => c.deptId === d.id);
          const apv = entTxApprovals.filter(a => a.deptId === d.id);
          const used = lgR2(d.used || 0);
          return { deptId: d.id, entId: d.entId, entName: ent ? ent.name : '—', deptName: d.name, ccNo: d.ccNo, owner: d.owner,
            budget: lgR2(d.monthlyBudget), used, remaining: entDeptRemaining(d),
            usage: d.monthlyBudget ? +(100 * used / d.monthlyBudget).toFixed(1) : 0,
            cardCount: dCards.length, avgPerCard: dCards.length ? lgR2(used / dCards.length) : 0,
            approvedCount: apv.filter(a => a.status === 'approved' || a.status === 'auto').length,
            pendingCount: apv.filter(a => a.status === 'pending').length, rejectedCount: apv.filter(a => a.status === 'rejected').length };
        }).sort((a, b) => b.usage - a.usage);
        return J({ list: rows,
          summary: { depts: rows.length, budgetTotal: lgR2(rows.reduce((s, r) => s + r.budget, 0)), usedTotal: lgR2(rows.reduce((s, r) => s + r.used, 0)),
            cards: entCards.length, avgUsage: rows.length ? +(rows.reduce((s, r) => s + r.usage, 0) / rows.length).toFixed(1) : 0 },
          note: '按部门月度预算使用率排行, 可定位超支风险部门' });
      }
      return J({ error: 'not found: ' + p }, 404);
    }

    // ============ P5.4 商户平台·后台侧(总监专属) ============
    if (p.startsWith('/api/admin/mch/')) {
      if (sid !== 1) return J({ error: '商户平台为运营总监专属功能' }, 403);
      // -- 商户入驻列表(联动 KYB)
      if (p === '/api/admin/mch/accounts' && method === 'GET') {
        const list = mchAccounts.map(pubMchAccount);
        const cnt = (s) => mchAccounts.filter(m => m.status === s).length;
        return J({ list,
          summary: { total: mchAccounts.length, pending: cnt('pending'), active: cnt('active'), rejected: cnt('rejected'),
            orders: mchOrders.length, paidVolume: lgR2(mchOrders.filter(o => o.status !== 'disputed').reduce((s, o) => s + o.amount, 0)) },
          flow: ['商户入驻审核', '费率配置', '收款交易', '退款/风控', '结算打款'] });
      }
      // -- 入驻审核: approve → active + 生成商户号/API Key / reject → 驳回(必填原因)
      const mMchA = p.match(/^\/api\/admin\/mch\/accounts\/(\d+)\/action$/);
      if (mMchA && method === 'POST') {
        const m = mchById(mMchA[1]); if (!m) return J({ error: '商户不存在' }, 404);
        if (m.status !== 'pending') return J({ error: '仅待审核商户可操作, 当前状态: ' + (MCH_STATUS_LABEL[m.status] || m.status) }, 409);
        const action = String(b.action || '');
        const reason = String(b.reason || '').trim();
        const kyb = kybOf(m);
        if (action === 'approve') {
          if (kyb && kyb.status === 'rejected') return J({ error: '关联 KYB 案例 #' + kyb.id + ' 已被驳回, 不可开通(需商户重新提交入驻与尽调材料)' }, 409);
          m.status = 'active'; m.mchNo = genMchNo(); m.reviewedAt = now(); m.apiKey = genMchApiKey();
          mchTimelineAdd(m, '入驻审核通过', '商户号 ' + m.mchNo + ' 已生成 · 结算周期 T+' + m.settleDays + ' · 费率 ' + pubMchAccount(m).rateLabel
            + (kyb && kyb.status !== 'approved' ? ' · 合规提示: 关联 KYB #' + kyb.id + ' ' + (KYB_STATUS_LABEL[kyb.status] || kyb.status) + ', 请补审' : ''), me && me.name);
          if (kyb && kyb.status === 'pending') kyb.status = 'approved', kyb.decidedAt = now(), (kyb.timeline || (kyb.timeline = [])).unshift({ ts: now(), node: '审核通过', note: '商户入驻审核联动: 收单开通, 商户号 ' + m.mchNo, operator: (me && me.name) || '总监' });
          return J({ ok: true, mch: pubMchAccount(m), note: '已开通收单并生成商户号 ' + m.mchNo + '(API Key 已下发, 商户端可登录)' });
        }
        if (action === 'reject') {
          if (!reason) return J({ error: '驳回必须填写原因' }, 400);
          m.status = 'rejected'; m.rejectReason = reason; m.reviewedAt = now();
          mchTimelineAdd(m, '入驻驳回', reason, me && me.name);
          if (kyb && kyb.status === 'pending') kyb.status = 'rejected', kyb.decidedAt = now(), (kyb.timeline || (kyb.timeline = [])).unshift({ ts: now(), node: '审核驳回', note: '商户入驻驳回联动: ' + reason, operator: (me && me.name) || '总监' });
          return J({ ok: true, mch: pubMchAccount(m), note: '已驳回(' + reason + ')' });
        }
        return J({ error: '未知 action: ' + action }, 400);
      }
      // -- 费率配置: 借记/贷记/换汇 + 借记封顶 + T+0/1/2/3
      const mMchR = p.match(/^\/api\/admin\/mch\/accounts\/(\d+)\/rate$/);
      if (mMchR && method === 'POST') {
        const m = mchById(mMchR[1]); if (!m) return J({ error: '商户不存在' }, 404);
        const credit = +b.credit, debit = +b.debit, fx = +b.fx, debitCap = +b.debitCap, settleDays = +b.settleDays;
        if (!(credit > 0 && credit <= 0.1) || !(debit > 0 && debit <= 0.1) || !(fx > 0 && fx <= 0.1)) return J({ error: '费率需在 (0%, 10%] 区间' }, 400);
        if (!(debitCap >= 0.5 && debitCap <= 50)) return J({ error: '借记封顶需在 $0.5 - $50' }, 400);
        if (![0, 1, 2, 3].includes(settleDays)) return J({ error: '结算周期仅支持 T+0 / T+1 / T+2 / T+3' }, 400);
        const from = { rate: { ...m.rate }, settleDays: m.settleDays };
        m.rate = { credit: Math.round(credit * 10000) / 10000, debit: Math.round(debit * 10000) / 10000, fx: Math.round(fx * 10000) / 10000, debitCap: lgR2(debitCap) };
        m.settleDays = settleDays;
        mchTimelineAdd(m, '费率/结算周期调整', '贷记 ' + (credit * 100).toFixed(2) + '% / 借记 ' + (debit * 100).toFixed(2) + '%(封顶 $' + debitCap.toFixed(2) + ') / 换汇 ' + (fx * 100).toFixed(2) + '% · 结算 T+' + settleDays, me && me.name);
        return J({ ok: true, mch: pubMchAccount(m), from,
          note: '费率已生效(新交易按新费率计费, 历史订单不追溯)' });
      }
      // -- 收款订单
      if (p === '/api/admin/mch/orders' && method === 'GET') {
        let list = mchOrders.map(pubMchOrder);
        if (q.status) list = list.filter(o => o.status === q.status);
        if (q.mchId) list = list.filter(o => o.mchId === +q.mchId);
        const cnt = (s) => mchOrders.filter(o => o.status === s).length;
        return J({ list: list.sort((a, b2) => b2.createdAt - a.createdAt),
          summary: { total: mchOrders.length, paid: cnt('paid'), refunded: cnt('refunded'), disputed: cnt('disputed'),
            amount: lgR2(mchOrders.reduce((s, o) => s + o.amount, 0)), fee: lgR2(mchOrders.reduce((s, o) => s + o.fee, 0)), net: lgR2(mchOrders.reduce((s, o) => s + o.net, 0)) },
          note: '收单订单实时入账: 借 channel:fiat / 贷 merchant:名(净额) / 贷 fee' });
      }
      // -- 退款管理
      if (p === '/api/admin/mch/refunds' && method === 'GET') {
        let list = mchRefunds.map(pubMchRefund);
        if (q.status) list = list.filter(r => r.status === q.status);
        const cnt = (s) => mchRefunds.filter(r => r.status === s).length;
        return J({ list: list.sort((a, b2) => b2.appliedAt - a.appliedAt),
          summary: { total: mchRefunds.length, pending: cnt('pending'), approved: cnt('approved'), rejected: cnt('rejected'),
            pendingAmount: lgR2(mchRefunds.filter(r => r.status === 'pending').reduce((s, r) => s + (pubMchRefund(r).amount || 0), 0)) },
          note: '退款通过 → 反向分录(借商户净额+借手续费 / 贷渠道原路退回) + 订单转 refunded + 联动待结算批次重算' });
      }
      const mRf = p.match(/^\/api\/admin\/mch\/refunds\/(\d+)\/action$/);
      if (mRf && method === 'POST') {
        const rf = mchRefunds.find(x => x.id === +mRf[1]); if (!rf) return J({ error: '退款单不存在' }, 404);
        if (rf.status !== 'pending') return J({ error: '仅待审核退款可操作, 当前状态: ' + (MCH_REFUND_STATUS_LABEL[rf.status] || rf.status) }, 409);
        const action = String(b.action || '');
        const note = String(b.note || '').trim();
        if (action === 'approve') {
          const o = mchOrderById(rf.orderId); if (!o) return J({ error: '退款单关联订单不存在' }, 404);
          if (o.status !== 'paid') return J({ error: '订单当前状态「' + (MCH_ORDER_STATUS_LABEL[o.status] || o.status) + '」不可退款' }, 409);
          mchRefundLedgerPost(rf, now());
          o.status = 'refunded'; o.refundedAt = now();
          rf.status = 'approved'; rf.approvedAt = now(); rf.approvedBy = (me && me.name) || '总监'; rf.actNote = note || '同意全额退款(原路退回)';
          let batchTouched = null;
          mchSettles.filter(bt => bt.status === 'pending' && (bt.orderIds || []).includes(o.id)).forEach(bt => {
            bt.orderIds = bt.orderIds.filter(x => x !== o.id); mchBatchRecompute(bt); batchTouched = bt.id;
          });
          const m = mchById(o.mchId);
          mchTimelineAdd(m, '订单退款', '订单 ' + o.orderNo + ' $' + lgR2(o.amount).toFixed(2) + ' 已原路退回(反向分录 MRFD' + rf.id + ')' + (batchTouched ? ' · 待结算批次 #' + batchTouched + ' 已联动重算' : ''), me && me.name);
          return J({ ok: true, refund: pubMchRefund(rf), order: pubMchOrder(o), batchTouched,
            note: '反向分录已入账(MRFD' + rf.id + ': 借 merchant:' + o.merchant + ' 净额+借 fee / 贷 channel:fiat)' });
        }
        if (action === 'reject') {
          if (!note) return J({ error: '驳回必须填写原因' }, 400);
          rf.status = 'rejected'; rf.approvedAt = now(); rf.approvedBy = (me && me.name) || '总监'; rf.actNote = note;
          return J({ ok: true, refund: pubMchRefund(rf), note: '已驳回(' + note + '), 订单与账本不变' });
        }
        return J({ error: '未知 action: ' + action }, 400);
      }
      // -- 结算管理(与 P4.4 商户结算页共存, 不改旧端点)
      if (p === '/api/admin/mch/settles' && method === 'GET') {
        let list = mchSettles.map(pubMchSettle);
        if (q.status) list = list.filter(x => x.status === q.status);
        if (q.mchId) list = list.filter(x => x.mchId === +q.mchId);
        const pend = mchSettles.filter(x => x.status === 'pending'), done = mchSettles.filter(x => x.status === 'settled');
        return J({ list: list.sort((a, b2) => (a.status === b2.status ? (b2.day < a.day ? -1 : 1) : a.status === 'pending' ? -1 : 1)),
          summary: { total: mchSettles.length, pending: pend.length, settled: done.length,
            pendingNet: lgR2(pend.reduce((s, x) => s + x.net, 0)), settledNet: lgR2(done.reduce((s, x) => s + x.net, 0)) },
          note: '「结算」按 T+N 打款: STL- 复式分录 借 merchant:名 / [分账拆付 贷接收方×N] / 贷 channel:fiat' });
      }
      const mSt = p.match(/^\/api\/admin\/mch\/settles\/(\d+)\/settle$/);
      if (mSt && method === 'POST') {
        const bt = mchSettles.find(x => x.id === +mSt[1]); if (!bt) return J({ error: '结算批次不存在' }, 404);
        if (bt.status !== 'pending') return J({ error: '仅待结算批次可打款, 当前: ' + (MCH_SETTLE_STATUS_LABEL[bt.status] || bt.status) }, 409);
        if (!(bt.orderIds || []).length) return J({ error: '该批次订单已全部退款冲回, 无可结算金额(可忽略该批次)' }, 409);
        const r = mchSettleLedgerPost(bt, now());
        const m = mchById(bt.mchId);
        mchTimelineAdd(m, '结算打款', '批次 #' + bt.id + '(' + bt.day + ') $' + lgR2(bt.net).toFixed(2) + ' 已打款 · 凭证 ' + r.voucher + (r.splitCount ? ' · 分账拆付 ' + r.splitCount + ' 笔 $' + r.splitSum.toFixed(2) : ''), me && me.name);
        return J({ ok: true, batch: pubMchSettle(bt), voucher: r.voucher, paidOut: r.payout, splitSum: r.splitSum, splitCount: r.splitCount,
          note: 'STL 复式分录已入账: 借 merchant:' + m.name + ' $' + lgR2(bt.net).toFixed(2) + (r.splitCount ? ' / 分账 ' + r.splitCount + ' 笔 $' + r.splitSum.toFixed(2) : '') + ' / 渠道出金 $' + r.payout.toFixed(2) });
      }
      // -- 分账规则(订单级, 结算时拆付)
      if (p === '/api/admin/mch/splits' && method === 'GET') {
        let list = mchSplits.map(s => { const o = mchOrderById(s.orderId) || {}; const m = mchById(s.mchId) || {};
          return { ...s, receiverTypeLabel: SPLIT_TYPE_LABEL[s.receiverType] || s.receiverType, orderNo: o.orderNo || '—', orderAmount: o.amount, merchant: m.name || '—', pctLabel: Math.round((s.pct || 0) * 10000) / 100 + '%' }; });
        if (q.mchId) list = list.filter(s => s.mchId === +q.mchId);
        return J({ list, summary: { total: mchSplits.length, amount: lgR2(mchSplits.reduce((s, x) => s + x.amount, 0)) },
          note: '订单级分账规则在结算打款时拆付(不改变商户总净额, 只改变收款方构成)' });
      }
      // -- 商户风控(风险分 / 拒付率 / 预警)
      if (p === '/api/admin/mch/risk' && method === 'GET') {
        const list = mchAccounts.map(m => {
          const r = mchRisk.find(x => x.mchId === m.id) || { score: 0, chargebackRate: 0, refundRate: 0, flags: [] };
          const orders = mchOrdersOf(m.id), n = orders.length;
          const refunded = orders.filter(o => o.status === 'refunded').length, disputed = orders.filter(o => o.status === 'disputed').length;
          const live = { refundRate: n ? +(100 * refunded / n).toFixed(1) : 0, disputeRate: n ? +(100 * disputed / n).toFixed(1) : 0 };
          const red = r.score >= MCH_RISK_THRESHOLD.score || live.disputeRate >= MCH_RISK_THRESHOLD.chargeback || (r.flags || []).some(f => /拒付/.test(f));
          const amber = !red && (r.score >= 50 || live.refundRate >= MCH_RISK_THRESHOLD.refundRate);
          return { mchId: m.id, name: m.name, mccLabel: MCC_LABEL[m.mcc] || m.mcc, status: m.status, statusLabel: MCH_STATUS_LABEL[m.status] || m.status,
            score: r.score, scoreBand: red ? 'red' : amber ? 'amber' : 'green',
            chargebackRate: r.chargebackRate, refundSeed: r.refundRate, ...live,
            flags: r.flags || [], orderCount: n, updatedAt: r.updatedAt || null,
            scoreLabel: red ? '高危' : amber ? '关注' : '正常' };
        }).sort((a, b2) => b2.score - a.score);
        return J({ list, thresholds: MCH_RISK_THRESHOLD,
          summary: { total: list.length, red: list.filter(x => x.scoreBand === 'red').length, amber: list.filter(x => x.scoreBand === 'amber').length, green: list.filter(x => x.scoreBand === 'green').length },
          note: '风险分 ≥ ' + MCH_RISK_THRESHOLD.score + ' 或 拒付率 ≥ ' + MCH_RISK_THRESHOLD.chargeback + '% 标红预警' });
      }
      // -- 对账单 / 经营报表(日 / 月)
      if (p === '/api/admin/mch/report' && method === 'GET') {
        const dim = q.dim === 'month' ? 'month' : 'day';
        const rows = mchReportRows(dim);
        return J({ list: rows, dim,
          summary: { amount: lgR2(rows.reduce((s, r) => s + r.amount, 0)), count: rows.reduce((s, r) => s + r.count, 0),
            avgOrder: rows.length ? lgR2(rows.reduce((s, r) => s + r.amount, 0) / rows.reduce((s, r) => s + r.count, 0)) : 0,
            refundRate: rows.reduce((s, r) => s + r.count, 0) ? +(100 * rows.reduce((s, r) => s + r.count * r.refundRate / 100, 0) / rows.reduce((s, r) => s + r.count, 0)).toFixed(1) : 0 },
          note: '按' + (dim === 'month' ? '月' : '日') + '聚合: 交易量 / 笔数 / 成功率 / 平均客单 / 退款率(仅已开通商户)' });
      }
      return J({ error: 'not found: ' + p }, 404);
    }
    // ============ P5.5 BI 数据中心(总监专属) ============
    if (p.startsWith('/api/admin/bi/')) {
      if (sid !== 1) return J({ error: '仅运营总监可访问 BI 数据中心' }, 403);
      const f = biParseQ(q);
      const ctx = biCtx(f);
      const filtersEcho = { range: f.range, level: f.level || null, merchant: f.merchant || null, rep: f.rep || null, repName: f.rep ? (repById(f.rep) || {}).name : null };
      const rangeLabel = { today: '今日', '7d': '近 7 天', '30d': '近 30 天' }[f.range];
      const biOptions = { // 前端全局筛选器选项(等级/商户/销售)
        levels: Object.keys(CARD_LEVELS).map(k => ({ key: k, label: CARD_LEVELS[k].label })),
        merchants: [...new Set(transactions.filter(t => t.merchant).map(t => t.merchant))].sort(),
        reps: salesReps.map(s => ({ id: s.id, name: s.name, level: s.level })),
      };
      if (p === '/api/admin/bi/overview' && method === 'GET') { // 实时指标卡 + 环比(上一同长周期)
        const cur = biOverviewData(f, ctx);
        const span = f.endTs - f.startTs;
        const fPrev = { ...f, startTs: f.startTs - span, endTs: f.startTs };
        const prev = biOverviewData(fPrev, biCtx(fPrev));
        return J({ filters: filtersEcho, rangeLabel, options: biOptions, metrics: cur, prev,
          note: 'DAU/MAU 按窗口内交易 distinct userId 近似; GMV=成功充值+消费(与驾驶舱同口径); 净收入=手续费+月费-佣金(与财务报表同口径); 积分成本=积分发放×$0.01。' });
      }
      if (p === '/api/admin/bi/users' && method === 'GET') {
        const d = biUsersData(f, ctx);
        return J({ filters: filtersEcho, rangeLabel, options: biOptions, ...d });
      }
      if (p === '/api/admin/bi/tx' && method === 'GET') {
        const txs = ctx.txs;
        const byChannel = [...biGroupTxs(txs, 'channel', ctx).entries()].map(([k, list]) => ({ dim: k, ...biRowMetrics(list) })).sort((a, b2) => b2.gmv - a.gmv);
        const byLevel = Object.keys(CARD_LEVELS).map(lv => ({ dim: CARD_LEVELS[lv].label, ...biRowMetrics(txs.filter(t => (ctx.cardById.get(t.cardId) || {}).level === lv)) }));
        const byMerchant = [...biGroupTxs(txs.filter(t => t.type === 'consume'), 'merchant', ctx).entries()]
          .map(([k, list]) => ({ dim: k, ...biRowMetrics(list) })).sort((a, b2) => b2.gmv - a.gmv).slice(0, 10);
        const byHour = Array.from({ length: 24 }, (_, h) => { const list = txs.filter(t => new Date(t.createdAt).getHours() === h); return { dim: d2(h) + ':00', txCount: list.length, gmv: biGmv(list) }; });
        const distDef = [[0, 50], [50, 100], [100, 200], [200, 500], [500, Infinity]];
        const succ = biSucc(txs).filter(t => t.type === 'topup' || t.type === 'consume');
        const amountDist = distDef.map(([lo, hi]) => ({ dim: hi === Infinity ? '$' + lo + '+' : '$' + lo + '-' + hi, txCount: succ.filter(t => t.amount >= lo && t.amount < hi).length }));
        return J({ filters: filtersEcho, rangeLabel, options: biOptions, summary: biRowMetrics(txs), byChannel, byLevel, byMerchant, byHour, amountDist, trend: biTrend(f, ctx),
          note: '按渠道/卡等级/商户(Top10)/时段(小时)/金额分布; 趋势为窗口内日(小时)粒度 GMV 与笔数。' });
      }
      if (p === '/api/admin/bi/sales' && method === 'GET') {
        const rows = biSalesData(f, ctx);
        const head = rows.find(r => r.level === 0) || rows[0] || { gmv: 0, perCapita: 0 };
        const commission = biCommissionScoped(f, ctx); // 汇总佣金取窗口口径(总监行个人佣金为 0 属正常: 三层分佣覆盖不到)
        return J({ filters: filtersEcho, rangeLabel, options: biOptions, rows, summary: {
          gmv: head.gmv, commission, eff: head.gmv > 0 ? +(100 * commission / head.gmv).toFixed(2) : 0,
          perCapita: head.perCapita, reps: rows.length,
        }, note: '每行 GMV 为该销售 subtree 口径(逐级包含下级); 人均单产=团队 GMV/团队人数(含本人); 佣金效率=窗口佣金/团队 GMV。' });
      }
      if (p === '/api/admin/bi/funnel' && method === 'GET') {
        const d = biFunnelData(ctx);
        return J({ filters: filtersEcho, options: biOptions, ...d });
      }
      if (p === '/api/admin/bi/report' && method === 'GET') { // ?metrics=a,b&dims=day,channel&format=csv
        const mk = String(q.metrics || '').split(',').map(s => s.trim()).filter(k => BI_METRICS[k]);
        const metrics = mk.length ? mk : ['txCount', 'gmv'];
        const dims = String(q.dims || '').split(',').map(s => s.trim()).filter(k => BI_DIMS[k]).slice(0, 2);
        const groups = new Map();
        ctx.txs.forEach(t => {
          const key = dims.length ? dims.map(d => biDimValue(d, t, ctx)).join(' / ') : '全部';
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(t);
        });
        const rows = [...groups.entries()].map(([k, list]) => {
          const m = biRowMetrics(list);
          const row = { dim: k };
          metrics.forEach(key => { row[key] = m[key]; });
          return row;
        });
        const timeOnly = dims.length && dims.every(d => d === 'day' || d === 'hour'); // 时间维度保持时序, 其余按 GMV 降序
        rows.sort(timeOnly ? (a, b2) => String(a.dim).localeCompare(String(b2.dim)) : (a, b2) => (b2.gmv || 0) - (a.gmv || 0));
        const columns = [{ key: 'dim', label: dims.length ? dims.map(d => BI_DIMS[d].label).join(' × ') : '汇总' }]
          .concat(metrics.map(k => ({ key: k, label: BI_METRICS[k].label + '(' + BI_METRICS[k].unit + ')' })));
        if (q.format === 'csv') {
          const lines = [columns.map(c => c.label).join(',')];
          rows.forEach(r => lines.push(columns.map(c => String(r[c.key] == null ? '' : r[c.key]).replace(/,/g, ' ')).join(',')));
          return J({ filename: 'bi-report-' + f.range + '.csv', csv: lines.join('\r\n'), rowCount: rows.length,
            note: 'CSV 内容(前端导出时追加 UTF-8 BOM, 复用对账导出模式)' });
        }
        return J({ filters: filtersEcho, rangeLabel, options: biOptions, columns, rows,
          catalog: { metrics: Object.entries(BI_METRICS).map(([k, v]) => ({ key: k, ...v })), dims: Object.entries(BI_DIMS).map(([k, v]) => ({ key: k, ...v })) },
          note: '自定义报表: 勾选指标×维度(最多 2 维交叉)生成表格, 可导出 CSV。' });
      }
      return J({ error: 'not found: ' + p }, 404);
    }
    // ============ P5.6 运维中心(总监专属, 演示级预留) ============
    if (p.startsWith('/api/admin/ops/')) {
      if (sid !== 1) return J({ error: '仅运营总监可访问运维中心' }, 403);
      const opsOp = (module, action, target, result = '成功') => { // 运维操作写审计(与系统管理同模式)
        opLogs.unshift({ id: opLogs.length ? Math.max(...opLogs.map(o => o.id)) + 1 : 910100, createdAt: now(), operator: me.name, module, action, target, result });
        if (opLogs.length > 150) opLogs.length = 150;
      };
      if (p === '/api/admin/ops/arch' && method === 'GET') return J(opsArchData());
      if (p === '/api/admin/ops/flags' && method === 'GET') {
        return J({ list: ffFlags.map(f => ({ ...f })),
          effects: [
            { key: 'shopFlag', effect: '关闭后用户端 GET /api/app/products 返回 503 降级响应(商城页显示错误提示)' },
            { key: 'approvalsFlag', effect: '关闭后审批中心 GET /api/admin/approvals 返回 disabled 标记, 页面显示「功能已下线」横幅' },
            { key: 'grayPayFlag', effect: '灰度百分比控制新支付编排路由放量(演示展示, 不改路由)' },
          ],
          note: 'Feature Flag 为演示级内存开关(生产接入配置中心); 切换即写 opLogs 审计。' });
      }
      const mFlag = p.match(/^\/api\/admin\/ops\/flags\/(\d+)$/);
      if (mFlag && method === 'PATCH') { // 开关切换 / 灰度百分比调整
        const fl = ffFlags.find(x => x.id === +mFlag[1]);
        if (!fl) return J({ error: '开关不存在' }, 404);
        const changed = [];
        if (typeof b.enabled === 'boolean' && b.enabled !== fl.enabled) { fl.enabled = b.enabled; changed.push('enabled → ' + b.enabled); }
        if (b.rollout != null) { const r = Math.max(0, Math.min(100, Math.round(+b.rollout))); if (r !== fl.rollout) { fl.rollout = r; changed.push('灰度 ' + r + '%'); } }
        if (!changed.length) return J({ error: '无有效修改字段(支持 enabled: boolean / rollout: 0-100)' }, 400);
        fl.updatedAt = now();
        opsOp('运维中心', 'Feature Flag 切换', fl.key + '(' + fl.label + '): ' + changed.join(', '));
        return J({ ok: true, flag: { ...fl } });
      }
      if (p === '/api/admin/ops/ratelimit' && method === 'GET') {
        return J({ ...opsRateCfg, tracked: rlBuckets.size,
          note: '内存令牌桶(单实例演示); 生产预留网关级 Redis 滑动窗口按 key/租户聚合。全局限流开关关闭后 test 端点不再触发 429。' });
      }
      if (p === '/api/admin/ops/ratelimit' && method === 'PATCH') { // 全局开关 / 规则 qps/burst
        const changed = [];
        if (typeof b.enabled === 'boolean' && b.enabled !== opsRateCfg.enabled) { opsRateCfg.enabled = b.enabled; changed.push('全局限流 → ' + b.enabled); }
        if (b.qps != null || b.burst != null) {
          const rule = opsRateCfg.rules.find(r => r.key === b.key);
          if (!rule) return J({ error: '限流规则不存在: ' + (b.key || '(未指定)') }, 400);
          if (b.qps != null) { const v = Math.max(1, Math.round(+b.qps) || 1); if (v !== rule.qps) { rule.qps = v; changed.push(rule.key + ' QPS → ' + v); } }
          if (b.burst != null) { const v = Math.max(1, Math.round(+b.burst) || 1); if (v !== rule.burst) { rule.burst = v; changed.push(rule.key + ' 突发 → ' + v); rlBuckets.delete('ops-demo:default'); } }
        }
        if (!changed.length) return J({ error: '无有效修改字段(支持 enabled / key+qps / key+burst)' }, 400);
        opsOp('运维中心', '限流配置变更', changed.join(', '));
        return J({ ok: true, cfg: { ...opsRateCfg } });
      }
      if (p === '/api/admin/ops/ratelimit/test' && method === 'POST') { // 限流演示: 连打第 5 次触发 429
        const rule = opsRateCfg.rules.find(r => r.key === '/api/admin/ops/ratelimit/test') || { qps: 1, burst: 4 };
        const r = rlAllow('ops-demo:' + String(h['x-demo-key'] || 'default'), rule.qps, rule.burst);
        if (!r.ok) return J({ error: '请求过于频繁: 已触发限流(429), 令牌不足, 约 ' + r.retryAfterMs + 'ms 后恢复', rateLimited: true, retryAfterMs: r.retryAfterMs, tokensLeft: r.tokens, rule }, 429);
        return J({ ok: true, seq: r.seq, tokensLeft: r.tokens, rule,
          note: '内存令牌桶 burst=' + rule.burst + ': 快速连打 ' + rule.burst + ' 次后第 ' + (rule.burst + 1) + ' 次返回 429。' });
      }
      if (p === '/api/admin/ops/audit' && method === 'GET') return J(opsAuditData(q));
      if (p === '/api/admin/ops/monitor' && method === 'GET') return J(opsMonitorData());
      if (p === '/api/admin/ops/alerts' && method === 'GET') return J(opsAlertsData());
      if (p === '/api/admin/ops/trace' && method === 'GET') return J({ candidates: opsTraceCandidates() });
      const mTrace = p.match(/^\/api\/admin\/ops\/trace\/(\d+)$/);
      if (mTrace && method === 'GET') {
        const d = opsTraceData(mTrace[1]);
        if (d.error) return J({ error: '交易不存在: #' + mTrace[1] }, 404);
        return J(d);
      }
      if (p === '/api/admin/ops/backup' && method === 'GET') { // 全量内存数据 JSON(前端 Blob 下载)
        const bk = opsBackupData();
        opsOp('运维中心', '数据备份导出', '全量内存 JSON · ' + Object.keys(bk.counts).length + ' 个集合 / ' + Object.values(bk.counts).reduce((s, n) => s + n, 0) + ' 条');
        return J(bk);
      }
      if (p === '/api/admin/ops/data-state' && method === 'GET') return J(opsDataState());
      if (p === '/api/admin/ops/restore' && method === 'POST') {
        if (sid !== 1) return J({ error: '仅运营总监可恢复演示数据' }, 403);
        if (b.mode !== 'seed' || b.confirm !== 'RESTORE_SEED') return J({ error: '请输入 RESTORE_SEED 确认恢复初始种子' }, 400);
        demoSeedReason = 'console_restore';
        inited = false;
        initSeed();
        opsOp('运维中心', '恢复演示数据', '数据控制台 · 全量重建初始种子');
        return J({ ok: true, at: now(), state: opsDataState() });
      }
      return J({ error: 'not found: ' + p }, 404);
    }
    return J({ error: 'not found: ' + p }, 404);
  }

  // ============ 用户端 H5 ============
  if (p.startsWith('/api/app')) {
    if (p === '/api/app/users') return J(getAppAccountChoices());
    const uid = context.actor?.type === 'user' ? context.actor.id : parseInt(h['x-user'] || '0', 10);
    const me = () => users.find(u => u.id === uid);
    if (!me()) return J({ error: '未登录', code: 'AUTH_REQUIRED' }, 401);
    if (p === '/api/app/me') { const u = me(); if (!u) return J({ error: '未登录' }, 401); return J(pubUser(u)); }
    if (p === '/api/app/transactions') { const u = me(); if (!u) return J({ error: '未登录' }, 401); return J(transactions.filter(t => t.userId === uid).slice(0, 50)); }
    if (p === '/api/app/topup' && method === 'POST') return J(doTopup(uid, +b.amount, b.method));
    if (p === '/api/app/pay' && method === 'POST') return J(doPay(uid, +b.amount, b.merchant || 'Amazon', b.usePoints));
    if (p === '/api/app/tasks') { const u = me(); if (!u) return J({ error: '未登录' }, 401); const day = new Date().toDateString();
      return J({ tasks, signedToday: pointsLogs.some(l => l.userId === uid && l.source === '每日签到' && new Date(l.createdAt).toDateString() === day),
        claimed: pointsLogs.filter(l => l.userId === uid && String(l.refNo).startsWith('TASK')).map(l => +String(l.refNo).slice(4)) }); }
    if (p === '/api/app/sign' && method === 'POST') { const u = me(); const day = new Date().toDateString(); if (pointsLogs.some(l => l.userId === uid && l.source === '每日签到' && new Date(l.createdAt).toDateString() === day)) return J({ error: '今日已签到' }, 400); addPointsLog(uid, 20, '每日签到', 'SIGN', now()); return J({ ok: true }); }
    if (p === '/api/app/task/claim' && method === 'POST') { const t = tasks.find(x => x.id === +b.id);
      if (!t) return J({ error: '任务不存在' }, 404);
      const claimedLog = (ref) => pointsLogs.find(l => l.userId === uid && l.refNo === ref);
      if (t.type === 'once' && claimedLog('TASK' + t.id)) return J({ error: '该任务奖励已领取过, 不能重复领取' }, 400);
      if (t.type === 'daily' && pointsLogs.some(l => l.userId === uid && l.refNo === 'TASK' + t.id && new Date(l.createdAt).toDateString() === new Date().toDateString())) return J({ error: '今日已领取该任务奖励, 明天再来' }, 400);
      addPointsLog(uid, t.points, '任务奖励:' + t.title, 'TASK' + t.id, now()); return J({ ok: true }); }
    // 卡片自助管控: 冻结/解冻/挂失(挂失需后台解除)
    if ((p === '/api/app/card/freeze' || p === '/api/app/card/unfreeze' || p === '/api/app/card/lost') && method === 'POST') {
      const act = p.split('/').pop();
      return changeAppCardStatus(uid, act);
    }
    if (p === '/api/app/products') { // P2.3: 返回商品(含限购/评分) + 分类列表
      if (ffFlags && !ffOn('shopFlag')) return J({ error: '积分商城功能已下线 (Feature Flag: shopFlag=off), 请联系运营在后台「运维中心」恢复', flag: 'shopFlag', degraded: true }, 503); // P5.6 生效点
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

  // ============ P5.4 商户端门户(merchant.html, x-mch 头标识商户) ============
  if (p.startsWith('/api/mch/')) {
    // 登录页商户下拉(已开通商户, 免密)
    if (p === '/api/mch/merchants' && method === 'GET') {
      return J(getMerchantAccountChoices());
    }
    const mid = parseInt(h['x-mch'] || h['X-Mch'] || '0', 10);
    const mch = mchAccounts.find(m => m.id === mid && m.status === 'active');
    if (!mch) return J({ error: '未登录或商户无效(需 x-mch 请求头 + 已开通商户)' }, 401);
    const myOrders = () => mchOrdersOf(mch.id);
    // -- 首页看板
    if (p === '/api/mch/me' && method === 'GET') {
      const orders = myOrders();
      const tKey = dayKey(now());
      const todays = orders.filter(o => dayKey(o.createdAt) === tKey);
      const pend = mchSettles.filter(x => x.mchId === mch.id && x.status === 'pending');
      const pendRefunds = mchRefunds.filter(r => r.mchId === mch.id && r.status === 'pending');
      return J({ me: { id: mch.id, name: mch.name, mchNo: mch.mchNo, mccLabel: MCC_LABEL[mch.mcc] || mch.mcc, settleDays: mch.settleDays, settleLabel: 'T+' + mch.settleDays },
        today: { amount: lgR2(todays.reduce((s, o) => s + o.amount, 0)), count: todays.length,
          successRate: todays.length ? +(100 * todays.filter(o => o.status !== 'disputed').length / todays.length).toFixed(1) : 100 },
        month: { amount: lgR2(orders.filter(o => isoDay(o.createdAt).slice(0, 7) === isoDay(now()).slice(0, 7)).reduce((s, o) => s + o.amount, 0)), count: orders.length },
        pendingSettle: { batches: pend.length, net: lgR2(pend.reduce((s, x) => s + x.net, 0)) },
        pendingRefunds: pendRefunds.length,
        recent: orders.slice().sort((a, b2) => b2.createdAt - a.createdAt).slice(0, 6).map(pubMchOrder) });
    }
    // -- 商户资料 + 费率(只读) + API Key + 分账规则
    if (p === '/api/mch/profile' && method === 'GET') {
      const r = mchRisk.find(x => x.mchId === mch.id) || {};
      const prof = pubMchAccount(mch);
      return J({ profile: { id: prof.id, name: prof.name, mchNo: prof.mchNo, mccLabel: prof.mccLabel, country: prof.country,
          contact: prof.contact, settleAccount: prof.settleAccount, settleDays: prof.settleDays, settleLabel: prof.settleLabel,
          rate: prof.rate, rateLabel: prof.rateLabel, createdAt: prof.createdAt },
        apiKey: prof.apiKey || '(入驻时未生成, 请联系平台)',
        risk: { score: r.score || 0, flags: r.flags || [] },
        splits: mchSplits.filter(s => s.mchId === mch.id).map(s => ({ ...s, receiverTypeLabel: SPLIT_TYPE_LABEL[s.receiverType] || s.receiverType, orderNo: (mchOrderById(s.orderId) || {}).orderNo || '—', pctLabel: Math.round((s.pct || 0) * 10000) / 100 + '%' })),
        note: '费率与结算账户由平台配置, 商户端只读' });
    }
    // -- 收款订单
    if (p === '/api/mch/orders' && method === 'GET') {
      let list = myOrders().map(pubMchOrder);
      if (q.status) list = list.filter(o => o.status === q.status);
      return J({ list: list.sort((a, b2) => b2.createdAt - a.createdAt).slice(0, 200),
        summary: { total: myOrders().length, amount: lgR2(myOrders().reduce((s, o) => s + o.amount, 0)), refunded: myOrders().filter(o => o.status === 'refunded').length } });
    }
    // -- 退款管理: 查询 + 发起申请(后台审核)
    if (p === '/api/mch/refunds' && method === 'GET') {
      return J({ list: mchRefunds.filter(r => r.mchId === mch.id).map(pubMchRefund).sort((a, b2) => b2.appliedAt - a.appliedAt) });
    }
    if (p === '/api/mch/refunds' && method === 'POST') {
      const reason = String(b.reason || '').trim();
      if (!reason) return J({ error: '请填写退款原因' }, 400);
      const o = mchOrderById(b.orderId);
      if (!o || o.mchId !== mch.id) return J({ error: '订单不存在' }, 404);
      if (o.status !== 'paid') return J({ error: '订单当前状态「' + (MCH_ORDER_STATUS_LABEL[o.status] || o.status) + '」不可申请退款' }, 409);
      if (mchRefunds.some(r => r.orderId === o.id && r.status !== 'rejected')) return J({ error: '该订单已有处理中/已完成的退款单' }, 409);
      const rf = { id: nid(), orderId: o.id, mchId: mch.id, reason, status: 'pending', appliedAt: now(), appliedBy: '商户门户', approvedAt: null, approvedBy: '', actNote: '' };
      mchRefunds.unshift(rf);
      return J({ ok: true, refund: pubMchRefund(rf), note: '退款申请已提交, 待平台审核(后台 商户平台 → 退款管理)' });
    }
    // -- 结算记录
    if (p === '/api/mch/settles' && method === 'GET') {
      return J({ list: mchSettles.filter(x => x.mchId === mch.id).map(pubMchSettle).sort((a, b2) => (a.status === b2.status ? (b2.day < a.day ? -1 : 1) : a.status === 'pending' ? -1 : 1)) });
    }
    return J({ error: 'not found' }, 404);
  }

  return J({ error: 'not found: ' + p }, 404); // 未匹配的 /api/* 路径统一 404(防壳层读 null.status 崩 500)
}

const tenantService = createTenantService({
  all: () => { ensureSeeded(); return tenants; },
  findById: (id) => { ensureSeeded(); return tenants.find(tenant => tenant.id === id); },
  present: pubTenant,
  statusLabels: TENANT_STATUS_LABEL,
});
const openPlatformService = createOpenPlatformService({
  apps: () => { ensureSeeded(); return openApps; },
  keys: () => { ensureSeeded(); return openKeys; },
  webhooks: () => { ensureSeeded(); return openWebhooks; },
  logs: () => { ensureSeeded(); return openApiLogs; },
  maskSecret,
  now,
  randomInt: ri,
});
const notificationService = createNotificationService({
  templates: () => { ensureSeeded(); return notifyTemplates; },
  sends: () => { ensureSeeded(); return notifySends; },
  channels: () => { ensureSeeded(); return notifyChannels; },
  now,
  randomInt: ri,
});
const systemService = createSystemService({
  accounts: () => { ensureSeeded(); return sysAccounts; },
  roles: () => { ensureSeeded(); return sysRoles; },
  permissions: () => { ensureSeeded(); return sysPerms; },
  parameters: () => { ensureSeeded(); return sysParams; },
  dictionaries: () => { ensureSeeded(); return sysDicts; },
  loginLogs: () => { ensureSeeded(); return sysLogs; },
  operationLogs: () => { ensureSeeded(); return opLogs; },
  salesReps: () => { ensureSeeded(); return salesReps; },
  customers: () => { ensureSeeded(); return customers; },
  cards: () => { ensureSeeded(); return cards; },
  organizationTree: () => { ensureSeeded(); return sysOrgTree(); },
  operatorName: id => repById(id)?.name || '未知账号',
  permissionTree: PERM_TREE,
  allPermissionKeys: ALL_PERM_KEYS,
  now,
});
const opsManagementService = createOpsManagementService({
  architecture: () => { ensureSeeded(); return opsArchData(); },
  flags: () => { ensureSeeded(); return ffFlags; },
  rateConfig: () => { ensureSeeded(); return opsRateCfg; },
  rateBuckets: () => { ensureSeeded(); return rlBuckets; },
  rateAllow: rlAllow,
  auditData: opsAuditData,
  monitorData: opsMonitorData,
  alertsData: opsAlertsData,
  traceCandidates: opsTraceCandidates,
  traceData: opsTraceData,
  audit: (actorId, module, action, target, result = '成功') => appendOpsLog(module, action, target, repById(actorId)?.name || '未知账号', result),
  now,
});
const merchantPortalService = createMerchantPortalService({
  accounts: () => { ensureSeeded(); return mchAccounts; },
  orders: () => { ensureSeeded(); return mchOrders; },
  refunds: () => { ensureSeeded(); return mchRefunds; },
  settles: () => { ensureSeeded(); return mchSettles; },
  splits: () => { ensureSeeded(); return mchSplits; },
  risks: () => { ensureSeeded(); return mchRisk; },
  orderById: id => mchOrderById(+id),
  presentAccount: pubMchAccount,
  presentOrder: pubMchOrder,
  presentRefund: pubMchRefund,
  presentSettle: pubMchSettle,
  mccLabels: MCC_LABEL,
  splitTypeLabels: SPLIT_TYPE_LABEL,
  orderStatusLabels: MCH_ORDER_STATUS_LABEL,
  dayKey,
  isoDay,
  round: lgR2,
  nextId: nid,
  now,
});
const appUserService = createAppUserService({
  users: () => { ensureSeeded(); return users; }, cards: () => { ensureSeeded(); return cards; },
  transactions: () => { ensureSeeded(); return transactions; }, pointsLogs: () => { ensureSeeded(); return pointsLogs; },
  tasks: () => { ensureSeeded(); return tasks; }, products: () => { ensureSeeded(); return products; }, orders: () => { ensureSeeded(); return orders; },
  notificationRead: () => notifRead,
  presentUser: pubUser, presentOrder: pubOrder, topup: doTopup, pay: doPay, redeem: doRedeem,
  addPoints: addPointsLog, pointsSummary, productLimit, productRating, notifications: appNotificationsFor,
  featureEnabled: ffOn, randomInt: ri, now,
});
const openApiMockService = createOpenApiMockService({
  apps: () => { ensureSeeded(); return openApps; }, users: () => { ensureSeeded(); return users; },
  cards: () => { ensureSeeded(); return cards; }, transactions: () => { ensureSeeded(); return transactions; },
  orders: () => { ensureSeeded(); return orders; }, pointsSummary, presentTransaction: pubTx, presentOrder: pubOrder,
  maskCardNumber: maskCardNo, generateCardNumber: genCardNo, randomInt: ri, now, logCall: logOpenApi,
});
const financeReconciliationService = createFinanceReconciliationService({
  transactions: () => { ensureSeeded(); return transactions; }, financeMeta: () => { ensureSeeded(); return financeMeta; },
  commissions: () => { ensureSeeded(); return commissions; }, cards: () => { ensureSeeded(); return cards; },
  cardLevels: CARD_LEVELS, round: lgR2, dayKey, isoDay, d2, now, ensureMerchantLedgerAccount, postLedgerTx,
});
const ledgerService = createLedgerService({
  ledgerAccounts: () => { ensureSeeded(); return ledgerAccounts; }, ledgerEntries: () => { ensureSeeded(); return ledgerEntries; },
  balanceSnapshots: () => { ensureSeeded(); return balanceSnapshots; }, frozenBalances: () => { ensureSeeded(); return frozenBalances; },
  typeLabels: LEDGER_TYPE_LABEL, round: lgR2, now, isoDay, verifyLedger,
});
const seeded = value => () => { ensureSeeded(); return value(); };
const basicOperationsService = createBasicOperationsService({
  salesReps: seeded(() => salesReps), users: seeded(() => users), cards: seeded(() => cards), transactions: seeded(() => transactions),
  orders: seeded(() => orders), commissions: seeded(() => commissions), customers: seeded(() => customers), pointsLogs: seeded(() => pointsLogs),
  repById, subtreeIds, presentTransaction: pubTx, presentUser: pubUser, performanceRows: perfRows, cardLevels: CARD_LEVELS,
  now, nextId: nid, randomInt: ri, pick, daysAgo, rangeStartTs, buildTrend, generateCardNo: genCardNo,
  addCommissions, addPointsLog, ensureCardLedgerAccount, ledgerForMonthlyFee, ledgerForAdjust, ledgerForRefund,
});
const crmService = createCrmService({
  salesReps: seeded(() => salesReps), users: seeded(() => users), cards: seeded(() => cards), transactions: seeded(() => transactions),
  customers: seeded(() => customers), followups: seeded(() => followups), commissions: seeded(() => commissions), pointsLogs: seeded(() => pointsLogs),
  repById, subtreeIds, presentCustomer: pubCustomer, presentCommission: pubCommission, performanceRows: perfRows, recentChains,
  cardLevels: CARD_LEVELS, commissionRules: COMMISSION, tierLabels: TIER_LABELS, now, nextId: nid, ledgerForCommissionSettle,
});
const adminShopService = createAdminShopService({
  salesReps: seeded(() => salesReps), users: seeded(() => users), pointsLogs: seeded(() => pointsLogs), products: seeded(() => products), orders: seeded(() => orders),
  repById, subtreeIds, presentOrder: pubOrder, pointsPerUsd: POINTS_PER_USD, cardLevels: CARD_LEVELS, commissionRules: COMMISSION,
  now, randomInt: ri, addPointsLog,
});
const complianceService = createComplianceService({
  users: seeded(() => users), userDocs: seeded(() => userDocs), approvals: seeded(() => approvals), kybCases: seeded(() => kybCases),
  sanctions: seeded(() => sanctions), peps: seeded(() => peps), strReports: seeded(() => strReports), riskEvents: seeded(() => riskEvents),
  engineRules: seeded(() => engineRules), cases: seeded(() => compCases), countryRules: seeded(() => countryRules),
  kycLimits: KYC_LIMITS, kybStatusLabels: KYB_STATUS_LABEL, strStatusLabels: STR_STATUS_LABEL, caseTypeLabels: COMP_CASE_TYPE_LABEL,
  now, daysAgo, isoDay, nextId: nid, screenName, complianceScreenings, docTier, operatorName: id => repById(id)?.name || '运营总监',
});
const biService = createBiService({
  transactions: seeded(() => transactions), salesReps: seeded(() => salesReps), cardLevels: CARD_LEVELS, metrics: BI_METRICS, dims: BI_DIMS,
  parseQuery: biParseQ, context: biCtx, repById, overviewData: biOverviewData, usersData: biUsersData, rowMetrics: biRowMetrics,
  successful: biSucc, gmv: biGmv, commissionScoped: biCommissionScoped, groupTransactions: biGroupTxs,
  dimValue: biDimValue, d2, trend: biTrend, salesData: biSalesData, funnelData: biFunnelData,
});
const merchantAdminPlatformService = createMerchantAdminPlatformService({
  accounts: seeded(() => mchAccounts), orders: seeded(() => mchOrders), refunds: seeded(() => mchRefunds),
  settles: seeded(() => mchSettles), splits: seeded(() => mchSplits), risks: seeded(() => mchRisk),
  accountById: mchById, orderById: mchOrderById, ordersOf: mchOrdersOf, kybOf,
  presentAccount: pubMchAccount, presentOrder: pubMchOrder, presentRefund: pubMchRefund, presentSettle: pubMchSettle, reportRows: mchReportRows,
  generateMerchantNumber: genMchNo, generateMerchantApiKey: genMchApiKey, timelineAdd: mchTimelineAdd,
  postRefundLedger: mchRefundLedgerPost, recomputeSettle: mchBatchRecompute, postSettleLedger: mchSettleLedgerPost,
  now, round: lgR2, operatorName: id => repById(id)?.name || '运营总监', merchantStatusLabels: MCH_STATUS_LABEL,
  kybStatusLabels: KYB_STATUS_LABEL, refundStatusLabels: MCH_REFUND_STATUS_LABEL, orderStatusLabels: MCH_ORDER_STATUS_LABEL,
  settleStatusLabels: MCH_SETTLE_STATUS_LABEL, splitTypeLabels: SPLIT_TYPE_LABEL, mccLabels: MCC_LABEL, riskThreshold: MCH_RISK_THRESHOLD,
});
const approvalService = createApprovalService({
  approvals: seeded(() => approvals), flags: seeded(() => ffFlags), now, typeLabels: AP_TYPE_LABEL,
  statusLabels: AP_STATUS_LABEL, executeBusiness: executeApprovalBiz, operatorName: id => repById(id)?.name || '运营总监',
});
const riskEngineService = createRiskEngineService({
  rules: seeded(() => engineRules), hits: seeded(() => engineHits), versions: seeded(() => engineVersions), scoreAll: engineScoreAll,
  nextId: nid, now, fields: ENGINE_FIELDS, ops: ENGINE_OPS, actionLabels: ENGINE_ACTION_LABEL, levelLabels: RISK_LEVEL_LABEL,
  operatorName: id => repById(id)?.name || '运营总监',
});
const enterpriseService = createEnterpriseService({
  entAccounts: seeded(() => entAccounts), entMembers: seeded(() => entMembers), entDepts: seeded(() => entDepts),
  entCards: seeded(() => entCards), entTxApprovals: seeded(() => entTxApprovals), entBills: seeded(() => entBills),
  entDeptLogs: seeded(() => entDeptLogs), workflowApprovals: seeded(() => approvals), kybCases: seeded(() => kybCases),
  ledgerAccounts: seeded(() => ledgerAccounts), ledgerTypeLabels: LEDGER_TYPE_LABEL, routeFor,
  ensureEntLedgerAccount, ensureLedgerAccount, ensureMerchantLedgerAccount,
  postLedgerTx, operatorName: id => repById(id)?.name || '总监', maskCardNo, round: lgR2, isoDay,
  randomInt: ri, nid, now,
});
const paymentOrchestrationService = createPaymentOrchestrationService({
  adapters: seeded(() => orchAdapters), transactions: seeded(() => transactions), txs: seeded(() => orchTxs),
  healthLog: seeded(() => orchHealthLog), webhookLogs: seeded(() => orchWebhookLogs), reconFixed: seeded(() => orchReconFixed),
  adapterById: orchById, routeFor, presentTx: pubOrchTx, transit: orchTransit,
  reconciliationDiffs: orchReconDiffs, fixDifference: orchFixDiff,
  feeOf: orchFeeOf, effectivePriority: orchEffPriority, now, random: rnd, randomInt: ri, nextId: nid,
  kindLabels: ORCH_KIND_LABEL, sceneKinds: ORCH_SCENE_KIND, sceneLabels: ORCH_SCENE_LABEL,
  stateLabels: ORCH_STATE_LABEL, nextStates: ORCH_NEXT,
  operatorName: id => repById(id)?.name || '运营总监',
});
const classicRiskService = createClassicRiskService({
  users: seeded(() => users), cards: seeded(() => cards),
  riskEvents: seeded(() => riskEvents), riskRules: seeded(() => riskRules),
  riskLists: seeded(() => riskLists), riskTags: seeded(() => riskTags),
  engineRules: seeded(() => engineRules), engineConditionText: engineCondStr,
  frozenBalances: seeded(() => frozenBalances), ensureCardLedgerAccount,
  levelLabels: RISK_LEVEL_LABEL, statusLabels: RISK_STATUS_LABEL, actionLabels: RISK_ACTION_LABEL,
  nextId: nid, now, round: lgR2,
  operatorName: id => repById(id)?.name || '运营总监',
});

return {
  getOpsDataState,
  exportOpsBackup,
  restoreOpsSeed,
  exportInternalSnapshot,
  importInternalSnapshot,
  getAdminAccountChoices,
  getAppAccountChoices,
  getMerchantAccountChoices,
  changeAppCardStatus,
  handleApi,
  tenantService,
  openPlatformService,
  notificationService,
  systemService,
  opsManagementService,
  merchantPortalService,
  appUserService,
  openApiMockService,
  financeReconciliationService,
  ledgerService,
  basicOperationsService,
  crmService,
  adminShopService,
  complianceService,
  biService,
  merchantAdminPlatformService,
  approvalService,
  riskEngineService,
  enterpriseService,
  paymentOrchestrationService,
  classicRiskService,
};
}

export const defaultCoreRuntime = createCoreRuntime();
export const getOpsDataState = (...args) => defaultCoreRuntime.getOpsDataState(...args);
export const exportOpsBackup = (...args) => defaultCoreRuntime.exportOpsBackup(...args);
export const restoreOpsSeed = (...args) => defaultCoreRuntime.restoreOpsSeed(...args);
export const exportInternalSnapshot = (...args) => defaultCoreRuntime.exportInternalSnapshot(...args);
export const importInternalSnapshot = (...args) => defaultCoreRuntime.importInternalSnapshot(...args);
export const getAdminAccountChoices = (...args) => defaultCoreRuntime.getAdminAccountChoices(...args);
export const getAppAccountChoices = (...args) => defaultCoreRuntime.getAppAccountChoices(...args);
export const getMerchantAccountChoices = (...args) => defaultCoreRuntime.getMerchantAccountChoices(...args);
export const changeAppCardStatus = (...args) => defaultCoreRuntime.changeAppCardStatus(...args);
export const handleApi = (...args) => defaultCoreRuntime.handleApi(...args);
