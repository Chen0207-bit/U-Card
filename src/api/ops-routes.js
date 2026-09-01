import { requireDirector } from '../auth/authorize.js';
import { failure, ok } from './response.js';
import { hasExactValues } from './validators.js';

export function registerOpsRoutes(router, services, config) {
  const director = (handler) => async (request) => {
    const denied = requireDirector(request.context);
    return denied || await handler(request);
  };

  router.register('GET', '/api/admin/ops/data-state', director(() => ok({ ...services.getState(), persistence: config.persistence })));
  router.register('GET', '/api/admin/ops/backup', director(() => ok(services.exportBackup())));
  router.register('POST', '/api/admin/ops/restore', director(({ body }) => {
    if (!config.allowDemoReset) return failure(403, '当前环境禁止恢复演示种子', 'DEMO_RESET_DISABLED');
    if (!hasExactValues(body, { mode: 'seed', confirm: 'RESTORE_SEED' })) return failure(400, '请输入 RESTORE_SEED 确认恢复初始种子', 'RESTORE_CONFIRM_REQUIRED');
    return ok(services.restoreSeed('console_restore'));
  }));
  router.register('POST', '/api/demo/reset', director(() => {
    if (!config.allowDemoReset) return failure(403, '当前环境禁止重置演示数据', 'DEMO_RESET_DISABLED');
    return ok(services.restoreSeed('header_reset'));
  }));
}
