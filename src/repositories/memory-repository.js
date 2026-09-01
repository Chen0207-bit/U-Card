export class MemorySnapshotRepository {
  constructor(initialSnapshot = null) {
    this.snapshot = initialSnapshot ? structuredClone(initialSnapshot) : null;
  }

  async load() {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  async save(snapshot) {
    this.snapshot = structuredClone(snapshot);
  }

  async reset(snapshot) {
    await this.save(snapshot);
  }

  async exportRedacted(redactor) {
    if (typeof redactor !== 'function') throw new TypeError('exportRedacted 需要脱敏投影函数');
    return redactor(await this.load());
  }

  async hasSnapshot() {
    return this.snapshot !== null;
  }

  async health() {
    return { type: 'memory', ready: true, hasSnapshot: await this.hasSnapshot() };
  }
}
