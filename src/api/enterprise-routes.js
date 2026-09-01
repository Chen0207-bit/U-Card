import { failure } from './response.js';

function authorizeEnterprise(context) {
  if (context.actor?.type !== 'sales' || context.actor.id !== 1) return failure(403, '企业服务为运营总监专属功能');
  return null;
}

export function registerEnterpriseRoutes(router, service) {
  const director = handler => request => authorizeEnterprise(request.context) || handler(request);
  const actorId = request => request.context.actor.id;

  router.register('GET', '/api/admin/ent/accounts', director(() => service.listAccounts()));
  router.register('POST', '/api/admin/ent/topup', director(request => service.topup(request.body, actorId(request))));
  router.register('POST', '/api/admin/ent/cards/issue', director(request => service.issueCards(request.body, actorId(request))));
  router.register('POST', '/api/admin/ent/cards/limits', director(request => service.updateCardLimits(request.body, actorId(request))));
  router.register('POST', '/api/admin/ent/consume', director(request => service.consume(request.body)));
  router.register('GET', '/api/admin/ent/approvals', director(request => service.listApprovals(request.query)));
  router.register('GET', '/api/admin/ent/bills', director(request => service.listBills(request.query)));
  router.register('GET', '/api/admin/ent/report', director(() => service.report()));

  router.registerPrefix('GET', '/api/admin/ent/', director(request => {
    const account = request.pathname.match(/^\/api\/admin\/ent\/accounts\/(\d+)$/);
    return account ? service.account(+account[1]) : failure(404, `not found: ${request.pathname}`);
  }));

  router.registerPrefix('POST', '/api/admin/ent/', director(request => {
    const departmentBudget = request.pathname.match(/^\/api\/admin\/ent\/depts\/(\d+)\/budget$/);
    if (departmentBudget) return service.adjustDepartmentBudget(+departmentBudget[1], request.body, actorId(request));
    const approvalAction = request.pathname.match(/^\/api\/admin\/ent\/approvals\/(\d+)\/action$/);
    if (approvalAction) return service.actOnApproval(+approvalAction[1], request.body, actorId(request));
    const billInvoice = request.pathname.match(/^\/api\/admin\/ent\/bills\/(\d+)\/invoice$/);
    if (billInvoice) return service.invoiceBill(+billInvoice[1], actorId(request));
    const billPay = request.pathname.match(/^\/api\/admin\/ent\/bills\/(\d+)\/pay$/);
    if (billPay) return service.payBill(+billPay[1], actorId(request));
    return failure(404, `not found: ${request.pathname}`);
  }));
}
