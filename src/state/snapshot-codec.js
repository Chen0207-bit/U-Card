export const SNAPSHOT_SCHEMA_VERSION = 2;
export const LEGACY_SNAPSHOT_SCHEMA_VERSION = 1;

function checksumPayload(snapshot) {
  return JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    createdAt: snapshot.createdAt,
    metadata: snapshot.metadata,
    counters: snapshot.counters,
    data: snapshot.data,
  });
}

export function snapshotChecksum(snapshot) {
  const text = checksumPayload(snapshot);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function createVersionedSnapshot({ data, counters, metadata = {} }) {
  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    createdAt: Date.now(),
    metadata: { app: 'ucard-demo', ...metadata },
    counters: structuredClone(counters),
    data: structuredClone(data),
  };
  return { ...snapshot, checksum: snapshotChecksum(snapshot) };
}

export function validateVersionedSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('快照为空或格式无效');
  if (![LEGACY_SNAPSHOT_SCHEMA_VERSION, SNAPSHOT_SCHEMA_VERSION].includes(snapshot.schemaVersion)) {
    throw new Error(`不支持的快照版本: ${snapshot.schemaVersion}; 当前版本: ${SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (!snapshot.data || typeof snapshot.data !== 'object') throw new Error('快照缺少 data');
  if (!snapshot.counters || typeof snapshot.counters !== 'object') throw new Error('快照缺少 counters');
  for (const key of ['users', 'cards', 'transactions', 'ledgerAccounts', 'ledgerEntries']) {
    if (!Array.isArray(snapshot.data[key])) throw new Error(`快照缺少必要集合: ${key}`);
  }
  if (snapshot.schemaVersion === SNAPSHOT_SCHEMA_VERSION) {
    if (!snapshot.createdAt || !snapshot.checksum) throw new Error('快照缺少 createdAt 或 checksum');
    if (snapshot.checksum !== snapshotChecksum(snapshot)) throw new Error('快照 checksum 校验失败，内容可能已损坏');
  }
  return snapshot;
}
