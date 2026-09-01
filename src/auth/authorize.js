export function requireDirector(context) {
  if (context.actor?.type !== 'sales') return { status: 401, json: { error: '请先选择运营后台账号', code: 'AUTH_REQUIRED' } };
  if (context.actor.id !== 1) return { status: 403, json: { error: '仅运营总监可执行此操作', code: 'DIRECTOR_REQUIRED' } };
  return null;
}
