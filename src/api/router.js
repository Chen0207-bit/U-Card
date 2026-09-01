export function createRouter() {
  const exact = new Map();
  const prefixes = [];
  const keyOf = (method, pathname) => `${String(method).toUpperCase()} ${pathname}`;
  return {
    register(method, pathname, handler) {
      const key = keyOf(method, pathname);
      if (exact.has(key)) throw new Error(`重复路由: ${key}`);
      exact.set(key, handler);
    },
    registerPrefix(method, prefix, handler) {
      const key = keyOf(method, `${prefix}*`);
      if (exact.has(key) || prefixes.some(route => route.key === key)) throw new Error(`重复路由: ${key}`);
      prefixes.push({ key, method: String(method).toUpperCase(), prefix, handler });
      prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
    },
    async dispatch(request) {
      const handler = exact.get(keyOf(request.method, request.pathname));
      if (handler) return await handler(request);
      const route = prefixes.find(item => item.method === String(request.method).toUpperCase() && request.pathname.startsWith(item.prefix));
      return route ? await route.handler(request) : null;
    },
    list() { return [...exact.keys(), ...prefixes.map(route => route.key)].sort(); },
  };
}
