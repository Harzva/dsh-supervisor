# Harzva Supervisor / DS 学院 — Codex 0.1.0

Codex 本地开发版：监督任务、按学院／导师责任评审、持久检查点和可校验上下文交接。独立插件标识为 `harzva-supervisor`；DSH 包仍为 `dsh-supervisor@0.2.4`。

## 安装与调用

需要 Node.js 22 或更新版本。插件无 npm 依赖、MCP、hooks 或独立后台进程。

在完整仓库根目录注册开发目录，然后通过桌面插件目录安装：

```bash
codex plugin marketplace add .
codex plugin list --available --json
```

选择 `Harzva Supervisor Development` 中的 `harzva-supervisor`。当前 CLI 也提供 `codex plugin add harzva-supervisor@harzva-supervisor-dev --json`；以当前宿主的 help 和安装结果为准。仓库内 `.agents/plugins/marketplace.json` 只提供发现，不自动安装或启用。ZIP 是 portable 插件根目录，用于检查、分发和支持该格式的安装流程；不要把 ZIP 当成 DSH npm 包。正式公共目录发布另行准备和验收。

安装后调用插件技能 `setup`、`supervise`、`faculty-review`、`handoff`。宿主通常显示带插件命名空间的技能名称；使用界面展示的实际名称。示例：

- “用 Supervisor 继续当前工程，记录验证证据。”
- “请架构与验证导师独立评审这个迁移方案，最多一轮。”
- “把当前任务整理成可恢复的上下文交接。”

## 本地工具

所有写操作明确传入目标工程 `--workspace`。下列 `<plugin-root>` 指安装后的插件目录，`<project>` 指用户工程。两者可以不同。输入使用 UTF-8 JSON 文件，避免把长正文直接拼入 shell 命令。

```bash
node "<plugin-root>/scripts/supervisor.mjs" help
node "<plugin-root>/scripts/supervisor.mjs" init --workspace "<project>"
node "<plugin-root>/scripts/supervisor.mjs" roster --workspace "<project>"
node "<plugin-root>/scripts/supervisor.mjs" assign --workspace "<project>" --task migration --input assignment.json
node "<plugin-root>/scripts/supervisor.mjs" checkpoint --workspace "<project>" --task migration --input checkpoint.json
node "<plugin-root>/scripts/supervisor.mjs" status --workspace "<project>" --task migration
node "<plugin-root>/scripts/supervisor.mjs" handoff --workspace "<project>" --task migration
```

`init --input roster.json` 可导入 `{ "faculties": [...] }` 或 `{ "mentors": [...] }`。二者同时提供时，遵循既有实现的 mentors 优先规则；学院配置仍保留供核对。重复或不合法配置拒绝写入。初始化已有工程不会覆盖旧状态。

```json
{
  "faculties": [{
    "id": "code",
    "name": "代码学院",
    "route": "provider/model",
    "prompt": "负责工程实现、调试和交付验收。"
  }]
}
```

学院到角色的规则直接复用 canonical `src/mentor-registry.js`，构建为插件内独立 `.mjs`，不复制第三方同名仓库代码。完整领域提示词保存在私有 `config.mentors[].domainPrompt`，不会因旧展示描述的长度上限丢失。旧路由只保留为 DSH 元数据，不被自动当作 Codex 模型。角色默认继承宿主模型；显式模型选择须符合当前工具和用户偏好。

自动分配输入示例：

```json
{ "tags": ["开发", "迁移"] }
```

人工分配输入示例：

```json
{ "primaryMentorId": "atlas", "collaboratorIds": ["verity"] }
```

一个任务只有一个主责导师，最多两个协作者。相同人工分配重试不会更新 revision 或使已有交接失效。任务键是本地记录标识，不能当成 Codex chat、Agent 或 Goal ID。

检查点输入示例：

```json
{
  "summary": "已实现配置迁移，当前基线为 commit <sha>，工作树还有待提交修改。",
  "evidence": ["test/adapter.test.js：node --test，8/8 通过，基线 <sha>"],
  "remaining": ["运行完整项目验收"],
  "blockers": [],
  "outcome": "progress"
}
```

