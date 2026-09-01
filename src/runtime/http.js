export const API_ALLOW_HEADERS = 'Content-Type,x-user,x-sales,x-mch,x-app-key,x-demo-key,x-request-id';

export function corsHeaders(config, origin = '') {
  const allowAll = config.corsOrigins.includes('*');
  const allowed = allowAll || (origin && config.corsOrigins.includes(origin));
  return {
    ...(allowed ? { 'Access-Control-Allow-Origin': allowAll ? '*' : origin, Vary: 'Origin' } : {}),
    'Access-Control-Allow-Headers': API_ALLOW_HEADERS,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
};
