import { failure } from './response.js';

export function registerMerchantPortalRoutes(router, service) {
  const merchant = handler => request => request.context.actor?.type === 'merchant' ? handler(request) : failure(401, '未登录或商户无效(需 x-mch 请求头 + 已开通商户)');
  const id = request => request.context.actor.id;
  router.register('GET', '/api/mch/me', merchant(request => service.dashboard(id(request))));
  router.register('GET', '/api/mch/profile', merchant(request => service.profile(id(request))));
  router.register('GET', '/api/mch/orders', merchant(request => service.listOrders(id(request), request.query)));
  router.register('GET', '/api/mch/refunds', merchant(request => service.listRefunds(id(request))));
  router.register('POST', '/api/mch/refunds', merchant(request => service.applyRefund(id(request), request.body, request.context.headers['x-idempotency-key'] || '')));
  router.register('GET', '/api/mch/settles', merchant(request => service.listSettles(id(request))));
}
