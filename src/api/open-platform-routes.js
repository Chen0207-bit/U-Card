import { requireDirector } from '../auth/authorize.js';

export function registerOpenPlatformRoutes(router, service) {
  const director = (handler) => async request => requireDirector(request.context) || handler(request);
  router.register('GET', '/api/admin/open/apps', director(() => service.listApps()));
  router.register('GET', '/api/admin/open/keys', director(() => service.listKeys()));
  router.register('GET', '/api/admin/open/webhooks', director(() => service.listWebhooks()));
  router.register('GET', '/api/admin/open/apilogs', director(() => service.listApiLogs()));
  router.registerPrefix('PATCH', '/api/admin/open/', director(({ pathname, body }) => {
    const match = pathname.match(/^\/api\/admin\/open\/apps\/(\d+)$/);
    return match ? service.updateApp(+match[1], body) : { status: 404, json: { error: `not found: ${pathname}` } };
  }));
  router.registerPrefix('POST', '/api/admin/open/', director(({ pathname }) => {
    const keyMatch = pathname.match(/^\/api\/admin\/open\/keys\/(\d+)\/revoke$/);
    if (keyMatch) return service.revokeKey(+keyMatch[1]);
    const webhookMatch = pathname.match(/^\/api\/admin\/open\/webhooks\/(\d+)\/test$/);
    return webhookMatch ? service.testWebhook(+webhookMatch[1]) : { status: 404, json: { error: `not found: ${pathname}` } };
  }));
}
