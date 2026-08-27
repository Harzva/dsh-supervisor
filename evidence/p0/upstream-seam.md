# P4 upstream seam lock

Canonical source authority is `deepseek-ai/deepseek-harness`, branch `master`, remote head `cd5ef8148158c3a752a658978873241fdf8e2bbc` at P0 capture time. The P4 owner is the `deepseek-ai` repository; no repository CODEOWNERS file identifies an individual owner.

The inspected local snapshot was clean and shallow at `f63e4dbb57116716036c3663d8236c31fbb3c637`, based on release commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`. It is DSH `0.1.1-rc.2`, while canonical remote Goal Driver and SystemPrompt packages are already `0.1.2-alpha.1`. It is evidence only and must not become the P4 implementation base.

## Approved seam locations to revalidate at P4 start

- Goal owner and queue point: `packages/goal/goal-round-driver/src/index.ts`, private `drive(state)`, after current Goal/capacity validation and before fixed prompt rendering, reservation and the sole `Agent.followup()`.
- Proposed frozen DTO/helper owner: `packages/goal/goal-round-driver/src/policy-seam.ts`.
- Fixed Goal prompt: `packages/goal/goal-round-driver/src/prompt.ts`; P4 must not change it.
- Runtime-context capability owner: existing `SystemPrompt` Service in `packages/core/system-prompt/src/index.ts`, because it owns global/scoped suppression and context assembly.
- Non-restorable pending snapshot fix: Goal Driver `restoreOtherClaimed()` should discard an unadmitted system-prompt runtime snapshot and let the next pre-step reassemble it.
- `agent/turn-stopping` is provisional, not final. Existing `agent/inbox/claimed`, durable `user/message`/`turn/end`, maintenance and admission fences remain the tracking inputs.

The locked approach does not require changing agent-loop production code. P4 must use a newly synchronized dedicated worktree, re-read the then-current root and package AGENTS instructions, preserve the remote `startsRequestSeries` field, and revalidate all line locations before editing.
