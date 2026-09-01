import { failure, ok } from '../../api/response.js';

export function createOpenApiMockService({
  apps, users, cards, transactions, orders, pointsSummary, presentTransaction, presentOrder,
  maskCardNumber, generateCardNumber, randomInt, now, logCall,
}) {
  const definitions = {
    'user.create': { label: '用户开户', run: body => ({ userId: randomInt(100, 999), name: body.name || 'OpenAPI User', kycLevel: 0, status: 'created', invitedBy: null, createdAt: now() }) },
    'kyc.submit': { label: 'KYC 提交', run: body => ({ kycId: `KYC-${randomInt(100000, 999999)}`, applyLevel: Math.min(2, +body.applyLevel || 1), docs: ['passport.jpg', 'selfie.jpg'], status: 'pending_review', sla: '2 小时' }) },
    'card.issue': { label: '发卡', run: body => ({ cardId: randomInt(100, 999), cardNo: maskCardNumber(generateCardNumber()), level: body.level || 'standard', status: 'active', balance: 0, expMonth: randomInt(1, 12), expYear: randomInt(28, 31) }) },
    'balance.query': { label: '查询余额', run: body => {
      const user = users().find(item => item.id === +body.userId) || users()[0];
      const card = cards().find(item => item.userId === user.id);
      const balance = card ? +card.balance.toFixed(2) : 0;
      return { userId: user.id, userName: user.name, currency: 'USD', balance, available: balance, frozen: 0, asOf: now() };
    } },
    'transaction.query': { label: '查询交易', run: () => ({ total: transactions().length, list: transactions().slice(0, 5).map(presentTransaction) }) },
    'topup.callback': { label: '充值回调', run: body => ({ accepted: true, txId: `TX${randomInt(100000, 999999)}`, amount: +body.amount || 100, currency: 'USD', method: body.method || 'usdt', status: 'settled', receivedAt: now() }) },
    'consume.callback': { label: '消费回调', run: body => ({ accepted: true, txId: `TX${randomInt(100000, 999999)}`, merchant: body.merchant || 'Amazon', amount: +body.amount || 58.4, fee: +(((+body.amount || 58.4) * 0.02)).toFixed(2), status: 'cleared', receivedAt: now() }) },
    'refund.create': { label: '退款', run: body => ({ refundId: `RF${randomInt(100000, 999999)}`, txId: body.txId || `TX${randomInt(100000, 999999)}`, amount: +body.amount || 45, status: 'processing', eta: 'T+1 到账' }) },
    'points.query': { label: '积分查询', run: body => {
      const user = users().find(item => item.id === +body.userId) || users()[0];
      const summary = pointsSummary(user.id);
      return { userId: user.id, userName: user.name, available: summary.available, frozen: summary.frozen, expiringSoon: summary.expiringSoon, totalEarned: summary.total };
    } },
    'order.query': { label: '订单查询', run: body => body.orderId
      ? { order: presentOrder(orders().find(order => order.id === +body.orderId) || orders()[0]) }
      : { total: orders().length, list: orders().slice(0, 5).map(presentOrder) } },
  };

  return {
    invoke(endpoint, body = {}, headers = {}, method = 'POST') {
      const appKey = headers['x-app-key'] || headers['X-App-Key'] || '';
      const app = apps().find(item => item.appKey === appKey);
      if (!app) return failure(401, '401 Unauthorized: 无效的 x-app-key, 请在「开放平台 → 应用管理」获取启用的 AppKey');
      if (!app.enabled) return failure(403, '403 Forbidden: 应用已停用, 拒绝访问');
      const definition = definitions[endpoint];
      const pathname = `/api/open/${endpoint}`;
      if (!definition) {
        logCall(app.appKey, pathname, method, 404, randomInt(4, 18), headers['x-forwarded-for']);
        return failure(404, `404 Not Found: 未知的开放接口: ${pathname}`, null, { available: Object.keys(definitions) });
      }
      const latency = randomInt(16, 180);
      app.todayCalls += 1;
      app.totalCalls += 1;
      logCall(app.appKey, pathname, method, 200, latency, headers['x-forwarded-for']);
      return ok({ ok: true, endpoint, label: definition.label, app: app.name, latencyHint: `${latency}ms`, data: definition.run(body || {}) });
    },
    endpoints() { return Object.keys(definitions); },
  };
}
