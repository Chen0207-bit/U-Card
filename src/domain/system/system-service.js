import { failure, ok } from '../../api/response.js';

export function createSystemService(port) {
  const audit = (actorId, action, target) => {
    const logs = port.operationLogs();
    logs.unshift({ id: logs.length ? Math.max(...logs.map(log => log.id)) + 1 : 910100, createdAt: port.now(), operator: port.operatorName(actorId), module: '系统管理', action, target, result: '成功' });
    if (logs.length > 150) logs.length = 150;
  };
  return {
    listAccounts: () => ok(port.accounts().map(account => ({ ...account }))),
    updateAccount(actorId, id, body = {}) {
      const account = port.accounts().find(item => item.id === id);
      if (!account) return failure(404, '账号不存在');
      if (body.resetPwd) {
        audit(actorId, '重置密码', `${account.username} · ${account.name}`);
        return ok({ ok: true, account: { ...account }, initPwd: `Ucard@${String(1000 + account.id).slice(-4)}` });
      }
      if (typeof body.enabled === 'boolean') {
        account.enabled = body.enabled;
        audit(actorId, body.enabled ? '启用账号' : '禁用账号', `${account.username} · ${account.name}`);
        return ok({ ok: true, account: { ...account } });
      }
      return failure(400, '无效的修改字段, 支持 enabled / resetPwd');
    },
    listRoles: () => ok({ list: port.roles().map(role => ({ ...role, memberCount: port.accounts().filter(account => account.roleCode === role.code).length, permCount: (port.permissions()[role.code] || []).length })) }),
    getPermissions(roleCode) {
      const role = port.roles().find(item => item.code === roleCode);
      if (!role) return failure(400, `角色不存在: ${roleCode || '(未指定)'}`);
      return ok({ role: { code: role.code, name: role.name, desc: role.desc }, tree: port.permissionTree, checked: port.permissions()[role.code] || [], totalKeys: port.allPermissionKeys.length });
    },
    updatePermissions(actorId, body = {}) {
      const role = port.roles().find(item => item.code === body.role);
      if (!role) return failure(400, `角色不存在: ${body.role || '(未指定)'}`);
      const valid = new Set(port.allPermissionKeys);
      const checked = Array.isArray(body.checked) ? body.checked.filter(key => valid.has(key)) : [];
      port.permissions()[role.code] = checked;
      audit(actorId, '保存权限', `${role.name} · ${checked.length} 项权限`);
      return ok({ ok: true, role: role.code, checked, total: port.allPermissionKeys.length });
    },
    getOrganization() {
      const reps = port.salesReps();
      const countLevel = level => reps.filter(rep => rep.level === level).length;
      return ok({ summary: { total: reps.length, l1: countLevel(1), l2: countLevel(2), l3: countLevel(3), customers: port.customers().length, cards: port.cards().length }, tree: port.organizationTree() });
    },
    listParameters: () => ok({ list: port.parameters().map(parameter => ({ ...parameter })) }),
    updateParameter(actorId, key, body = {}) {
      const parameter = port.parameters().find(item => item.key === key);
      if (!parameter) return failure(404, `参数不存在: ${key}`);
      const value = String(body.value == null ? '' : body.value).trim();
      if (!value) return failure(400, '参数值不能为空');
      const previous = String(parameter.value);
      parameter.value = value; parameter.updatedAt = port.now();
      audit(actorId, '参数修改', `${parameter.label}: ${previous} → ${value}`);
      return ok({ ok: true, param: { ...parameter } });
    },
    listDictionaries: () => ok({ list: port.dictionaries().map(dictionary => ({ ...dictionary, items: dictionary.items.map(item => ({ ...item })) })) }),
    updateDictionaryItem(actorId, id, body = {}) {
      let item = null; let owner = null;
      for (const dictionary of port.dictionaries()) for (const candidate of dictionary.items) if (candidate.id === id) { item = candidate; owner = dictionary; }
      if (!item) return failure(404, '字典项不存在');
      if (typeof body.enabled === 'boolean') {
        item.enabled = body.enabled;
        audit(actorId, body.enabled ? '启用字典项' : '停用字典项', `${owner.typeLabel} / ${item.value}`);
      }
      return ok({ ok: true, dictType: owner.type, item: { ...item } });
    },
    getLoginLogs() {
      const logs = port.loginLogs();
      return ok({ list: [...logs].sort((a, b) => b.createdAt - a.createdAt), summary: { total: logs.length, ok: logs.filter(log => log.result === '成功').length, fail: logs.filter(log => log.result !== '成功').length, accounts: new Set(logs.map(log => log.username)).size } });
    },
    getOperationLogs() {
      const logs = port.operationLogs();
      return ok({ list: [...logs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100), summary: { total: logs.length, ok: logs.filter(log => log.result === '成功').length, fail: logs.filter(log => log.result !== '成功').length } });
    },
  };
}
