import { requireDirector } from '../auth/authorize.js';

export function registerOpsRoutes(router, services, config) {
  const director = (handler) => async (request) => {
    const denied = requireDirector(request.context);
    return denied || await handler(request);
  };

  router.register('GET', '/api/admin/ops/data-state', director(() => ({ status: 200, json: { ...services.getState(), persistence: config.persistence } })));
  router.register('GET', '/api/admin/ops/backup', director(() => ({ status: 200, json: services.exportBackup() })));
  router.register('POST', '/api/admin/ops/restore', director(({ body }) => {
    if (!config.allowDemoReset) return { status: 403, json: { error: '当前环境禁止恢复演示种子', code: 'DEMO_RESET_DISABLED' } };
    if (body.mode !== 'seed' || body.confirm !== 'RESTORE_SEED') {
      return { status: 400, json: { error: '请输入 RESTORE_SEED 确认恢复初始种子', code: 'RESTORE_CONFIRM_REQUIRED' } };
    }
    return { status: 200, json: services.restoreSeed('console_restore') };
  }));
  router.register('POST', '/api/demo/reset', director(() => {
    if (!config.allowDemoReset) return { status: 403, json: { error: '当前环境禁止重置演示数据', code: 'DEMO_RESET_DISABLED' } };
    return { status: 200, json: services.restoreSeed('header_reset') };
  }));
}
