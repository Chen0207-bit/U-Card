const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

function boolValue(value, fallback) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (TRUE.has(normalized)) return true;
  if (FALSE.has(normalized)) return false;
  throw new Error(`无效布尔配置: ${value}`);
}

function listValue(value, fallback = []) {
  if (value == null || value === '') return [...fallback];
  return String(value).split(',').map((x) => x.trim()).filter(Boolean);
}

export function createConfig(env = {}, defaults = {}) {
  const get = (key) => env[key] ?? defaults[key];
  const mode = String(get('APP_MODE') || 'production').trim().toLowerCase();
  if (!['demo', 'production'].includes(mode)) throw new Error(`APP_MODE 必须是 demo 或 production: ${mode}`);
  const demo = mode === 'demo';
  const authMode = String(get('AUTH_MODE') || (demo ? 'demo-header' : 'session')).trim().toLowerCase();
  if (!['demo-header', 'session'].includes(authMode)) throw new Error(`不支持的 AUTH_MODE: ${authMode}`);
  if (!demo && authMode === 'demo-header') throw new Error('production 模式禁止使用 demo-header 鉴权');
  const persistence = String(get('PERSISTENCE') || 'memory').trim().toLowerCase();
  if (!['memory', 'durable', 'file'].includes(persistence)) throw new Error(`不支持的 PERSISTENCE: ${persistence}`);

  return Object.freeze({
    mode,
    demo,
    authMode,
    persistence,
    allowDemoReset: boolValue(get('ALLOW_DEMO_RESET'), demo),
    corsOrigins: listValue(get('CORS_ORIGINS'), demo ? ['*'] : []),
  });
}
