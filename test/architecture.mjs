import { createApp } from '../src/app/create-app.js';
import { createConfig } from '../src/config.js';
import { corsHeaders } from '../src/runtime/http.js';
import { resolveStaticPath } from '../src/runtime/static-routes.js';
import { createCoreRuntime, exportInternalSnapshot, importInternalSnapshot, handleApi, restoreOpsSeed } from '../core.js';
import { AppState } from '../do.js';
import { MemorySnapshotRepository } from '../src/repositories/memory-repository.js';
import { DurableSnapshotRepository, RUNTIME_SNAPSHOT_KEY } from '../src/repositories/durable-repository.js';
import { transitionCardStatus } from '../src/domain/card/card-state-machine.js';

let pass = 0;
let fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
};

console.log('\n== 架构边界 ==');
const demo = createApp({ env: { APP_MODE: 'demo', AUTH_MODE: 'demo-header', ALLOW_DEMO_RESET: 'true', CORS_ORIGINS: '*' } });
check('Router 注册首批领域路由', demo.routes.length === 185, demo.routes.join(','));

let r = await demo.handleApi('GET', '/api/admin/users');
check('后台无身份返回 401', r.status === 401, JSON.stringify(r));
r = await demo.handleApi('GET', '/api/admin/accounts');
check('Demo 账号选择列表允许匿名访问', r.status === 200 && Array.isArray(r.json), JSON.stringify(r).slice(0, 100));
r = await demo.handleApi('GET', '/api/app/users');
check('用户端账号选择列表由 Router 匿名提供', r.status === 200 && Array.isArray(r.json), JSON.stringify(r).slice(0, 100));
r = await demo.handleApi('GET', '/api/mch/merchants');
check('商户端账号选择列表由 Router 匿名提供', r.status === 200 && Array.isArray(r.json.list), JSON.stringify(r).slice(0, 100));
r = await demo.handleApi('GET', '/api/mch/me', {}, {}, { 'x-mch': '8301' });
check('商户看板由新 Router/Service 提供', r.status === 200 && r.json.me?.id === 8301, JSON.stringify(r).slice(0, 120));
r = await demo.handleApi('GET', '/api/admin/ops/backup', {}, {}, { 'x-sales': '30' });
check('普通销售不能导出运维备份', r.status === 403, JSON.stringify(r));
r = await demo.handleApi('GET', '/api/admin/tenants', {}, {}, { 'x-sales': '30' });
check('普通销售不能访问租户领域', r.status === 403, JSON.stringify(r));
r = await demo.handleApi('GET', '/api/admin/tenants', {}, {}, { 'x-sales': '1' });
check('租户列表由新 Router/Service 提供', r.status === 200 && Array.isArray(r.json.list), JSON.stringify(r).slice(0, 120));
r = await demo.handleApi('GET', '/api/admin/open/apps', {}, {}, { 'x-sales': '1' });
check('开放平台应用由新 Router/Service 提供', r.status === 200 && Array.isArray(r.json.list), JSON.stringify(r).slice(0, 120));
const openAppKey = r.json.list?.find(item => item.enabled)?.appKey;
const openMock = await demo.handleApi('POST', '/api/open/balance.query', {}, { userId: 1 }, { 'x-app-key': openAppKey });
check('开放 API mock 由新 Router/Service 提供', openMock.status === 200 && openMock.json.endpoint === 'balance.query', JSON.stringify(openMock).slice(0, 120));
const openMockUnauthorized = await demo.handleApi('POST', '/api/open/balance.query');
check('开放 API mock 拒绝无 AppKey 请求', openMockUnauthorized.status === 401, JSON.stringify(openMockUnauthorized));
const ledgerVerify = await demo.handleApi('GET', '/api/admin/ledger/verify', {}, {}, { 'x-sales': '1' });
check('资金账本由新 Router/Service 提供且保持平衡', ledgerVerify.status === 200 && ledgerVerify.json.balanced === true, JSON.stringify(ledgerVerify).slice(0, 160));
const financeRecon = await demo.handleApi('GET', '/api/admin/finance/recon', { type: 'consume' }, {}, { 'x-sales': '1' });
check('财务对账由新 Router/Service 提供', financeRecon.status === 200 && financeRecon.json.type === 'consume', JSON.stringify(financeRecon).slice(0, 120));
r = await demo.handleApi('GET', '/api/admin/notify/channels', {}, {}, { 'x-sales': '1' });
check('消息渠道由新 Router/Service 提供', r.status === 200 && Array.isArray(r.json.list), JSON.stringify(r).slice(0, 120));
r = await demo.handleApi('GET', '/api/admin/sys/roles', {}, {}, { 'x-sales': '1' });
check('系统角色由新 Router/Service 提供', r.status === 200 && Array.isArray(r.json.list), JSON.stringify(r).slice(0, 120));
r = await demo.handleApi('GET', '/api/admin/ops/data-state', {}, {}, { 'x-sales': '1' });
check('总监可读取数据状态', r.status === 200 && r.json.persistence === 'memory', JSON.stringify(r).slice(0, 120));
r = await demo.handleApi('GET', '/api/app/me');
check('用户端无身份返回 401', r.status === 401, JSON.stringify(r));
r = await demo.handleApi('GET', '/api/app/me', {}, {}, { 'x-user': '1' });
check('Demo 用户身份兼容', r.status === 200 && r.json.id === 1, JSON.stringify(r).slice(0, 100));
r = await demo.handleApi('POST', '/api/app/card/freeze', {}, {}, { 'x-user': '1' });
check('卡片冻结由新 Router 和状态机处理', r.status === 200 && r.json.status === 'frozen', JSON.stringify(r));
r = await demo.handleApi('POST', '/api/app/card/unfreeze', {}, {}, { 'x-user': '1' });
check('卡片解冻由新 Router 和状态机处理', r.status === 200 && r.json.status === 'active', JSON.stringify(r));
check('挂失状态不能自助解冻', transitionCardStatus('lost', 'unfreeze').ok === false);
const isolatedA = createCoreRuntime();
const isolatedB = createCoreRuntime();
const isolatedBefore = isolatedB.handleApi('GET', '/api/app/me', {}, {}, { 'x-user': '1' }).json.card.balance;
isolatedA.handleApi('POST', '/api/app/topup', {}, { amount: 88, method: 'usdt' }, { 'x-user': '1' });
const isolatedAfter = isolatedB.handleApi('GET', '/api/app/me', {}, {}, { 'x-user': '1' }).json.card.balance;
check('不同 StateContainer 实例互不串数据', isolatedAfter === isolatedBefore, `${isolatedAfter} != ${isolatedBefore}`);

