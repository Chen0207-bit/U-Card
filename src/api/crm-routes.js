import { failure } from './response.js';

export function registerCrmRoutes(router, service) {
  const sales = handler => request => request.context.actor?.type === 'sales'
    ? handler(request, request.context.actor.id)
    : failure(401, '请先选择运营后台账号', 'AUTH_REQUIRED');

  router.register('GET', '/api/admin/customers', sales((request, actorId) => service.listCustomers(actorId, request.query)));
  router.register('POST', '/api/admin/customers', sales((request, actorId) => service.createCustomer(actorId, request.body)));
  router.registerPrefix('GET', '/api/admin/customers/', sales((request, actorId) => {
    const match = request.pathname.match(/^\/api\/admin\/customers\/(\d+)\/overview$/);
    return match ? service.customerOverview(actorId, +match[1]) : failure(404, `not found: ${request.pathname}`);
  }));
  router.register('POST', '/api/admin/followups', sales((request, actorId) => service.createFollowup(actorId, request.body)));
  router.register('GET', '/api/admin/performance', sales((request, actorId) => service.performance(actorId)));
  router.register('GET', '/api/admin/commissions', sales((request, actorId) => service.listCommissions(actorId)));
  router.register('POST', '/api/admin/commissions/settle', sales((request, actorId) => service.settleCommission(actorId, request.body)));
  router.register('GET', '/api/admin/commissions/tree', sales((request, actorId) => service.commissionTree(actorId)));
}
