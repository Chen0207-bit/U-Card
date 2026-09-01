export function registerDemoEntryRoutes(router, services) {
  router.register('GET', '/api/admin/accounts', () => ({ status: 200, json: services.getAdminAccounts() }));
  router.register('GET', '/api/app/users', () => ({ status: 200, json: services.getAppAccounts() }));
  router.register('GET', '/api/mch/merchants', () => ({ status: 200, json: services.getMerchantAccounts() }));
}
