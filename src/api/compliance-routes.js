import { requireDirector } from '../auth/authorize.js';
import { failure } from './response.js';

export function registerComplianceRoutes(router, service) {
  const director = handler => request => requireDirector(request.context) || handler(request);
  const actorId = request => request.context.actor.id;

  router.register('GET', '/api/admin/compliance/kyc', director(() => service.kyc()));
  router.register('GET', '/api/admin/compliance/kyb', director(() => service.kyb()));
  router.register('POST', '/api/admin/compliance/screen', director(request => service.screen(request.body)));
  router.register('GET', '/api/admin/compliance/screenings', director(() => service.screenings()));
  router.register('GET', '/api/admin/compliance/sanctions', director(request => service.sanctions(request.query)));
  router.register('GET', '/api/admin/compliance/peps', director(request => service.peps(request.query)));
  router.register('GET', '/api/admin/compliance/str', director(() => service.strReports()));
  router.register('POST', '/api/admin/compliance/str', director(request => service.createStr(request.body)));
  router.register('GET', '/api/admin/compliance/docs', director(() => service.documents()));
  router.register('GET', '/api/admin/compliance/cases', director(() => service.cases()));
  router.register('GET', '/api/admin/compliance/countries', director(() => service.countries()));

  router.registerPrefix('POST', '/api/admin/compliance/kyb/', director(request => {
    const match = request.pathname.match(/^\/api\/admin\/compliance\/kyb\/(\d+)\/action$/);
    return match ? service.actOnKyb(+match[1], request.body, actorId(request)) : failure(404, `not found: ${request.pathname}`);
  }));
  router.registerPrefix('POST', '/api/admin/compliance/str/', director(request => {
    const match = request.pathname.match(/^\/api\/admin\/compliance\/str\/(\d+)\/submit$/);
    return match ? service.submitStr(+match[1]) : failure(404, `not found: ${request.pathname}`);
  }));
  router.registerPrefix('POST', '/api/admin/compliance/cases/', director(request => {
    const match = request.pathname.match(/^\/api\/admin\/compliance\/cases\/(\d+)\/action$/);
    return match ? service.actOnCase(+match[1], request.body, actorId(request)) : failure(404, `not found: ${request.pathname}`);
  }));
}
