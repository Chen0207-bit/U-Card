function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const lower = name.toLowerCase();
  return headers[lower] ?? headers[name] ?? '';
}

function positiveInt(value) {
  const id = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function resolveDemoActor(pathname, headers) {
  if (pathname.startsWith('/api/admin/') || pathname === '/api/demo/reset') {
    const id = positiveInt(headerValue(headers, 'x-sales'));
    return id ? { type: 'sales', id, auth: 'demo-header' } : { type: 'anonymous', id: null, auth: 'none' };
  }
  if (pathname.startsWith('/api/app/')) {
    const id = positiveInt(headerValue(headers, 'x-user'));
    return id ? { type: 'user', id, auth: 'demo-header' } : { type: 'anonymous', id: null, auth: 'none' };
  }
  if (pathname.startsWith('/api/mch/')) {
    const id = positiveInt(headerValue(headers, 'x-mch'));
    return id ? { type: 'merchant', id, auth: 'demo-header' } : { type: 'anonymous', id: null, auth: 'none' };
  }
  if (pathname.startsWith('/api/open/')) {
    const appKey = String(headerValue(headers, 'x-app-key') || '');
    return appKey ? { type: 'open-app', id: appKey, auth: 'app-key' } : { type: 'anonymous', id: null, auth: 'none' };
  }
  return { type: 'anonymous', id: null, auth: 'none' };
}
