# U-Card 架构迁移状态

更新时间：2026-09-01

## 完成口径

某个领域只有同时满足以下条件才计为“已迁移”：

1. 路径与 HTTP 方法由新 Router 显式注册。
2. 身份和权限来自 RequestContext/授权策略，不在业务代码读取请求头。
3. 业务入口由 runtime service 暴露，Router 不直接修改状态。
4. 新旧行为有契约或回归测试覆盖。
5. `core.js::handleApi` 中对应路径分支已删除。

## 当前路由进度

| 领域 | 总路径 | 新 Router | Legacy | 状态 |
|---|---:|---:|---:|---|
| Demo 运维恢复 | 4 | 4 | 0 | 已迁移 |
| Demo 身份入口 | 3 | 3 | 0 | 已迁移 |
| 用户卡片状态 | 3 | 3 | 0 | 已迁移，待删除 core 兼容分支 |
| 多租户管理 | 2 | 2 | 0 | 已迁移，core 分支已删除 |
| 后台开放平台 | 7 | 7 | 0 | 新 Router/Service 已接管，待统一清理兼容分支 |
| 后台消息中心 | 6 | 6 | 0 | 新 Router/Service 已接管，待统一清理兼容分支 |
| 系统管理 | 11 | 11 | 0 | 新 Router/Service 已接管，待统一清理兼容分支 |
| 运维管理 | 约 15 | 约 15 | 0 | Router/Service 已覆盖状态、恢复、Flag、限流、监控与 Trace |
| 用户端其他 | 21 | 0 | 21 | 待迁移 |
| 商户门户 | 6 | 0 | 6 | 待迁移 |
| OpenAPI Mock | 10 | 0 | 10 | 待迁移 |
| 运营后台 | 约 114 | 0 | 约 114 | 待按领域迁移 |

Router 当前包含 44 个精确/前缀注册项，覆盖约 51 个字面或动态业务端点。API 契约基线仍为 161 个字面路径。

## 基础设施进度

- [x] Demo/Production 配置边界
- [x] RequestContext 与 DemoAuth
- [x] Node/Worker 公共静态路由、CORS、安全响应头
- [x] 精确 Router 与 legacy fallback
- [x] 每实例独立 CoreRuntime/StateContainer
- [x] Memory/Durable Repository
- [x] 内部快照 schema、createdAt、checksum、v1 向后兼容
- [x] Durable Object 实例恢复和写失败保护
- [ ] 统一 UnitOfWork/快照回滚
- [ ] 领域 Repository/Port
- [ ] 清空 legacy fallback
- [ ] 前端公共模块
- [ ] CI 与完整浏览器套件

## 后续顺序

1. 低耦合：admin tenants/open/notify/system/ops。
2. 用户与商户只读查询。
3. CRM、积分、商城等一般写服务。
4. 账本写入端口、充值、消费、退款和佣金。
5. 风控、审批、编排、合规、企业与商户后台。
6. BI/监控等跨域读模型。
7. 删除最后 legacy 分支并拆前端公共模块。
