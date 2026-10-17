# Codex 接手记录 · 2026-10-17

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

## 验证与交付边界

具体检查结果写在同目录 `checks.json`。验证覆盖构建资源一致性、manifest/path/marketplace、四个技能元数据、本地 CLI 的迁移／重启／交接／拒绝路径，及完整 DSH 回归和 pack gate。ZIP 解包后以独立工程做 smoke，以确认不依赖 canonical 仓库的 package.json 或其他运行文件。

没有修改用户已安装的插件、个人 Codex config 或 DSH Profile。`codex plugin list --marketplace harzva-supervisor-dev --available --json` 在未注册目录时返回空列表，不视为安装验收。尝试以临时 sqlite/log 目录调用 app-server `plugin/read`：严格配置模式因现有未知 feature 字段退出，常规模式在 sandbox 中因 Operation not permitted 退出，均未执行到插件解析。没有扩大权限或改写宿主配置。桌面真实安装、新会话触发、进行中会话 setup、真实原生子代理与跨 chat 交接仍需宿主验收；本地 CLI 通过不等于这些测试已完成。没有 npm/public-directory/DSH 市场发布。

## 独立后续

DSH 市场发布以 [awesome-dsh-plugin 收录仓库](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 为另一个任务。核查 tree `a3c72b2913447cfaf6c69db5d39fb0cb06a0cf30` 无这两个 dsh-supervisor 项目条目。后续使用 `data/plugins/<owner>__<repo>.yml` 而非手改生成 README，并单独复核可见性、dsh.bundle、topic 和许可证。当前 private 仓库不能被视为已经公开发布。

Codex 后续先完成桌面安装验收，再决定是否需要正式 MCP／hooks 产品及公共目录身份。找回原电脑修改时做独立 diff 和来源核查，不能直接覆盖 canonical 新实现。DSH v2 active Goal 双调度问题也应保持独立修复与运行验收。
