import { failure } from './response.js';

function authorizeClassicRisk(context) {
  if (context.actor?.type !== 'sales' || context.actor.id !== 1) {
    return failure(403, '仅运营总监可访问风控与财务中心');
  }
  return null;
}

export function registerClassicRiskRoutes(router, service) {
  const director = handler => request => authorizeClassicRisk(request.context) || handler(request);
  const actorName = request => service.operatorName(request.context.actor.id);

  router.register('GET', '/api/admin/risk', director(request => service.events(request.query)));
  router.register('GET', '/api/admin/risk/rules', director(() => service.rules()));
  router.register('GET', '/api/admin/risk/lists', director(() => service.lists()));
  router.register('GET', '/api/admin/risk/tags', director(() => service.tags()));

  router.registerPrefix('POST', '/api/admin/risk/', director(request => {
    const eventMatch = request.pathname.match(/^\/api\/admin\/risk\/(\d+)\/action$/);
    if (eventMatch) return service.actOnEvent(+eventMatch[1], request.body, actorName(request));
    const listMatch = request.pathname.match(/^\/api\/admin\/risk\/lists\/(\d+)\/remove$/);
    return listMatch ? service.removeListItem(+listMatch[1]) : failure(404, `not found: ${request.pathname}`);
  }));
  router.registerPrefix('PATCH', '/api/admin/risk/rules/', director(request => {
    const match = request.pathname.match(/^\/api\/admin\/risk\/rules\/(\d+)$/);
    return match ? service.updateRule(+match[1], request.body) : failure(404, `not found: ${request.pathname}`);
  }));
  router.registerPrefix('DELETE', '/api/admin/risk/lists/', director(request => {
    const match = request.pathname.match(/^\/api\/admin\/risk\/lists\/(\d+)\/remove$/);
    return match ? service.removeListItem(+match[1]) : failure(404, `not found: ${request.pathname}`);
  }));
}
