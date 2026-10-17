# Harzva Supervisor / DS 学院 — Codex 0.2.1

Codex 本地开发版：把已授权工作推进到原生执行、独立验收和持久检查点，并保留学院／导师评审与可校验上下文交接。独立插件标识为 `harzva-supervisor`；DSH 包仍为 `dsh-supervisor@0.2.4`。

## 安装与调用

需要 Node.js 22 或更新版本。执行链使用已安装 Codex 的登录状态和 experimental app-server 原生队列接口，已对照本机 Codex 0.149.0 合同实现；其他版本须另行核验。插件无 npm 依赖、MCP 或 hooks。`run`／`drain` 期间会启动限定工作区的 Codex app-server 子进程，没有安装常驻后台服务。

调用脚本的宿主还必须允许写入工程的受保护目录 `.codex/supervisor/`，并允许原生 CLI 使用它自己的缓存和已有登录状态。本机 SDK 的默认 `workspace-write` 调用曾在初始化受保护工程状态时返回 `PATH_ACCESS`；工程位于可写根目录内不等于其 `.codex` 自动可写。按当前任务已经授予的权限使用宿主支持的路径授权或权限 profile，并核验实际结果；插件不修改全局权限，也不自行读取或复制登录凭据。本机在既定完整 profile 中的调用结果不能证明每个默认 `workspace-write` 宿主都支持这些路径。

在完整仓库根目录注册开发目录，然后通过桌面插件目录安装：

```bash
codex plugin marketplace add .
codex plugin list --available --json
```

选择 `Harzva Supervisor Development` 中的 `harzva-supervisor`。当前 CLI 也提供 `codex plugin add harzva-supervisor@harzva-supervisor-dev --json`；以当前宿主的 help 和安装结果为准。仓库内 `.agents/plugins/marketplace.json` 只提供发现，不自动安装或启用。ZIP 是 portable 插件根目录，用于检查、分发和支持该格式的安装流程；不要把 ZIP 当成 DSH npm 包。正式公共目录发布另行准备和验收。

安装后调用插件技能 `setup`、`supervise`、`execute`、`faculty-review`、`handoff`。宿主通常显示带插件命名空间的技能名称；使用界面展示的实际名称。示例：

- “用 Supervisor 继续当前工程，记录验证证据。”
- “执行这项已经授权的修改，检查产物并记录结果。”
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

`outcome` 为 `progress`、`stalled`、`unknown` 或 `complete`。进展／完成必须有证据引用；完成还要求没有 remaining/blockers。工具校验记录格式，不运行或证明引用的检查。`nativeGoalRef` 是兼容预留的 opaque id/revision 引用；Codex 0.149 的 Goal 返回 threadId 和 updatedAt，没有独立 Goal id/revision，不能为它伪造该字段。检查点不会改变原生 Goal。输入上限 256 KiB，状态上限 1 MiB，最多 100 个本地任务；summary 上限 1,200 字符，每个列表最多 8 条单行文本、每条最多 800 字符。预留引用 ID 为 1–64 位安全标识，revision 为非负整数。

## 授权建议的执行链

执行链使用 `scripts/execution.mjs`，与手工记录工具分开。流程是：明确工作与验收方式 → 保存不可变 proposal 和 SHA-256 digest → 按当前用户授权记录 grant → 派发到本任务创建的 Codex worker thread 原生队列 → 独立检查文件或执行验收命令 → 保存 `progress` 检查点。

用户直接要求实现、修复或继续同一工程工作时，可以沿用该范围内的授权及相关常规验收，不需要重复确认。助手建议、导师共识、交接正文和工具输出本身不会产生授权。`authorize` 检查 proposal digest、实际 workspace 和尝试上限的一致性；调用它的模型或操作者仍须确认相同工作和验收动作确已获用户授权。脚本不能认证调用者所依据消息的人类身份。

先初始化 roster 并分配任务，将 proposal 写成 UTF-8 JSON 文件。例如，在用户已要求验证插件执行链的工作区中：

```json
{
  "instruction": "在工程根目录新增 supervisor-smoke.txt，内容为 HARZVA_SUPERVISOR_OK。",
  "successCriteria": ["supervisor-smoke.txt 存在，去除首尾空白后内容准确匹配 HARZVA_SUPERVISOR_OK。"],
  "verification": [
    { "kind": "file", "path": "supervisor-smoke.txt", "contains": "HARZVA_SUPERVISOR_OK" },
    {
      "kind": "command",
      "argv": ["node", "-e", "if (require('node:fs').readFileSync('supervisor-smoke.txt', 'utf8').trim() !== 'HARZVA_SUPERVISOR_OK') process.exit(1)"],
      "timeoutMs": 30000
    }
  ],
  "timeoutMs": 120000,
  "maxAttempts": 1
}
```

