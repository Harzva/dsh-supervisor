# 前端同步审计对账清单 —— Supervisor / Session-Board

> 唯一事实源。逐项核对「后端已实现 / 前端是否暴露」，标注状态。
> 状态：✅已暴露并实测 · 🟡代码在但未实测暴露 · ❌未暴露（缺口）。

## A. Supervisor 接管 = 按 todo/计划驱动（非仅次数）

| 项 | 状态 | 说明 |
|---|---|---|
| `plan` 驱动停止（`plan.completed>=total` 停） | ✅ 逻辑在 | `suggestFor`/`scheduleIfIdle` 均有 `plan.completed>=plan.total` 停止分支 |
| 数据源 `sessionProjections.todos` | 🟡 依赖会话有 todo | 仅当会话写过 `todo/write` 才有值；当前会话 `plan:null` → 退化为轮次 |
| 无 todo 时的接管行为 | ❌ 无提示/无降级 | 应：无 todo 时提示"未设计划，按轮次驱动"，或默认小轮次 |

**目标**：接管以 todo 计划为监督主线（有 plan 就按 plan 逐项监督），无 plan 时明确提示并降级小轮次。

## B. Roundtable 图：后端 vs 前端

| 项 | 状态 | 说明 |
|---|---|---|
| 后端 `GET /dsh-supervisor/roundtables/graph` | ✅ 已上线 | 实测 4 轮/分歧边 3 |
| Supervisor 浮动面板「圆桌记录」入口 | 🟡 代码在 | `client.js` 有 toggle+渲染（需确认渲染可达） |
| **Session-Board 卡片圆桌记录入口** | ❌ **缺失** | 卡片只有 GroupX 徽章，无圆桌历史/图入口 |

**目标**：session-board 卡片加「圆桌记录」可展开区（拉 `/roundtables/graph`，按轮次 timeline 渲染，分歧标注虚线边）。

## C. 前端全局审计（已实现但可能未暴露）

> 需逐一确认是否真实渲染，而非仅代码存在。

### Supervisor 浮动面板 / 模式栏
| 功能 | 代码 | 前端暴露 | 状态 |
|---|---|---|---|
| 三态模式(off/advice/takeover) | ✅ | 面板 chip | 🟡 需实测 |
| 策略(plan/insight/fixed) | ✅ | 面板 chip | 🟡 需实测 |
| 上限 rounds / 间隔 interval | ✅ | 面板 input | 🟡 需实测 |
| 监督模型选择 | ✅ | 面板 select | 🟡 需实测 |
| 多角色(主责+协作)展示 | ✅ | `renderSupervisorTeam` | 🟡 需实测 |
| 圆桌意见建议 + 各角色意见 | ✅ | `facultySuggestions` 块 | 🟡 需实测 |
| 圆桌记录图 | ✅ | 面板「圆桌记录」toggle | 🟡 需实测 |

### Session-Board 卡片
| 功能 | 代码 | 前端暴露 | 状态 |
|---|---|---|---|
| 卡片名=会话名+流式副行 | ✅ | `sessionTitle/cardSummary` | 🟡 需实测 |
| 仅接管筛选 | ✅ | `仅接管` chip | 🟡 需实测 |
| 多角色(主责+协作，含批评家 cross) | ✅ | `renderSupervisorTeam` | 🟡 需实测 |
| 协作数真实/无则 0 | ✅ | `协作 0` | 🟡 需实测 |
| GroupX 徽章(alpha.26 投影) | ✅ | `groupxModeMeta` | 🟡 需实测(待 groupx 模式会话) |
| **圆桌记录入口** | ❌ | 无 | ❌ 缺失 |

## 审计结论（已实测闭环）

- **客户端 bundle 已确认从磁盘新鲜提供**：`/plugins/dsh-supervisor/client.js`、`/plugins/zhitro-brandos-session-board/client.js`
  经 `?rev=<hash>` 读取 `lib/client.js` 内容做哈希，`link:` 依赖改动对浏览器即时生效（host 重启后重算 rev）。
- 实测 `GET` 返回的 client 均含新增标记（supervisor：`roundtables/graph`/`圆桌记录`；session-board：`RoundtableGraphEntry`/`圆桌记录`/`zhitro-sb-roundtable`）。
- full suite：Supervisor 34/34 · GroupX 209/209 · Neutral 8/8 · Session-Board 65/65。

## 已补齐的缺口
- **A. 接管按 todo/计划驱动**：`suggestFor` 注入建议锚定到 `plan.next`（`本轮监督聚焦 todo「X」`）；
  `maybeInject`/`watchdog` 在 `strategy:plan` 但无 todo 时提示一次（`暂无 todo 计划`）并降级（`planEmptyWarned`/`planWarnAt`）。
- **B. 圆桌记录入口**：session-board 卡片新增 `RoundtableGraphEntry`（可展开，`fetchRoundtableGraph` 拉 `/roundtables/graph`，
  按轮次 timeline、分歧虚线边、共识副行）；supervisor 浮窗保留「圆桌记录」toggle。

## 已知真实限制
- **GroupX 徽章**：`groupxModeMeta` 读 `projectionValues.groupxMode`，仅当某会话处于 GroupX 模式（`active`/`running`）
  且有 Host 端 `sessionProjections` 物化该投影时才有值。groupx 模式会话开启后才显示 —— 非缺口，是数据前提。
