# 下一步 Goal

## Goal Objective

`（本功能域已关闭）Supervisor 圆桌记录 P1（数据层）+ P2（图可视化）已完成并通过总验收，overall_goal_state=closed。无下一 Goal，不生成新 Phase/Goal。`

## Track

`Mainline；已到最终 Phase（P2）并通过总验收 + 唯一总体关闭复核。`

## 最终关闭记录

- **P1（数据层）**：store 落盘 `roundtables[]`（opinions[]/verdict/consensus）+ `appendRoundtable`/`getRoundtables`；`suggestFor` 结构化落盘；`parseRoundtableVerdict` 修正（CJK 非 `\w`，改用关键词搜索且「分歧」优先）。测试 **24/24**。
- **P2（图可视化）**：`src/roundtable-graph.js` 纯函数 `buildRoundtableGraph` + `GET /dsh-supervisor/roundtables/graph` + 客户端「圆桌记录」入口。验收 **G1-G6 全 ✅**（G2/G3 按实际参与集）。测试 **32/32**。
- **重启验证**：真实接管 3 轮落盘；`verdict=分歧` 轮画 3 条虚线分歧边；上线后 `GET .../roundtables/graph` 实时返回真实图（rounds=3,nodes=14,edges=11）。
- **总验收（对照 01-需求 FR-D1..FR-D6）**：D1 opinions 结构化 ✅；D2 consensus ✅；D3 opinions[]=judge 输入 ✅；D4 多轮留存 ✅；D5 verdict 标注 ✅；D6 图可还原 ✅。

## 可复制提示词

```text
（本功能域已关闭，无下一 Goal。若需继续，请基于新需求重新发起 Goal。）
```

---

## 迭代收尾契约（供未来功能域复用）

在结束当前 Goal 前，必须执行以下步骤：

1. 根据磁盘中的开发文档、checkbox、源码和真实测试结果判断当前阶段状态，
   不得只依据对话中的完成声明。
   - 当前 Phase 通过只表示阶段性收尾或下一棒交接；整体 Goal 仍保持未关闭，除非已到最终 Phase、总验收和唯一总体关闭复核。

2. 回写 `docs/supervisor-roundtable-graph/03-开发计划.md`：
   - 当前阶段 checkbox；真实测试/构建结果；风险与偏差；完成/失败/阻塞状态。

3. 按规则计算下一 Goal 或终止状态：
   - 以开发计划为阶段拓扑事实源对账；任何冲突→只生成计划对账 Goal；
   - 当前阶段通过→进入下一个已声明未完成 Phase；验证失败→留在当前 Phase 只修验证；
   - 外部条件阻塞→当前 Phase，分类 Remediation/Approval；
   - 候选不在计划中→只请求修订计划，不建新 Phase；
   - 只有对已记录 blocker 必要且充分、且本 Goal 内可验证后置条件时才称“解除阻塞”；
   - 所有 Phase 完成→总验收；总验收仍有遗留→只修验收报告列出的项并引用 `05-验收报告.md`；
   - 总验收通过→在当前最终 Phase 内执行唯一一次“复核并关闭 Goal”，overall_goal_state=closed，停止，不生成新 Phase/Goal。

4. 原子覆盖 `docs/supervisor-roundtable-graph/NEXT_GOAL.md`：
   - 下一 Goal Objective（P2 关闭后写最终关闭记录，不伪造下一 Goal）；
   - Track（Mainline/Remediation/Approval）及绑定 Phase；
   - 完整可复制提示词；@真实文档与测试路径；明确不做/验证要求/停止门；
   - 本段完整“迭代收尾契约”。

5. 最终答复中的“下一步 Goal/可复制提示词”必须与
   `docs/supervisor-roundtable-graph/NEXT_GOAL.md` 完全一致；
   已关闭时写明“无下一 Goal”。

6. 整体未关闭只生成下一 Goal 接力文件；已关闭只保留最终关闭记录。不得当前 Goal 内执行下一 Phase、
   自动创建新 Goal、提交、安装或发布。
```