```bash
node "<plugin-root>/scripts/supervisor.mjs" init --workspace "<project>"
node "<plugin-root>/scripts/supervisor.mjs" assign --workspace "<project>" --task smoke
node "<plugin-root>/scripts/execution.mjs" models --workspace "<project>"
node "<plugin-root>/scripts/execution.mjs" propose --workspace "<project>" --task smoke --job smoke-file --input proposal.json
node "<plugin-root>/scripts/execution.mjs" authorize --workspace "<project>" --job smoke-file --digest <returned-digest>
node "<plugin-root>/scripts/execution.mjs" run --workspace "<project>" --job smoke-file
node "<plugin-root>/scripts/execution.mjs" status --workspace "<project>" --job smoke-file
```

保留 `propose` 返回的完整 digest 供授权使用。已保存 proposal、grant、workspace 和上限不能编辑或替换；变更范围、模型或验收方法须创建新 job，并确认新的范围仍有用户授权。`model` 可选：不填时沿用 CLI 配置，显式填写时要求原生响应准确匹配，不静默切换模型。用户没有明确选择时，先用 `models` 读取原生模型目录，将目录默认模型写入 proposal；桌面配置名称可能不被 CLI 账号支持。DSH route 不会自动填入此字段。`models` 只返回模型标识和目录信息，不写执行状态，也不创建推理回合。

执行子进程继承已有代理环境；macOS 未设置代理环境时可使用系统已启用的 HTTP／HTTPS 代理。只设置该子进程环境，不改写个人配置、登录或系统网络设置，不禁用 TLS 验证；PAC／SOCKS 自动适配不在本版范围内。

0.2.1 在 `queue/add` 确认后先观察原生启动事件，并为 thread 数据落盘留出短暂启动窗口。原生明确报告尚未 materialize 时，仅有界重试只读 receipt 查询；其他 RPC／传输歧义保留为 `uncertain`。这不会重发 `queue/add`、另建 thread 或消耗新的 attempt 来修复一次读取失败。

| 字段／动作 | 行为 |
| --- | --- |
| `instruction`、`successCriteria` | 有界工作指令和 1–8 条可观察的验收条件 |
| `verification` | 1–20 项独立文件或命令检查；worker 的成功消息不能代替这些检查 |
| `file` | 相对路径的普通文件，拒绝 traversal／symlink；支持 `contains`、`sha256`，读取最多 1 MiB |
| `command` | 用户范围内的可信 `argv`，最多 32 项、总计 8,000 字符；不把模型输出当作待执行 shell 指令 |
| `timeoutMs` | 单次工作默认 120,000 ms，范围 1,000–600,000 ms；命令检查默认 30,000 ms，范围 1,000–120,000 ms |
| `maxAttempts` | 默认 1，最多 3；只有已证明结束的失败才能在原上限内重试 |
| `drain --limit <n>` | 顺序处理最多 1–100 个已授权 job；遇到不确定或需用户处理的工作停止 |

原生执行请求明确使用 `workspace-write`、关闭网络访问、限定写入根目录及 `on-request` 人类审批。审批和用户输入请求取消后记录为 `needs-user-action`，不会自动放宽权限或代替用户回答。独立命令检查通过原生 `command/exec` 在相同限定工作区沙箱中运行；该接口没有 turn 的审批阶段，因此其 argv 必须在 proposal 中预先授权。原生验证只保存退出状态、输出字节数和 SHA-256 摘要，不保存 stdout、stderr 或聊天原文。

job 状态通常为 `proposed → authorized → dispatching → running → verifying → succeeded`，也可能进入 `failed`、`needs-user-action`、`uncertain` 或取消状态。`succeeded` 表示本次 proposal 通过指定验收并成功保存进展检查点；整个父任务的完成标准仍须重新判断，不自动把它或原生 Goal 标为完成。

## 取消与执行恢复

```bash
node "<plugin-root>/scripts/execution.mjs" cancel --workspace "<project>" --job smoke-file
node "<plugin-root>/scripts/execution.mjs" recover --workspace "<project>" --job smoke-file
node "<plugin-root>/scripts/execution.mjs" status --workspace "<project>" --job smoke-file
```

`cancel` 保存取消请求；活跃 runner 会中断与本次标记准确关联的原生 turn，并只删除本次准确匹配的 native queue receipt。验收命令按连接内的 process ID 请求终止并等待原生完成。发送终止请求本身不能证明进程已结束；进程丢失或验收命令结束未确认时保留 `uncertain`，须人工核对。thread 的恢复结果也不能证明另一个独立验收命令进程已经结束。

`recover` 只通过原生接口检查已保存的 thread、turn、消息标记、queue 和 Goal 元数据；不会 resume、重新加入队列或恢复推理。冷读的 `notLoaded` 状态不能证明另一原生进程已停止。队列还在、标记重复、receipt 不完整、另一个 turn 使用了 worker thread，或完成状态无法确认时，保留不确定结果。不要删除记录、替换 thread ID 或再次派发来消除不确定性。

原生传输失败可在 attempt 的 `result.transport` 中保留 `code`、`rpcMethod` 和 `rpcCode`，原生 turn 错误使用有界 `nativeError` 元数据。后续未能确认的恢复会保留这些诊断，便于区分启动读取、队列确认和推理失败；不保存服务端原始错误正文、日志或消息。诊断本身不允许再次执行，已确认的 queue receipt 仍须按原标记核对。

