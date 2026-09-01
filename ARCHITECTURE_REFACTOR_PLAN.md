# U-Card 3.x 渐进式架构治理计划

> 适用仓库：`D:\Project\demos\ucard-demo`  
> 当前基线：3.0 功能 Demo，约 161 个字面 API 路径，`core.js` 约 4852 行，`admin.html` 约 7031 行。  
> 核心原则：先冻结可展示版本，再建立兼容层，最后逐域迁移；任何阶段都不得破坏现有演示入口、接口路径和种子数据闭环。

## 当前执行进度（2026-09-01，迁移完成）

- **3.x 迁移已收尾**：全部公开路径由新 Router 显式注册（185 个注册项），`core.js::handleApi` 与 legacy fallback 已物理删除，未命中路径统一 404（`test/no-fallback.mjs` 源码治理 + 全路由匿名探测双重守护）。
- API 契约基线 169 个字面路径（治理起点 161，历次变化均有 `docs/api-contract-baseline.md` 变更记录）；核心回归 192 PASS、HTTP 演示线路 50 PASS 保持不变。
- `core.js` 从约 5155 行收缩到约 3260 行，仅保留运行时服务、种子与快照导入导出等纯业务能力。
- 已建立统一 `createApp`、请求上下文、显式 Demo/Production 配置、鉴权和精确 Router 边界；Node/Worker 静态路由、CORS、安全响应头和 requestId 已统一。
- 已实现版本化内部快照（schema v2，兼容线上 v1）与 Durable Object 持久化；storage 收口到 `DurableSnapshotRepository`/`MemorySnapshotRepository`。
- UnitOfWork（快照基线 + 业务/持久化两阶段回滚）已接入 DO 写路径，高风险写入（充值/退款/调账/结算/企业账单）与回滚、实例回收均有测试（`test/unit-of-work.mjs`）。
- 前端四入口已抽取公共模块（`public/assets/` 七件套，UC 命名空间 + var 别名委托，270+ 调用点零改动），`test/handler-check.mjs` 守护全部事件处理函数可解析。
- 迁移结论与领域清单见 `docs/migration-status.md`。

## 1. 目标与边界

### 1.1 本轮目标

1. 保留现有 3.0 Demo 的四个入口与全部演示动线：
   - `/`：运营后台
   - `/app`：用户端 H5/PC
   - `/merchant`：商户端门户
   - `/data-console`：数据恢复控制台
2. 将请求头模拟身份、纯内存状态和超长路由从“隐含实现”变为可替换适配器。
3. 将 Node 与 Cloudflare Worker 的公共行为统一，避免路由、CORS、错误响应漂移。
4. 在不一次性重写 161 个接口的前提下，逐步拆分 `core.js`。
5. 建立单元、HTTP、真实浏览器三层测试，冻结关键业务闭环。
6. 为后续 SQLite/D1/PostgreSQL、真实 Session/JWT 和 Durable Object 持久化留下明确接口。

### 1.2 本轮不做

- 不把前端一次性重写为 React/Vue。
- 不一次性迁移全部 API。
- 不在同一个 commit 同时修改鉴权、持久化、路由和 UI。
- 不改变现有接口路径、主要返回结构、演示账号选择方式和种子数据口径。
- 不把当前“种子恢复”包装成生产灾备；生产灾备必须单独建设。
- 不在 Claude 或其他 Agent 仍修改相同文件时开始大规模拆分。

## 2. 当前架构事实

### 2.1 运行结构

```text
浏览器静态页面
  ├─ admin.html
  ├─ app.html / app-pc.html
  ├─ merchant.html
  └─ data-console.html
          │
          ▼
Node server.js 或 Cloudflare worker.js
          │
          ▼
core.js::handleApi(method, path, query, body, headers)
          │
          ▼
模块级数组 / Map / 计数器
```

### 2.2 已确认的问题

| 等级 | 问题 | 当前证据 | 影响 |
|---|---|---|---|
| P0 | 身份由 `x-sales/x-user/x-mch` 直接决定 | `core.js` 的 `scopeOf`、用户端和商户端分支 | 可任意模拟身份，仅适合 Demo |
| P0 | 后台未传身份时默认总监 | `scopeOf()` 中空值回退到 `sid=1` | 未认证请求可获得后台全量范围 |
| P0 | DO 未使用 `state.storage` | `do.js` 构造函数忽略 `state` | 实例回收后状态重建，不是真持久化 |
| P0 | 数据恢复只重建种子 | `opsDataState()` 明确 `persistence:none` | 不能恢复现场快照 |
| P1 | 后端大单体 | `core.js` 约 4852 行、约 161 个字面 API 路径 | 修改面大、回归成本高 |
| P1 | 前端大文件与重复基础函数 | `admin.html` 约 7031 行 | UI 修复容易多端不一致 |
| P1 | Node/Worker 壳层重复 | `server.js`、`worker.js` 分别维护路由/CORS | 本地与线上可能漂移 |
| P1 | CORS 为 `*` | 两个运行壳层均开放自定义身份头 | 与真实 Cookie/Token 鉴权不兼容 |
| P1 | 回归以直接调用 `handleApi` 为主 | `test/regress.mjs` | 无法覆盖真实 HTTP、静态路由和浏览器错误 |

