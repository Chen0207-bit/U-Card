import { requireDirector } from '../auth/authorize.js';
import { failure } from './response.js';

export function registerRiskEngineRoutes(router, service) {
  const director = handler => request => requireDirector(request.context) || handler(request);
  const actorName = request => service.operatorName(request.context.actor.id);

  router.register('GET', '/api/admin/risk-engine/rules', director(() => service.rules()));
  router.register('POST', '/api/admin/risk-engine/rules', director(request => service.createRule(request.body, actorName(request))));
  router.register('GET', '/api/admin/risk-engine/scores', director(() => service.scores()));
  router.register('GET', '/api/admin/risk-engine/hits', director(() => service.hits()));
  router.register('GET', '/api/admin/risk-engine/versions', director(() => service.versions()));
  router.register('POST', '/api/admin/risk-engine/versions/publish', director(request => service.publish(request.body, actorName(request))));

  router.registerPrefix('PATCH', '/api/admin/risk-engine/rules/', director(request => {
    const match = request.pathname.match(/^\/api\/admin\/risk-engine\/rules\/(\d+)$/);
    return match ? service.updateRule(+match[1], request.body, actorName(request)) : failure(404, `not found: ${request.pathname}`);
  }));
  router.registerPrefix('DELETE', '/api/admin/risk-engine/rules/', director(request => {
    const match = request.pathname.match(/^\/api\/admin\/risk-engine\/rules\/(\d+)$/);
    return match ? service.deleteRule(+match[1], actorName(request)) : failure(404, `not found: ${request.pathname}`);
  }));
  router.registerPrefix('POST', '/api/admin/risk-engine/versions/', director(request => {
    const match = request.pathname.match(/^\/api\/admin\/risk-engine\/versions\/(v\d+\.\d+)\/rollback$/);
    return match ? service.rollback(match[1], request.body, actorName(request)) : failure(404, `not found: ${request.pathname}`);
  }));
}
