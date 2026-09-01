import { failure, ok } from '../../api/response.js';

const RECON_DEFS = {
  topup: { label: '充值对账', voucher: 'TP', matches: tx => tx.type === 'topup' && tx.status === 'success' },
  consume: { label: '消费对账', voucher: 'CS', matches: tx => tx.type === 'consume' && tx.status === 'success' },
  refund: { label: '退款对账', voucher: 'RF', matches: tx => tx.type === 'consume' && tx.status === 'refunded' },
};

export function createFinanceReconciliationService(port) {
  const round = value => port.round(value);
  const meta = () => port.financeMeta();

  const reconGroups = type => {
    const definition = RECON_DEFS[type] || RECON_DEFS.topup;
    const byDay = {};
    port.transactions().filter(definition.matches).forEach(tx => {
      const day = port.dayKey(tx.createdAt);
      const group = byDay[day] = byDay[day] || { day, count: 0, due: 0, fee: 0 };
      group.count += 1;
      group.due += tx.amount;
      group.fee += tx.fee;
    });
    return Object.values(byDay)
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
      .map((group, index) => {
        const due = +group.due.toFixed(2);
        const difference = (meta().diffs[type] || {})[group.day];
        const actual = difference ? +(due - difference.delta).toFixed(2) : due;
        const diff = +(due - actual).toFixed(2);
        return {
          day: group.day,
          count: group.count,
          due,
          actual,
          fee: +group.fee.toFixed(2),
          diff,
          status: Math.abs(diff) < 0.01 ? '平' : '差异',
          reason: difference ? difference.reason : '',
          period: meta().period[type] || 'T+1',
          voucher: `${definition.voucher}-${group.day.replace('-', '')}-${String(index + 1).padStart(2, '0')}`,
        };
      });
  };

  const merchantRows = () => {
    const transactions = port.transactions();
    const names = [...new Set(transactions.filter(tx => tx.type === 'consume' && tx.merchant).map(tx => tx.merchant))];
    return names.map((name, index) => {
      const txs = transactions.filter(tx => tx.type === 'consume' && tx.status === 'success' && tx.merchant === name);
      const consumeAmt = +txs.reduce((sum, tx) => sum + tx.amount, 0).toFixed(2);
      const fee = +txs.reduce((sum, tx) => sum + tx.fee, 0).toFixed(2);
      const lastTxAt = txs.length ? Math.max(...txs.map(tx => tx.createdAt)) : null;
      return {
        merchant: name,
        txCount: txs.length,
        consumeAmt,
        fee,
        net: +(consumeAmt - fee).toFixed(2),
        settled: !!meta().merchantSettled[name],
        period: 'T+2',
        voucher: `MC-${String(index + 1).padStart(2, '0')}${lastTxAt ? `-${port.dayKey(lastTxAt).replace('-', '')}` : ''}`,
        lastTxAt,
      };
    }).sort((a, b) => b.consumeAmt - a.consumeAmt);
  };

  return {
    reconciliation(query = {}) {
      const type = RECON_DEFS[query.type] ? query.type : 'topup';
      const groups = reconGroups(type);
      const sum = key => +groups.reduce((total, group) => total + group[key], 0).toFixed(2);
      return ok({
        type,
        typeLabel: RECON_DEFS[type].label,
        period: meta().period[type],
        groups,
        summary: {
          days: groups.length,
          count: groups.reduce((total, group) => total + group.count, 0),
          due: sum('due'),
          actual: sum('actual'),
          fee: sum('fee'),
          diff: sum('diff'),
          diffDays: groups.filter(group => group.status === '差异').length,
        },
      });
    },

    differences() {
      const list = [];
      Object.keys(RECON_DEFS).forEach(type => reconGroups(type).forEach(group => {
        if (group.status === '差异') list.push({ type, typeLabel: RECON_DEFS[type].label, ...group });
      }));
      list.sort((a, b) => (a.day < b.day ? 1 : -1));
      return ok({ list, summary: { count: list.length, totalDiff: +list.reduce((total, row) => total + row.diff, 0).toFixed(2) } });
    },

    merchantSettlements() {
      const list = merchantRows();
      const pending = list.filter(row => !row.settled);
      return ok({
        feeRate: 0.02,
        period: 'T+2',
        summary: {
          merchants: list.length,
          consumeAmt: +list.reduce((total, row) => total + row.consumeAmt, 0).toFixed(2),
          fee: +list.reduce((total, row) => total + row.fee, 0).toFixed(2),
          net: +list.reduce((total, row) => total + row.net, 0).toFixed(2),
          pending: pending.length,
          pendingNet: +pending.reduce((total, row) => total + row.net, 0).toFixed(2),
        },
        list,
      });
    },

    updateMerchantSettlement(encodedName, body = {}) {
      const name = decodeURIComponent(encodedName);
      const row = merchantRows().find(item => item.merchant === name);
      if (!row) return failure(404, `商户不存在: ${name}`);
      const state = meta();
      const wasSettled = state.merchantSettled[name] === true;
      state.merchantSettled[name] = body.settled !== false;
      let stlPosted = 0;
      let stlTxId = '';
      if (body.settled !== false && !wasSettled) {
        const paid = +(state.merchantSettledAmt || {})[name] || 0;
        const due = +round(row.net - paid);
        if (due > 0.005) {
          const timestamp = port.now();
          stlTxId = `STL-${name}-${port.isoDay(timestamp)}`;
          port.ensureMerchantLedgerAccount(name);
          port.postLedgerTx(stlTxId, `商户结算打款 · ${name} · T+2`, timestamp, [
            { key: `merchant:${name}`, dir: 'debit', amount: due, memo: `结算出金 · 净额(扣 2% 手续费) · 凭证 ${row.voucher}` },
            { key: 'channel:fiat', dir: 'credit', amount: due, memo: `渠道出金支付商户结算款 · ${name}` },
          ]);
          stlPosted = due;
          state.merchantSettledAmt = state.merchantSettledAmt || {};
          state.merchantSettledAmt[name] = row.net;
        }
      }
      return ok({ row: { ...row, settled: state.merchantSettled[name], stlPosted, stlTxId } });
    },

    monthlyReport() {
      const timestamp = port.now();
      const current = new Date(timestamp);
      const monthStart = new Date(current.getFullYear(), current.getMonth(), 1).getTime();
      const inMonth = item => item.createdAt >= monthStart;
      const transactions = port.transactions();
      const topups = transactions.filter(tx => tx.type === 'topup' && tx.status === 'success' && inMonth(tx));
      const consumes = transactions.filter(tx => tx.type === 'consume' && tx.status === 'success' && inMonth(tx));
      const refunds = transactions.filter(tx => tx.type === 'consume' && tx.status === 'refunded' && inMonth(tx));
      const topupFee = +topups.reduce((sum, tx) => sum + tx.fee, 0).toFixed(2);
      const consumeFee = +consumes.reduce((sum, tx) => sum + tx.fee, 0).toFixed(2);
      const commissionPaid = +port.commissions().filter(inMonth).reduce((sum, commission) => sum + commission.amount, 0).toFixed(2);
      const monthlyFeeIncome = +port.cards().filter(card => card.status !== 'lost')
        .reduce((sum, card) => sum + ((port.cardLevels[card.level] || {}).monthlyFee || 0), 0).toFixed(2);
      const recon = Object.keys(RECON_DEFS).map(type => {
        const groups = reconGroups(type);
        const differences = groups.filter(group => group.status === '差异');
        return { type, typeLabel: RECON_DEFS[type].label, days: groups.length, diffDays: differences.length, diffTotal: +differences.reduce((sum, group) => sum + group.diff, 0).toFixed(2) };
      });
      const merchants = merchantRows();
      const pending = merchants.filter(row => !row.settled);
      return ok({
        month: `${current.getFullYear()}-${port.d2(current.getMonth() + 1)}`,
        topup: { amount: +topups.reduce((sum, tx) => sum + tx.amount, 0).toFixed(2), count: topups.length },
        consume: { amount: +consumes.reduce((sum, tx) => sum + tx.amount, 0).toFixed(2), count: consumes.length },
        refund: { amount: +refunds.reduce((sum, tx) => sum + tx.amount, 0).toFixed(2), count: refunds.length },
        feeIncome: { topup: topupFee, consume: consumeFee, monthlyFee: monthlyFeeIncome, total: +(topupFee + consumeFee + monthlyFeeIncome).toFixed(2) },
        commissionPaid,
        netIncome: +(topupFee + consumeFee + monthlyFeeIncome - commissionPaid).toFixed(2),
        recon,
        merchant: { total: merchants.length, pending: pending.length, pendingNet: +pending.reduce((sum, row) => sum + row.net, 0).toFixed(2) },
      });
    },
  };
}
