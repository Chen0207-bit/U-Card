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

  async hasSnapshot() {
    return this.snapshot !== null;
  }

  async health() {
    return { type: 'memory', ready: true, hasSnapshot: await this.hasSnapshot() };
  }
}
