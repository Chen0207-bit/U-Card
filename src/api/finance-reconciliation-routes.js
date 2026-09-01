import { requireDirector } from '../auth/authorize.js';
import { failure } from './response.js';

export function registerFinanceReconciliationRoutes(router, service) {
  const director = handler => request => requireDirector(request.context) || handler(request);
  router.register('GET', '/api/admin/finance/recon', director(request => service.reconciliation(request.query)));
  router.register('GET', '/api/admin/finance/diff', director(() => service.differences()));
  router.register('GET', '/api/admin/finance/merchant', director(() => service.merchantSettlements()));
  router.register('GET', '/api/admin/finance/report', director(() => service.monthlyReport()));
  router.registerPrefix('PATCH', '/api/admin/finance/merchant/', director(request => {
    const match = request.pathname.match(/^\/api\/admin\/finance\/merchant\/(.+)$/);
    return match ? service.updateMerchantSettlement(match[1], request.body) : failure(404, `not found: ${request.pathname}`);
  }));
  router.registerPrefix('GET', '/api/admin/finance/', director(request => failure(404, `not found: ${request.pathname}`)));
}
