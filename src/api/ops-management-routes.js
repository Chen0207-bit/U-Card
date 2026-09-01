import { requireDirector } from '../auth/authorize.js';

export function registerOpsManagementRoutes(router, service) {
  const director = handler => async request => requireDirector(request.context) || handler(request);
  const actorId = request => request.context.actor.id;
  router.register('GET', '/api/admin/ops/arch', director(() => service.architecture()));
  router.register('GET', '/api/admin/ops/flags', director(() => service.listFlags()));
  router.register('GET', '/api/admin/ops/ratelimit', director(() => service.getRateLimit()));
  router.register('PATCH', '/api/admin/ops/ratelimit', director(request => service.updateRateLimit(actorId(request), request.body)));
  router.register('POST', '/api/admin/ops/ratelimit/test', director(request => service.testRateLimit(request.context.headers['x-demo-key'] || 'default')));
  router.register('GET', '/api/admin/ops/audit', director(({ query }) => service.audit(query)));
  router.register('GET', '/api/admin/ops/monitor', director(() => service.monitor()));
  router.register('GET', '/api/admin/ops/alerts', director(() => service.alerts()));
  router.register('GET', '/api/admin/ops/trace', director(() => service.traceCandidates()));
  router.registerPrefix('PATCH', '/api/admin/ops/', director(request => {
    const match = request.pathname.match(/^\/api\/admin\/ops\/flags\/(\d+)$/);
    return match ? service.updateFlag(actorId(request), +match[1], request.body) : { status: 404, json: { error: `not found: ${request.pathname}` } };
  }));
  router.registerPrefix('GET', '/api/admin/ops/', director(request => {
    const match = request.pathname.match(/^\/api\/admin\/ops\/trace\/(\d+)$/);
    return match ? service.trace(+match[1]) : { status: 404, json: { error: `not found: ${request.pathname}` } };
  }));
}