const production = createConfig({ APP_MODE: 'production' });
check('生产模式默认 session 且禁止 reset', production.authMode === 'session' && production.allowDemoReset === false, JSON.stringify(production));
let rejected = false;
try { createConfig({ APP_MODE: 'production', AUTH_MODE: 'demo-header' }); } catch { rejected = true; }
check('生产模式拒绝 demo-header', rejected);

const cors = corsHeaders(createConfig({ APP_MODE: 'production', CORS_ORIGINS: 'https://console.example.com' }), 'https://evil.example.com');
check('生产 CORS 不回显未授权 Origin', !('Access-Control-Allow-Origin' in cors), JSON.stringify(cors));

check('PC /app 分流', resolveStaticPath('/app', 'Mozilla/5.0') === '/app-pc.html');
check('Mobile /app 分流', resolveStaticPath('/app', 'Mozilla/5.0 iPhone') === '/app.html');
check('商户入口统一映射', resolveStaticPath('/merchant') === '/merchant.html');
check('数据控制台入口统一映射', resolveStaticPath('/data-console') === '/data-console.html');

console.log('\n== 内部快照 ==');
restoreOpsSeed('snapshot_test_seed');
const beforeMe = handleApi('GET', '/api/app/me', {}, {}, { 'x-user': '1' }).json;
const beforeBalance = beforeMe.card.balance;
const topup = handleApi('POST', '/api/app/topup', {}, { amount: 123, method: 'usdt' }, { 'x-user': '1' });
const changedMe = handleApi('GET', '/api/app/me', {}, {}, { 'x-user': '1' }).json;
const changedBalance = changedMe.card.balance;
check('快照测试充值改变余额', topup.status === 200 && changedBalance > beforeBalance, JSON.stringify({ topup, before: beforeBalance, after: changedBalance }));
const snapshot = exportInternalSnapshot();
check('内部快照带版本、checksum 和必要集合', snapshot.schemaVersion === 2 && snapshot.checksum && snapshot.data.users.length >= 1 && snapshot.data.ledgerEntries.length >= 1);
restoreOpsSeed('snapshot_test_reset');
importInternalSnapshot(snapshot);
const restoredMe = handleApi('GET', '/api/app/me', {}, {}, { 'x-user': '1' }).json;
check('内部快照可恢复业务状态', restoredMe.card.balance === changedBalance, `${restoredMe.card.balance} != ${changedBalance}`);
let badSnapshotRejected = false;
try { importInternalSnapshot({ schemaVersion: 999, data: {}, counters: {} }); } catch { badSnapshotRejected = true; }
check('拒绝未知快照版本', badSnapshotRejected);
let corruptSnapshotRejected = false;
const balanceBeforeCorruptImport = handleApi('GET', '/api/app/me', {}, {}, { 'x-user': '1' }).json.card.balance;
try { const corrupt = structuredClone(snapshot); corrupt.data.users[0].name = 'tampered'; importInternalSnapshot(corrupt); } catch { corruptSnapshotRejected = true; }
check('拒绝 checksum 不匹配的损坏快照', corruptSnapshotRejected);
check('损坏快照恢复失败不破坏当前状态', handleApi('GET', '/api/app/me', {}, {}, { 'x-user': '1' }).json.card.balance === balanceBeforeCorruptImport);
const legacySnapshot = structuredClone(snapshot);
legacySnapshot.schemaVersion = 1;
delete legacySnapshot.checksum;
let legacyAccepted = true;
try { importInternalSnapshot(legacySnapshot); } catch { legacyAccepted = false; }
check('兼容读取线上既有 schema v1 快照', legacyAccepted);
restoreOpsSeed('snapshot_test_cleanup');

