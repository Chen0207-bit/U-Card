export function createRouter() {
  const exact = new Map();
  const keyOf = (method, pathname) => `${String(method).toUpperCase()} ${pathname}`;
  return {
    register(method, pathname, handler) {
      const key = keyOf(method, pathname);
      if (exact.has(key)) throw new Error(`重复路由: ${key}`);
      exact.set(key, handler);
    },
    async dispatch(request) {
      const handler = exact.get(keyOf(request.method, request.pathname));
      return handler ? await handler(request) : null;
    },
    list() { return [...exact.keys()].sort(); },
  };
}
