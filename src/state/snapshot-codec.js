export const SNAPSHOT_SCHEMA_VERSION = 1;

export function createVersionedSnapshot({ data, counters, metadata = {} }) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    createdAt: Date.now(),
    metadata: { app: 'ucard-demo', ...metadata },
    counters: structuredClone(counters),
    data: structuredClone(data),
  };
}

export function validateVersionedSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('快照为空或格式无效');
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`不支持的快照版本: ${snapshot.schemaVersion}; 当前版本: ${SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (!snapshot.data || typeof snapshot.data !== 'object') throw new Error('快照缺少 data');
  if (!snapshot.counters || typeof snapshot.counters !== 'object') throw new Error('快照缺少 counters');
  for (const key of ['users', 'cards', 'transactions', 'ledgerAccounts', 'ledgerEntries']) {
    if (!Array.isArray(snapshot.data[key])) throw new Error(`快照缺少必要集合: ${key}`);
  }
  return snapshot;
}