### 2.3 必须保留的优点

- `server.js` 与 Worker 共用同一个业务核心，已有跨运行时基础。
- 复式账本已经有平衡校验，必须作为强制质量门禁。
- 风控、审批、支付编排、企业卡、商户、BI 等功能已经形成完整演示链路。
- 种子初始化确定性较好，适合快照回归。
- 当前回归测试可作为重构期间的行为契约。

## 3. 目标架构

采用“绞杀者模式”：保留 `legacy-core` 作为兜底，新路由逐域迁移，不进行一次性重写。

```text
src/
├─ app/
│  ├─ create-app.js             # 组装 config/auth/store/router
│  └─ request-context.js        # requestId、actor、tenant、mode
├─ api/
│  ├─ router.js                 # 路由注册与 dispatch
│  ├─ response.js               # 统一成功/错误格式
│  ├─ validators.js             # 轻量参数校验
│  └─ routes/
│     ├─ ops-routes.js
│     ├─ app-routes.js
│     ├─ card-routes.js
│     ├─ merchant-routes.js
│     └─ legacy-routes.js       # 未迁移接口回退到旧 handleApi
├─ auth/
│  ├─ demo-auth.js              # 兼容请求头选账号
│  ├─ session-auth.js           # 后续真实认证
│  └─ authorize.js              # RBAC + 数据范围
├─ domain/
│  ├─ card/
│  ├─ payment/
│  ├─ ledger/
│  ├─ points/
│  ├─ risk/
│  ├─ merchant/
│  └─ restore/
├─ state/
│  ├─ state-container.js        # 统一持有运行状态
│  ├─ snapshot-codec.js         # Map/计数器/数组序列化
│  └─ seed.js                   # 生成初始状态
├─ repositories/
│  ├─ memory-repository.js
│  ├─ durable-repository.js
│  └─ file-repository.js        # 仅本地可选
├─ runtime/
│  ├─ node-adapter.js
│  └─ worker-adapter.js
└─ legacy/
   └─ core.js                   # 迁移期间保留
```

前端暂不引入大型框架，先抽公共资产：

```text
public/assets/
├─ api.js
├─ demo-auth.js
├─ format.js
├─ feedback.js
├─ modal.js
├─ tokens.css
└─ common.css
```

## 4. 执行总原则

1. 每个阶段开始前确认 `git status`，不得覆盖未知改动。
2. 先提交当前两个 smoke 测试或确认其归属，工作区干净后再重构。
3. 每个 commit 只做一种结构变化，并保持全部旧接口可用。
4. 先增加兼容层，再迁移业务；禁止先删除旧实现。
5. 新实现必须通过同一套契约测试后才切流。
6. 任何阶段失败，应能通过 revert 当前单个 commit 恢复。
7. Demo 模式继续支持免密选账号，但必须通过显式配置开启。
8. 生产模式默认拒绝请求头模拟身份。
9. 所有金额继续按分或现有两位小数规则处理，账本借贷恒等必须保持。
10. 数据恢复、批量调账、密钥操作必须有独立权限和审计事件。

## 5. 分阶段实施计划

## Phase A：冻结 3.0 稳定基线

目标：形成可随时回退、可比较的演示基线，不改业务行为。

### A1. 清理协作状态

- 检查 Claude/其他 Agent 是否还在修改仓库。
- 处理 `test/route1-smoke.mjs` 和 `test/routes-cross-smoke.mjs`：
  - 如果测试有效，运行后提交。
  - 如果仍在生成，等待写入完成。
  - 不允许直接删除。
- 确保 `main` 与 `origin/main` 同步。

验收：

```text
git status --short 为空
node test/regress.mjs => 0 FAIL
两个 HTTP smoke 测试均通过
```

### A2. 增加基线命令

在 `package.json` 增加：

