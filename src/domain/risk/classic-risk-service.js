import { failure, ok } from '../../api/response.js';

const maskCardNumber = number => {
  const digits = String(number || '').replace(/\s/g, '');
  return digits.length >= 4 ? `**** **** **** ${digits.slice(-4)}` : '—';
};

export function createClassicRiskService(port) {
  const presentEvent = event => {
    const user = port.users().find(item => item.id === event.userId);
    const card = port.cards().find(item => item.id === event.cardId);
    const rule = port.riskRules().find(item => item.id === event.ruleId)
      || port.engineRules().find(item => item.id === event.ruleId);
    const expression = rule
      ? (rule.expr || (rule.conditions ? port.engineConditionText(rule) : ''))
      : '';
    return {
      ...event,
      levelLabel: port.levelLabels[event.level] || event.level,
      statusLabel: port.statusLabels[event.status] || event.status,
      user: user ? user.name : '—',
      cardNoMask: card ? maskCardNumber(card.cardNo) : '—',
      cardStatus: card ? card.status : '—',
      ruleName: rule ? rule.name : '已删除规则',
      ruleAction: rule ? rule.action : '',
      ruleExpr: expression,
    };
  };

  const presentRule = rule => ({
    ...rule,
    actionLabel: port.actionLabels[rule.action] || rule.action,
    levelLabel: port.levelLabels[rule.level] || rule.level,
    hitEvents: port.riskEvents().filter(event => event.ruleId === rule.id).length,
  });

  return {
    operatorName: port.operatorName,

    events(query = {}) {
      const events = port.riskEvents();
      const list = events
        .filter(event => (!query.level || event.level === query.level) && (!query.status || event.status === query.status))
        .sort((left, right) => right.createdAt - left.createdAt)
        .map(presentEvent);
      const count = status => events.filter(event => event.status === status).length;
      return ok({
        list,
        summary: {
          total: events.length,
          pending: count('pending'),
          frozen: count('frozen'),
          reviewed: count('reviewed'),
          released: count('released'),
        },
      });
    },

    actOnEvent(id, body = {}, actorName) {
      const event = port.riskEvents().find(item => item.id === id);
      if (!event) return failure(404, '事件不存在');
      const card = port.cards().find(item => item.id === event.cardId);

      if (body.action === 'review') {
        event.status = 'reviewed';
        event.timeline.push({ ts: port.now(), node: 'review', label: '人工复核', note: '总监已人工复核本事件', operator: actorName });
      } else if (body.action === 'release') {
        event.status = 'released';
        if (card && card.status === 'frozen') card.status = 'active';
        const accountKey = card ? `card:${card.id}` : '';
        const frozen = port.frozenBalances();
        for (let index = frozen.length - 1; index >= 0; index -= 1) {
          const balance = frozen[index];
          if (balance.status !== 'frozen') continue;
          const riskReason = String(balance.reason || '').startsWith('风控')
            || String(balance.reason || '').startsWith('规则引擎冻结');
          if (balance.eventId === event.id || (accountKey && balance.accountKey === accountKey && riskReason)) frozen.splice(index, 1);
        }
        event.timeline.push({
          ts: port.now(),
          node: 'release',
          label: '解除风控',
          note: `复核通过, 风险解除${card && card.status === 'active' ? ', 关联卡已解冻, 冻结余额已释放' : ''}`,
          operator: actorName,
        });
      } else if (body.action === 'freeze') {
        event.status = 'frozen';
        if (card && card.status === 'active') {
          card.status = 'frozen';
          port.ensureCardLedgerAccount(card);
          port.frozenBalances().push({
            id: port.nextId(),
            accountKey: `card:${card.id}`,
            amount: port.round(card.balance),
            reason: `风控冻结 · 事件 #${event.id} · ${String(event.reason || '').slice(0, 60)}`,
            createdAt: port.now(),
            status: 'frozen',
            eventId: event.id,
          });
        }
        event.timeline.push({
          ts: port.now(),
          node: 'freeze',
          label: '自动冻结',
          note: '手动触发自动冻结动作, 关联卡已冻结, 待结算余额已全额冻结',
          operator: actorName,
        });
      } else {
        return failure(400, '无效动作, 支持 review / release / freeze');
      }
      return ok({ event: presentEvent(event) });
    },

    rules() {
      return ok({ list: port.riskRules().map(presentRule) });
    },

    updateRule(id, body = {}) {
      const rule = port.riskRules().find(item => item.id === id);
      if (!rule) return failure(404, '规则不存在');
      if (typeof body.enabled === 'boolean') rule.enabled = body.enabled;
      return ok({ rule: presentRule(rule) });
    },

    lists() {
      return ok({ list: [...port.riskLists()].sort((left, right) => right.createdAt - left.createdAt) });
    },

    removeListItem(id) {
      const lists = port.riskLists();
      const index = lists.findIndex(item => item.id === id);
      if (index < 0) return failure(404, '名单项不存在');
      lists.splice(index, 1);
      return ok({ ok: true, remain: lists.length });
    },

    tags() {
      return ok({ list: port.riskTags() });
    },
  };
}
