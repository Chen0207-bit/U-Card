import { createConfig } from '../config.js';
import { createRequestContext } from './request-context.js';
import { createRouter } from '../api/router.js';
import { registerOpsRoutes } from '../api/ops-routes.js';
import { registerDemoEntryRoutes } from '../api/demo-entry-routes.js';
import { registerCardRoutes } from '../api/card-routes.js';
import { registerTenantRoutes } from '../api/tenant-routes.js';
import { registerOpenPlatformRoutes } from '../api/open-platform-routes.js';
import { registerNotificationRoutes } from '../api/notification-routes.js';
import { registerSystemRoutes } from '../api/system-routes.js';
import { registerOpsManagementRoutes } from '../api/ops-management-routes.js';
import { registerMerchantPortalRoutes } from '../api/merchant-portal-routes.js';
import { registerAppUserRoutes } from '../api/app-user-routes.js';
import { registerOpenApiMockRoutes } from '../api/open-api-mock-routes.js';
import { registerFinanceReconciliationRoutes } from '../api/finance-reconciliation-routes.js';
import { registerLedgerRoutes } from '../api/ledger-routes.js';
import { registerBasicOperationsRoutes } from '../api/basic-operations-routes.js';
import { registerCrmRoutes } from '../api/crm-routes.js';
import { registerAdminShopRoutes } from '../api/admin-shop-routes.js';
import { registerComplianceRoutes } from '../api/compliance-routes.js';
import { registerBiRoutes } from '../api/bi-routes.js';
import { registerMerchantAdminPlatformRoutes } from '../api/merchant-admin-platform-routes.js';
import { defaultCoreRuntime } from '../../core.js';

export function createApp({ env = {}, defaults = {}, core = defaultCoreRuntime } = {}) {
  const config = createConfig(env, defaults);
  const router = createRouter();
  registerOpsRoutes(router, {
    getState: core.getOpsDataState,
    exportBackup: core.exportOpsBackup,
    restoreSeed: core.restoreOpsSeed,
  }, config);
  registerDemoEntryRoutes(router, {
    getAdminAccounts: core.getAdminAccountChoices,
    getAppAccounts: core.getAppAccountChoices,
    getMerchantAccounts: core.getMerchantAccountChoices,
  });
  registerCardRoutes(router, { changeStatus: core.changeAppCardStatus });
  registerTenantRoutes(router, core.tenantService);
  registerOpenPlatformRoutes(router, core.openPlatformService);
  registerNotificationRoutes(router, core.notificationService);
  registerSystemRoutes(router, core.systemService);
  registerOpsManagementRoutes(router, core.opsManagementService);
  registerMerchantPortalRoutes(router, core.merchantPortalService);
  registerAppUserRoutes(router, core.appUserService);
  registerOpenApiMockRoutes(router, core.openApiMockService);
  registerFinanceReconciliationRoutes(router, core.financeReconciliationService);
  registerLedgerRoutes(router, core.ledgerService);
  registerBasicOperationsRoutes(router, core.basicOperationsService);
  registerCrmRoutes(router, core.crmService);
  registerAdminShopRoutes(router, core.adminShopService);
  registerComplianceRoutes(router, core.complianceService);
  registerBiRoutes(router, core.biService);
  registerMerchantAdminPlatformRoutes(router, core.merchantAdminPlatformService);

  return {
    config,
    routes: router.list(),
    async handleApi(method, pathname, query = {}, body = {}, headers = {}) {
      const context = createRequestContext({ method, pathname, query, headers, config });
      const request = { method, pathname, query, body, headers: context.headers, context };
      const routed = await router.dispatch(request);
      const result = routed || core.handleApi(method, pathname, query, body, context.headers, context);
      return { ...result, requestId: context.requestId };
    },
  };
}