`outcome` 为 `progress`、`stalled`、`unknown` 或 `complete`。进展／完成必须有证据引用；完成还要求没有 remaining/blockers。工具校验记录格式，不运行或证明引用的检查。`nativeGoalRef` 是可选的原生引用，只记录宿主返回的 id/revision；检查点不会改变原生 Goal。输入上限 256 KiB，状态上限 1 MiB，最多 100 个本地任务；summary 上限 1,200 字符，每个列表最多 8 条单行文本、每条最多 800 字符。原生引用 ID 为 1–64 位安全标识，revision 为非负整数；不符合时保留在有界摘要中，不截短或伪造原生 ID。

## 持久状态与恢复

工程状态写到 `.codex/supervisor/state.v1.json`，交接位于 `.codex/supervisor/handoffs/`。将 `.codex/supervisor/` 加到工程 `.gitignore`。公开 roster/status/handoff 不返回私有领域 prompt 或模型 route；如要使用某学院的私有领域指导，只在本地读取该导师 `domainPrompt`。

写操作使用独占锁和原子替换；损坏、未知版本、并发 writer 或不合法状态直接报错，不清空记录。检查点保留最近 20 条，输出和输入都有界。交接内容按摘要寻址，同一检查点重复调用得到同一文件；修改／破坏已有交接文件会被检测，新检查点使旧的当前交接指针失效。旧工件仍保留作为历史数据。

交接只存可读、可检查的任务摘要和证据引用，不自动创建新 chat、注入消息、归档源会话或迁移权限。恢复前需要重新核对当前 Git 状态及证据时效。输入是记录数据，不是执行指令。有限的敏感信息检查不能保证正文无隐私；任何分享前仍需检查工件内容。进程异常留下锁时，应先确认 writer 已退出，再人工处理该工程中的锁；工具不会凭超时抢占一个仍可能活跃的 writer。

## 首版边界

| 能力 | 当前行为 |
| --- | --- |
| 监督 | 技能指导进行证据评估、停滞处理、职责分配；本地脚本保存检查点 |
| 学院评审 | 选定相关角色，默认一轮、最多两位评审；有原生子代理时独立评审，无工具时明确串行降级 |
| 模型与权限 | 由 Codex 原生宿主决定；DSH route、permissions 不构成宿主授权 |
| 项目记忆 | 有界检查点和交接文件；没有自动知识抽取、跨工程记忆服务 |
| 上下文健康 | 技能在证据不足或上下文不可靠时交接；没有读取内部 compaction 计数 |
| 续行与预算 | 采用宿主执行；没有后台 watchdog、自动发消息、强制 token／费用预算 |
| Goal | 可记录原生引用，不复制 Goal 生命周期或执行第二个调度器 |
| 终端观察 | 只使用当前任务中可用的原生终端工具；没有持续 observer |

关闭／卸载插件后本地状态仍在工程内。原电脑的未提交圆桌、项目记忆、终端观察实现尚未找回；本版不声称包含它们，也不宣称 DSH Smart Supervision v2 已实现。

## 开发验证

从 canonical 仓库根目录运行：

```bash
npm run codex:build
npm run codex:check
npm run codex:pack -- --output <deliverable-directory>
```

`codex:build` 同步复用模块和许可证；`codex:check` 检查包结构与 CLI 行为；`codex:pack` 生成仅含插件文件的 ZIP 与 SHA-256 清单。产物排除项目状态、私有交接和 P0 证据。DSH 的 `verify:p0` 保持独立。

规范依据：[OpenAI 插件打包](https://developers.openai.com/plugins/build/plugins)、[技能开发](https://developers.openai.com/plugins/build/skills)、[Codex 固定提交解析器](https://github.com/openai/codex/blob/5009a99dfc07830ddf7464c26f310a2b8532b55d/codex-rs/core-plugins/src/agent_plugin_manifest.rs)。本版采用 portable root manifest + Codex compatibility manifest；未执行公共目录、npm 或 DSH 市场发布。