```json
{
  "scripts": {
    "check": "node --check core.js && node --check server.js && node --check worker.js && node --check do.js",
    "test:core": "node test/regress.mjs",
    "test:http:user": "node test/route1-smoke.mjs",
    "test:http:cross": "node test/routes-cross-smoke.mjs",
    "test:all": "npm run check && npm run test:core && npm run test:http:user && npm run test:http:cross"
  }
}
```

说明：HTTP 测试需要本地服务，脚本应清晰提示依赖，不要静默失败。

### A3. 固化接口清单

- 生成 `docs/api-contract-baseline.md`。
- 按 `admin/app/mch/open/demo` 分类记录方法、路径、身份和预期状态码。
- 固化四个入口及设备分流行为。
- 记录当前种子集合数量和账本校验摘要。

验收：基线文档覆盖当前约 161 个字面接口路径；重构后以此做差异审查。

建议 commits：

```text
test: commit end-to-end route smoke coverage
chore: add repeatable architecture baseline checks
docs: freeze 3.0 API and demo behavior baseline
```

## Phase B：建立配置、请求上下文和鉴权边界

目标：先隔离风险最高的身份逻辑，但保留 Demo 免密体验。

### B1. 新增运行配置

新增 `src/config.js`：

```text
APP_MODE=demo|production
AUTH_MODE=demo-header|session
PERSISTENCE=memory|durable|file
CORS_ORIGINS=...
ALLOW_DEMO_RESET=true|false
```

默认规则：

- 本地开发可显式使用 `APP_MODE=demo`。
- 正式部署若未配置，不得默认启用请求头身份模拟。
- `/api/demo/reset` 和恢复控制台只能在允许的 Demo 环境开启。

### B2. 新增 RequestContext

统一生成：

```js
{
  requestId,
  mode,
  actor: { type, id, roles },
  tenantId,
  ip,
  userAgent,
  startedAt
}
```

`server.js`、`do.js` 只负责把原始请求转换成上下文，不再让业务函数直接读取任意 headers。

### B3. 抽出 DemoAuthAdapter

- 将 `x-sales/x-user/x-mch/x-app-key` 解析集中到 `demo-auth.js`。
- 修复后台空身份默认总监的问题：
  - Demo 页面通过账号选择明确发送身份。
  - 无身份访问后台业务接口返回 401。
  - 仅账号选择列表可匿名访问。
- 保持现有前端账号选择流程不变。

### B4. 授权策略

建立明确能力：

```text
admin.read
admin.write
ops.restore
ops.backup
ledger.adjust
risk.review
merchant.refund
app.self
```

先映射现有角色，不需要立即实现完整 IAM。数据范围仍沿用销售子树，但由 `authorize()` 返回 scope。

验收：

- 无身份访问后台数据、备份和恢复均为 401。
- 普通销售无法恢复数据、结算佣金或全局调账。
- 用户只能访问自己的卡、订单、积分和通知。
- 商户只能访问自己的订单、退款和结算。
- Demo 选账号流程仍然流畅。

建议 commits：

```text
refactor: add explicit runtime configuration
refactor(auth): centralize demo identity resolution
fix(auth): reject implicit director access without identity
feat(auth): add capability authorization for destructive actions
```

## Phase C：统一路由与运行壳层

目标：消除 Node/Worker 行为漂移，并为逐域迁移准备 router。

### C1. 提取静态入口映射

建立单一配置：

```js
{
  '/': '/admin.html',
  '/admin': '/admin.html',
  '/merchant': '/merchant.html',
  '/data-console': '/data-console.html',
  '/restore-console': '/data-console.html'
}
```

`/app` 的设备分流也由公共函数处理，Node 与 Worker 共用测试。

### C2. 统一 HTTP 响应

新增：

- `json(data, status)`
- `problem(code, message, status, details)`
- request ID 响应头
- 安全响应头
- CORS allowlist

为了兼容现有前端，第一阶段错误 JSON 继续保留 `error` 字段，同时增加 `code` 和 `requestId`。

### C3. 引入 Router + Legacy fallback

```text
新 router 命中 → 新 handler
未命中 → legacy handleApi
```

首批只迁移低风险接口：

1. `/api/admin/ops/data-state`
2. `/api/admin/ops/backup`
3. `/api/admin/ops/restore`
4. `/api/app/users`
5. `/api/mch/merchants`

这些接口迁移完成后，旧路由仍保留一段时间，通过契约测试比较新旧结果。

验收：Node 和 Worker 对同一路径、方法、身份、状态码和主要 JSON 字段一致。

建议 commits：

```text
refactor(runtime): share static route mapping across node and worker
refactor(api): add response helpers and request ids
refactor(api): introduce router with legacy fallback
refactor(ops): migrate data console routes to router
```

