# U-Card 架构迁移状态

更新时间：2026-09-01（3.x 迁移收尾）

## 结论：迁移完成

- 全部公开 API 路径由新 Router 显式注册（185 个精确/前缀注册项），`core.js::handleApi` 及其 legacy fallback 已**物理删除**，未命中路径由 `src/app/create-app.js` 统一返回 404。
- API 契约基线 169 个字面路径（admin 135 / app 25 / merchant 6 / open 2 / other 1），SHA-256 见 `docs/api-contract-baseline.md`，历次基线变化均有变更记录。
- `core.js` 从约 5155 行收缩到约 3260 行，仅保留：运行时服务（tenant/ledger/risk/approval/orch/ent/...）、种子数据、内部快照导入导出、演示账号选择与卡片状态切换等供 Router/Service 调用的纯业务能力。
- UnitOfWork（快照基线 + 业务/持久化两阶段回滚）已接入 Durable Object 写路径。
- 前端四入口已抽取公共模块（`public/assets/`，UC 命名空间 + var 别名委托），270+ 调用点零改动。

## 完成口径

某个领域只有同时满足以下条件才计为“已迁移”（当前全部满足）：

1. 路径与 HTTP 方法由新 Router 显式注册。
2. 身份和权限来自 RequestContext/授权策略，不在业务代码读取请求头。
3. 业务入口由 runtime service 暴露，Router 不直接修改状态。
4. 新旧行为有契约或回归测试覆盖。
5. `core.js::handleApi` 中对应路径分支已删除。

## 领域清单（全部已迁移）

| 领域 | 说明 |
|---|---|
| Demo 运维恢复 / 身份入口 / 用户卡片状态 | 最早迁移的试点域；卡片自助动作为显式字面量注册（freeze/unfreeze/lost） |
| 多租户 / 开放平台 / 消息中心 / 系统管理 / 运维管理 | Router + Service 接管，旧分支批次 A 删除 |
| 用户端全部 / 商户门户 | Router/AppUserService/MerchantService 接管，旧分支批次 C 删除 |
| OpenAPI Mock | 已迁移，旧分支先行删除 |
| 运营后台基础 / CRM / 积分商城 / 账本 / 财务 / 合规 / BI / 商户后台侧 | Router/Service 接管，旧分支批次 B 删除 |
| 审批中心 / 风控引擎（规则版本化+快照回滚）/ 经典风控 / 支付编排 / 企业服务 | P4-P5 高风险域，含幂等键、账本平衡与回滚语义测试 |

## 基础设施进度

- [x] Demo/Production 配置边界
- [x] RequestContext 与 DemoAuth
- [x] Node/Worker 公共静态路由、CORS、安全响应头
- [x] 精确 Router；legacy fallback 已**删除**（test/no-fallback.mjs 双重守护：源码治理 + 185 路由匿名探测）
- [x] 每实例独立 CoreRuntime/StateContainer
- [x] Memory/Durable Repository
- [x] 内部快照 schema v2（createdAt、checksum、v1 兼容）
- [x] Durable Object 实例恢复和写失败保护
- [x] 统一 UnitOfWork/快照回滚（test/unit-of-work.mjs：高风险写入 5 类 + 回滚/重试/实例回收）
- [ ] 领域 Repository/Port（后续按需拆分）
- [x] 前端公共模块（assets 七件套 + handler-check 回归）
- [x] GitHub Actions 语法、架构、契约、核心与 HTTP smoke 门禁
- [ ] 完整浏览器套件（当前以 handler-check + HTTP 冒烟代理覆盖）

## 质量门禁

`npm run test:all` = check（79 源文件）→ arch（45）→ contract（169 不变）→ core（192）→ no-fallback → UOW（17）→ handlers（264 事件函数）→ HTTP 冒烟（25 + 25）。

新增/删除/重命名公开路径时：先更新 `test/api-contract.mjs` 基线与 `docs/api-contract-baseline.md` 变更记录，不得为通过测试直接改哈希。

## 后续方向（非迁移阻塞项）

1. 领域级 Repository/Port 拆分，替代整库快照粒度。
2. 真实浏览器 E2E（当前无浏览器环境，以零漂移委托 + handler-check 兜底）。
3. 生产身份适配（DemoAuth 之外的真实认证源）。
