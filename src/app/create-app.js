import { createConfig } from '../config.js';
import { createRequestContext } from './request-context.js';
import { createRouter } from '../api/router.js';
import { registerOpsRoutes } from '../api/ops-routes.js';
import { registerDemoEntryRoutes } from '../api/demo-entry-routes.js';
import {
  handleApi as legacyHandleApi, getOpsDataState, exportOpsBackup, restoreOpsSeed,
  getAdminAccountChoices, getAppAccountChoices, getMerchantAccountChoices,
} from '../../core.js';

export function createApp({ env = {}, defaults = {} } = {}) {
  const config = createConfig(env, defaults);
  const router = createRouter();
  registerOpsRoutes(router, {
    getState: getOpsDataState,
    exportBackup: exportOpsBackup,
    restoreSeed: restoreOpsSeed,
  }, config);
  registerDemoEntryRoutes(router, {
    getAdminAccounts: getAdminAccountChoices,
    getAppAccounts: getAppAccountChoices,
    getMerchantAccounts: getMerchantAccountChoices,
  });

  return {
    config,
    routes: router.list(),
    async handleApi(method, pathname, query = {}, body = {}, headers = {}) {
      const context = createRequestContext({ method, pathname, query, headers, config });
      const request = { method, pathname, query, body, headers: context.headers, context };
      const routed = await router.dispatch(request);
      const result = routed || legacyHandleApi(method, pathname, query, body, context.headers, context);
      return { ...result, requestId: context.requestId };
    },
  };
}
