import { failure } from './response.js';

export function registerCardRoutes(router, services) {
  for (const action of ['freeze', 'unfreeze', 'lost']) {
    router.register('POST', `/api/app/card/${action}`, ({ context }) => {
      if (context.actor?.type !== 'user') return failure(401, '未登录', 'AUTH_REQUIRED');
      return services.changeStatus(context.actor.id, action);
    });
  }
}
