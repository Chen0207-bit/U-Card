import { requireDirector } from '../auth/authorize.js';

export function registerBiRoutes(router, service) {
  const director = handler => request => requireDirector(request.context) || handler(request);
  router.register('GET', '/api/admin/bi/overview', director(request => service.overview(request.query)));
  router.register('GET', '/api/admin/bi/users', director(request => service.users(request.query)));
  router.register('GET', '/api/admin/bi/tx', director(request => service.transactions(request.query)));
  router.register('GET', '/api/admin/bi/sales', director(request => service.sales(request.query)));
  router.register('GET', '/api/admin/bi/funnel', director(request => service.funnel(request.query)));
  router.register('GET', '/api/admin/bi/report', director(request => service.report(request.query)));
}