const deterministicRuntime = createCoreRuntime();
deterministicRuntime.restoreOpsSeed('deterministic_first');
const deterministicFirst = deterministicRuntime.exportInternalSnapshot();
deterministicRuntime.handleApi('POST', '/api/app/topup', {}, { amount: 33, method: 'usdt' }, { 'x-user': '1' });
deterministicRuntime.restoreOpsSeed('deterministic_second');
const deterministicSecond = deterministicRuntime.exportInternalSnapshot();
check('重复恢复会重置随机种子与 ID 基线',
  deterministicFirst.data.users[0].phone === deterministicSecond.data.users[0].phone
  && deterministicFirst.data.cards[0].number === deterministicSecond.data.cards[0].number
  && deterministicFirst.data.transactions[0].id === deterministicSecond.data.transactions[0].id);

console.log('\n== Snapshot Repository ==');
const memoryRepository = new MemorySnapshotRepository();
check('Memory Repository 初始为空', await memoryRepository.load() === null);
await memoryRepository.save({ schemaVersion: 1, data: { marker: 'memory' } });
const memoryLoaded = await memoryRepository.load();
memoryLoaded.data.marker = 'mutated';
check('Memory Repository 保存隔离副本', (await memoryRepository.load()).data.marker === 'memory');
await memoryRepository.reset({ schemaVersion: 1, data: { marker: 'reset' } });
check('Memory Repository reset 与脱敏投影可用', (await memoryRepository.exportRedacted(s => ({ marker: s.data.marker }))).marker === 'reset');

const durableMemory = new Map();
const fakeState = {
  storage: {
    get: async (key) => durableMemory.get(key),
    put: async (key, value) => { durableMemory.set(key, structuredClone(value)); },
  },
  blockConcurrencyWhile: (fn) => fn(),
};
const durableRepository = new DurableSnapshotRepository(fakeState.storage);
await durableRepository.save({ schemaVersion: 1, data: { marker: 'durable' } });
check('Durable Repository 使用固定版本键', (await durableRepository.load()).data.marker === 'durable' && durableMemory.has(RUNTIME_SNAPSHOT_KEY));
durableMemory.clear();
const durableEnv = { APP_MODE: 'demo', AUTH_MODE: 'demo-header', ALLOW_DEMO_RESET: 'true', CORS_ORIGINS: '*', PERSISTENCE: 'durable' };
const durable1 = new AppState(fakeState, durableEnv);
let durableResponse = await durable1.fetch(new Request('http://do/api/app/topup', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-user': '1' }, body: JSON.stringify({ amount: 77, method: 'usdt' }),
}));
const durableTopup = await durableResponse.json();
check('DO 写操作成功并保存内部快照', durableResponse.status === 200 && durableTopup.balance > 0 && durableMemory.has('runtime-snapshot-v1'));
const durableBalance = durableTopup.balance;
restoreOpsSeed('durable_recycle_simulation');
const durable2 = new AppState(fakeState, durableEnv);
durableResponse = await durable2.fetch(new Request('http://do/api/app/me', { headers: { 'x-user': '1' } }));
const durableMe = await durableResponse.json();
check('DO 重建后从 storage 恢复最后余额', durableResponse.status === 200 && durableMe.card.balance === durableBalance, `${durableMe.card?.balance} != ${durableBalance}`);
const failingState = {
  storage: { get: async () => null, put: async () => { throw new Error('storage unavailable'); } },
  blockConcurrencyWhile: (fn) => fn(),
};
const failingDurable = new AppState(failingState, durableEnv);
const failingResponse = await failingDurable.fetch(new Request('http://do/api/app/me', { headers: { 'x-user': '1' } }));
check('Repository 写入失败不会返回业务成功', failingResponse.status === 500);
restoreOpsSeed('durable_test_cleanup');

console.log(`\n===== ARCH PASS ${pass} FAIL ${fail} =====`);
process.exit(fail ? 1 : 0);
