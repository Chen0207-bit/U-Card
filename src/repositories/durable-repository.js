export const RUNTIME_SNAPSHOT_KEY = 'runtime-snapshot-v1';

export class DurableSnapshotRepository {
  constructor(storage, key = RUNTIME_SNAPSHOT_KEY) {
    if (!storage || typeof storage.get !== 'function' || typeof storage.put !== 'function') {
      throw new TypeError('DurableSnapshotRepository 需要兼容 Durable Object storage 的存储对象');
    }
    this.storage = storage;
    this.key = key;
  }

  async load() {
    return (await this.storage.get(this.key)) || null;
  }

  async save(snapshot) {
    await this.storage.put(this.key, snapshot);
  }

  async hasSnapshot() {
    return Boolean(await this.storage.get(this.key));
  }

  async health() {
    return { type: 'durable', ready: true, hasSnapshot: await this.hasSnapshot(), key: this.key };
  }
}
