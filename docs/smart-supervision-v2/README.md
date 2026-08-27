# DSH Smart Supervision v2 规划索引

> 状态：设计基线已批准；P0 已建立 private canonical Git/远端与 P10 有界运行锁值，但生产 Profile lock 漂移门尚未关闭，因此 P0 保持部分完成。P1/P2 未授权。
>
> 日期：2026-08-27

## 目的

本目录以标准开发流程定义 `dsh-supervisor` 的下一代智能监管系统。规划目标是把当前基于 todo 与短建议的接管模式，升级为原生 Goal 感知、证据驱动评估、可重规划、可有界召集 GroupX 讨论并可恢复的监督控制面。

本目录包含已批准的需求、架构、开发计划、验收标准，以及 P0 的脱敏工程证据。P0 未实现监管业务功能，也未对 Profile 执行安装、重启、覆盖或恢复；闭环复核发现的外部 lock 漂移已单独阻塞记录。

## 审批记录

- 审批日期：2026-08-27（Asia/Shanghai）。
- 审批主体：产品负责人。
- 已批准范围：ADR-001～ADR-015，以及 [`01-需求分析.md`](01-需求分析.md) 的 PD-001～PD-010。
- P0 收口授权：允许建立 private `Harzva/dsh-supervisor`、透明 Git 基线、`main`/`feat/smart-supervision-v2` 并上传；允许锁定 P10 矩阵与预算，但 P0 不执行模型调用。
- 后续未授权事项：P1～P10 实施、转为 public、npm 发布、安装或修改 Profile、真实 Council。
- P0 授权边界：允许安全可恢复的本地源码恢复、构建、测试、pack 和脱敏证据；不允许伪造 Git 历史或把现有脏工作树当作 P4 实施基线。
- 范围保留：FR-022 Matrix 与 FR-023 HARVIS/业务角色包仍是 P2 可选范围，由 P0 另行锁定；本次审批不隐式纳入。
- 变更控制：任何改变已批准语义、预算、安全边界或所有权的提议，必须先新增/修订 ADR 并重新审批。

## 阅读顺序

1. [`01-需求分析.md`](01-需求分析.md)：目标、边界、用户场景、功能与非功能需求。
2. [`02-架构设计.md`](02-架构设计.md)：所有权、模块、接口、状态机、数据流和最终文件树。
3. [`03-开发计划.md`](03-开发计划.md)：分阶段任务、阶段验收、回滚和新会话提示词。
4. [`04-验收矩阵.md`](04-验收矩阵.md)：需求到自动化、运行时和人工验收的映射。

实现完成后再新增 `05-验收报告.md`，不得预先把计划项标记为完成。

## P0 前已确认的基线事实

以下事实记录规划开始时的基线，实施后必须由各阶段证据取代，不能长期当作当前运行状态。

- DSH 原生 Goal 是事件溯源的持久目标状态；Goal Round Driver 是同会话续行调度器。Goal 不是 todo 清单，也不是独立会话。
- 当前 Supervisor 的 `plan` 策略只读取 todo 投影并生成短建议；它不创建、编辑、完成或阻塞原生 Goal。
- 当前 active Goal 让位检查只覆盖部分调度路径，watchdog 仍可能直接生成并注入建议。
- 当前 `faculties`、`mentors`、Supervisor session-group 和 GroupX 运行成员是四种不同实体，没有共享角色权威源。
- 当前 `dsh-identity-library` 已实现 Identity/Harness/Brain 分离和 Prompt 不出 Host 的安全边界，但尚无版本化通用角色合同。
- 当前 DSH 原生 GroupX 成员是人工选择的 provider/model 执行者；版本化 RoleRef 和多轮角色注册表仍处于规划阶段。
- P0 已从当前运行产物恢复规范 `src`，建立单一 build/test/pack/scan 门槛并统一 package/启动诊断为 `0.2.4`；canonical source 已落在 private `Harzva/dsh-supervisor` 的透明根基线。固定 tarball 与后续 Client 修复的差异已单独记录，原 tarball 因含历史 runtime identifier 只保留为本机私有工件，现有持久 Store 行为未修改。

## 已批准 ADR

以下决策已成为 v2 设计基线；“已批准”不等同于“已授权实施”。

