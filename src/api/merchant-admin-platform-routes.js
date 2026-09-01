import { requireDirector } from '../auth/authorize.js';
import { failure } from './response.js';

export function registerMerchantAdminPlatformRoutes(router, service) {
  const director = handler => request => requireDirector(request.context) || handler(request);
  const notFound = request => failure(404, `not found: ${request.pathname}`);

  router.register('GET', '/api/admin/mch/accounts', director(() => service.listAccounts()));
  router.register('GET', '/api/admin/mch/orders', director(request => service.listOrders(request.query)));
  router.register('GET', '/api/admin/mch/refunds', director(request => service.listRefunds(request.query)));
  router.register('GET', '/api/admin/mch/settles', director(request => service.listSettles(request.query)));
  router.register('GET', '/api/admin/mch/splits', director(request => service.listSplits(request.query)));
  router.register('GET', '/api/admin/mch/risk', director(() => service.riskOverview()));
  router.register('GET', '/api/admin/mch/report', director(request => service.report(request.query)));

  router.registerPrefix('POST', '/api/admin/mch/accounts/', director(request => {
    const action = request.pathname.match(/^\/api\/admin\/mch\/accounts\/(\d+)\/action$/);
    if (action) return service.reviewAccount(action[1], request.body, request.context.actor);
    const rate = request.pathname.match(/^\/api\/admin\/mch\/accounts\/(\d+)\/rate$/);
    return rate ? service.updateRate(rate[1], request.body, request.context.actor) : notFound(request);
  }));
  router.registerPrefix('POST', '/api/admin/mch/refunds/', director(request => {
    const match = request.pathname.match(/^\/api\/admin\/mch\/refunds\/(\d+)\/action$/);
    return match ? service.reviewRefund(match[1], request.body, request.context.actor) : notFound(request);
  }));
  router.registerPrefix('POST', '/api/admin/mch/settles/', director(request => {
    const match = request.pathname.match(/^\/api\/admin\/mch\/settles\/(\d+)\/settle$/);
    return match ? service.settle(match[1], request.context.actor) : notFound(request);
  }));
}
