import { failure } from './response.js';

export function registerAdminShopRoutes(router, service) {
  const sales = handler => request => request.context.actor?.type === 'sales'
    ? handler(request, request.context.actor.id)
    : failure(401, '请先选择运营后台账号', 'AUTH_REQUIRED');

  router.register('GET', '/api/admin/points', sales((request, actorId) => service.listPoints(actorId)));
  router.register('POST', '/api/admin/points/grant', sales((request, actorId) => service.grantPoints(actorId, request.body)));
  router.register('GET', '/api/admin/products', sales((request, actorId) => service.listProducts(actorId)));
  router.registerPrefix('PATCH', '/api/admin/products/', sales((request, actorId) => {
    const match = request.pathname.match(/^\/api\/admin\/products\/(\d+)$/);
    return match ? service.toggleProduct(actorId, +match[1]) : failure(404, `not found: ${request.pathname}`);
  }));
  router.register('GET', '/api/admin/orders', sales((request, actorId) => service.listOrders(actorId)));
  router.register('POST', '/api/admin/orders/ship', sales((request, actorId) => service.shipOrder(actorId, request.body)));
}
