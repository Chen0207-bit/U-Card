import { requireDirector } from '../auth/authorize.js';
import { failure } from './response.js';

export function registerApprovalRoutes(router, service) {
  const director = handler => request => requireDirector(request.context) || handler(request);

  router.register('GET', '/api/admin/approvals', director(request => service.list(request.query, request.context.actor.id)));
  router.registerPrefix('POST', '/api/admin/approvals/', director(request => {
    const match = request.pathname.match(/^\/api\/admin\/approvals\/(\d+)\/action$/);
    return match
      ? service.action(+match[1], request.body, request.context.actor)
      : failure(404, `not found: ${request.pathname}`);
  }));
}