## Phase D：建立 StateContainer、快照和真实可恢复边界

目标：先把全局状态集中，再谈数据库；不直接把 40 多个集合同时改成 SQL。

### D1. StateContainer

建立一个显式状态对象，至少包含：

```text
users/cards/transactions
pointsLogs/commissions
ledgerAccounts/ledgerEntries/frozenBalances
risk/approval/orchestration
enterprise/merchant
system/ops
counters/maps/seed metadata
```

迁移策略：

1. 先让 `initSeed()` 返回完整状态对象。
2. 旧函数通过兼容 getter 访问状态。
3. 每迁移一个领域，就取消该领域的模块级变量。
4. 最后删除全局数组。

### D2. SnapshotCodec

快照必须覆盖：

- 数组和普通对象
- `Map`（例如限流桶）
- `idSeq`、随机种子、恢复次数
- schema version
- checksum
- createdAt

必须区分：

```text
脱敏导出：给演示审查人员下载，不可回灌
内部快照：完整状态，仅受控存储，可用于恢复
```

### D3. MemoryRepository

实现统一接口：

```js
load()
save(snapshot)
reset(seed)
exportRedacted()
health()
```

现有 Node 模式先接 `MemoryRepository`，行为保持一致。

### D4. DurableRepository

- `AppState` 保存 `state` 引用。
- 使用 `blockConcurrencyWhile()` 首次载入快照。
- 非 GET 或明确发生状态变化后写入 `state.storage`。
- 使用 schema version 支持迁移。
- 写入失败时不得返回“成功但未保存”。

注意：整包快照适合当前 Demo 规模，不是最终生产数据库方案。数据规模变大后再迁 D1/PostgreSQL。

### D5. 本地可选持久化

如需要本地重启不丢数据，可增加 `FileRepository`：

- 默认关闭。
- 只允许写入仓库内明确的 `var/` 目录。
- 临时文件写完后原子替换。
- `var/` 加入 `.gitignore`。
- 数据控制台展示当前 repository 类型。

验收：

- 内存模式重启重建种子。
- Durable 模式实例回收后可恢复最后状态。
- 内部快照可以恢复，脱敏导出不能误用为内部快照。
- 恢复失败不会破坏当前可用状态。
- 恢复动作生成审计日志。

建议 commits：

```text
refactor(state): introduce explicit state container
feat(state): add versioned snapshot codec
refactor(store): route demo state through memory repository
feat(worker): persist demo snapshot in durable object storage
feat(ops): separate redacted export from internal restore snapshot
```

## Phase E：逐域拆分 core.js

目标：按风险从低到高迁移，每次只迁一个领域。

### 迁移顺序

1. `ops`：状态、备份、恢复、Feature Flag、监控。
2. `open-platform`：Mock API、应用、密钥、调用日志。
3. `notification`：模板、渠道、发送记录。
4. `system`：账号、角色、字典、参数、日志。
5. `merchant`：商户、订单、退款、结算。
6. `enterprise`：企业、部门、企业卡、审批。
7. `risk`：规则、评分、命中、处置。
8. `approval`：流程实例与业务联动。
9. `points/mall`：积分、任务、商品、兑换、订单。
10. `card/payment`：卡状态、充值、消费、退款。
11. `ledger`：最后迁移，必须保持所有恒等检查。

### 每个领域的固定步骤

1. 写当前行为契约测试。
2. 抽 serializer/view model。
3. 抽 service，不改变接口。
4. 抽 repository 查询/写入。
5. 新 router 接管该领域。
6. 对比新旧结果。
7. 删除旧分支。
8. 单独 commit。

### 资金领域额外门禁

- 充值、消费、退款、调账、佣金结算必须有幂等键。
- 余额变更、业务单和账本分录在同一事务边界内。
- 金额禁止直接使用任意浮点累加；保留现有量化规则，后续迁移为整数分。
- 每次写操作后可运行账本恒等校验。
- 卡状态机必须显式定义：

```text
active → frozen → active
active/frozen → lost
lost → replacement_pending → replaced
```

禁止通过通用 PATCH 任意修改状态。

## Phase F：前端基础设施拆分

目标：保留原生 HTML/JS，降低重复代码和多端漂移。

### F1. 先抽无业务风险模块

- `format.js`：金额、日期、卡号掩码。
- `feedback.js`：toast、错误提示、loading。
- `api.js`：请求、错误码、requestId、超时。
- `demo-auth.js`：账号选择和身份存储。
- `tokens.css`：颜色、间距、圆角、阴影。

### F2. 页面拆分原则

