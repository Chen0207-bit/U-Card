import { failure } from './response.js';

export function registerAppUserRoutes(router, service) {
  const user = handler => request => request.context.actor?.type === 'user' ? handler(request) : failure(401, '未登录', 'AUTH_REQUIRED');
  const id = request => request.context.actor.id;
  const get = (path, method) => router.register('GET', path, user(request => service[method](id(request), request.query)));
  get('/api/app/me', 'me'); get('/api/app/transactions', 'transactions'); get('/api/app/tasks', 'tasks');
  get('/api/app/products', 'products'); get('/api/app/orders', 'orders'); get('/api/app/points', 'points');
  get('/api/app/points/summary', 'pointsSummary'); get('/api/app/invite', 'invite'); get('/api/app/notifications', 'notifications');
  router.register('POST', '/api/app/topup', user(request => service.topup(id(request), request.body)));
  router.register('POST', '/api/app/pay', user(request => service.pay(id(request), request.body)));
  router.register('POST', '/api/app/sign', user(request => service.sign(id(request))));
  router.register('POST', '/api/app/task/claim', user(request => service.claimTask(id(request), request.body.id)));
  router.register('POST', '/api/app/redeem', user(request => service.redeem(id(request), request.body.id)));
  router.register('POST', '/api/app/orders/cancel', user(request => service.cancelOrder(id(request), request.body.id)));
  router.register('POST', '/api/app/orders/aftersale', user(request => service.applyAfterSale(id(request), request.body)));
  router.register('POST', '/api/app/orders/review', user(request => service.reviewOrder(id(request), request.body)));
  router.register('POST', '/api/app/kyc', user(request => service.submitKyc(id(request))));
  router.register('POST', '/api/app/password', user(request => service.changePassword(id(request), request.body)));
  router.register('POST', '/api/app/notifications/read', user(request => service.readNotifications(id(request), request.body)));
}
