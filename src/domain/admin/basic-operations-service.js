import { failure, ok } from '../../api/response.js';

export function createBasicOperationsService(port) {
  const session = actorId => {
    const me = port.repById(actorId);
    if (!me) return null;
    return { sid: actorId, ids: actorId === 1 ? port.salesReps().map(rep => rep.id) : port.subtreeIds(actorId), me };
  };
  const requireSession = actorId => session(actorId) || failure(401, '请先选择运营后台账号', 'AUTH_REQUIRED');
  const scopedUserIds = ids => port.users().filter(user => ids.includes(user.salesRepId)).map(user => user.id);
  const director = (sid, message) => sid === 1 ? null : failure(403, message);

  return {
    dashboard(actorId, query = {}) {
      const auth = requireSession(actorId); if (auth.status) return auth;
      const { sid, ids, me } = auth; const userIds = scopedUserIds(ids);
      const range = ['today', 'week', 'month', 'quarter'].includes(query.range) ? query.range : 'today';
      const rangeStart = port.rangeStartTs(range);
      const topups = port.transactions().filter(tx => tx.type === 'topup' && tx.status === 'success' && userIds.includes(tx.userId));
      const consumes = port.transactions().filter(tx => tx.type === 'consume' && tx.status === 'success' && userIds.includes(tx.userId));
      const rangeTx = [...topups, ...consumes].filter(tx => tx.createdAt >= rangeStart);
      const topupTotal = +rangeTx.filter(tx => tx.type === 'topup').reduce((sum, tx) => sum + tx.amount, 0).toFixed(2);
      const consumeTotal = +rangeTx.filter(tx => tx.type === 'consume').reduce((sum, tx) => sum + tx.amount, 0).toFixed(2);
      const commissions = port.commissions().filter(item => ids.includes(item.salesId));
      const scopedTx = port.transactions().filter(tx => userIds.includes(tx.userId));
      const today = new Date().toDateString();
      const isToday = ts => new Date(ts).toDateString() === today;
      return ok({
        me: { id: me.id, name: me.name, role: me.role, level: me.level },
        stats: {
          range,
          gmv: +(topupTotal + consumeTotal).toFixed(2), topupTotal, consumeTotal,
          activeUsers: new Set(scopedTx.filter(tx => tx.createdAt >= port.now() - 30 * 864e5).map(tx => tx.userId)).size,
          riskCount: scopedTx.filter(tx => tx.status === 'refunded' || (tx.type === 'consume' && tx.amount > 400)).length,
          totalCards: port.cards().filter(card => ids.includes(card.salesRepId)).length,
          activeCards: port.cards().filter(card => ids.includes(card.salesRepId) && card.status === 'active').length,
          todayTopup: +topups.filter(tx => isToday(tx.createdAt)).reduce((sum, tx) => sum + tx.amount, 0).toFixed(0),
          todayConsume: +consumes.filter(tx => isToday(tx.createdAt)).reduce((sum, tx) => sum + tx.amount, 0).toFixed(0),
          totalBalance: +port.cards().filter(card => ids.includes(card.salesRepId)).reduce((sum, card) => sum + card.balance, 0).toFixed(0),
          pendingKyc: port.users().filter(user => ids.includes(user.salesRepId) && user.kycStatus.startsWith('pending')).length,
          pendingOrders: sid === 1 ? port.orders().filter(order => order.status === 'pending').length : port.orders().filter(order => userIds.includes(order.userId) && order.status === 'pending').length,
          pendingCommission: +commissions.filter(item => item.status === 'pending').reduce((sum, item) => sum + item.amount, 0).toFixed(2),
          customers: port.customers().filter(customer => ids.includes(customer.ownerSalesId)).length,
          pointsIssued: (sid === 1 ? port.pointsLogs().filter(log => log.delta > 0) : port.pointsLogs().filter(log => log.delta > 0 && userIds.includes(log.userId))).reduce((sum, log) => sum + log.delta, 0),
        },
        trend: port.buildTrend(range, topups, consumes),
        recentTx: port.transactions().filter(tx => userIds.includes(tx.userId)).slice(0, 8).map(port.presentTransaction),
        perf: port.performanceRows(ids).sort((a, b) => (b.topup + b.consume) - (a.topup + a.consume)),
      });
    },

    listCards(actorId) {
      const auth = requireSession(actorId); if (auth.status) return auth;
      return ok(port.cards().filter(card => auth.ids.includes(card.salesRepId)).map(card => ({
        ...card, levelLabel: port.cardLevels[card.level].label,
        user: port.users().find(user => user.id === card.userId)?.name,
        kyc: port.users().find(user => user.id === card.userId)?.kycLevel,
        salesRep: port.repById(card.salesRepId)?.name,
      })));
    },

    issueCard(actorId, body = {}) {
      const auth = requireSession(actorId); if (auth.status) return auth;
      const user = port.users().find(item => item.id === +body.userId); if (!user) return failure(400, '用户不存在');
      const card = { id: port.nextId(), userId: user.id, cardNo: port.generateCardNo(port.randomInt(0, 2)), cvv: String(port.randomInt(100, 999)), expMonth: port.randomInt(1, 12), expYear: 30, level: body.level || 'standard', status: 'active', balance: 0, salesRepId: body.salesRepId || user.salesRepId, createdAt: port.now() };
      port.cards().push(card); port.addCommissions(card.salesRepId, 'card', 1, card.id, port.now());
      port.ensureCardLedgerAccount(card); port.ledgerForMonthlyFee(card, port.now());
      const customer = port.customers().find(item => item.userId === user.id);
      if (customer && ['线索', '意向', '方案'].includes(customer.stage)) customer.stage = '开卡';
      return ok({ card });
    },

    updateCard(actorId, cardId, body = {}) {
      const auth = requireSession(actorId); if (auth.status) return auth;
      const denied = director(auth.sid, '仅运营总监可执行冻结/调账'); if (denied) return denied;
      const card = port.cards().find(item => item.id === cardId); if (!card) return failure(404, 'not found');
      if (body.action === 'freeze') card.status = (card.status === 'frozen' || card.status === 'lost') ? 'active' : 'frozen';
      if (body.action === 'adjust') {
        const before = card.balance; card.balance = +(card.balance + +body.amount).toFixed(2);
        const transaction = { id: port.nextId(), type: 'adjust', userId: card.userId, cardId: card.id, amount: +body.amount, fee: 0, method: 'adjust', ref: `OP-${port.randomInt(10000, 99999)}`, pointsEarned: 0, status: 'success', createdAt: port.now() };
        port.transactions().unshift(transaction); port.ledgerForAdjust(transaction, card, +(card.balance - before).toFixed(2));
      }
      return ok({ card });
    },

    listKyc(actorId) {
      const auth = requireSession(actorId); if (auth.status) return auth;
      return ok(port.users().filter(user => auth.ids.includes(user.salesRepId) && user.kycStatus.startsWith('pending')).map(user => ({ id: user.id, name: user.name, country: user.country, phone: user.phone, kycLevel: user.kycLevel, applyLevel: user.kycLevel + 1, idType: port.pick(['护照', '国民ID']), submitAt: port.daysAgo(port.randomInt(1, 5)), docs: ['passport.jpg', 'selfie.jpg'], owner: port.repById(user.salesRepId)?.name })));
    },

    reviewKyc(actorId, body = {}) {
      const auth = requireSession(actorId); if (auth.status) return auth;
      const denied = director(auth.sid, '仅运营总监可审核 KYC'); if (denied) return denied;
      const user = port.users().find(item => item.id === +body.userId); if (!user) return failure(400, '用户不存在');
      if (body.pass) { user.kycLevel = body.toLevel || user.kycLevel + 1; user.kycStatus = 'approved'; port.addPointsLog(user.id, 200, 'KYC 认证奖励', 'KYC', port.now()); }
      else user.kycStatus = 'rejected';
      return ok({ ok: true });
    },

    listTransactions(actorId, query = {}) {
      const auth = requireSession(actorId); if (auth.status) return auth; const userIds = scopedUserIds(auth.ids);
      return ok(port.transactions().filter(tx => userIds.includes(tx.userId) && (!query.type || tx.type === query.type)).slice(0, 200).map(port.presentTransaction));
    },

    refund(actorId, body = {}) {
      const auth = requireSession(actorId); if (auth.status) return auth;
      const denied = director(auth.sid, '仅运营总监可执行退款'); if (denied) return denied;
      const transaction = port.transactions().find(item => item.id === +body.txId);
      if (!transaction || transaction.type !== 'consume') return failure(400, '交易不存在');
      transaction.status = 'refunded'; const card = port.cards().find(item => item.id === transaction.cardId);
      card.balance = +(card.balance + transaction.amount).toFixed(2); port.ledgerForRefund(transaction, port.now());
      return ok({ ok: true });
    },

    listUsers(actorId) {
      const auth = requireSession(actorId); if (auth.status) return auth;
      return ok(port.users().filter(user => auth.ids.includes(user.salesRepId)).map(port.presentUser));
    },

    createUser(actorId, body = {}) {
      const auth = requireSession(actorId); if (auth.status) return auth; const { sid } = auth;
      const name = String(body.name || '').trim(); if (!name) return failure(400, '请填写客户姓名');
      const phone = String(body.phone || '').trim();
      if (phone && port.users().some(user => user.phone === phone)) return failure(409, `手机号已存在: ${name}`);
      const repId = +body.salesRepId || (sid === 1 ? 30 : sid);
      if (!port.repById(repId)) return failure(400, '归属销售不存在');
      if (sid !== 1 && !port.subtreeIds(sid).includes(repId)) return failure(403, '只能为本人或下级团队的客户开户');
      const userId = Math.max(0, ...port.users().map(user => user.id)) + 1;
      port.users().push({ id: userId, name, phone: phone || `+966 5${port.randomInt(10000000, 99999999)}`, email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@ucard.io`, country: body.country || 'Saudi Arabia', cc: 'SA', city: body.city || 'Riyadh', kycLevel: 0, kycStatus: 'pending_upgrade', salesRepId: repId, invitedBy: null, points: 200, createdAt: port.now() });
      let card = null;
      if (body.issueCard !== false) {
        card = { id: Math.max(0, ...port.cards().map(item => item.id)) + 1, userId, cardNo: port.generateCardNo(), cvv: String(port.randomInt(100, 999)), expMonth: port.randomInt(1, 12), expYear: port.randomInt(28, 31), level: body.level || 'standard', status: 'active', balance: 0, salesRepId: repId, createdAt: port.now() };
        port.cards().push(card); port.addCommissions(repId, 'card', 1, card.id, port.now()); port.ensureCardLedgerAccount(card); port.ledgerForMonthlyFee(card, port.now());
      }
      return ok({ user: port.presentUser(port.users().find(user => user.id === userId)), card });
    },

    createSales(actorId, body = {}) {
      const auth = requireSession(actorId); if (auth.status) return auth;
      const denied = director(auth.sid, '仅运营总监可创建销售账号'); if (denied) return denied;
      const name = String(body.name || '').trim(); if (!name) return failure(400, '请填写姓名');
      if (port.salesReps().some(rep => rep.name === name)) return failure(409, '同名销售已存在');
      const parent = port.repById(+body.parentId); if (!parent) return failure(400, '请选择上级(挂靠的组织节点)');
      const level = parent.level + 1; if (level > 3) return failure(400, '三级销售下不能再挂下级(演示上限三级)');
      const roles = { 1: '一级销售', 2: '二级销售', 3: '三级销售' }; const targets = { 1: 120000, 2: 60000, 3: 25000 };
      const id = Math.max(0, ...port.salesReps().map(rep => rep.id)) + 1;
      port.salesReps().push({ id, name, role: body.role || roles[level], parentId: parent.id, level, region: body.region || parent.region, target: +body.target || targets[level] });
      return ok({ sales: port.salesReps().find(rep => rep.id === id) });
    },

    goals(actorId, query = {}) {
      const auth = requireSession(actorId); if (auth.status) return auth; const ids = auth.ids;
      const dim = query.dim === 'team' ? 'team' : 'personal'; const period = ['month', 'quarter', 'year'].includes(query.period) ? query.period : 'month';
      const mult = period === 'year' ? 12 : period === 'quarter' ? 3 : 1; const current = new Date();
      const periodStart = period === 'year' ? new Date(current.getFullYear(), 0, 1).getTime() : period === 'quarter' ? new Date(current.getFullYear(), Math.floor(current.getMonth() / 3) * 3, 1).getTime() : new Date(current.getFullYear(), current.getMonth(), 1).getTime();
      const rate = (done, target) => target > 0 ? +(done / target * 100).toFixed(1) : 0;
      const rows = port.salesReps().filter(rep => ids.includes(rep.id) && rep.level > 0).map(rep => {
        const teamIds = port.subtreeIds(rep.id); const aggregateIds = dim === 'team' ? teamIds : [rep.id]; const userIds = port.users().filter(user => aggregateIds.includes(user.salesRepId)).map(user => user.id);
        const transactions = port.transactions().filter(tx => userIds.includes(tx.userId) && tx.status === 'success' && tx.createdAt >= periodStart);
        const done = { cards: port.cards().filter(card => aggregateIds.includes(card.salesRepId) && card.createdAt >= periodStart).length, topup: +transactions.filter(tx => tx.type === 'topup').reduce((sum, tx) => sum + tx.amount, 0).toFixed(2), consume: +transactions.filter(tx => tx.type === 'consume').reduce((sum, tx) => sum + tx.amount, 0).toFixed(2), points: port.pointsLogs().filter(log => userIds.includes(log.userId) && log.delta > 0 && log.createdAt >= periodStart).reduce((sum, log) => sum + log.delta, 0) };
        const base = rep.target || (rep.level === 1 ? 120000 : rep.level === 2 ? 60000 : 25000);
        const targets = { cards: (rep.level === 1 ? 20 : rep.level === 2 ? 12 : 6) * mult, topup: Math.round(base * 0.7 * mult), consume: Math.round(base * 0.3 * mult), points: Math.round(base * 0.3 * mult * 10) };
        const rates = { cards: rate(done.cards, targets.cards), topup: rate(done.topup, targets.topup), consume: rate(done.consume, targets.consume), points: rate(done.points, targets.points) };
        return { id: rep.id, name: rep.name, role: rep.role, level: rep.level, region: rep.region, teamSize: teamIds.length - 1, baseTarget: base, dim, period, targets, done, rates, overall: +((rates.cards + rates.topup + rates.consume + rates.points) / 4).toFixed(1) };
      }).sort((a, b) => b.overall - a.overall);
      rows.forEach((row, index) => { row.rank = index + 1; });
      const sumDone = key => rows.reduce((sum, row) => sum + row.done[key], 0); const sumTarget = key => rows.reduce((sum, row) => sum + row.targets[key], 0);
      const rates = ['cards', 'topup', 'consume', 'points'].map(key => rate(sumDone(key), sumTarget(key)));
      return ok({ dim, period, mult, periodStart, summary: { repCount: rows.length, overall: +(rates.reduce((sum, value) => sum + value, 0) / rates.length).toFixed(1), rates: { cards: rates[0], topup: rates[1], consume: rates[2], points: rates[3] }, done: { cards: sumDone('cards'), topup: +sumDone('topup').toFixed(2), consume: +sumDone('consume').toFixed(2), points: sumDone('points') }, targets: { cards: sumTarget('cards'), topup: sumTarget('topup'), consume: sumTarget('consume'), points: sumTarget('points') }, top: rows[0] ? { id: rows[0].id, name: rows[0].name, overall: rows[0].overall } : null }, rows });
    },

    me(actorId) {
      const auth = requireSession(actorId); if (auth.status) return auth;
      return ok({ ...auth.me, scope: '全部数据', teamIds: port.subtreeIds(auth.sid) });
    },
  };
}