| ADR | 决策 | 状态 | 核心理由 |
| --- | --- | --- | --- |
| ADR-001 | 原生 `ctx.goals` 是唯一 Goal 生命周期权威 | 已批准 | 避免第二套 objective/phase/round 状态产生分叉 |
| ADR-002 | 新建中立 `dsh-role-core`，不让 Supervisor 或 GroupX 独占角色真源 | 已批准 | 角色可跨 Identity、Supervisor、Council 复用且不形成反向依赖 |
| ADR-003 | 共享版本化 `RoleRef`，不共享运行成员实例 | 已批准 | 角色语义稳定，执行者的会话、模型、熔断和生命周期保持隔离 |
| ADR-004 | 采用混合权限：建议模式需确认，显式智能接管后允许有界自动讨论 | 已批准 | 同时保留用户控制与长任务自治 |
| ADR-005 | GroupX 提供可选 `CouncilService`；缺失时降级为单 Supervisor 建议，不伪造共识 | 已批准 | GroupX 故障不得阻塞原生 Goal |
| ADR-006 | 为每个 stock Goal queue candidate 增加最小 fail-local `goal/before-next-round` seam，并补 runtime-context capability/delivery 合同 | 已批准 | `turn-stopping` 不具 finality；completed 可空的 seam 支持 resume 首轮、取消和用户优先，仍不 fork Driver |
| ADR-007 | v2 使用独立版本化 Store，不直接提升现有 `supervisor-state.v1.json` 版本 | 已批准 | 防止旧分配、设置、健康度和 Handoff 被清空 |
| ADR-008 | Host 拥有目标策略、角色解析、讨论事务和持久化；Client 只消费有界 JSON | 已批准 | 符合 DSH/Cordis 所有权与故障隔离规则 |
| ADR-009 | 模型只接收有界 Decision Artifact，不接收原始 Group 记录或整段会话日志 | 已批准 | 控制隐私、token、提示词注入和审计风险 |
| ADR-010 | 实施第 0 阶段先恢复 Git、源码、版本和构建制品的一致性 | 已批准 | 当前目录不能支持可审查、可回滚的长期开发 |
| ADR-011 | Policy 使用 stable GoalSubject + exact bound GoalRef；grant 不跨 revision | 已批准 | resume 可恢复策略历史，同时防止语义变化沿用旧自治授权 |
| ADR-012 | Council v1 只产生 `advisory/unresolved`，不提供 formal ratification | 已批准 | 多数意见不能冒充用户批准或系统共识 |
| ADR-013 | Supervisor v1 为单 Host writer，第二实例 fail closed | 已批准 | 避免重复 Loader/HMR 与 Store writer 竞争，不提前引入分布式 lease |
| ADR-014 | CandidateSnapshot 只表示用户批准的候选池；每次派发前冻结 exact ParticipantPlan 并让 receipt/result 绑定 digest | 已批准 | 让“允许谁参加”和“本次实际谁执行”都可审计，阻止 Provider 临场替换、减员或扩员 |
| ADR-015 | Goal 预算只由 `reserved/accepted/settled/released` reservations 推导，首次合格请求 CAS 建账，扩额必须独立确认 | 已批准 | receipt 后、usage 前仍能守恒，重启不双计，也不能用 policy/restart 重置额度 |

## 关键语义

```text
RoleDefinition / RoleRef       共享、版本化、只读角色语义
├── IdentityAssignment         某会话是谁
├── SupervisorProfile         谁长期负责监督、采用什么监督策略
└── CouncilParticipantPlan    某次讨论中哪些 exact Actor/RoleBinding 实际执行

ActorRef                       实际执行载体：模型、Agent 或 Harness
Goal                           DSH 原生持久目标
SupervisionPolicy              stable GoalSubject + exact bound GoalRef 的评估与升级策略
Deliberation                   一次有预算、有截止时间、可审计的讨论事务
CandidateSnapshot              用户明确批准的 GroupX 候选池
ParticipantPlan                本次讨论冻结的 exact execution roster
```

学院成员与 Group 成员因此不是同一实体。二者共享角色定义，但分别拥有独立的成员绑定和运行状态。

## 实施授权门

ADR-001～ADR-015 与 PD-001～PD-010 已通过设计审批，P0 已收到独立启动与 Git/远端收口授权；仓库上传已完成，但 Profile LKG 漂移使闭环标签暂缓。后续阶段仍按 [`03-开发计划.md`](03-开发计划.md) 逐阶段授权；P0 的仓库上传与 P10 锁值不外溢为 P1/P2 实施、public/npm 发布、Profile 安装、真实模型调用或自动讨论授权。
