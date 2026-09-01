import { failure, ok } from '../../api/response.js';

export function createAdminShopService(port) {
  const session = actorId => {
    const me = port.repById(actorId);
    if (!me) return null;
    return { sid: actorId, ids: actorId === 1 ? port.salesReps().map(rep => rep.id) : port.subtreeIds(actorId) };
  };
  const requireSession = actorId => session(actorId) || failure(401, '请先选择运营后台账号', 'AUTH_REQUIRED');
  const scopedUserIds = ids => port.users().filter(user => ids.includes(user.salesRepId)).map(user => user.id);

  return {
    listPoints(actorId) {
      const auth = requireSession(actorId); if (auth.status) return auth; const userIds = scopedUserIds(auth.ids);
      return ok({ rules: { POINTS_PER_USD: port.pointsPerUsd, CARD_LEVELS: port.cardLevels, COMMISSION: port.commissionRules }, logs: port.pointsLogs().filter(log => auth.sid === 1 || userIds.includes(log.userId)).slice(0, 200).map(log => ({ ...log, user: port.users().find(user => user.id === log.userId)?.name })) });
    },
    grantPoints(actorId, body = {}) {
      const auth = requireSession(actorId); if (auth.status) return auth;
      if (auth.sid !== 1) return failure(403, '仅运营总监可发放积分');
      port.addPointsLog(+body.userId, +body.delta, body.source || '运营发放', 'OP', port.now()); return ok({ ok: true });
    },
    listProducts(actorId) {
      const auth = requireSession(actorId); if (auth.status) return auth; return ok(port.products());
    },
    toggleProduct(actorId, productId) {
      const auth = requireSession(actorId); if (auth.status) return auth;
      if (auth.sid !== 1) return failure(403, '仅运营总监可上下架商品');
      const product = port.products().find(item => item.id === productId); if (product) product.status = product.status === 'on' ? 'off' : 'on';
      return ok({ ok: true });
    },
    listOrders(actorId) {
      const auth = requireSession(actorId); if (auth.status) return auth; const userIds = scopedUserIds(auth.ids);
      return ok(port.orders().filter(order => auth.sid === 1 || userIds.includes(order.userId)).map(port.presentOrder));
    },
    shipOrder(actorId, body = {}) {
      const auth = requireSession(actorId); if (auth.status) return auth;
      if (auth.sid !== 1) return failure(403, '仅运营总监可发货');
      const order = port.orders().find(item => item.id === +body.id);
      if (order) { order.status = 'shipped'; order.trackingNo = body.trackingNo || `SF${port.randomInt(100000000, 999999999)}`; }
      return ok({ ok: true });
    },
  };
}
