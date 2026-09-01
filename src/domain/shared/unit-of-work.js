/**
 * UnitOfWork — 以内部快照为回滚基线的写事务。
 *
 * 语义(对应交接文档 §5.4):
 *  1. 执行前抓基线快照(变更集的内存实现);
 *  2. 业务失败(operation 抛错 / 返回 5xx)或持久化失败(persist 抛错)
 *     时 importInternalSnapshot(基线) 整体回滚内存状态;
 *  3. 只有业务与持久化都成功才算提交。
 * 4xx 是正常业务拒绝(校验/权限), 不触发回滚。
 */
export function createUnitOfWork({ exportSnapshot, importSnapshot }) {
  const rollback = (baseline) => { importSnapshot(baseline); };
  return {
    async run(operation, persist) {
      const baseline = exportSnapshot();
      let result;
      try {
        result = await operation();
      } catch (error) {
        rollback(baseline);
        return { committed: false, stage: 'business', error, result: null };
      }
      if (!result || result.status >= 500) {
        rollback(baseline);
        return { committed: false, stage: 'business', error: new Error(`业务执行失败: status ${result?.status}`), result };
      }
      try {
        await persist(result);
      } catch (error) {
        rollback(baseline);
        return { committed: false, stage: 'persist', error, result };
      }
      return { committed: true, stage: 'done', error: null, result };
    },
  };
}
