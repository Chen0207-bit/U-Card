import { failure, ok } from '../../api/response.js';

export function createCrmService(port) {
  const session = actorId => {
    const me = port.repById(actorId);
    if (!me) return null;
    return { sid: actorId, ids: actorId === 1 ? port.salesReps().map(rep => rep.id) : port.subtreeIds(actorId), me };
  };
  const requireSession = actorId => session(actorId) || failure(401, '请先选择运营后台账号', 'AUTH_REQUIRED');
  const scopedUserIds = ids => port.users().filter(user => ids.includes(user.salesRepId)).map(user => user.id);

  return {
    listCustomers(actorId, query = {}) {
      const auth = requireSession(actorId); if (auth.status) return auth;
      if (query.id) return ok(port.presentCustomer(port.customers().find(customer => customer.id === +query.id)));
      return ok(port.customers().filter(customer => auth.ids.includes(customer.ownerSalesId)).map(port.presentCustomer));
    },

    createCustomer(actorId, body = {}) {
      const auth = requireSession(actorId); if (auth.status) return auth;
      const duplicate = port.customers().find(customer => customer.contact === body.contact);
      if (duplicate) return failure(409, `查重: 已存在客户 ${duplicate.name}(${duplicate.stage})`);
      const customer = { id: port.nextId(), ...body, stage: '线索', userId: null, tags: [], createdAt: port.now(), nextFollowAt: port.now() + 3 * 864e5 };
      port.customers().unshift(customer); return ok(customer);
    },

    customerOverview(actorId, customerId) {
      const auth = requireSession(actorId); if (auth.status) return auth;
      const customer = port.customers().find(item => item.id === customerId); if (!customer) return failure(404, '客户不存在');
      if (!auth.ids.includes(customer.ownerSalesId)) return failure(403, '无权查看该客户(不在你的数据范围内)');
      const user = customer.userId ? port.users().find(item => item.id === customer.userId) : null;
      const cards = user ? port.cards().filter(card => card.userId === user.id).map(card => ({ id: card.id, cardNo: card.cardNo, level: card.level, levelLabel: port.cardLevels[card.level].label, balance: card.balance, status: card.status, createdAt: card.createdAt })) : [];
      const transactions = user ? port.transactions().filter(tx => tx.userId === user.id) : [];
      const topups = transactions.filter(tx => tx.type === 'topup'); const consumes = transactions.filter(tx => tx.type === 'consume');
      const sum = list => +list.reduce((total, tx) => total + tx.amount, 0).toFixed(2); const txIds = new Set(transactions.map(tx => tx.id));
      const commissions = port.commissions().filter(item => txIds.has(item.refId)).sort((a, b) => b.createdAt - a.createdAt);
      return ok({
        customer: { ...customer, owner: port.repById(customer.ownerSalesId)?.name },
        user: user ? { id: user.id, name: user.name, phone: user.phone, email: user.email, points: user.points, kycLevel: user.kycLevel, kycStatus: user.kycStatus, createdAt: user.createdAt } : null,
        followups: port.followups().filter(item => item.customerId === customer.id).sort((a, b) => b.createdAt - a.createdAt).map(item => ({ ...item, sales: port.repById(item.salesId)?.name })),
        cards,
        topup: { total: sum(topups), count: topups.length, list: topups.slice(0, 10) },
        consume: { total: sum(consumes), count: consumes.length, list: consumes.slice(0, 10) },
        points: { current: user ? user.points : 0, list: user ? port.pointsLogs().filter(log => log.userId === user.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 10) : [] },
        commission: { total: +commissions.reduce((total, item) => total + item.amount, 0).toFixed(2), count: commissions.length, list: commissions.slice(0, 5).map(port.presentCommission) },
      });
    },

    createFollowup(actorId, body = {}) {
      const auth = requireSession(actorId); if (auth.status) return auth;
      const followup = { id: port.nextId(), customerId: +body.customerId, salesId: +body.salesId || auth.sid, type: body.type, content: body.content, nextPlan: body.nextPlan || '', createdAt: port.now() };
      port.followups().unshift(followup);
      if (body.nextStage) { const customer = port.customers().find(item => item.id === +body.customerId); if (customer) customer.stage = body.nextStage; }
      return ok(followup);
    },

    performance(actorId) {
      const auth = requireSession(actorId); if (auth.status) return auth;
      return ok(port.performanceRows(auth.ids).sort((a, b) => (b.topup + b.consume) - (a.topup + a.consume)));
    },

    listCommissions(actorId) {
      const auth = requireSession(actorId); if (auth.status) return auth;
      return ok(port.commissions().filter(item => auth.ids.includes(item.salesId) || auth.ids.includes(item.fromSalesId)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 300).map(port.presentCommission));
    },

    settleCommission(actorId, body = {}) {
      const auth = requireSession(actorId); if (auth.status) return auth;
      if (auth.sid !== 1) return failure(403, '仅运营总监可结算佣金');
      port.commissions().forEach(item => {
        if (item.id === +body.id) { if (item.status !== 'settled') port.ledgerForCommissionSettle(item, port.now()); item.status = 'settled'; }
      });
      return ok({ ok: true });
    },

    commissionTree(actorId) {
      const auth = requireSession(actorId); if (auth.status) return auth; const ids = auth.ids;
      const nodes = port.salesReps().filter(rep => ids.includes(rep.id)).map(rep => {
        const commissions = port.commissions().filter(item => item.salesId === rep.id);
        return { id: rep.id, name: rep.name, role: rep.role, level: rep.level, region: rep.region, parentId: rep.parentId, teamSize: port.subtreeIds(rep.id).length - 1, target: rep.target, directTotal: +commissions.filter(item => item.tier === 0).reduce((sum, item) => sum + item.amount, 0).toFixed(2), uplineTotal: +commissions.filter(item => item.tier > 0).reduce((sum, item) => sum + item.amount, 0).toFixed(2), total: +commissions.reduce((sum, item) => sum + item.amount, 0).toFixed(2), customers: port.customers().filter(customer => customer.ownerSalesId === rep.id).length, cards: port.cards().filter(card => card.salesRepId === rep.id).length };
      });
      const chains = port.recentChains(ids).map(chain => {
        const transaction = port.transactions().find(tx => tx.id === chain.txId); const card = transaction ? port.cards().find(item => item.id === transaction.cardId) : null;
        const cardNo = card ? String(card.cardNo).replace(/\s/g, '') : '';
        const path = port.commissions().filter(item => item.refId === chain.txId).sort((a, b) => a.tier - b.tier).map(item => ({ salesId: item.salesId, sales: port.repById(item.salesId)?.name, tier: item.tier, tierLabel: item.tierLabel, rate: item.rate, amount: item.amount, status: item.status, refId: item.refId }));
        return { ...chain, userId: transaction?.userId, cardNoMask: cardNo ? `**** **** **** ${cardNo.slice(-4)}` : '', path, total: +path.reduce((sum, item) => sum + item.amount, 0).toFixed(2) };
      });
      return ok({ rules: port.commissionRules, tierLabels: port.tierLabels, nodes, chains });
    },
  };
}
