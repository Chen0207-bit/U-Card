import { requireDirector } from '../auth/authorize.js';
import { failure } from './response.js';

export function registerPaymentOrchestrationRoutes(router, service) {
  const director = handler => request => {
    const denied = requireDirector(request.context);
    if (!denied) return handler(request);
    return denied.status === 403 ? failure(403, '仅运营总监可访问支付编排中心') : denied;
  };
  const notFound = request => failure(404, `not found: ${request.pathname}`);

  router.register('GET', '/api/admin/orch/adapters', director(() => service.listAdapters()));
  router.register('GET', '/api/admin/orch/routes', director(() => service.routeTable()));
  router.register('GET', '/api/admin/orch/routes/simulate', director(request => service.simulateRoute(request.query)));
  router.register('GET', '/api/admin/orch/health', director(() => service.health()));
  router.register('POST', '/api/admin/orch/health/check', director(() => service.checkHealth()));
  router.register('GET', '/api/admin/orch/compare', director(request => service.compare(request.query)));
  router.register('GET', '/api/admin/orch/txs', director(request => service.listTransactions(request.query)));
  router.register('POST', '/api/admin/orch/txs', director(request => service.createTransaction(request.body)));
  router.register('GET', '/api/admin/orch/recon', director(() => service.reconciliation()));

  router.registerPrefix('PATCH', '/api/admin/orch/adapters/', director(request => {
    const match = request.pathname.match(/^\/api\/admin\/orch\/adapters\/(\d+)$/);
    return match ? service.updateAdapter(match[1], request.body) : notFound(request);
  }));
  router.registerPrefix('GET', '/api/admin/orch/tx/', director(request => {
    const match = request.pathname.match(/^\/api\/admin\/orch\/tx\/(\d+)$/);
    return match ? service.transaction(match[1]) : notFound(request);
  }));
  router.registerPrefix('POST', '/api/admin/orch/tx/', director(request => {
    const match = request.pathname.match(/^\/api\/admin\/orch\/tx\/(\d+)\/(callback|replay|compensate|reverse|refund)$/);
    return match ? service.actOnTransaction(match[1], match[2], request.body) : notFound(request);
  }));
  router.registerPrefix('POST', '/api/admin/orch/diff/', director(request => {
    const match = request.pathname.match(/^\/api\/admin\/orch\/diff\/(\d+)\/fix$/);
    return match ? service.fixDifference(match[1], request.context.actor) : notFound(request);
  }));
}
