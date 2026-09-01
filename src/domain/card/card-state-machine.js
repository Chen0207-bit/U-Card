const TRANSITIONS = {
  freeze: {
    allowed: new Set(['active']),
    next: 'frozen',
    error: '当前状态不可冻结',
  },
  unfreeze: {
    allowed: new Set(['frozen']),
    next: 'active',
    error: '只有冻结状态可自助解冻, 挂失请联系客服',
  },
  lost: {
    next: 'lost',
    error: '卡已处于挂失状态',
  },
};

export function transitionCardStatus(currentStatus, action) {
  const transition = TRANSITIONS[action];
  if (!transition) return { ok: false, error: '不支持的卡片操作' };
  const allowed = action === 'lost' ? currentStatus !== 'lost' : transition.allowed.has(currentStatus);
  if (!allowed) return { ok: false, error: transition.error };
  return { ok: true, status: transition.next };
}
