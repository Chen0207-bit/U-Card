import { failure, ok } from '../../api/response.js';

export function createOpenPlatformService({ apps, keys, webhooks, logs, maskSecret, now, randomInt }) {
  const appName = (appId) => apps().find(app => app.id === appId)?.name || '—';
  return {
    listApps() {
      return ok({ list: apps().map(app => ({
        ...app,
        keyCount: keys().filter(key => key.appId === app.id && key.status === 'active').length,
        hookCount: webhooks().filter(hook => hook.appId === app.id).length,
      })) });
    },
    updateApp(id, body = {}) {
      const app = apps().find(item => item.id === id);
      if (!app) return failure(404, '应用不存在');
      if (typeof body.enabled === 'boolean') app.enabled = body.enabled;
      return ok({ app: { ...app } });
    },
    listKeys() {
      return ok({ list: keys().map(key => ({
        id: key.id, appId: key.appId, appName: appName(key.appId), secretMask: maskSecret(key.appSecret),
        scopes: key.scopes, status: key.status, lastUsedAt: key.lastUsedAt, expireAt: key.expireAt, createdAt: key.createdAt,
      })) });
    },
    revokeKey(id) {
      const key = keys().find(item => item.id === id);
      if (!key) return failure(404, '密钥不存在');
      if (key.status === 'revoked') return failure(400, '该密钥已处于吊销状态');
      key.status = 'revoked';
      return ok({ ok: true, key: { ...key, secretMask: maskSecret(key.appSecret) } });
    },
    listWebhooks() {
      return ok({ list: webhooks().map(hook => ({ ...hook, appName: appName(hook.appId) })) });
    },
    testWebhook(id) {
      const hook = webhooks().find(item => item.id === id);
      if (!hook) return failure(404, 'Webhook 配置不存在');
      const push = { id: (hook.pushes.length ? Math.max(...hook.pushes.map(item => item.id)) : 0) + 1, at: now(), status: 'success', httpCode: 200, ms: randomInt(60, 420) };
      hook.pushes.unshift(push);
      if (hook.pushes.length > 20) hook.pushes.length = 20;
      hook.lastPush = { status: 'success', httpCode: 200, at: now() };
      hook.pushCount += 1;
      return ok({ ok: true, webhook: { ...hook, appName: appName(hook.appId) }, push });
    },
    listApiLogs() {
      const all = logs();
      const list = [...all].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
      const success = all.filter(log => log.status === 200).length;
      return ok({ list, summary: { total: all.length, ok: success, fail: all.length - success, avgMs: Math.round(all.reduce((sum, log) => sum + log.ms, 0) / Math.max(1, all.length)) } });
    },
  };
}
