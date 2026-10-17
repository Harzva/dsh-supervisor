# Codex 接手记录 · 2026-10-17

## 0.3.0 对话页与工程开关

通过官方本地 stdio MCP App 注册 Supervisor thread entrypoint。工程须在面板内明确选择；服务端不把默认安装缓存 cwd 当工程，也不信任 UI 自造 cwd。绑定按宿主提供的 thread ID 隔离，数据位于稳定 PLUGIN_DATA；状态及开关操作只接受该对话的随机 binding ID。关闭阻止新派发与重试；已运行工作仍可验收。开启不创建任务、授权或后台观察器。

实际本机 Codex 0.149.0 识别入口 metadata，直接调用已安装 MCP 完成绑定、OFF/ON 持久保存、stale revision 拒绝和跨 thread 拒绝，最终 UI resource 与安装缓存一致；全程零模型推理，未创建执行任务。[native-panel-installation.json](native-panel-installation.json) 保存脱敏证据。

已安装 HTML 与 runtime 通过官方 AppBridge/PostMessageTransport 隔离测试宿主实测 14 项 UI 检查，包括按钮关联、保存、Space、刷新、重开、亮暗主题、390px 无横向溢出和 stale 状态禁用直到刷新。CX Luna 检查亮色、暗色、窄屏与错误截图，已消除 stale 仍显示开启的语义问题。[ui-panel.json](ui-panel.json) 标明验证范围。iframe 保持 allow-scripts，使用按钮直接调用 SDK；不扩大 allow-forms。工具 outputSchema 同时严格描述成功和静态错误，包含先 listTools 缓存 schema 后的错误验证回归。

115 项 Codex 测试与全套131项回归通过，DSH0.2.4/19文件契约保持，公开扫描0发现。MCP/MCP Apps SDK与许可证均打包，21文件ZIP安装后不需要npm；源码构建需npm ci。桌面自身UI被现有computer-use工具禁止控制，因此**未代用户点击真实Codex页签**，不把测试宿主截图当桌面入口截图。已运行窗口的发现可能需自然重启或新对话刷新。没有市场发布、Release或PR合并。

