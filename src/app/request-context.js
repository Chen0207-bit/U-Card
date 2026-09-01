import { resolveDemoActor } from '../auth/demo-auth.js';

function toHeadersObject(headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function') return Object.fromEntries(headers.entries());
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function requestIdOf(headers) {
  const incoming = headers['x-request-id'];
  if (incoming && /^[a-zA-Z0-9._:-]{1,100}$/.test(String(incoming))) return String(incoming);
  return globalThis.crypto?.randomUUID?.() || `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createRequestContext({ method, pathname, query = {}, headers, config }) {
  const normalizedHeaders = toHeadersObject(headers);
  const actor = config.authMode === 'demo-header'
    ? resolveDemoActor(pathname, normalizedHeaders)
    : { type: 'anonymous', id: null, auth: 'session-unconfigured' };
  return {
    requestId: requestIdOf(normalizedHeaders),
    method,
    pathname,
    query,
    headers: normalizedHeaders,
    actor,
    mode: config.mode,
    startedAt: Date.now(),
  };
}
