export function registerOpenApiMockRoutes(router, service) {
  const dispatch = ({ pathname, body, headers, method }) => service.invoke(pathname.slice('/api/open/'.length), body, headers, method);
  // 保留旧入口对常用 HTTP 方法的响应语义；接口文档仍只推荐 POST。
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) router.registerPrefix(method, '/api/open/', dispatch);
}
