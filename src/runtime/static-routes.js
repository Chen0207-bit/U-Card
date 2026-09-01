const STATIC_ROUTES = new Map([
  ['/', '/admin.html'],
  ['/admin', '/admin.html'],
  ['/app/select', '/app-select.html'],
  ['/app/m', '/app.html'],
  ['/app/mobile', '/app.html'],
  ['/app/pc', '/app-pc.html'],
  ['/merchant', '/merchant.html'],
  ['/data-console', '/data-console.html'],
  ['/restore-console', '/data-console.html'],
]);

export function resolveStaticPath(pathname, userAgent = '') {
  if (pathname === '/app') return /Mobile|Android|iPhone/i.test(userAgent) ? '/app.html' : '/app-pc.html';
  return STATIC_ROUTES.get(pathname) || pathname;
}

export function staticRouteEntries() {
  return [...STATIC_ROUTES.entries()];
}
