import { failure, ok } from '../../api/response.js';

export function createMerchantAdminPlatformService(port) {
  const actorName = actor => port.operatorName(actor?.id);
  const countBy = (items, status) => items.filter(item => item.status === status).length;

  return {
    listAccounts() {
      const accounts = port.accounts();
      const orders = port.orders();
      return ok({
        list: accounts.map(port.presentAccount),
        summary: {
          total: accounts.length,
          pending: countBy(accounts, 'pending'),
          active: countBy(accounts, 'active'),
          rejected: countBy(accounts, 'rejected'),
          orders: orders.length,
          paidVolume: port.round(orders.filter(order => order.status !== 'disputed').reduce((sum, order) => sum + order.amount, 0)),
        },
        flow: ['商户入驻审核', '费率配置', '收款交易', '退款/风控', '结算打款'],
      });
    },

    reviewAccount(id, body = {}, actor) {
      const account = port.accountById(id);
      if (!account) return failure(404, '商户不存在');
      if (account.status !== 'pending') return failure(409, `仅待审核商户可操作, 当前状态: ${port.merchantStatusLabels[account.status] || account.status}`);
      const action = String(body.action || '');
      const reason = String(body.reason || '').trim();
      const kyb = port.kybOf(account);
      const operator = actorName(actor);

      if (action === 'approve') {
        if (kyb && kyb.status === 'rejected') return failure(409, `关联 KYB 案例 #${kyb.id} 已被驳回, 不可开通(需商户重新提交入驻与尽调材料)`);
        account.status = 'active';
        account.mchNo = port.generateMerchantNumber();
        account.reviewedAt = port.now();
        account.apiKey = port.generateMerchantApiKey();
        const presented = port.presentAccount(account);
        port.timelineAdd(account, '入驻审核通过', `商户号 ${account.mchNo} 已生成 · 结算周期 T+${account.settleDays} · 费率 ${presented.rateLabel}${kyb && kyb.status !== 'approved' ? ` · 合规提示: 关联 KYB #${kyb.id} ${port.kybStatusLabels[kyb.status] || kyb.status}, 请补审` : ''}`, operator);
        if (kyb && kyb.status === 'pending') {
          kyb.status = 'approved';
          kyb.decidedAt = port.now();
          (kyb.timeline || (kyb.timeline = [])).unshift({ ts: port.now(), node: '审核通过', note: `商户入驻审核联动: 收单开通, 商户号 ${account.mchNo}`, operator });
        }
        return ok({ ok: true, mch: port.presentAccount(account), note: `已开通收单并生成商户号 ${account.mchNo}(API Key 已下发, 商户端可登录)` });
      }
      if (action === 'reject') {
        if (!reason) return failure(400, '驳回必须填写原因');
        account.status = 'rejected';
        account.rejectReason = reason;
        account.reviewedAt = port.now();
        port.timelineAdd(account, '入驻驳回', reason, operator);
        if (kyb && kyb.status === 'pending') {
          kyb.status = 'rejected';
          kyb.decidedAt = port.now();
          (kyb.timeline || (kyb.timeline = [])).unshift({ ts: port.now(), node: '审核驳回', note: `商户入驻驳回联动: ${reason}`, operator });
        }
        return ok({ ok: true, mch: port.presentAccount(account), note: `已驳回(${reason})` });
      }
      return failure(400, `未知 action: ${action}`);
    },

    updateRate(id, body = {}, actor) {
      const account = port.accountById(id);
      if (!account) return failure(404, '商户不存在');
      const credit = +body.credit;
      const debit = +body.debit;
      const fx = +body.fx;
      const debitCap = +body.debitCap;
      const settleDays = +body.settleDays;
      if (!(credit > 0 && credit <= 0.1) || !(debit > 0 && debit <= 0.1) || !(fx > 0 && fx <= 0.1)) return failure(400, '费率需在 (0%, 10%] 区间');
      if (!(debitCap >= 0.5 && debitCap <= 50)) return failure(400, '借记封顶需在 $0.5 - $50');
      if (![0, 1, 2, 3].includes(settleDays)) return failure(400, '结算周期仅支持 T+0 / T+1 / T+2 / T+3');
      const from = { rate: { ...account.rate }, settleDays: account.settleDays };
      account.rate = { credit: Math.round(credit * 10000) / 10000, debit: Math.round(debit * 10000) / 10000, fx: Math.round(fx * 10000) / 10000, debitCap: port.round(debitCap) };
      account.settleDays = settleDays;
      port.timelineAdd(account, '费率/结算周期调整', `贷记 ${(credit * 100).toFixed(2)}% / 借记 ${(debit * 100).toFixed(2)}%(封顶 $${debitCap.toFixed(2)}) / 换汇 ${(fx * 100).toFixed(2)}% · 结算 T+${settleDays}`, actorName(actor));
      return ok({ ok: true, mch: port.presentAccount(account), from, note: '费率已生效(新交易按新费率计费, 历史订单不追溯)' });
    },

    listOrders(query = {}) {
      const all = port.orders();
      let list = all.map(port.presentOrder);
      if (query.status) list = list.filter(order => order.status === query.status);
      if (query.mchId) list = list.filter(order => order.mchId === +query.mchId);
      return ok({
        list: list.sort((a, b) => b.createdAt - a.createdAt),
        summary: {
          total: all.length,
          paid: countBy(all, 'paid'),
          refunded: countBy(all, 'refunded'),
          disputed: countBy(all, 'disputed'),
          amount: port.round(all.reduce((sum, order) => sum + order.amount, 0)),
          fee: port.round(all.reduce((sum, order) => sum + order.fee, 0)),
          net: port.round(all.reduce((sum, order) => sum + order.net, 0)),
        },
        note: '收单订单实时入账: 借 channel:fiat / 贷 merchant:名(净额) / 贷 fee',
      });
    },

    listRefunds(query = {}) {
      const all = port.refunds();
      let list = all.map(port.presentRefund);
      if (query.status) list = list.filter(refund => refund.status === query.status);
      return ok({
        list: list.sort((a, b) => b.appliedAt - a.appliedAt),
        summary: {
          total: all.length,
          pending: countBy(all, 'pending'),
          approved: countBy(all, 'approved'),
          rejected: countBy(all, 'rejected'),
          pendingAmount: port.round(all.filter(refund => refund.status === 'pending').reduce((sum, refund) => sum + (port.presentRefund(refund).amount || 0), 0)),
        },
        note: '退款通过 → 反向分录(借商户净额+借手续费 / 贷渠道原路退回) + 订单转 refunded + 联动待结算批次重算',
      });
    },

    reviewRefund(id, body = {}, actor) {
      const refund = port.refunds().find(item => item.id === +id);
      if (!refund) return failure(404, '退款单不存在');
      if (refund.status !== 'pending') return failure(409, `仅待审核退款可操作, 当前状态: ${port.refundStatusLabels[refund.status] || refund.status}`);
      const action = String(body.action || '');
      const note = String(body.note || '').trim();
      const operator = actorName(actor);
      if (action === 'approve') {
        const order = port.orderById(refund.orderId);
        if (!order) return failure(404, '退款单关联订单不存在');
        if (order.status !== 'paid') return failure(409, `订单当前状态「${port.orderStatusLabels[order.status] || order.status}」不可退款`);
        port.postRefundLedger(refund, port.now());
        order.status = 'refunded';
        order.refundedAt = port.now();
        refund.status = 'approved';
        refund.approvedAt = port.now();
        refund.approvedBy = operator;
        refund.actNote = note || '同意全额退款(原路退回)';
        let batchTouched = null;
        port.settles().filter(batch => batch.status === 'pending' && (batch.orderIds || []).includes(order.id)).forEach(batch => {
          batch.orderIds = batch.orderIds.filter(orderId => orderId !== order.id);
          port.recomputeSettle(batch);
          batchTouched = batch.id;
        });
        const account = port.accountById(order.mchId);
        port.timelineAdd(account, '订单退款', `订单 ${order.orderNo} $${port.round(order.amount).toFixed(2)} 已原路退回(反向分录 MRFD${refund.id})${batchTouched ? ` · 待结算批次 #${batchTouched} 已联动重算` : ''}`, operator);
        return ok({ ok: true, refund: port.presentRefund(refund), order: port.presentOrder(order), batchTouched, note: `反向分录已入账(MRFD${refund.id}: 借 merchant:${order.merchant} 净额+借 fee / 贷 channel:fiat)` });
      }
      if (action === 'reject') {
        if (!note) return failure(400, '驳回必须填写原因');
        refund.status = 'rejected';
        refund.approvedAt = port.now();
        refund.approvedBy = operator;
        refund.actNote = note;
        return ok({ ok: true, refund: port.presentRefund(refund), note: `已驳回(${note}), 订单与账本不变` });
      }
      return failure(400, `未知 action: ${action}`);
    },

    listSettles(query = {}) {
      const all = port.settles();
      let list = all.map(port.presentSettle);
      if (query.status) list = list.filter(batch => batch.status === query.status);
      if (query.mchId) list = list.filter(batch => batch.mchId === +query.mchId);
      const pending = all.filter(batch => batch.status === 'pending');
      const settled = all.filter(batch => batch.status === 'settled');
      return ok({
        list: list.sort((a, b) => a.status === b.status ? (b.day < a.day ? -1 : 1) : a.status === 'pending' ? -1 : 1),
        summary: { total: all.length, pending: pending.length, settled: settled.length, pendingNet: port.round(pending.reduce((sum, batch) => sum + batch.net, 0)), settledNet: port.round(settled.reduce((sum, batch) => sum + batch.net, 0)) },
        note: '「结算」按 T+N 打款: STL- 复式分录 借 merchant:名 / [分账拆付 贷接收方×N] / 贷 channel:fiat',
      });
    },

    settle(id, actor) {
      const batch = port.settles().find(item => item.id === +id);
      if (!batch) return failure(404, '结算批次不存在');
      if (batch.status !== 'pending') return failure(409, `仅待结算批次可打款, 当前: ${port.settleStatusLabels[batch.status] || batch.status}`);
      if (!(batch.orderIds || []).length) return failure(409, '该批次订单已全部退款冲回, 无可结算金额(可忽略该批次)');
      const result = port.postSettleLedger(batch, port.now());
      const account = port.accountById(batch.mchId);
      port.timelineAdd(account, '结算打款', `批次 #${batch.id}(${batch.day}) $${port.round(batch.net).toFixed(2)} 已打款 · 凭证 ${result.voucher}${result.splitCount ? ` · 分账拆付 ${result.splitCount} 笔 $${result.splitSum.toFixed(2)}` : ''}`, actorName(actor));
      return ok({ ok: true, batch: port.presentSettle(batch), voucher: result.voucher, paidOut: result.payout, splitSum: result.splitSum, splitCount: result.splitCount, note: `STL 复式分录已入账: 借 merchant:${account.name} $${port.round(batch.net).toFixed(2)}${result.splitCount ? ` / 分账 ${result.splitCount} 笔 $${result.splitSum.toFixed(2)}` : ''} / 渠道出金 $${result.payout.toFixed(2)}` });
    },

    listSplits(query = {}) {
      let list = port.splits().map(split => {
        const order = port.orderById(split.orderId) || {};
        const account = port.accountById(split.mchId) || {};
        return { ...split, receiverTypeLabel: port.splitTypeLabels[split.receiverType] || split.receiverType, orderNo: order.orderNo || '—', orderAmount: order.amount, merchant: account.name || '—', pctLabel: `${Math.round((split.pct || 0) * 10000) / 100}%` };
      });
      if (query.mchId) list = list.filter(split => split.mchId === +query.mchId);
      return ok({ list, summary: { total: port.splits().length, amount: port.round(port.splits().reduce((sum, split) => sum + split.amount, 0)) }, note: '订单级分账规则在结算打款时拆付(不改变商户总净额, 只改变收款方构成)' });
    },

    riskOverview() {
      const list = port.accounts().map(account => {
        const risk = port.risks().find(item => item.mchId === account.id) || { score: 0, chargebackRate: 0, refundRate: 0, flags: [] };
        const orders = port.ordersOf(account.id);
        const count = orders.length;
        const refunded = orders.filter(order => order.status === 'refunded').length;
        const disputed = orders.filter(order => order.status === 'disputed').length;
        const live = { refundRate: count ? +(100 * refunded / count).toFixed(1) : 0, disputeRate: count ? +(100 * disputed / count).toFixed(1) : 0 };
        const red = risk.score >= port.riskThreshold.score || live.disputeRate >= port.riskThreshold.chargeback || (risk.flags || []).some(flag => /拒付/.test(flag));
        const amber = !red && (risk.score >= 50 || live.refundRate >= port.riskThreshold.refundRate);
        return {
          mchId: account.id, name: account.name, mccLabel: port.mccLabels[account.mcc] || account.mcc, status: account.status,
          statusLabel: port.merchantStatusLabels[account.status] || account.status, score: risk.score, scoreBand: red ? 'red' : amber ? 'amber' : 'green',
          chargebackRate: risk.chargebackRate, refundSeed: risk.refundRate, ...live, flags: risk.flags || [], orderCount: count, updatedAt: risk.updatedAt || null,
          scoreLabel: red ? '高危' : amber ? '关注' : '正常',
        };
      }).sort((a, b) => b.score - a.score);
      return ok({ list, thresholds: port.riskThreshold, summary: { total: list.length, red: list.filter(item => item.scoreBand === 'red').length, amber: list.filter(item => item.scoreBand === 'amber').length, green: list.filter(item => item.scoreBand === 'green').length }, note: `风险分 ≥ ${port.riskThreshold.score} 或 拒付率 ≥ ${port.riskThreshold.chargeback}% 标红预警` });
    },

    report(query = {}) {
      const dim = query.dim === 'month' ? 'month' : 'day';
      const rows = port.reportRows(dim);
      const count = rows.reduce((sum, row) => sum + row.count, 0);
      const amount = port.round(rows.reduce((sum, row) => sum + row.amount, 0));
      return ok({ list: rows, dim, summary: { amount, count, avgOrder: rows.length ? port.round(amount / count) : 0, refundRate: count ? +(100 * rows.reduce((sum, row) => sum + row.count * row.refundRate / 100, 0) / count).toFixed(1) : 0 }, note: `按${dim === 'month' ? '月' : '日'}聚合: 交易量 / 笔数 / 成功率 / 平均客单 / 退款率(仅已开通商户)` });
    },
  };
}
