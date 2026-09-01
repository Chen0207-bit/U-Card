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
总计：169
admin：135
app：25
merchant：6
open：2
other：1
SHA-256：02dcd596354c97f26e870ceab1281337466ccd895dccaf447029020d04e79fe0
```

### 基线变更记录

- **42534be（冻结）→ 173（1a670b9 前）**：3.x 迁移期间 Router 接管动态路由时引入了带尾斜杠的**前缀注册字面量**（如 `/api/admin/customers/`），对应旧 `core.js` 正则匹配的既有端点，未新增公开能力；另在 P4.3 风控规则引擎迁移时**有意新增**两个端点：`POST /api/admin/risk-engine/versions/publish`（手动发布当前策略）与 `POST /api/admin/risk-engine/versions/{ver}/rollback`（回滚到含快照的版本，旧版本无 `rulesSnapshot` 时返回 409 防伪造）。净增 12 条：161 → 173（admin 124 → 136）。
- **173 → 176（P5.1 支付编排接入）**：`src/api/payment-orchestration-routes.js` 从 staging 移入后，其 4 个前缀注册中的 3 个带尾斜杠字面量 `/api/admin/orch/adapters/`、`/api/admin/orch/tx/`、`/api/admin/orch/diff/` 进入扫描（旧 `core.js` 以正则字面量匹配同样端点，不被扫描）；9 个精确路径全部为既有端点，未新增公开能力。173 → 176（admin 136 → 139）。
- **176 → 178（P1.5 经典风控接入）**：`src/api/classic-risk-routes.js` 移入后新增 2 个带尾斜杠前缀字面量 `/api/admin/risk/rules/`、`/api/admin/risk/lists/`（旧 `core.js` 以正则字面量匹配同样端点）；`/api/admin/risk/` 与 4 个精确路径均为既有字面量。176 → 178（admin 139 → 141）。
- **178 → 174（legacy 分支删除批次 A）**：物理删除 `core.js` 中 P1.5/P1.6/P3/P4.1/P4.2/P4.3/P4.4/P4.5/P4.6/P5.1/P5.2/P5.3 已接管道域的旧分支体后，4 个仅作为旧 `startsWith` 前缀守卫存在、不对应任何 endpoint 的字面量随之消失：`/api/admin/compliance`、`/api/admin/finance`、`/api/admin/orch`、`/api/admin/risk-engine`（请求这些前缀本身旧代码即返回 404，新 Router 同样 404）。公开端点集合无变化，178 → 174（admin 141 → 137）。
- **174 → 171（legacy 分支删除批次 B）**：删除 `/api/admin` 剩余旧分支体（基础运营/CRM/积分商城/P5.4 商户后台/P5.5 BI/P5.6 运维）。消失的 3 条为旧前缀守卫字面量：`/api/admin/bi/`、`/api/admin/mch/`（admin 组）与裸 `/api/admin`（无尾斜杠，归入 other 组；请求该前缀本身旧代码即返回 404，新 Router 同样 404），均不对应 endpoint。方法矩阵补齐：`POST /api/admin/goals`（legacy 分支无方法守卫，POST 与 GET 返回同一目标数据集，核心回归依赖此行为）。公开端点集合无变化，174 → 171（admin 137 → 135，other 3 → 2）。
- **171 → 169（legacy 分支删除批次 C）**：删除 core.js handleApi 中 `/api/app` 与 `/api/mch/` 两个旧分支块及重复的 `/api/demo/reset` 旧分支（该端点早已由 `ops-routes.js` 注册接管）。消失的 3 条为旧 `startsWith` 前缀守卫字面量：裸 `/api/app`（other 组）与 `/api/mch/`（merchant 组），不对应 endpoint。同时将 `card-routes.js` 的卡片自助动作从循环模板字面量改为三个显式路径注册（`/api/app/card/freeze|unfreeze|lost`），模板拼接此前对契约扫描不可见。公开端点集合无变化，171 → 169（merchant 7 → 6，other 2 → 1）。

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
语法检查通过（79 源文件）
API contract PASS
核心回归 192 PASS / 0 FAIL
no-fallback PASS（legacy 已删除，全路由 Router 承接）
UnitOfWork 17 PASS / 0 FAIL
handler-check PASS（四入口事件函数全部可解析）
用户端 HTTP smoke 0 FAIL
跨域业务 HTTP smoke 0 FAIL
账本 balanced=true
```
