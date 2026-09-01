// UnitOfWork / 回滚与高风险写入测试(交接文档 §5.4)
// 覆盖: 充值、消费、退款、调账、商户结算、企业账单等高风险写操作,
// 以及业务失败 / 持久化失败时的内存状态整体回滚。
import { createCoreRuntime, restoreOpsSeed } from '../core.js';
import { createUnitOfWork } from '../src/domain/shared/unit-of-work.js';
import { AppState } from '../do.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.error('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
};
const ADMIN = { 'x-sales': '1' };
const APP = { 'x-user': '1' };

const env = { APP_MODE: 'demo', AUTH_MODE: 'demo-header', ALLOW_DEMO_RESET: 'true', CORS_ORIGINS: '*', PERSISTENCE: 'durable' };
const makeState = () => {
  const storage = new Map();
  return {
    storage: {
      get: async (key) => storage.get(key),
      put: async (key, value) => { storage.set(key, structuredClone(value)); },
    },
    blockConcurrencyWhile: (fn) => fn(),
    raw: storage,
  };
};
const post = (doApp, path, body = {}, headers = ADMIN) => doApp.fetch(new Request('http://do' + path, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
}));
const get = (doApp, path, headers = ADMIN) => doApp.fetch(new Request('http://do' + path, { headers }));

console.log('\n== UnitOfWork 基础语义 ==');
restoreOpsSeed('uow_test_seed');
const core = createCoreRuntime();
const uow = createUnitOfWork({ exportSnapshot: () => core.exportInternalSnapshot(), importSnapshot: (s) => core.importInternalSnapshot(s) });
const snapshotFingerprint = (s) => JSON.stringify({ users: s.data.users, cards: s.data.cards, ledgerEntries: s.data.ledgerEntries, counters: s.counters });

// 1. 业务失败(抛错)→ 整体回滚
let baseline = core.exportInternalSnapshot();
let outcome = await uow.run(async () => { throw new Error('业务中途失败'); }, async () => {});
check('业务抛错时不提交', outcome.committed === false && outcome.stage === 'business');
check('业务抛错后内存状态与基线完全一致', snapshotFingerprint(core.exportInternalSnapshot()) === snapshotFingerprint(baseline));

// 2. 持久化失败 → 整体回滚
outcome = await uow.run(async () => ({ status: 200, json: { ok: true } }), async () => { throw new Error('storage unavailable'); });
check('持久化失败时不提交', outcome.committed === false && outcome.stage === 'persist');
check('持久化失败后内存状态与基线完全一致', snapshotFingerprint(core.exportInternalSnapshot()) === snapshotFingerprint(baseline));

// 3. 业务 5xx → 回滚; 4xx 业务拒绝 → 正常提交(不回滚)
outcome = await uow.run(async () => ({ status: 502, json: { error: 'bad gateway' } }), async () => {});
check('业务 5xx 视为失败回滚', outcome.committed === false);
outcome = await uow.run(async () => ({ status: 400, json: { error: '参数不合法' } }), async () => {});
check('业务 4xx 拒绝正常提交不回滚', outcome.committed === true);

