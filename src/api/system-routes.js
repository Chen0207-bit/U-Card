import { requireDirector } from '../auth/authorize.js';

export function registerSystemRoutes(router, service) {
  const director = handler => async request => requireDirector(request.context) || handler(request);
  const actorId = request => request.context.actor.id;
  router.register('GET', '/api/admin/sys/accounts', director(() => service.listAccounts()));
  router.register('GET', '/api/admin/sys/roles', director(() => service.listRoles()));
  router.register('GET', '/api/admin/sys/perms', director(({ query }) => service.getPermissions(query.role)));
  router.register('PATCH', '/api/admin/sys/perms', director(request => service.updatePermissions(actorId(request), request.body)));
  router.register('GET', '/api/admin/sys/org', director(() => service.getOrganization()));
  router.register('GET', '/api/admin/sys/params', director(() => service.listParameters()));
  router.register('GET', '/api/admin/sys/dicts', director(() => service.listDictionaries()));
  router.register('GET', '/api/admin/sys/loginlogs', director(() => service.getLoginLogs()));
  router.register('GET', '/api/admin/sys/oplogs', director(() => service.getOperationLogs()));
  router.registerPrefix('PATCH', '/api/admin/sys/', director(request => {
    const account = request.pathname.match(/^\/api\/admin\/sys\/accounts\/(\d+)$/);
    if (account) return service.updateAccount(actorId(request), +account[1], request.body);
    const parameter = request.pathname.match(/^\/api\/admin\/sys\/params\/(.+)$/);
    if (parameter) return service.updateParameter(actorId(request), decodeURIComponent(parameter[1]), request.body);
    const dictionary = request.pathname.match(/^\/api\/admin\/sys\/dicts\/(\d+)$/);
    return dictionary ? service.updateDictionaryItem(actorId(request), +dictionary[1], request.body) : { status: 404, json: { error: `not found: ${request.pathname}` } };
  }));
}
