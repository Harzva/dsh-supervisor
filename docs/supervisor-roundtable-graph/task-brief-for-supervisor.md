# 任务简报 —— 让 supervisor 接管监督执行（已关闭）

> 主会话收集的积压工作已全部完成。以下是执行结果记录（磁盘事实 + host 核验）。

## 状态总览

| # | 任务 | 状态 | 说明 |
|---|---|---|---|
| 1 | Supervisor 圆桌记录 P1（数据层） | ✅ 完成 | store 落盘 roundtables[]/verdict/consensus；测试 24/24 |
| 2 | Supervisor 圆桌记录 P2（图可视化） | ✅ 完成 | buildRoundtableGraph + /roundtables/graph + 客户端入口；测试 32/32 |
| 3 | 排队执行修复（接管稀疏化） | ✅ 完成 | rounds:3 · intervalMs:20000（本会话+默认） |
| 4 | GroupX A 方案（源码层解耦） | ✅ 完成 | src 解耦 + lib 重建；测试 209/209 |
| 5 | GroupX A 方案（部署到 profile） | ✅ 完成 | 已上线，见下 |

## #5 GroupX A 方案部署到 profile —— 已完成

### 实施（B 方案：profile 加依赖）
1. **neutral 打包**：`@harzva/dsh-role-registry` 补 `@types/node`（symlink）+ `tsc` shim（`node_modules/.bin/tsc` 指向 groupx 真实 tsc，经 node 运行），
   `npm run build` 可跑通（esbuild + tsc）。打包 `harzva-dsh-role-registry-0.1.0-alpha.1.tgz`（含 lib/*.js + lib/types/*.d.ts）。
2. **GroupX 重打包**：`harness-flow-dsh-groupx-0.1.0-alpha.26.tgz`。修正两处类型/依赖问题：
   - `roles.ts` 的 `GroupXRoleRegistry` 类型别名从 `RoleRegistry`(类,含 #private 字段) 改为引用中立包导出的 `GroupXRoleRegistry`(接口)，
     修复 `freezeRoleRegistry` 的 frozen 对象不满足类类型的 `TS2741`。
   - neutral 依赖改为 **peerDependency**（`0.1.0-alpha.1`），避免 pnpm 从 registry 404（本地 file 包）。
   - GroupX 测试仍 **209/209**，tsc clean。
3. **profile 接线**：`package.json` 里 `@harness-flow/dsh-groupx → alpha.26.tgz` + 新增 `@harzva/dsh-role-registry: file:...tgz`；`pnpm install` 成功（新增 neutral，groupx 25→26）。
4. **重启 host**。

### host 上线核验
- `GET /dsh-groupx/api/roles` → **14 个角色**，同一 shared registry 实例（FR-6）：
  - `core.dsh-groupx` → 9 认知（`core.council.*`）
  - `dsh-supervisor` → 5 领域（`dsh-supervisor.strategy/code/research/verify/critic`）

### 额外发现并修复
- **supervisor 领域角色 id 需 namespace 前缀**：`ctx.inject(['groupxRoleRegistry'])` 回调可触发，但
  `roleRegistry.register` 因 `id: faculty.id`（如 `strategy`）未以 `namespace: 'dsh-supervisor'` 为前缀而抛
  `invalid-role-protocol:contribution.roles[0].namespace`（中立库 `normalizeRoleContribution` 校验）。
  已改为 `id: 'dsh-supervisor.' + faculty.id`，实测注册成功（模拟同一实例 3 认知 + 5 领域）。

### 停止门达成
- `/dsh-groupx/api/roles` 返回 9 认知 + 5 领域（同实例）。✅
- GroupX 未装/服务缺失/圆桌失败时 supervisor 静默回退。✅
- 测试：GroupX 209/209 · Supervisor 32/32 · Neutral 8/8。✅
- Supervisor 健康：接管模式 rounds:3 · intervalMs:20000；`/roundtables/graph` 返回 4 轮、分歧边 3。

## 归档
- 关键文件：`dsh-role-registry/{scripts/build.mjs, src, lib}`、`12-groupx/{package.json, src/roles.ts, src/council/role-registry.ts, tests}`、
  `dsh-supervisor/{src/index.js, test/client-drag-contract.test.js}`、`~/.dsh/profiles/digital-me/{package.json(+bak), pnpm-lock.yaml(+bak)}`。
- 本简报与 GroupX 部署遗留均已关闭；无新功能域。
