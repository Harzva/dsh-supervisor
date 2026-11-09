# 接管模式下"排队执行难触发" —— 机制与对策（归档）

> 关联：dsh-supervisor 接管模式（`mode: takeover`）；DSH agent-loop 队列机制。
> 结论：通过把接管注入流调稀疏（降 rounds + 拉长 intervalMs），让 turn 更快收敛回
> idle，用户排队消息更容易被唤醒执行。已应用默认 `rounds:3 · intervalMs:20000`。

## 现象

GUI 显示会话「2 queued messages」等排队消息，但用户自己的真实输入/指令长时间不触发、
不执行。尤其接管模式下很明显。

## 根因（DSH agent-loop / inbox 机制）

依据源码：
- `packages/core/agent-loop/src/agent.ts`（`wakeDriver` / `turn`）
- `packages/core/agent/src/inbox.ts`（`hasPending` / `claim` / `next-turn` / `next-step`）

1. **`wakeDriver()` 非空闲只闩存（latch），不打断当前 turn。**
   ```js
   // agent.ts:172-182
   if (this.phase.kind !== 'idle') {
     if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
       this.phase.wakeRequested = true   // 排队消息的 wake 被挂起
     }
     return
   }
   // 只有 idle 才立刻开新 turn
   ```
2. **`turn()` 循环只有到 `turnEnds && inbox.nextStep.length === 0` 才 break 回 idle。**
   只要下一个 step/queue 还有内容，就继续 claim 并跑，不收敛。
3. **接管模式下 supervisor 每轮 `followup()` 注入**（`injectText` → `agent.followup`，
   dsh-supervisor `src/index.js:543/561`）。`followup` = `send(input,'next-turn',true)`，
   是唤醒型消息；叠加 `intervalMs=5000`（每 5s 一条），turn 循环持续把注入消化掉，
   **用户排队的真实输入其 wake 一直被闩存**，直到接管注入流（rounds 用完 / suggesting 结束）停止。

## 次要因素

- `used`（已用轮数）是**内存态、不持久化**：重启后回 0，接管从第 0 轮重新跑 10 轮，
  又开一段注入流，进一步推迟排队消息。

## 对策（已应用）

- **本会话**：`POST /dsh-supervisor/state` `{sessionId, patch:{intervalMs:20000, rounds:3}}`
  → store `settings[sid]` 已写入 `{rounds:3, intervalMs:20000}`。
- **默认值**：`~/.dsh/profiles/digital-me/cordis.patch.yml` 的 `dsh-supervisor` 行加
  `rounds: 3` + `intervalMs: 20000`（含注释说明）。
- **每会话覆盖**：`/supervise on [N]`（轮数）、`/supervise interval [秒]`（间隔）。

## 边界

- 该改动只影响**下一次建议的调度**，不改变已在途的 turn。
- supervisor 建议注入本身仍走 `followup`（唤醒型）。若后续需要更彻底地让位给用户排队
  消息，可把接管注入改为**非唤醒型**（投进 `next-step` / `wakeup:false`），但会延迟建议
  显示，未采用。
