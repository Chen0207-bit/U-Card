# U-Card 3.0 API 与入口基线

本文件冻结架构治理前的公开行为。内部模块可以逐步重构，但除非经过显式评审，不得改变这些入口、身份模式和 API 字面路径集合。

## 页面入口

| 路径 | 行为 |
|---|---|
| `/`、`/admin` | 运营后台/销售工作台 |
| `/app` | 按 User-Agent 分流 H5 或 PC 用户端 |
| `/app/m`、`/app/mobile` | 强制 H5 |
| `/app/pc` | 强制 PC |
| `/app/select` | 用户端形态选择 |
| `/merchant` | 商户端门户 |
| `/data-console`、`/restore-console` | 数据恢复控制台 |

## API 路径集合

从 `core.js` 与 `src/api/*.js`（不含 `src/api/staging/`）字面路径提取，排序后以换行连接：

```text
总计：176
admin：139
app：25
merchant：7
open：2
other：3
SHA-256：8c65f69522bda0977b51e6d7248018f3287a1ef44a7b2684aabc7fab3e0e5597
```

### 基线变更记录

- **42534be（冻结）→ 173（1a670b9 前）**：3.x 迁移期间 Router 接管动态路由时引入了带尾斜杠的**前缀注册字面量**（如 `/api/admin/customers/`），对应旧 `core.js` 正则匹配的既有端点，未新增公开能力；另在 P4.3 风控规则引擎迁移时**有意新增**两个端点：`POST /api/admin/risk-engine/versions/publish`（手动发布当前策略）与 `POST /api/admin/risk-engine/versions/{ver}/rollback`（回滚到含快照的版本，旧版本无 `rulesSnapshot` 时返回 409 防伪造）。净增 12 条：161 → 173（admin 124 → 136）。
- **173 → 176（P5.1 支付编排接入）**：`src/api/payment-orchestration-routes.js` 从 staging 移入后，其 4 个前缀注册中的 3 个带尾斜杠字面量 `/api/admin/orch/adapters/`、`/api/admin/orch/tx/`、`/api/admin/orch/diff/` 进入扫描（旧 `core.js` 以正则字面量匹配同样端点，不被扫描）；9 个精确路径全部为既有端点，未新增公开能力。173 → 176（admin 136 → 139）。

`node test/api-contract.mjs` 会检查该集合。新增、删除或重命名路径时必须先审查兼容性，再更新基线，不能为了让测试通过而直接修改哈希。

## 当前身份契约

3.0 Demo 使用以下请求头选账号：

| 场景 | 请求头 | 匿名入口 |
|---|---|---|
| 运营后台 | `x-sales` | `/api/admin/accounts` |
| 用户端 | `x-user` | `/api/app/users` |
| 商户端 | `x-mch` | `/api/mch/merchants` |
| 开放平台 | `x-app-key` | 无 |

架构治理后仍允许 Demo 模式使用这些请求头，但必须由 `DemoAuthAdapter` 统一解析；生产模式不得直接信任它们。无身份请求不得隐式获得总监权限。

## 强制业务契约

- 冻结卡不可充值或消费，冻结卡可以自助解冻。
- 挂失卡不可自助恢复为 active。
- 充值、消费、退款和调账后账本保持借贷平衡。
- 用户只能操作自己的卡、积分和订单。
- 商户只能操作自己的订单、退款和结算。
- 普通销售不能执行总监专属操作。
- Feature Flag 关闭商城后，商品接口返回明确降级响应；恢复开关后正常。
- 幂等键重复提交支付编排单时返回同一业务单。
- HTTP smoke 测试前后必须自动恢复演示种子，避免污染现场演示数据。

## 基线检查

需要运行中的本地服务：

```bash
npm run test:all
```

最低预期：

```text
语法检查通过
API contract PASS
核心回归 192 PASS / 0 FAIL
用户端 HTTP smoke 0 FAIL
跨域业务 HTTP smoke 0 FAIL
账本 balanced=true
```