依据：[官方对话入口扩展](https://developers.openai.com/plugins/build/extensions)、[UI SDK](https://developers.openai.com/plugins/build/chatgpt-ui)、[本地 stdio 打包](https://developers.openai.com/plugins/deploy/desktop-only)。

## 0.2.1 本地安装与已安装技能验收

本机以支持的 CLI 注册本地开发市场并安装、启用 `harzva-supervisor@harzva-supervisor-dev` 0.2.1。插件缓存 16 个文件与 ZIP 摘要一致。新原生进程通过 `skills/list` 识别五个已启用技能；以明确的 native skill inputs 调用缓存中的 setup 和 execute，在新隔离工程完成五导师初始化、Git 忽略、单次原生 worker 执行、两项独立验收与 sequence 1 的 progress 检查点。脱敏回执在 [local-installation.json](local-installation.json)。107 项测试通过，其中 Codex 91 项。

0.2.0 首次已安装技能嵌套试用在 queue 确认后遇到 `thread/read` 内部 RPC 错误 -32603，按设计保留 uncertain，未重投该任务。单独的有界诊断表明先等待原生事件、延迟首次历史读取后执行成功。0.2.1 增加 2 秒启动窗口；仅对官方准确的自有线程尚未 materialize 错误 -32600 有界重试只读查询。观察到的 -32603 与官方的 -32600 是不同证据；未知内部错误仍停止。原截止时间不延长，queue 不重派发，结构化 transport 诊断在恢复后保留，不存储原始 RPC 正文。

默认 SDK workspace-write 宿主对受保护的项目 `.codex/supervisor/` 写入返回 PATH_ACCESS。成功试用的外层宿主使用本次会话已授权的 full-access 权限，未修改持久权限设置；内部 worker 和验收命令继续使用限定工程、无网络的 workspace-write 沙箱。此结果不证明每个默认受限宿主都能初始化这些路径。当前已运行桌面聊天的技能目录刷新未直接验证；按官方本地插件说明可能需要自然重启。未执行市场发布、Release、npm 发布或 PR 合并。

权威时序依据：[0.149.0 thread/read 处理](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/app-server/src/request_processors/thread_processor.rs#L5580)、[未 materialize 测试](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/app-server/tests/suite/v2/thread_read.rs#L1409)、[本地插件安装说明](https://developers.openai.com/plugins/build/plugins)。

## 0.2.0 执行链验收（历史记录）

本轮在 0.1.0 本地迁移版上实现授权 proposal → Codex owned worker 原生 queue → 独立文件／命令验收 → Supervisor `progress` 检查点。旧验证原样保存在 `checks-0.1.0.json` 和 `checks-0.2.0.json`；当前结果在 `checks.json`，真实原生执行证据在 `native-execution.json`。后续章节中的 0.1.0 行为是接手时的历史记录。

使用实际安装的 Codex 0.149.0 完成了非模拟测试：worker 创建 26 字节目标文件，文件 SHA-256 为 `ba813dc8bcdeea5ef96ca5427035cd5744e0e631221f7fa5bbd748d12a2d370c`；文件内容／摘要和原生 sandbox 中的 Node 精确断言均通过，原生 queue、turn、消息标记已关联，单次 attempt 后写回 sequence 1 的进展检查点。未把父任务或原生 Goal 标记为完成。

首次使用默认 CLI 配置遇到连接重试和不支持的桌面模型名称。读取原生 `model/list` 后明确选择其默认模型，再按本机已启用的 HTTP／HTTPS 静态代理发送原生模型请求。最终测试无需手工设置代理环境：适配器只把现有系统代理传给子进程，不更改个人配置、登录或系统网络设置。模型目录只读，显式模型必须原样保留，不映射 DSH route，不静默替换用户模型。

同时完成原生 `plugin/read`：官方解析器识别 `harzva-supervisor` 和五个命名空间技能；结果 `installed=false, enabled=false`，只读解析通过不等于桌面安装或自动触发验收。没有安装、启用、发布或合并。

执行持久化先于 dispatch-capable `queue/add`；队列是唯一调度器。入队标记用于关联，不是 exactly-once 幂等键。原生回合失败、用户审批、输入、超时、取消、重复标记、并发 runner 和进程丢失均有独立测试。不确定派发不会重投。独立验收命令也先保存持久意图；终止未确认时停止后续检查，且原生推理回合的完成不能清除独立命令的不确定性。验收回执先于普通检查点落盘，恢复可复用历史命令结果并重新检查指定文件摘要；未声明的依赖时效仍由恢复时的项目核查负责。

恢复使用 inert `thread/read`、queue/list、Goal/get；不 resume 或投递工作。0.149.0 会在新 app-server 冷读时把仍未结束的持久化 turn 投影为 `interrupted`；`notLoaded` 不能证明另一原生进程已经结束，因此保留不确定状态。队列、Goal 或最新 turn 存在冲突时同样停止。

权威依据：[app-server 文档](https://learn.chatgpt.com/docs/app-server)、[0.149.0 队列服务](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/ext/queue/src/service.rs)、[0.149.0 thread/read 处理](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/app-server/src/request_processors/thread_processor.rs)。独立审查发现的取消、模型保留、恢复冲突、验证进程丢失与历史文件变化问题已修复并覆盖回归。

## 真源与范围

主仓库为 [Harzva/dsh-supervisor](https://github.com/Harzva/dsh-supervisor)，当前 GitHub 元数据为 private、非 fork、Apache-2.0，GitHub Release 列表为空。源码 package 为 `dsh-supervisor@0.2.4`。远端 main 为 `e27e9208dda5972916cdc0aee2cfaccf90d05cb1`，smart-supervision-v2 为 `5092a0905c8d41c88f25f6c06c6c27a9b05a15c5`，标签 `p0-0.2.4` 存在并指向 `910b12298386567f916a06dbdf0750904ed5b124`。可访问 Harzva 仓库名称／简介检索未发现独立公开的 Supervisor／学院发布仓库。npm Registry 对 `dsh-supervisor` 返回 E404，并记录 2026-08-20 的 unpublished 时间；当前没有该名字的可安装版本。这个同名 Registry 记录不能证明历史撤包属于 Harzva。

本次开发分支 `feat/codex-supervisor` 从最新 v2 分支基线继续，添加独立 `harzva-supervisor@0.1.0` Codex 插件。本次用户授权用于 Codex 迁移开发；原 DSH v2 规划中的阶段授权门不被改写为 DSH 实施或发布授权。

当前聊天工作目录起初没有代码副本，已克隆 canonical 仓库。对当前可访问的 Codex 工程目录及本机相关 ChatGPT 开发目录做了有界文件发现，没有定位到旧电脑那些未提交 Supervisor 副本。这不把远端克隆视为全部最新成果；圆桌、项目记忆和终端观察未提交实现仍需在后续找回。

## 同名参考与许可证

[dat-lequoc/dsh-supervisor](https://github.com/dat-lequoc/dsh-supervisor) 为公开非 fork 仓库，默认 master，核查提交 `84cc8eeee85e800242d30ee15f9b672aa2aea9b9`，package 版本 0.9.1，没有 tags 或 GitHub Releases。manifest 声明 MIT，但 API license 为 null，license endpoint 为 404，完整文件树没有 LICENSE/COPYING/NOTICE。不能将“声明 MIT”写成已核实完整授权。本次没有复用该项目代码。

两仓库可见 commit SHA 交集为零（Harzva 6、参考 31），完整 blob SHA 交集为零（Harzva 导入基线 44、参考 master 49）。Harzva P0 [approval-request](../p0/approval-request.md) 明确把同名第三方排除为 namespace collision，并采用透明新导入基线。可以确认没有 GitHub fork／共享可见历史关系；导入前开发历史缺失，因此不据此推断从未借鉴过任何片段。

参考项目包含 main-agent、AGI template、goal/spawn/control 与教程。它的功能、版本和发布状态不属于 Harzva 项目。

## 已实现与规划

| 能力 | canonical 0.2.4 实际代码 | 规划／缺口 |
| --- | --- | --- |
| 监督 | plan/insight/fixed；todo 与有限对话驱动的短建议；advice/takeover | Goal 成功标准、Assessment、停滞、重规划、目标预算尚未实现 |
| 学院 | faculties 的模型 route 和领域 prompt；并行调用全部学院后主席综合 | 未按困难程度选择、冻结参与者；无版本化 Role Core |
| 导师 | 五种角色；持久责任分配、两个协作者、会话级模型覆盖 | 角色与原生 Actor 不统一；DSH route 不可直接迁移为 Codex model |
| Goal | `maybeInject` 中有 active Goal 避让 | watchdog/adopt/regen 等绕过该 gate，仍有双调度风险 |
| 协作 | faculties fanout；托管会话 groups | 没有 v2 CouncilService、预算预留、receipt 或讨论恢复 |
| 项目记忆 | assignment/settings/health/handoff 持久 Store | 没有 project-memory 模块；建议只读 surface 尾部 |
| 终端观察 | 未找到实现或测试 | 旧电脑未提交内容待找回 |
| 交接 | compaction 阈值、结构化 brief、稳定目标 ID、事务记录、外部 transport | 会话创建／投递由外部 transport 承担；不要把记录阶段当成已发送 |

定位：`src/index.js:409` 上下文、`:548` faculties、`:648` Goal gate、`:663` watchdog、`:826` adopt、`:832` regen；`src/mentor-registry.js` 角色映射；`src/handoff-service.js` 事务；`test/` 基线 16 项，其中 5 项是客户端源码文本契约，并非浏览器运行验收。

main 到 v2 分支只改变 13 个 docs/evidence 文件，没有 src/test/runtime 差异。`docs/smart-supervision-v2/README.md` 明确写 P0 未实现监管业务功能；已批准的设计不是已完成的功能。

## Codex 迁移决策

采用官方 portable `plugin.json` 与 Codex compatibility overlay，root `skills/` 自动发现。OpenAI settings 的 inline extension 整体替代 compatibility overlay，不合并。采用 skills + 本地无依赖脚本，不移植 Cordis/DSH host lifecycle；没有 MCP 或 hooks。本机 CLI 为 0.149.0；官方源码核查固定于 `5009a99dfc07830ddf7464c26f310a2b8532b55d`。

原有角色 normalizer 字节复用，独立 `.mjs` 包内资源由 build 同步。学院完整 domainPrompt 私有保存，公开投影移除 route、prompt、由 prompt 派生的 description 与旧 permissions。模型由宿主选择，插件不安装原生 custom-agent TOML。协作工具可用时使用原生子代理；否则声明串行评审。技能中的评审轮次是工作流约束，不宣称硬性调用、费用或 token 守恒。

本地任务记录采用独立 schemaVersion=1、真实工作区绑定、独占 writer 锁、有界检查点、敏感正文启发式检查和摘要寻址交接。它不复制 Goal phase/round，不创建或完成 native Goal，不监听内部 transcript/compaction 数据，也不自动发消息。配置迁移从用户给定的 JSON 读取，不扫描 DSH profiles 或凭据。

权威资料：[打包规范](https://developers.openai.com/plugins/build/plugins)、[技能规范](https://developers.openai.com/plugins/build/skills)、[官方解析器](https://github.com/openai/codex/blob/5009a99dfc07830ddf7464c26f310a2b8532b55d/codex-rs/core-plugins/src/agent_plugin_manifest.rs)、[原生子代理](https://learn.chatgpt.com/docs/agent-configuration/subagents)。

## 0.1.0 验证与交付边界（历史记录）

具体检查结果写在同目录 `checks.json`。验证覆盖构建资源一致性、manifest/path/marketplace、四个技能元数据、本地 CLI 的迁移／重启／交接／拒绝路径，及完整 DSH 回归和 pack gate。ZIP 解包后以独立工程做 smoke，以确认不依赖 canonical 仓库的 package.json 或其他运行文件。

没有修改用户已安装的插件、个人 Codex config 或 DSH Profile。`codex plugin list --marketplace harzva-supervisor-dev --available --json` 在未注册目录时返回空列表，不视为安装验收。尝试以临时 sqlite/log 目录调用 app-server `plugin/read`：严格配置模式因现有未知 feature 字段退出，常规模式在 sandbox 中因 Operation not permitted 退出，均未执行到插件解析。没有扩大权限或改写宿主配置。桌面真实安装、新会话触发、进行中会话 setup、真实原生子代理与跨 chat 交接仍需宿主验收；本地 CLI 通过不等于这些测试已完成。没有 npm/public-directory/DSH 市场发布。

## 独立后续

DSH 市场发布以 [awesome-dsh-plugin 收录仓库](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 为另一个任务。核查 tree `a3c72b2913447cfaf6c69db5d39fb0cb06a0cf30` 无这两个 dsh-supervisor 项目条目。后续使用 `data/plugins/<owner>__<repo>.yml` 而非手改生成 README，并单独复核可见性、dsh.bundle、topic 和许可证。当前 private 仓库不能被视为已经公开发布。

Codex 后续继续验收桌面自然刷新、其他受限宿主与自动触发，再决定是否需要正式 MCP／hooks 产品及公共目录身份。找回原电脑修改时做独立 diff 和来源核查，不能直接覆盖 canonical 新实现。DSH v2 active Goal 双调度问题也应保持独立修复与运行验收。