- 不一次性拆 `admin.html`。
- 先提取公共函数和样式，再按菜单页面拆渲染模块。
- H5 与 PC 共用 API 和领域数据转换，不强行共用布局。
- 每次抽取后截图对比，避免视觉回归。

### F3. 错误体验

所有页面统一处理：

- 401：回到账号选择页。
- 403：展示无权限，不伪装 404。
- 409：展示业务状态冲突。
- 429：展示重试时间。
- 5xx：展示 requestId 便于定位。

建议 commits：

```text
refactor(frontend): extract shared api and formatting utilities
refactor(frontend): centralize demo identity handling
refactor(frontend): extract feedback and modal primitives
refactor(admin): move one navigation domain at a time
```

## Phase G：测试、CI 与上线门禁

### G1. 三层测试

```text
test/unit/       领域函数、状态机、金额和规则
test/http/       真实 Node 服务、CORS、方法、状态码
test/browser/    Playwright 真实页面与交互
```

### G2. 浏览器关键流程

至少覆盖：

1. 后台账号选择、退出和数据范围。
2. 驾驶舱、客户列表、筛选、分页、弹窗。
3. 卡片冻结→解冻。
4. 挂失→后台补卡/恢复流程。
5. 充值→消费→积分→佣金→账本。
6. 风控命中→处置→卡状态变化。
7. 审批提交→通过/驳回→业务联动。
8. 商户退款申请→后台审核→账本反向流水。
9. 数据快照→修改数据→恢复→状态回到快照。
10. PC/H5 宽度、刷新、返回和错误提示。

### G3. 每个 commit 的最低检查

```text
node --check
核心回归 0 FAIL
HTTP smoke 0 FAIL
账本 balanced=true
无新增未处理 console error
无新增未处理 4xx/5xx
```

### G4. 发布门禁

- `main` 工作区干净。
- 本地与 Worker 契约测试一致。
- 四个入口 200。
- 关键写流程完成后刷新仍一致。
- 数据恢复操作需要权限、口令、二次确认和审计。
- 发布后再跑线上只读 smoke；不要在线上自动执行破坏性恢复。

## 6. 推荐版本节奏

| 版本 | 内容 | 是否改变演示业务 |
|---|---|---|
| 3.0-stable | 固化当前功能与 smoke 测试 | 否 |
| 3.1 | Config、RequestContext、DemoAuth、CORS、Router fallback | 仅修复未鉴权访问 |
| 3.2 | StateContainer、MemoryRepository、版本化快照 | 否 |
| 3.3 | Durable Object 持久化、内部快照恢复 | 数据可持续 |
| 3.4 | ops/open/system/merchant 等低风险领域拆分 | 否 |
| 3.5 | card/payment/ledger 高风险领域拆分 | 否，内部重构 |
| 4.0 | 真实 Session、数据库、生产级部署与密钥体系 | 是，进入生产化路线 |

## 7. Claude 执行指令

Claude 应按以下规则执行：

1. 先读取本文件、`CLAUDE_IMPLEMENTATION_PLAN.md`、`README.md` 和当前测试。
2. 先检查是否有其他进程修改仓库；发现并发写入时停止写操作并报告冲突文件。
3. 从 Phase A 开始，不得跳过基线冻结。
4. 每次只完成一个小节，测试通过后提交清晰 commit。
5. 不得制造空提交，不得覆盖未知未提交文件。
6. 不得一次性重写 `core.js` 或 `admin.html`。
7. 新架构先走兼容层，旧接口和响应保持可用。
8. 每个阶段记录：修改文件、迁移接口、测试结果、已知风险、下一步。
9. 只有实际修复并验证后才 push 到 `origin/main`。
10. Phase B、D、E 的高风险切换点必须保留可单 commit revert 的回退路径。

推荐首轮只执行：

```text
Phase A 全部
Phase B1-B3
Phase C1-C3 的基础设施与 ops 首批路由
```

首轮不要开始账本、支付和卡片领域迁移。首轮完成后应重新审查，再决定是否进入 Phase D。

## 8. 最终完成定义

架构治理不是以“文件变多”为完成，而是满足以下结果：

- Demo 模式和生产模式边界清晰。
- 未认证请求不能默认成为总监。
- 身份、授权、数据范围不再散落在路由中。
- Node 与 Worker 的入口和错误行为一致。
- 业务状态由显式 StateContainer/Repository 管理。
- Durable Object 真正使用持久化存储。
- 内部快照可恢复，脱敏导出只用于审查。
- `core.js` 只剩兼容入口或被逐域替代。
- 三层测试覆盖关键闭环。
- 每个阶段可回滚，现有展示动线持续可用。
