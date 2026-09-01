import { requireDirector } from '../auth/authorize.js';
import { failure } from './response.js';

export function registerLedgerRoutes(router, service) {
  const director = handler => request => requireDirector(request.context) || handler(request);
  router.register('GET', '/api/admin/ledger/accounts', director(() => service.accounts()));
  router.register('GET', '/api/admin/ledger/entries', director(request => service.entries(request.query)));
  router.register('GET', '/api/admin/ledger/snapshots', director(() => service.snapshots()));
  router.register('GET', '/api/admin/ledger/verify', director(() => service.verify()));
  router.registerPrefix('GET', '/api/admin/ledger', director(request => failure(404, `not found: ${request.pathname}`)));
}
