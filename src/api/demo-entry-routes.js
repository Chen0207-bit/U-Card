import { ok } from './response.js';

export function registerDemoEntryRoutes(router, services) {
  router.register('GET', '/api/admin/accounts', () => ok(services.getAdminAccounts()));
  router.register('GET', '/api/app/users', () => ok(services.getAppAccounts()));
  router.register('GET', '/api/mch/merchants', () => ok(services.getMerchantAccounts()));
}
