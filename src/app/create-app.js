import { createConfig } from '../config.js';
import { createRequestContext } from './request-context.js';
import { createRouter } from '../api/router.js';
import { registerOpsRoutes } from '../api/ops-routes.js';
import { registerDemoEntryRoutes } from '../api/demo-entry-routes.js';
import { registerCardRoutes } from '../api/card-routes.js';
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