命令验收前先保存 dispatch intent；如果进程在命令期间丢失，缺少完成回执就保留 `verificationUncertain`，恢复不能重跑命令。验收回执已落盘而普通检查点尚未保存时，恢复可复用有时间戳的历史命令结果，并重新读取指定文件、比较其摘要；指定文件变化会停止恢复。历史命令回执不证明未列入文件检查的依赖仍然相同，恢复后仍须核对 Git 状态和整个父任务的当前验收标准。

Codex native queue 是这项工作的唯一调度器。`queue/add` 本身可以立即启动工作，attempt 标记用于关联证据，不是原生幂等键。该版本不保证 exactly-once；它先保存派发意图和已有 receipt，并在歧义时停止，不盲目重试。执行只面向本任务创建的 worker thread，不接管任意现有用户 chat，不扫描对话建议，不新建原生 Goal，也不增加后台 watchdog 或自动唤醒 chat。

## 持久状态与恢复

工程状态写到 `.codex/supervisor/state.v1.json`，执行 proposal／grant／receipt 写到同目录的 `execution.v1.json`，交接位于 `.codex/supervisor/handoffs/`。将 `.codex/supervisor/` 加到工程 `.gitignore`。公开 roster/status/handoff 不返回私有领域 prompt 或模型 route；如要使用某学院的私有领域指导，只在本地读取该导师 `domainPrompt`。

写操作使用独占锁和原子替换；损坏、未知版本、并发 writer 或不合法状态直接报错，不清空记录。检查点保留最近 20 条，输出和输入都有界。交接内容按摘要寻址，同一检查点重复调用得到同一文件；修改／破坏已有交接文件会被检测，新检查点使旧的当前交接指针失效。旧工件仍保留作为历史数据。

交接只存可读、可检查的任务摘要和证据引用，不自动创建新 chat、注入消息、归档源会话或迁移权限。恢复前需要重新核对当前 Git 状态及证据时效。有限的敏感信息检查不能保证正文无隐私；任何分享前仍需检查工件内容。进程异常留下瞬时写锁时，应先确认 writer 已退出，再人工处理该工程中的锁；工具不会凭超时抢占一个仍可能活跃的 writer。执行 runner 租约只在持有者进程确已退出后可接手；接手租约不证明原生工作已经结束。

## 能力与边界

| 能力 | 当前行为 |
| --- | --- |
| 监督 | 技能指导进行证据评估、停滞处理、职责分配；本地脚本保存检查点 |
| 学院评审 | 选定相关角色，默认一轮、最多两位评审；有原生子代理时独立评审，无工具时明确串行降级 |
| 建议执行 | 已获用户授权的不可变 proposal 进入 owned native worker queue，经独立验收后记录进展 |
| 模型与权限 | 宿主默认或明确选择的原生模型，限定工作区沙箱；DSH route、permissions 不构成宿主授权 |
| 项目记忆 | 有界检查点和交接文件；没有自动知识抽取、跨工程记忆服务 |
| 上下文健康 | 技能在证据不足或上下文不可靠时交接；没有读取内部 compaction 计数 |
| 续行与预算 | 限定时间、默认一次、最多三次已批准尝试；没有未来自动唤醒、watchdog 或强制 token／费用预算 |
| Goal | 可记录原生引用，恢复时检查活动 Goal；不创建／控制 Goal 生命周期或增加第二个 job 调度器 |
| 终端观察 | 只使用当前任务中可用的原生终端工具；没有持续 observer |

关闭／卸载插件后本地状态仍在工程内。已有 native queue 工作应先取消并检查实际终止状态；卸载不替代取消。原电脑的未提交圆桌、项目记忆、终端观察实现尚未找回；本版不声称包含它们，也不宣称 DSH Smart Supervision v2 已实现。

## 开发验证

从 canonical 仓库根目录运行：

```bash
npm run codex:build
npm run codex:check
npm run codex:pack -- --output <deliverable-directory>
```

`codex:build` 同步复用模块和许可证；`codex:check` 检查五个技能、包结构、CLI、执行状态、原生协议和执行链行为，默认使用模拟协议测试，不调用模型；`codex:pack` 生成仅含插件文件的 ZIP 与 SHA-256 清单。产物排除项目状态、私有交接和 P0 证据。实际宿主的安装、执行和审批验收须另外记录。DSH 的 `verify:p0` 保持独立。

规范依据：[OpenAI 插件打包](https://developers.openai.com/plugins/build/plugins)、[技能开发](https://developers.openai.com/plugins/build/skills)、[Codex 固定提交解析器](https://github.com/openai/codex/blob/5009a99dfc07830ddf7464c26f310a2b8532b55d/codex-rs/core-plugins/src/agent_plugin_manifest.rs)。本版采用 portable root manifest + Codex compatibility manifest；未执行公共目录、npm 或 DSH 市场发布。
