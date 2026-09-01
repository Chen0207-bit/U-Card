import { failure, ok } from '../../api/response.js';

const cloneRules = rules => rules.map(rule => ({
  ...rule,
  scene: [...(rule.scene || [])],
  conditions: (rule.conditions || []).map(condition => ({
    ...condition,
    value: Array.isArray(condition.value) ? [...condition.value] : condition.value,
  })),
}));

export function createRiskEngineService(port) {
  const conditionsText = rule => (rule.conditions || []).map(condition => {
    const field = port.fields[condition.field] || { label: condition.field };
    const value = Array.isArray(condition.value) ? `[${condition.value.join(' / ')}]` : condition.value;
    return `${field.label} ${port.ops[condition.op] || condition.op} ${value}`;
  }).join(rule.condOp === 'or' ? ' 或 ' : ' 且 ');

  const presentRule = rule => ({
    ...rule,
    actionLabel: port.actionLabels[rule.action] || rule.action,
    levelLabel: port.levelLabels[rule.level] || rule.level,
    sceneLabel: (rule.scene || []).map(scene => (scene === 'pay' ? '消费' : '充值')).join(' / '),
    condStr: conditionsText(rule),
    hitCount: port.hits().filter(hit => hit.ruleId === rule.id).length,
  });

  const normalizeConditions = raw => {
    if (!Array.isArray(raw)) return null;
    const normalized = [];
    for (const condition of raw) {
      const field = String(condition.field || '');
      const op = String(condition.op || '');
      if (!port.fields[field] || !port.ops[op]) return null;
      let value = condition.value;
      if (op === 'in' || op === 'not_in') {
        const list = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[,，\s]+/);
        value = list.map(String).map(item => item.trim()).filter(Boolean);
        if (!value.length) return null;
      } else {
        value = +(value || 0);
        if (!Number.isFinite(value)) return null;
      }
      normalized.push({ field, op, value });
    }
    return normalized.length ? normalized : null;
  };

  const publicVersion = version => {
    const { rulesSnapshot: _rulesSnapshot, ...metadata } = version;
    return metadata;
  };

  const currentVersion = () => port.versions()[port.versions().length - 1] || { ver: 'v1.0' };

  const ensureCurrentSnapshot = () => {
    const current = currentVersion();
    if (!current.rulesSnapshot) current.rulesSnapshot = cloneRules(port.rules());
  };

  const publish = (by, note, changes) => {
    const current = currentVersion();
    const match = /^v(\d+)\.(\d+)$/.exec(current.ver) || [null, '1', '0'];
    const version = `v${match[1]}.${parseInt(match[2], 10) + 1}`;
    port.versions().push({
      ver: version,
      at: port.now(),
      by,
      note,
      changes: changes || [],
      rulesSnapshot: cloneRules(port.rules()),
    });
    return version;
  };

  ensureCurrentSnapshot();

  return {
    operatorName: port.operatorName,
    rules() {
      return ok({
        fields: port.fields,
        ops: port.ops,
        list: [...port.rules()].sort((left, right) => (left.priority || 99) - (right.priority || 99)).map(presentRule),
        version: currentVersion().ver || 'v1.0',
      });
    },

    createRule(body = {}, actorName) {
      const name = String(body.name || '').trim();
      if (!name) return failure(400, '请填写规则名');
      if (port.rules().some(rule => rule.name === name)) return failure(409, `规则名已存在: ${name}`);
      const conditions = normalizeConditions(body.conditions);
      if (!conditions) return failure(400, '条件不合法: 需至少 1 条「字段+操作符+阈值」且字段/操作符受支持');
      const scene = Array.isArray(body.scene) ? body.scene.filter(item => item === 'pay' || item === 'topup') : [];
      if (!scene.length) return failure(400, '请选择适用场景(消费/充值 至少一项)');
      const action = port.actionLabels[body.action] ? body.action : 'review';
      const level = ['high', 'mid', 'low'].includes(body.level) ? body.level : 'mid';
      const rule = {
        id: port.nextId(),
        name,
        priority: +body.priority || 100,
        enabled: body.enabled !== false,
        action,
        level,
        weight: Math.max(0, Math.min(100, +body.weight || 15)),
        scene,
        condOp: body.condOp === 'or' ? 'or' : 'and',
        conditions,
        desc: String(body.desc || '').slice(0, 160),
        hits: 0,
        createdAt: port.now(),
        updatedAt: port.now(),
      };
      port.rules().push(rule);
      const version = publish(actorName, `新增规则「${name}」`, [`新增: ${name} · ${conditionsText(rule)} → ${port.actionLabels[action]}`]);
      return ok({ rule: presentRule(rule), version });
    },

    updateRule(id, body = {}, actorName) {
      const rule = port.rules().find(item => item.id === id);
      if (!rule) return failure(404, '规则不存在');
      if (Object.keys(body).length === 1 && typeof body.enabled === 'boolean') {
        rule.enabled = body.enabled;
        rule.updatedAt = port.now();
        const version = publish(actorName, `${body.enabled ? '启用' : '停用'}规则「${rule.name}」`, [`规则「${rule.name}」${body.enabled ? '停用 → 启用' : '启用 → 停用'}`]);
        return ok({ rule: presentRule(rule), version });
      }

      const changes = [];
      if (body.name != null) {
        const name = String(body.name).trim();
        if (!name) return failure(400, '规则名不能为空');
        if (name !== rule.name) { changes.push(`名称 ${rule.name} → ${name}`); rule.name = name; }
      }
      if (Array.isArray(body.conditions)) {
        const conditions = normalizeConditions(body.conditions);
        if (!conditions) return failure(400, '条件不合法: 需至少 1 条「字段+操作符+阈值」');
        const before = conditionsText(rule);
        rule.conditions = conditions;
        const after = conditionsText(rule);
        if (before !== after) changes.push(`条件 ${before} → ${after}`);
      }
      if (Array.isArray(body.scene)) {
        const scene = body.scene.filter(item => item === 'pay' || item === 'topup');
        if (!scene.length) return failure(400, '适用场景不能为空');
        if (scene.join() !== (rule.scene || []).join()) { changes.push(`场景 → ${scene.join('/')}`); rule.scene = scene; }
      }
      if (body.action != null && port.actionLabels[body.action] && body.action !== rule.action) {
        changes.push(`动作 ${port.actionLabels[rule.action] || rule.action} → ${port.actionLabels[body.action]}`);
        rule.action = body.action;
      }
      if (body.level != null && ['high', 'mid', 'low'].includes(body.level) && body.level !== rule.level) {
        changes.push(`等级 → ${body.level}`);
        rule.level = body.level;
      }
      if (body.priority != null && Number.isFinite(+body.priority) && +body.priority !== rule.priority) {
        changes.push(`优先级 ${rule.priority} → ${+body.priority}`);
        rule.priority = +body.priority;
      }
      if (body.weight != null && Number.isFinite(+body.weight)) {
        const weight = Math.max(0, Math.min(100, +body.weight));
        if (weight !== rule.weight) { changes.push(`权重 ${rule.weight} → ${weight}`); rule.weight = weight; }
      }
      if (body.condOp != null) {
        const condOp = body.condOp === 'or' ? 'or' : 'and';
        if (condOp !== rule.condOp) { changes.push(`条件关系 → ${condOp === 'or' ? '或' : '且'}`); rule.condOp = condOp; }
      }
      if (body.desc != null) rule.desc = String(body.desc).slice(0, 160);
      if (typeof body.enabled === 'boolean' && body.enabled !== rule.enabled) {
        changes.push(body.enabled ? '停用 → 启用' : '启用 → 停用');
        rule.enabled = body.enabled;
      }
      rule.updatedAt = port.now();
      const version = publish(actorName, `编辑规则「${rule.name}」`, changes.length ? changes : [`编辑规则「${rule.name}」(元数据更新)`]);
      return ok({ rule: presentRule(rule), version });
    },

    deleteRule(id, actorName) {
      const index = port.rules().findIndex(rule => rule.id === id);
      if (index < 0) return failure(404, '规则不存在');
      const [removed] = port.rules().splice(index, 1);
      const version = publish(actorName, `删除规则「${removed.name}」`, [`删除: ${removed.name} · ${conditionsText(removed)} (历史命中记录保留)`]);
      return ok({ ok: true, removed: removed.name, version });
    },

    scores() {
      const list = port.scoreAll();
      const count = grade => list.filter(item => item.grade === grade).length;
      return ok({
        list,
        summary: {
          users: list.length,
          high: count('high'),
          mid: count('mid'),
          low: count('low'),
          avg: list.length ? Math.round(list.reduce((sum, item) => sum + item.score, 0) / list.length) : 0,
        },
        version: currentVersion().ver || 'v1.0',
      });
    },

    hits() {
      const hits = port.hits();
      return ok({
        list: hits.slice(0, 200),
        summary: {
          total: hits.length,
          blocked: hits.filter(hit => hit.result === 'blocked').length,
          frozen: hits.filter(hit => hit.result === 'frozen').length,
          review: hits.filter(hit => hit.result === 'review').length,
          marked: hits.filter(hit => hit.result === 'marked').length,
        },
      });
    },

    versions() {
      const versions = port.versions();
      return ok({
        current: currentVersion().ver || 'v1.0',
        list: [...versions].sort((left, right) => right.at - left.at).map(publicVersion),
      });
    },

    publish(body = {}, actorName) {
      const note = String(body.note || '').trim() || '手动发布当前风控策略';
      const changes = Array.isArray(body.changes) ? body.changes.map(String).map(item => item.slice(0, 200)).filter(Boolean) : [];
      const version = publish(actorName, note.slice(0, 160), changes.length ? changes : ['当前规则集发布为新版本']);
      return ok({ version, current: version, rules: port.rules().length });
    },

    rollback(version, body = {}, actorName) {
      const target = port.versions().find(item => item.ver === version);
      if (!target) return failure(404, `策略版本不存在: ${version}`);
      if (!target.rulesSnapshot) return failure(409, `策略版本 ${version} 没有可回滚快照`);
      const rules = port.rules();
      rules.splice(0, rules.length, ...cloneRules(target.rulesSnapshot));
      const note = String(body.reason || '').trim();
      const published = publish(actorName, `回滚至 ${version}${note ? `: ${note.slice(0, 120)}` : ''}`, [`规则集恢复到 ${version} 快照`]);
      return ok({ ok: true, rolledBackFrom: version, version: published, list: rules.map(presentRule) });
    },
  };
}
