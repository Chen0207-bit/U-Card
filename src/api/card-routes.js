import { failure } from './response.js';

export function registerCardRoutes(router, services) {
  // 显式字面量注册(而非循环拼接): 保证契约扫描可见这三个公开端点
  const self = (action) => ({ context }) => {
    if (context.actor?.type !== 'user') return failure(401, '未登录', 'AUTH_REQUIRED');
    return services.changeStatus(context.actor.id, action);
  };
  router.register('POST', '/api/app/card/freeze', self('freeze'));
  router.register('POST', '/api/app/card/unfreeze', self('unfreeze'));
  router.register('POST', '/api/app/card/lost', self('lost'));
}
