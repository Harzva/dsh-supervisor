# DSH 智能接管（监管/导师）· 行为与注入内容记录

> 本文记录 `dsh-supervisor` package `0.2.4` 的 legacy 行为；旧动态插件编号仅作为历史背景，不是 package 版本。
> 会话 ID 示例：`session-<uuid>`

## 一、核心概念：智能开关 = 接管对话输入

- **智能接管（auto，开）**：导师自动执行闭环——`监听空闲 → 生成建议 → 自动输入对话 → 主对话执行 → 再监听`，直到 N 轮用完、计划完成或回复「监督完成」；
- **智能接管（关）**：导师完全静默，不注入任何内容；UI 仍保留"手动生成建议 / 手动采纳"作为备用通道；
- 入口三处同步：输入区「智能接管」条 / 右上角导师浮窗 / `/supervise on [N] | off`；
- **浮窗显示与否**：设置 → 「监管导师」→「显示右侧导师悬浮窗」（localStorage，默认开）——浮窗不再承担开关，只负责展示。

## 二、接管后注入的内容（按策略）

| 策略 | 注入内容 | 说明 |
|---|---|---|
| **计划驱动 `plan`**（默认） | 导师 LLM 基于「会话 todo 清单（计划黑板）+ 四段上下文（任务头/目标/工具进展/最近对话，见 `CONTEXT.md`）」实时生成的**下一步建议**（≤80 字一句中文） | 优先围绕「未开始/进行中」条目；清单全部完成 → 建议"任务已完成，建议停止"；上下文不足 → 必须回复"上下文不足，请补充信息后再建议" |
| **理解驱动 `insight`** | 同上，但**不喂清单**，纯按对话理解给出建议 | 任务已完成 → 建议停止 |
| **固定随机 `fixed`** | 固定词表随机一条（continue/继续/请继续/继续执行/继续你的工作/请继续推进，不要停） | 不用 LLM |

**注入信封**（三种策略共用，全部复用原生组件）：
- 消息：`role=user`，单 text 块，`source={kind:'plugin', plugin:'dsh-supervisor'}`，`id='supv-<sid>-<seq>'`；
- 通道：`agent.followup()`（与 Goal 续跑驱动、子代理同款原生轮子）；
- 编排组件：`sessionProjections`(todos) + `sessionQuery.readSurface` + `llm.stream` + `agentFollowup`——无自造协议。
- **不与 Goal 模式冲突**：会话存在 active 目标时导师自动让位（skip）。

## 三、导师状态机（可见状态灯）

```
未接管(off) → 监听中·等待任务(silent) → 思考中·分析对话(thinking)
→ 已给建议·待采纳(suggested，自动模式为瞬态) → 已接管·主对话执行中(working)
```

## 四、导师模型（独立于主对话）

- 目录 = 主对话同款 `modelDirectories`（同一份 provider/model 清单、同一协议）；
- 「自动」= 优先使用当前 Supervisor 的配置路由，否则跟随主对话当前模型；按 Provider 选择其他模型 = 仅当前会话分配的 Supervisor 使用该模型（不改主对话选择），并持久化到该 Supervisor 的会话级覆盖；
- 命令：`/supervise mentor-model <provider/model>`（留空恢复默认）。

## 五、跨对话托管（同项目/同主题）

- 浮窗「管理对话」→ 勾选同 workspace 会话（显示标题）→ 保存托管清单；
- 顶部下拉：本会话 / ↳ 被托管会话，逐目标查看状态、建议、执行；
- **「批量刷新」**：用主宰者（lead）的导师模型为**全部托管对话一键生成建议**（托管对话若已接管则自动注入）。

## 六、触发条件与计数

- 看门狗每 2.5s 扫描；条件：auto=开、idle、输入队列空、冷却（间隔可设 2~60s 或命令 2~3600s）、used<N、未 done、无 active 目标；
- 每会话独立计数：`used / N`（默认 10）；人类**本人**发新消息 → 清零重计；
- 状态为**进程内**：目前插件更新/重启会清空（静态版已规划持久化 `~/.dsh/dsh-supervisor-state.json`）。

## 七、命令表

| 命令 | 作用 |
|---|---|
| `/supervise on [N]` | 开启智能接管，上限 N 次 |
| `/supervise off` | 停止接管（导师静默） |
| `/supervise strategy plan\|insight\|fixed` | 切换策略 |
| `/supervise interval [秒]` | 接管间隔（2–3600） |
| `/supervise mentor-model <provider/model>` | 导师模型（空=跟随主对话） |
| `/supervise status` | 状态+策略+计数 |