console.log('\n== DO 写路径走 UnitOfWork ==');
// 4. 高风险写操作 happy path: 充值 → 消费 → 退款 → 调账 → 商户结算 → 企业账单
const healthy = new AppState(makeState(), env);
await get(healthy, '/api/app/me', APP); // 触发种子落盘
const before = await (await get(healthy, '/api/app/me', APP)).json();
let r = await post(healthy, '/api/app/topup', { amount: 120, method: 'usdt' }, APP);
const topupJson = await r.json();
check('充值提交成功', r.status === 200 && (topupJson.tx?.amount === 120 || topupJson.balance > before.card.balance), JSON.stringify(topupJson).slice(0, 100));
r = await post(healthy, '/api/app/pay', { amount: 30, merchant: 'Starbucks' }, APP);
check('消费提交成功', r.status === 200, JSON.stringify(await r.json()).slice(0, 100));
const txs = await (await get(healthy, '/api/app/transactions', APP)).json();
const consumeTx = Array.isArray(txs) ? txs.find(t => t.type === 'consume') : null;
if (consumeTx) {
  r = await post(healthy, '/api/admin/refund', { txId: consumeTx.id }, ADMIN);
  check('后台退款提交成功', r.status === 200, JSON.stringify(await r.json()).slice(0, 100));
} else check('后台退款提交成功(取消费单)', false, '未找到消费流水');
const cards = await (await get(healthy, '/api/admin/cards', ADMIN)).json();
const activeCard = Array.isArray(cards) ? cards.find(c => c.status === 'active') : null;
if (activeCard) {
  r = await healthy.fetch(new Request(`http://do/api/admin/cards/${activeCard.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', ...ADMIN }, body: JSON.stringify({ action: 'adjust', amount: 5 }),
  }));
  check('调账提交成功', r.status === 200, JSON.stringify(await r.json()).slice(0, 100));
} else check('调账提交成功(有活动卡)', false, '无活动卡');
const settles = await (await get(healthy, '/api/admin/mch/settles', ADMIN)).json();
const pendingSettle = settles.list?.find(s => s.status === 'pending');
if (pendingSettle) {
  r = await post(healthy, `/api/admin/mch/settles/${pendingSettle.id}/settle`, {}, ADMIN);
  check('商户结算提交成功', r.status === 200, JSON.stringify(await r.json()).slice(0, 100));
} else check('商户结算提交成功(有待结算批次)', false, '无待结算批次');
const bills = await (await get(healthy, '/api/admin/ent/bills', ADMIN)).json();
const openBill = bills.list?.find(b => b.status === 'pending');
if (openBill) {
  r = await post(healthy, `/api/admin/ent/bills/${openBill.id}/pay`, {}, ADMIN);
  check('企业账单支付提交成功', r.status === 200, JSON.stringify(await r.json()).slice(0, 100));
} else check('企业账单支付提交成功(有待支付账单)', false, '无待支付账单');
const verify = await (await get(healthy, '/api/admin/ledger/verify', ADMIN)).json();
check('全部高风险写操作后账本仍借贷平衡', verify.balanced === true, JSON.stringify(verify).slice(0, 120));

// 5. 持久化失败: 写请求返回 500 且内存回滚到请求前快照
const failingState = makeState();
let putShouldFail = false;
const originalPut = failingState.storage.put;
failingState.storage.put = async (key, value) => { if (putShouldFail) throw new Error('storage unavailable'); return originalPut(key, value); };
const fragile = new AppState(failingState, env);
await get(fragile, '/api/app/me', APP);
const beforeFail = fragile.core.exportInternalSnapshot();
putShouldFail = true;
r = await post(fragile, '/api/app/topup', { amount: 66, method: 'usdt' }, APP);
check('持久化失败时写请求返回 500', r.status === 500, String(r.status));
check('持久化失败后内存回滚到请求前状态', snapshotFingerprint(fragile.core.exportInternalSnapshot()) === snapshotFingerprint(beforeFail));
putShouldFail = false;
r = await post(fragile, '/api/app/topup', { amount: 66, method: 'usdt' }, APP);
check('存储恢复后同一写操作可重试成功', r.status === 200, String(r.status));

// 6. DO 回收后从 storage 恢复最后提交状态(不含被回滚的写入)
const recycled = new AppState({ storage: failingState.storage, blockConcurrencyWhile: (fn) => fn() }, env);
const recycledMe = await (await get(recycled, '/api/app/me', APP)).json();
check('DO 回收后恢复最后成功提交的余额', recycledMe.card.balance === (await (await get(fragile, '/api/app/me', APP)).json()).card.balance);

console.log(`\n===== UOW PASS ${pass} FAIL ${fail} =====`);
process.exit(fail ? 1 : 0);
