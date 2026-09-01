import { ok } from '../../api/response.js';

export function createBiService(port) {
  const prepare = query => {
    const filters = port.parseQuery(query);
    const context = port.context(filters);
    return {
      filters,
      context,
      filtersEcho: {
        range: filters.range,
        level: filters.level || null,
        merchant: filters.merchant || null,
        rep: filters.rep || null,
        repName: filters.rep ? (port.repById(filters.rep) || {}).name : null,
      },
      rangeLabel: { today: '今日', '7d': '近 7 天', '30d': '近 30 天' }[filters.range],
      options: {
        levels: Object.keys(port.cardLevels).map(key => ({ key, label: port.cardLevels[key].label })),
        merchants: [...new Set(port.transactions().filter(transaction => transaction.merchant).map(transaction => transaction.merchant))].sort(),
        reps: port.salesReps().map(rep => ({ id: rep.id, name: rep.name, level: rep.level })),
      },
    };
  };

  return {
    overview(query = {}) {
      const view = prepare(query);
      const current = port.overviewData(view.filters, view.context);
      const span = view.filters.endTs - view.filters.startTs;
      const previousFilters = { ...view.filters, startTs: view.filters.startTs - span, endTs: view.filters.startTs };
      const previous = port.overviewData(previousFilters, port.context(previousFilters));
      return ok({
        filters: view.filtersEcho,
        rangeLabel: view.rangeLabel,
        options: view.options,
        metrics: current,
        prev: previous,
        note: 'DAU/MAU 按窗口内交易 distinct userId 近似; GMV=成功充值+消费(与驾驶舱同口径); 净收入=手续费+月费-佣金(与财务报表同口径); 积分成本=积分发放×$0.01。',
      });
    },

    users(query = {}) {
      const view = prepare(query);
      return ok({ filters: view.filtersEcho, rangeLabel: view.rangeLabel, options: view.options, ...port.usersData(view.filters, view.context) });
    },

    transactions(query = {}) {
      const view = prepare(query);
      const txs = view.context.txs;
      const byChannel = [...port.groupTransactions(txs, 'channel', view.context).entries()]
        .map(([dim, list]) => ({ dim, ...port.rowMetrics(list) })).sort((a, b) => b.gmv - a.gmv);
      const byLevel = Object.keys(port.cardLevels).map(level => ({
        dim: port.cardLevels[level].label,
        ...port.rowMetrics(txs.filter(transaction => (view.context.cardById.get(transaction.cardId) || {}).level === level)),
      }));
      const byMerchant = [...port.groupTransactions(txs.filter(transaction => transaction.type === 'consume'), 'merchant', view.context).entries()]
        .map(([dim, list]) => ({ dim, ...port.rowMetrics(list) })).sort((a, b) => b.gmv - a.gmv).slice(0, 10);
      const byHour = Array.from({ length: 24 }, (_, hour) => {
        const list = txs.filter(transaction => new Date(transaction.createdAt).getHours() === hour);
        return { dim: `${port.d2(hour)}:00`, txCount: list.length, gmv: port.gmv(list) };
      });
      const distribution = [[0, 50], [50, 100], [100, 200], [200, 500], [500, Infinity]];
      const successful = port.successful(txs).filter(transaction => transaction.type === 'topup' || transaction.type === 'consume');
      const amountDist = distribution.map(([low, high]) => ({
        dim: high === Infinity ? `$${low}+` : `$${low}-${high}`,
        txCount: successful.filter(transaction => transaction.amount >= low && transaction.amount < high).length,
      }));
      return ok({
        filters: view.filtersEcho,
        rangeLabel: view.rangeLabel,
        options: view.options,
        summary: port.rowMetrics(txs),
        byChannel,
        byLevel,
        byMerchant,
        byHour,
        amountDist,
        trend: port.trend(view.filters, view.context),
        note: '按渠道/卡等级/商户(Top10)/时段(小时)/金额分布; 趋势为窗口内日(小时)粒度 GMV 与笔数。',
      });
    },

    sales(query = {}) {
      const view = prepare(query);
      const rows = port.salesData(view.filters, view.context);
      const head = rows.find(row => row.level === 0) || rows[0] || { gmv: 0, perCapita: 0 };
      const commission = port.commissionScoped(view.filters, view.context);
      return ok({
        filters: view.filtersEcho,
        rangeLabel: view.rangeLabel,
        options: view.options,
        rows,
        summary: {
          gmv: head.gmv,
          commission,
          eff: head.gmv > 0 ? +(100 * commission / head.gmv).toFixed(2) : 0,
          perCapita: head.perCapita,
          reps: rows.length,
        },
        note: '每行 GMV 为该销售 subtree 口径(逐级包含下级); 人均单产=团队 GMV/团队人数(含本人); 佣金效率=窗口佣金/团队 GMV。',
      });
    },

    funnel(query = {}) {
      const view = prepare(query);
      return ok({ filters: view.filtersEcho, options: view.options, ...port.funnelData(view.context) });
    },

    report(query = {}) {
      const view = prepare(query);
      const selectedMetrics = String(query.metrics || '').split(',').map(value => value.trim()).filter(key => port.metrics[key]);
      const metrics = selectedMetrics.length ? selectedMetrics : ['txCount', 'gmv'];
      const dims = String(query.dims || '').split(',').map(value => value.trim()).filter(key => port.dims[key]).slice(0, 2);
      const groups = new Map();
      view.context.txs.forEach(transaction => {
        const key = dims.length ? dims.map(dim => port.dimValue(dim, transaction, view.context)).join(' / ') : '全部';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(transaction);
      });
      const rows = [...groups.entries()].map(([dim, list]) => {
        const values = port.rowMetrics(list);
        const row = { dim };
        metrics.forEach(key => { row[key] = values[key]; });
        return row;
      });
      const timeOnly = dims.length && dims.every(dim => dim === 'day' || dim === 'hour');
      rows.sort(timeOnly ? (a, b) => String(a.dim).localeCompare(String(b.dim)) : (a, b) => (b.gmv || 0) - (a.gmv || 0));
      const columns = [{ key: 'dim', label: dims.length ? dims.map(dim => port.dims[dim].label).join(' × ') : '汇总' }]
        .concat(metrics.map(key => ({ key, label: `${port.metrics[key].label}(${port.metrics[key].unit})` })));
      if (query.format === 'csv') {
        const lines = [columns.map(column => column.label).join(',')];
        rows.forEach(row => lines.push(columns.map(column => String(row[column.key] == null ? '' : row[column.key]).replace(/,/g, ' ')).join(',')));
        return ok({
          filename: `bi-report-${view.filters.range}.csv`,
          csv: lines.join('\r\n'),
          rowCount: rows.length,
          note: 'CSV 内容(前端导出时追加 UTF-8 BOM, 复用对账导出模式)',
        });
      }
      return ok({
        filters: view.filtersEcho,
        rangeLabel: view.rangeLabel,
        options: view.options,
        columns,
        rows,
        catalog: {
          metrics: Object.entries(port.metrics).map(([key, value]) => ({ key, ...value })),
          dims: Object.entries(port.dims).map(([key, value]) => ({ key, ...value })),
        },
        note: '自定义报表: 勾选指标×维度(最多 2 维交叉)生成表格, 可导出 CSV。',
      });
    },
  };
}
