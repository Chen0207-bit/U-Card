import { failure } from './response.js';

export function registerBasicOperationsRoutes(router, service) {
  const sales = handler => request => request.context.actor?.type === 'sales'
    ? handler(request, request.context.actor.id)
    : failure(401, '请先选择运营后台账号', 'AUTH_REQUIRED');

  router.register('GET', '/api/admin/dashboard', sales((request, actorId) => service.dashboard(actorId, request.query)));
  router.register('GET', '/api/admin/cards', sales((request, actorId) => service.listCards(actorId)));
  router.register('POST', '/api/admin/cards/issue', sales((request, actorId) => service.issueCard(actorId, request.body)));
  router.registerPrefix('PATCH', '/api/admin/cards/', sales((request, actorId) => {
    const match = request.pathname.match(/^\/api\/admin\/cards\/(\d+)$/);
    return match ? service.updateCard(actorId, +match[1], request.body) : failure(404, `not found: ${request.pathname}`);
  }));
  router.register('GET', '/api/admin/kyc', sales((request, actorId) => service.listKyc(actorId)));
  router.register('POST', '/api/admin/kyc/review', sales((request, actorId) => service.reviewKyc(actorId, request.body)));
  router.register('GET', '/api/admin/transactions', sales((request, actorId) => service.listTransactions(actorId, request.query)));
  router.register('POST', '/api/admin/refund', sales((request, actorId) => service.refund(actorId, request.body)));
  router.register('GET', '/api/admin/users', sales((request, actorId) => service.listUsers(actorId)));
  router.register('POST', '/api/admin/users', sales((request, actorId) => service.createUser(actorId, request.body)));
  router.register('POST', '/api/admin/sales', sales((request, actorId) => service.createSales(actorId, request.body)));
  router.register('GET', '/api/admin/goals', sales((request, actorId) => service.goals(actorId, request.query)));
}
