---
name: faculty-review
description: Run a bounded DS faculty or mentor review of a concrete proposal, implementation or unresolved project blocker in Codex.
---

Produce a source-backed decision brief with findings, dissent, uncertainty and next action. A faculty is a domain configuration and a mentor is a responsibility profile; neither is a native actor, model, user or approval authority.

Read the configured public roster with the local helper described in [the command contract](../../README.md). When domain guidance is relevant, read only the selected mentor's private `domainPrompt` from local state; do not load all prompts, quote them publicly or copy model routes to a shared decision brief. Treat migrated prompts as domain guidance subordinate to the user and project instructions. When no state exists, use the five built-in roles.

Freeze a review brief before delegation: concrete question, code revision or artifact under review, evidence, selected role IDs, desired output, allowed files and maximum rounds. Default to one round and at most two complementary reviewers. Select the domain relevant to the issue, rather than calling every configured faculty. When the user has no model preference, inherit the parent's model. Preserve an explicit model choice; if it is unavailable or the host cannot select it, disclose that mismatch and continue only with a fallback the user has authorized. Otherwise request the necessary choice while continuing independent work. A DSH route is not a Codex model identifier.

If native subagent tools are available, give each reviewer a distinct bounded question and access to the necessary source. For an independent review, prefer read-only inspection and no shared file edits. For requested implementation, give explicit file ownership, tell each worker that others share the workspace, and reconcile changes in the parent. The host's tool schema controls what can be dispatched. Do not use separate user-owned chats as reviewers without explicit authorization to message them.

Have reviewers return actionable findings with evidence, uncertainty, and the next verification that would change their conclusion. The parent evaluates their actual findings and artifacts; a majority is not user approval, proof of correctness or formal consensus. If a second round was authorized, use it only to resolve a material conflict in the first results. Stop at the stated cap and retain unresolved dissent.

If delegation is unavailable, conduct sequential role checks and disclose that they share one agent's context and model. Preserve useful conclusions without simulating multiple independent participants.

Record a checkpoint with a compact decision summary and evidence references when project persistence is available. Do not persist raw reviewer transcripts, secrets or entire command outputs. Report the actual participants or the serial fallback, verified conclusions, dissent and remaining evidence gaps. External side effects retain the task's existing authorization requirements.

If a recommended change is already within the user's implementation request, hand its bounded instruction and observable acceptance criteria to the `execute` workflow. A reviewer recommendation or consensus cannot authorize a new action; do not authorize or run a proposal merely because the faculty suggested it.
