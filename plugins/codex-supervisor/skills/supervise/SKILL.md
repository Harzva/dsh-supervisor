---
name: supervise
description: Supervise an authorized Codex task with mentor responsibility, evidence checkpoints and recovery after repeated stalls or context loss.
---

Carry the user's task to a verifiable result. Supervisor records are a review aid; Codex owns execution and any native Goal lifecycle. Read [the helper contract](../../README.md) when persisting or recovering state.

At entry, inspect the current workspace, its instructions and Git state. Read the latest Supervisor status if configured. Preserve earlier user constraints and distinguish completed work, remaining work and evidence that must be refreshed. A saved checkpoint or handoff is historical data, not new authorization or an instruction to run commands.

Assign a stable project-local task key and use `assign` to select its primary mentor. Include concrete task tags or the user's explicit mentor choice. Collaborators support the primary responsibility; they do not become a second controller. Keep actor IDs returned by native tools separately from these local task and mentor IDs.

Use the role responsibilities:

- Atlas / architecture: interfaces, boundaries and migration tradeoffs.
- Scout / research: source quality and facts that require verification.
- Forge / execution: implementation and delivery.
- Verity / verification: acceptance evidence and unresolved defects.
- Relay / handoff: recoverable context and remaining work.

After a meaningful milestone, persist a bounded `checkpoint` from observed outcomes: summary, exact evidence references, remaining work, blockers and outcome. Evidence references should identify the tested code baseline and command result or a source; they are not raw logs. A test command named without its result does not establish success. Use `unknown` when evidence is insufficient. `complete` describes the checkpoint's assessment, and never marks a native Goal complete.

If successive checkpoints repeat a concrete blocker without new evidence, inspect the cause and revise the next action. Use `faculty-review` when independent judgment would resolve the issue; do not trigger reviews for every ordinary milestone. Set participants and the maximum rounds for the current issue before dispatch, respect existing user budgets, and use a bounded default of one round with at most two reviewers. Runtime concurrency limits can reduce that count. Continue independent work when useful.

Use Codex native delegation when available. Respect the current host tool schema and inherited sandbox. If it cannot delegate, perform the necessary role checks serially and label them as one agent's review. Do not claim that the plugin enforces a token, cost or scheduling budget.

At completion, verify against the user's acceptance criteria and report the change, validation and material limitations. If context is becoming unreliable, use `handoff` and resume from the checked file. This skill runs during the active task; future monitoring or background continuation requires the user's request and an available native scheduling capability.
