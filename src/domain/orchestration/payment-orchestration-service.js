import { failure, ok } from '../../api/response.js';

export function createPaymentOrchestrationService(port) {
  const adapters = () => port.adapters();
  const transactions = () => port.transactions();
  const txs = () => port.txs();
  const healthLog = () => port.healthLog();
  const webhookLogs = () => port.webhookLogs();
  const reconFixed = () => port.reconFixed();
  const countByState = (items, state) => items.filter(item => item.state === state).length;

  const logHealth = (adapterId, type, from, to, latencyMs, successRate, note) => {
    const logs = healthLog();
    logs.unshift({
      id: logs.length ? Math.max(...logs.map(item => item.id)) + 1 : 980005,
      adapterId,
      at: port.now(),
      type,
      from,
      to,
      latencyMs,
      successRate,
      note,
    });
    if (logs.length > 120) logs.length = 120;
  };

  const presentAdapter = adapter => ({
    ...adapter,
    kindLabel: port.kindLabels[adapter.kind],
    fee1000: port.feeOf(adapter, 1000),
  });

  return {
    listAdapters() {
      const list = adapters();
      const count = status => list.filter(adapter => adapter.status === status).length;
      return ok({
        list: list.map(presentAdapter),
        kinds: [...new Set(list.map(adapter => adapter.kind))].map(key => ({ key, label: port.kindLabels[key] })),
        summary: {
          total: list.length,
          healthy: count('healthy'),
          degraded: count('degraded'),
          down: count('down'),
          disabled: list.filter(adapter => adapter.enabled === false).length,
        },
      });
    },

    updateAdapter(id, body = {}) {
      const adapter = port.adapterById(id);
      if (!adapter) return failure(404, '适配器不存在');
      const changes = [];
      if (body.status != null && ['healthy', 'degraded', 'down'].includes(body.status) && body.status !== adapter.status) {
        const from = adapter.status;
        adapter.status = body.status;
        adapter.manual = body.status !== 'healthy';
        const fallbackNote = body.status === 'down' ? '演示故障切换' : '演示降权';
        logHealth(adapter.id, 'manual', from, adapter.status, adapter.latencyMs, adapter.successRate,
          `人工标记: ${String(body.note || fallbackNote)}${adapter.manual ? '(探测不改状态)' : ''}`);
        changes.push(`状态 ${from} → ${adapter.status}${adapter.manual ? '(人工标记, 自动探测不改状态)' : '(人工恢复)'}`);
      }
      if (body.priority != null && Number.isFinite(+body.priority) && +body.priority > 0 && +body.priority !== adapter.priority) {
        changes.push(`优先级 ${adapter.priority} → ${+body.priority}`);
        adapter.priority = +body.priority;
      }
      if (typeof body.enabled === 'boolean' && body.enabled !== adapter.enabled) {
        adapter.enabled = body.enabled;
        changes.push(body.enabled ? '启用适配器' : '停用适配器(路由不再选中)');
      }
      if (!changes.length) return failure(400, '无可更新字段: status(healthy/degraded/down) / priority / enabled');
      return ok({ adapter: presentAdapter(adapter), changes });
    },

    routeTable() {
      const scenes = Object.keys(port.sceneKinds);
      const currencies = ['USD', 'AED', 'SAR'];
      const brief = (adapter, amount) => adapter ? {
        id: adapter.id,
        name: adapter.name,
        kindLabel: port.kindLabels[adapter.kind],
        priority: adapter.priority,
        effPriority: port.effectivePriority(adapter),
        status: adapter.status,
        latencyMs: adapter.latencyMs,
        successRate: adapter.successRate,
        feeRate: adapter.feeRate,
        feeFixed: adapter.feeFixed,
        fee100: port.feeOf(adapter, amount),
      } : null;
      const table = [];
      scenes.forEach(scene => currencies.forEach(currency => {
        const route = port.routeFor(scene, currency);
        table.push({
          scene,
          sceneLabel: port.sceneLabels[scene],
          currency,
          adapter: brief(route.adapter, 100),
          backup: brief(route.backup, 100),
          reason: route.reason,
        });
      }));
      return ok({
        table,
        scenes: scenes.map(key => ({ key, label: port.sceneLabels[key] })),
        currencies,
        note: '路由实时计算: 标记渠道 down/degraded 后刷新即可看到故障切换',
      });
    },

    simulateRoute(query = {}) {
      const scene = String(query.scene || 'topup_fiat');
      const currency = String(query.currency || 'USD').toUpperCase();
      const amount = Math.max(1, +query.amount || 1000);
      if (!port.sceneKinds[scene]) return failure(400, `未知场景: ${scene}, 支持: ${Object.keys(port.sceneKinds).join(' / ')}`);
      const route = port.routeFor(scene, currency);
      if (!route.adapter) return failure(409, `无可路由渠道: ${route.reason}`);
      const estimatedFee = port.feeOf(route.adapter, amount);
      return ok({
        scene,
        sceneLabel: port.sceneLabels[scene],
        currency,
        amount,
        decision: {
          adapterId: route.adapter.id,
          adapterName: route.adapter.name,
          priority: route.adapter.priority,
          status: route.adapter.status,
          latencyMs: route.adapter.latencyMs,
          successRate: route.adapter.successRate,
          estimatedFee,
          totalCost: +(amount + estimatedFee).toFixed(2),
        },
        backup: route.backup ? {
          id: route.backup.id,
          name: route.backup.name,
          priority: route.backup.priority,
          estimatedFee: port.feeOf(route.backup, amount),
        } : null,
        candidates: route.candidates.map(candidate => ({
          id: candidate.id,
          name: candidate.name,
          status: candidate.status,
          effPriority: port.effectivePriority(candidate),
          estimatedFee: port.feeOf(candidate, amount),
        })),
        reason: route.reason,
      });
    },

    health() {
      const list = adapters();
      const logs = healthLog();
      return ok({
        list: logs.slice(0, 100),
        adapters: list.map(adapter => ({
          id: adapter.id,
          name: adapter.name,
          kindLabel: port.kindLabels[adapter.kind],
          status: adapter.status,
          manual: adapter.manual,
          latencyMs: adapter.latencyMs,
          successRate: adapter.successRate,
          mttdMs: adapter.mttdMs,
        })),
        summary: {
          healthy: list.filter(adapter => adapter.status === 'healthy').length,
          degraded: list.filter(adapter => adapter.status === 'degraded').length,
          down: list.filter(adapter => adapter.status === 'down').length,
          probes: logs.filter(item => item.type === 'probe').length,
          manual: logs.filter(item => item.type === 'manual').length,
        },
      });
    },

    checkHealth() {
      const results = adapters().map(adapter => {
        const latency = Math.max(30, adapter.latencyMs + port.randomInt(-60, 80));
        const successRate = +Math.min(99.9, Math.max(80, adapter.successRate + (port.random() < 0.5 ? -0.2 : 0.3))).toFixed(1);
        const from = adapter.status;
        let to = adapter.status;
        let note = `探测: 延迟 ${latency}ms / 成功率 ${successRate}%`;
        if (adapter.manual) note += `(人工标记 ${adapter.status}, 探测不改状态)`;
        else if (adapter.status === 'degraded') {
          to = 'healthy';
          note += ', 探活恢复, 自动解除降级';
        }
        adapter.latencyMs = latency;
        adapter.successRate = successRate;
        if (from !== to) adapter.status = to;
        logHealth(adapter.id, 'probe', from, to, latency, successRate, note);
        return { id: adapter.id, name: adapter.name, from, to, latencyMs: latency, successRate, manual: adapter.manual };
      });
      const route = port.routeFor('pay', 'USD');
      return ok({
        results,
        routing: { scene: 'pay', currency: 'USD', adapter: route.adapter ? route.adapter.name : null, reason: route.reason },
        note: `全量健康探测完成: ${results.length} 个适配器(降级渠道探活成功自动恢复, 人工标记不动)`,
      });
    },

    compare(query = {}) {
      const amount = Math.max(1, +query.amount || 1000);
      const groups = Object.keys(port.sceneKinds).map(scene => {
        const kind = port.sceneKinds[scene];
        const list = adapters()
          .filter(adapter => adapter.kind === kind && (adapter.caps.scenes || []).includes(scene))
          .map(adapter => ({
            id: adapter.id,
            name: adapter.name,
            status: adapter.status,
            enabled: adapter.enabled !== false,
            priority: adapter.priority,
            feeRate: adapter.feeRate,
            feeFixed: adapter.feeFixed,
            fee1000: port.feeOf(adapter, 1000),
            total: port.feeOf(adapter, amount),
            note: (adapter.caps && adapter.caps.note) || '',
          }))
          .sort((left, right) => left.total - right.total);
        const route = port.routeFor(scene, 'USD');
        return {
          scene,
          sceneLabel: port.sceneLabels[scene],
          kindLabel: port.kindLabels[kind],
          sampleAmount: amount,
          list,
          routed: route.adapter ? route.adapter.id : null,
        };
      });
      return ok({ amount, groups });
    },

    listTransactions(query = {}) {
      const all = txs();
      let list = all;
      if (query.state) list = list.filter(tx => tx.state === String(query.state));
      if (query.scene) list = list.filter(tx => tx.scene === String(query.scene));
      return ok({
        list: [...list].sort((left, right) => right.createdAt - left.createdAt).map(port.presentTx),
        webhooks: webhookLogs().slice(0, 50),
        summary: {
          total: all.length,
          created: countByState(all, 'created'),
          pending: countByState(all, 'pending'),
          processing: countByState(all, 'processing'),
          success: countByState(all, 'success'),
          failed: countByState(all, 'failed'),
          reversed: countByState(all, 'reversed'),
          refunded: countByState(all, 'refunded'),
          callbacks: all.reduce((sum, tx) => sum + tx.callbacks.length, 0),
        },
        scenes: Object.keys(port.sceneKinds).map(key => ({ key, label: port.sceneLabels[key] })),
        states: Object.keys(port.stateLabels).map(key => ({ key, label: port.stateLabels[key] })),
      });
    },

    createTransaction(body = {}) {
      const scene = String(body.scene || '');
      if (!port.sceneKinds[scene]) return failure(400, `不支持的场景: ${scene || '(空)'}, 支持: ${Object.keys(port.sceneKinds).join(' / ')}`);
      const amount = +body.amount;
      if (!(amount > 0)) return failure(400, '金额必须大于 0');
      const currency = String(body.currency || 'USD').toUpperCase();
      const idempotencyKey = String(body.idempotencyKey || '').trim();
      if (idempotencyKey) {
        const existing = txs().find(tx => tx.idempotencyKey === idempotencyKey);
        if (existing) return ok({
          idempotent: true,
          tx: port.presentTx(existing),
          note: `幂等命中: 相同 idempotencyKey(${idempotencyKey})不重复下单, 返回同一订单 #${existing.id}`,
        });
      }
      const route = port.routeFor(scene, currency);
      if (!route.adapter) return failure(409, `无可路由渠道: ${route.reason}`);
      const tx = {
        id: port.nextId(),
        scene,
        sceneLabel: port.sceneLabels[scene],
        amount: +amount.toFixed(2),
        currency,
        adapterId: route.adapter.id,
        state: 'created',
        idempotencyKey: idempotencyKey || null,
        timeoutMs: scene === 'topup_crypto' ? 30000 : 15000,
        attempts: [],
        callbacks: [],
        timeline: [{ ts: port.now(), from: null, to: 'created', note: `编排单创建, 路由决策: ${route.adapter.name}(${route.reason})` }],
        userId: +body.userId || null,
        localRef: null,
        channelStatus: null,
        note: '',
        reconSeed: null,
        reconFixed: null,
        createdAt: port.now(),
        updatedAt: port.now(),
      };
      txs().push(tx);
      port.transit(tx, 'pending', `已提交 ${route.adapter.name}(尝试 #1), 等待渠道异步回调`);
      tx.attempts.push({ no: 1, adapterId: route.adapter.id, at: port.now(), latencyMs: route.adapter.latencyMs, result: 'accepted', note: '渠道已受理' });
      return ok({
        idempotent: false,
        tx: port.presentTx(tx),
        routing: { adapter: route.adapter.name, backup: route.backup ? route.backup.name : null, reason: route.reason },
      });
    },

    transaction(id) {
      const tx = txs().find(item => item.id === +id);
      if (!tx) return failure(404, '编排单不存在');
      const local = tx.localRef != null ? transactions().find(item => item.id === tx.localRef) : null;
      const adapter = port.adapterById(tx.adapterId);
      return ok({
        tx: port.presentTx(tx),
        adapter: adapter ? presentAdapter(adapter) : null,
        localTx: local ? { id: local.id, type: local.type, status: local.status, amount: local.amount, createdAt: local.createdAt } : null,
        nextStates: port.nextStates[tx.state] || [],
      });
    },

    actOnTransaction(id, action, body = {}) {
      const tx = txs().find(item => item.id === +id);
      if (!tx) return failure(404, '编排单不存在');
      if (action === 'callback') {
        if (!['pending', 'processing'].includes(tx.state)) return failure(409, `仅待受理/处理中状态可接收渠道回调, 当前: ${port.stateLabels[tx.state]}`);
        const type = body.result === 'fail' ? 'fail' : 'success';
        if (tx.state === 'pending') port.transit(tx, 'processing', '渠道受理回执到达');
        tx.callbacks.push({
          at: port.now(),
          type,
          receipt: String(body.receipt || `RCPT-${port.randomInt(100000, 999999)}`),
          source: 'channel-async-callback',
          note: String(body.note || (type === 'success' ? '渠道确认成功' : '渠道返回失败')),
        });
        port.transit(tx, type === 'success' ? 'success' : 'failed', `渠道异步回调: ${type} 回执`);
        tx.channelStatus = type;
        return ok({ tx: port.presentTx(tx), note: '回调已受理, 编排单进入终态并已发出站 webhook 通知' });
      }
      if (action === 'replay') {
        if (!['failed', 'created'].includes(tx.state)) return failure(409, `仅失败/已创建的编排单可重放, 当前: ${port.stateLabels[tx.state]}`);
        const route = port.routeFor(tx.scene, tx.currency);
        if (!route.adapter) return failure(409, `无可路由渠道: ${route.reason}`);
        if (!port.transit(tx, 'pending', `人工重放: 重新路由至 ${route.adapter.name}(${route.reason})`)) return failure(409, '状态机不允许该迁移');
        tx.adapterId = route.adapter.id;
        tx.attempts.push({ no: tx.attempts.length + 1, adapterId: route.adapter.id, at: port.now(), latencyMs: route.adapter.latencyMs, result: 'accepted', note: `重放尝试 #${tx.attempts.length}` });
        return ok({ tx: port.presentTx(tx), note: `已重放至 ${route.adapter.name}, 等待渠道回调` });
      }
      if (action === 'compensate') {
        if (!['pending', 'processing'].includes(tx.state)) return failure(409, `仅待受理/处理中可执行超时补偿, 当前: ${port.stateLabels[tx.state]}`);
        const age = port.now() - tx.updatedAt;
        if (age < tx.timeoutMs && body.force !== true) return failure(409, `未到超时阈值: 需 ${tx.timeoutMs}ms, 已等待 ${age}ms(可传 force: true 强制)`);
        const outcome = body.outcome === 'fail' ? 'failed' : 'success';
        tx.attempts.push({ no: tx.attempts.length + 1, adapterId: tx.adapterId, at: port.now(), latencyMs: port.randomInt(120, 400), result: outcome === 'success' ? 'success' : 'fail', note: `超时补偿: 重查渠道回执 → ${outcome}` });
        if (tx.state === 'pending') port.transit(tx, 'processing', '超时补偿: 转处理中并重查回执');
        port.transit(tx, outcome, `超时补偿: 渠道回执重查结果为 ${outcome}`);
        tx.channelStatus = outcome;
        return ok({ tx: port.presentTx(tx), note: `超时补偿完成: 渠道回执 ${outcome}` });
      }
      if (action === 'reverse') {
        if (tx.state !== 'success') return failure(409, `仅成功单可冲正, 当前: ${port.stateLabels[tx.state]}`);
        port.transit(tx, 'reversed', String(body.note || '人工冲正: 撤销渠道侧已授权交易'));
        tx.channelStatus = 'reversed';
        return ok({ tx: port.presentTx(tx), note: '已冲正: 渠道侧授权撤销, 编排单终态 reversed' });
      }
      if (action === 'refund') {
        if (tx.state !== 'success') return failure(409, `仅成功单可退款, 当前: ${port.stateLabels[tx.state]}`);
        port.transit(tx, 'refunded', String(body.note || '原路退款(演示)'));
        tx.channelStatus = 'refunded';
        return ok({ tx: port.presentTx(tx), note: '已退款: 原路退回, 编排单终态 refunded' });
      }
      return failure(404, `not found: /api/admin/orch/tx/${id}/${action}`);
    },

    reconciliation() {
      const all = txs();
      const diffs = port.reconciliationDiffs();
      const fixed = reconFixed();
      return ok({
        ranAt: port.now(),
        diffs,
        fixed,
        summary: {
          checked: all.length,
          matched: all.filter(tx => !tx.reconSeed || tx.reconFixed).length,
          open: diffs.length,
          fixedCount: fixed.length,
          channelSuccessLocalMissing: diffs.filter(item => item.type === 'channel_success_local_missing').length,
          localSuccessChannelTimeout: diffs.filter(item => item.type === 'local_success_channel_timeout').length,
        },
        note: '三方比对: 编排单(渠道口径) × 交易流水(本地口径) × 资金账本(记账口径)',
      });
    },

    fixDifference(id, actor) {
      const item = port.reconciliationDiffs().find(diff => diff.id === +id);
      if (!item) return failure(404, '差异不存在或已处理');
      const by = port.operatorName(actor?.id);
      const result = port.fixDifference(item, by);
      if (result.error) return ok(result, 409);
      reconFixed().unshift({ ...item, fixedAt: port.now(), by, fixNote: result.note });
      return ok({ ok: true, note: result.note, remaining: port.reconciliationDiffs().length });
    },
  };
}
