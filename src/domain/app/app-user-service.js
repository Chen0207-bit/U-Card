import { failure, ok } from '../../api/response.js';

export function createAppUserService(port) {
  const user = id => port.users().find(item => item.id === id);
  const requireUser = id => user(id) || null;
  return {
    me(id) { const account = requireUser(id); return account ? ok(port.presentUser(account)) : failure(401, '未登录'); },
    transactions(id) { return requireUser(id) ? ok(port.transactions().filter(tx => tx.userId === id).slice(0, 50)) : failure(401, '未登录'); },
    topup(id, body = {}) { return requireUser(id) ? ok(port.topup(id, +body.amount, body.method)) : failure(401, '未登录'); },
    pay(id, body = {}) { return requireUser(id) ? ok(port.pay(id, +body.amount, body.merchant || 'Amazon', body.usePoints)) : failure(401, '未登录'); },
    tasks(id) {
      if (!requireUser(id)) return failure(401, '未登录');
      const day = new Date().toDateString(); const logs = port.pointsLogs();
      return ok({ tasks: port.tasks(), signedToday: logs.some(log => log.userId === id && log.source === '每日签到' && new Date(log.createdAt).toDateString() === day), claimed: logs.filter(log => log.userId === id && String(log.refNo).startsWith('TASK')).map(log => +String(log.refNo).slice(4)) });
    },
    sign(id) {
      if (!requireUser(id)) return failure(401, '未登录');
      const day = new Date().toDateString();
      if (port.pointsLogs().some(log => log.userId === id && log.source === '每日签到' && new Date(log.createdAt).toDateString() === day)) return failure(400, '今日已签到');
      port.addPoints(id, 20, '每日签到', 'SIGN', port.now()); return ok({ ok: true });
    },
    claimTask(id, taskId) {
      if (!requireUser(id)) return failure(401, '未登录');
      const task = port.tasks().find(item => item.id === +taskId); if (!task) return failure(404, '任务不存在');
      const logs = port.pointsLogs(); const ref = `TASK${task.id}`;
      if (task.type === 'once' && logs.some(log => log.userId === id && log.refNo === ref)) return failure(400, '该任务奖励已领取过, 不能重复领取');
      if (task.type === 'daily' && logs.some(log => log.userId === id && log.refNo === ref && new Date(log.createdAt).toDateString() === new Date().toDateString())) return failure(400, '今日已领取该任务奖励, 明天再来');
      port.addPoints(id, task.points, `任务奖励:${task.title}`, ref, port.now()); return ok({ ok: true });
    },
    products(id) {
      if (!requireUser(id)) return failure(401, '未登录');
      if (!port.featureEnabled('shopFlag')) return failure(503, '积分商城功能已下线 (Feature Flag: shopFlag=off), 请联系运营在后台「运维中心」恢复', null, { flag: 'shopFlag', degraded: true });
      const products = port.products().filter(product => product.status === 'on').map(product => ({ ...product, limitPerUser: port.productLimit(product), rating: port.productRating(product.id) }));
      return ok({ products, categories: ['全部', ...new Set(products.map(product => product.category))] });
    },
    redeem(id, productId) { return requireUser(id) ? ok(port.redeem(id, +productId)) : failure(401, '未登录'); },
    orders(id) { return requireUser(id) ? ok(port.orders().filter(order => order.userId === id).map(port.presentOrder)) : failure(401, '未登录'); },
    cancelOrder(id, orderId) {
      if (!requireUser(id)) return failure(401, '未登录');
      const order = port.orders().find(item => item.id === +orderId && item.userId === id); if (!order) return failure(404, '订单不存在');
      if (order.status !== 'pending') return failure(400, '仅待发货的实物订单可取消');
      order.status = 'cancelled'; const product = port.products().find(item => item.id === order.productId); if (product) product.stock += 1;
      port.addPoints(id, order.pointsCost, '订单取消退回', order.id, port.now()); return ok({ ok: true, order: port.presentOrder(order) });
    },
    applyAfterSale(id, body = {}) {
      if (!requireUser(id)) return failure(401, '未登录');
      const order = port.orders().find(item => item.id === +body.id && item.userId === id); if (!order) return failure(404, '订单不存在');
      if (!['shipped', 'redeemed'].includes(order.status)) return failure(400, '当前状态的订单不可申请售后');
      order.status = 'aftersale'; order.aftersale = { no: `AS-${port.randomInt(100000, 999999)}`, type: body.type || '退货退款', reason: String(body.reason || '').slice(0, 200), appliedAt: port.now() };
      return ok({ ok: true, order: port.presentOrder(order) });
    },
    reviewOrder(id, body = {}) {
      if (!requireUser(id)) return failure(401, '未登录');
      const order = port.orders().find(item => item.id === +body.id && item.userId === id); if (!order) return failure(404, '订单不存在');
      if (order.status !== 'redeemed') return failure(400, '订单完成后才能评价');
      if (order.review) return failure(400, '该订单已评价过');
      order.review = { stars: Math.min(5, Math.max(1, Math.round(+body.stars) || 5)), text: String(body.text || '').slice(0, 200), createdAt: port.now() };
      return ok({ ok: true, order: port.presentOrder(order) });
    },
    points(id) { return requireUser(id) ? ok(port.pointsLogs().filter(log => log.userId === id).slice(0, 50)) : failure(401, '未登录'); },
    pointsSummary(id) { return requireUser(id) ? ok(port.pointsSummary(id)) : failure(401, '未登录'); },
    invite(id) {
      if (!requireUser(id)) return failure(401, '未登录');
      const invited = port.users().filter(item => item.invitedBy === id); const base = `UC${String(id).padStart(4, '0')}`;
      return ok({ code: `${base}${String(100 + id).slice(-3)}`, link: `https://u-card.app/i/${base}`, invited: invited.map(item => ({ name: item.name, at: item.createdAt, reward: 800 })), totalReward: invited.length * 800 });
    },
    submitKyc(id) { const account = requireUser(id); if (!account) return failure(401, '未登录'); account.kycStatus = 'pending_upgrade'; return ok({ ok: true }); },
    changePassword(id, body = {}) {
      if (!requireUser(id)) return failure(401, '未登录');
      const oldPassword = String(body.oldPassword || ''), password = String(body.newPassword || ''), confirmation = String(body.newPassword2 || '');
      if (!oldPassword || !password) return failure(400, '请填写旧密码与新密码');
      if (password !== confirmation) return failure(400, '两次输入的新密码不一致');
      return ok({ ok: true });
    },
    notifications(id) { return requireUser(id) ? ok(port.notifications(id)) : failure(401, '未登录'); },
    readNotifications(id, body = {}) {
      if (!requireUser(id)) return failure(401, '未登录');
      const read = port.notificationRead()[id] || (port.notificationRead()[id] = {}); const current = port.notifications(id);
      if (body.all) current.list.forEach(item => { read[item.id] = true; }); else if (body.id) read[body.id] = true;
      return ok({ ok: true, unread: port.notifications(id).unread });
    },
  };
}
