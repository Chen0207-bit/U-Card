import { failure, ok } from '../../api/response.js';

export function createMerchantPortalService(port) {
  const merchant = id => port.accounts().find(item => item.id === id && item.status === 'active');
  const requireMerchant = id => merchant(id) || null;
  const merchantOrders = id => port.orders().filter(order => order.mchId === id);
  return {
    dashboard(id) {
      const account = requireMerchant(id); if (!account) return failure(401, '未登录或商户无效(需 x-mch 请求头 + 已开通商户)');
      const orders = merchantOrders(id); const todayKey = port.dayKey(port.now());
      const today = orders.filter(order => port.dayKey(order.createdAt) === todayKey);
      const month = orders.filter(order => port.isoDay(order.createdAt).slice(0, 7) === port.isoDay(port.now()).slice(0, 7));
      const pendingSettles = port.settles().filter(item => item.mchId === id && item.status === 'pending');
      const pendingRefunds = port.refunds().filter(item => item.mchId === id && item.status === 'pending');
      return ok({
        me: { id, name: account.name, mchNo: account.mchNo, mccLabel: port.mccLabels[account.mcc] || account.mcc, settleDays: account.settleDays, settleLabel: `T+${account.settleDays}` },
        today: { amount: port.round(today.reduce((sum, order) => sum + order.amount, 0)), count: today.length, successRate: today.length ? +(100 * today.filter(order => order.status !== 'disputed').length / today.length).toFixed(1) : 100 },
        month: { amount: port.round(month.reduce((sum, order) => sum + order.amount, 0)), count: month.length },
        pendingSettle: { batches: pendingSettles.length, net: port.round(pendingSettles.reduce((sum, item) => sum + item.net, 0)) },
        pendingRefunds: pendingRefunds.length,
        recent: orders.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 6).map(port.presentOrder),
      });
    },
    profile(id) {
      const account = requireMerchant(id); if (!account) return failure(401, '未登录或商户无效(需 x-mch 请求头 + 已开通商户)');
      const risk = port.risks().find(item => item.mchId === id) || {};
      const profile = port.presentAccount(account);
      return ok({
        profile: { id: profile.id, name: profile.name, mchNo: profile.mchNo, mccLabel: profile.mccLabel, country: profile.country, contact: profile.contact, settleAccount: profile.settleAccount, settleDays: profile.settleDays, settleLabel: profile.settleLabel, rate: profile.rate, rateLabel: profile.rateLabel, createdAt: profile.createdAt },
        apiKey: profile.apiKey || '(入驻时未生成, 请联系平台)',
        risk: { score: risk.score || 0, flags: risk.flags || [] },
        splits: port.splits().filter(split => split.mchId === id).map(split => ({ ...split, receiverTypeLabel: port.splitTypeLabels[split.receiverType] || split.receiverType, orderNo: port.orderById(split.orderId)?.orderNo || '—', pctLabel: `${Math.round((split.pct || 0) * 10000) / 100}%` })),
        note: '费率与结算账户由平台配置, 商户端只读',
      });
    },
    listOrders(id, query = {}) {
      if (!requireMerchant(id)) return failure(401, '未登录或商户无效(需 x-mch 请求头 + 已开通商户)');
      const all = merchantOrders(id); let list = all.map(port.presentOrder);
      if (query.status) list = list.filter(order => order.status === query.status);
      return ok({ list: list.sort((a, b) => b.createdAt - a.createdAt).slice(0, 200), summary: { total: all.length, amount: port.round(all.reduce((sum, order) => sum + order.amount, 0)), refunded: all.filter(order => order.status === 'refunded').length } });
    },
    listRefunds(id) {
      if (!requireMerchant(id)) return failure(401, '未登录或商户无效(需 x-mch 请求头 + 已开通商户)');
      return ok({ list: port.refunds().filter(refund => refund.mchId === id).map(port.presentRefund).sort((a, b) => b.appliedAt - a.appliedAt) });
    },
    applyRefund(id, body = {}, idempotencyKey = '') {
      if (!requireMerchant(id)) return failure(401, '未登录或商户无效(需 x-mch 请求头 + 已开通商户)');
      if (idempotencyKey) {
        const replay = port.refunds().find(refund => refund.mchId === id && refund.idempotencyKey === idempotencyKey);
        if (replay) return ok({ ok: true, refund: port.presentRefund(replay), replayed: true, note: '幂等重放: 返回原退款申请' });
      }
      const reason = String(body.reason || '').trim();
      if (!reason) return failure(400, '请填写退款原因');
      const order = port.orderById(body.orderId);
      if (!order || order.mchId !== id) return failure(404, '订单不存在');
      if (order.status !== 'paid') return failure(409, `订单当前状态「${port.orderStatusLabels[order.status] || order.status}」不可申请退款`);
      if (port.refunds().some(refund => refund.orderId === order.id && refund.status !== 'rejected')) return failure(409, '该订单已有处理中/已完成的退款单');
      const refund = { id: port.nextId(), orderId: order.id, mchId: id, reason, status: 'pending', appliedAt: port.now(), appliedBy: '商户门户', approvedAt: null, approvedBy: '', actNote: '', ...(idempotencyKey ? { idempotencyKey } : {}) };
      port.refunds().unshift(refund);
      return ok({ ok: true, refund: port.presentRefund(refund), note: '退款申请已提交, 待平台审核(后台 商户平台 → 退款管理)' });
    },
    listSettles(id) {
      if (!requireMerchant(id)) return failure(401, '未登录或商户无效(需 x-mch 请求头 + 已开通商户)');
      return ok({ list: port.settles().filter(item => item.mchId === id).map(port.presentSettle).sort((a, b) => (a.status === b.status ? (b.day < a.day ? -1 : 1) : a.status === 'pending' ? -1 : 1)) });
    },
  };
}
