import { requireDirector } from '../auth/authorize.js';

export function registerNotificationRoutes(router, service) {
  const director = (handler) => async request => requireDirector(request.context) || handler(request);
  router.register('GET', '/api/admin/notify/templates', director(() => service.listTemplates()));
  router.register('GET', '/api/admin/notify/sends', director(() => service.listSends()));
  router.register('GET', '/api/admin/notify/channels', director(() => service.listChannels()));
  router.registerPrefix('PATCH', '/api/admin/notify/', director(({ pathname, body }) => {
    const template = pathname.match(/^\/api\/admin\/notify\/templates\/(\d+)$/);
    if (template) return service.updateTemplate(+template[1], body);
    const channel = pathname.match(/^\/api\/admin\/notify\/channels\/([a-z]+)$/);
    return channel ? service.updateChannel(channel[1], body) : { status: 404, json: { error: `not found: ${pathname}` } };
  }));
  router.registerPrefix('POST', '/api/admin/notify/', director(({ pathname }) => {
    const match = pathname.match(/^\/api\/admin\/notify\/sends\/(\d+)\/retry$/);
    return match ? service.retrySend(+match[1]) : { status: 404, json: { error: `not found: ${pathname}` } };
  }));
}
