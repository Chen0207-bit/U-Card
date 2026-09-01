import { requireDirector } from '../auth/authorize.js';

export function registerTenantRoutes(router, service) {
  const director = (handler) => async (request) => requireDirector(request.context) || handler(request);
  router.register('GET', '/api/admin/tenants', director(() => service.list()));
  router.registerPrefix('PATCH', '/api/admin/tenants' + '/', director(({ pathname, body }) => {
    const match = pathname.match(/^\/api\/admin\/tenants\/(\d+)$/);
    return match ? service.update(+match[1], body) : { status: 404, json: { error: `not found: ${pathname}` } };
  }));
}
