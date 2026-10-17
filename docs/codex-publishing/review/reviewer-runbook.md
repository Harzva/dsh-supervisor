# Clean installation and reproducible review

Use a dedicated sample-only local desktop environment. Do not uninstall an existing user's plugin, erase previous Supervisor records, copy authentication files or alter HOME/CODEX_HOME to make a test pass. The submitting publisher must confirm reviewer access through the approved local-MCP channel. The plugin has no publisher-operated login or remote MCP endpoint; native execution requires an already authenticated local Codex account with an available model and the host's existing authorized file/cache access.

## Freeze the candidate

Record the exact final `plugin.json` version and ZIP SHA-256. The existing 0.4.0 evidence is a baseline; a policy/asset-only update can reuse runtime evidence only when its runtime and HTML digests match or the changed surface is separately checked. Never label a newer untested runtime as tested merely because its version is similar.

Inspect `node --version`, `codex --version` and current CLI help. The tested runtime was Node 22+ and codex-cli 0.149.0 on macOS. Install Node/Codex through their ordinary trusted installation flow when absent. MCP and MCP Apps JavaScript dependencies are already bundled; installation does not require npm downloads. Resolve a real existing empty directory as `REVIEW_WORKSPACE`. Create a second empty sample directory and a symlink alias `REVIEW_WORKSPACE_LINK` only for N2.

## Install a fresh copy

After organization allowlist confirmation, use the portal's documented desktop-only upload route and the installation instructions OpenAI provides for the review environment. For a local development reproduction, use a separate authorized test machine/profile:

1. Extract the frozen ZIP into a new wrapper at `<review-marketplace>/plugins/codex-supervisor`; preserve its root `plugin.json`, `mcp.json`, runtime, skills and assets.
2. Create `<review-marketplace>/.agents/plugins/marketplace.json` with the local development descriptor below. This wrapper is a review fixture and is not the public distribution channel.
3. Verify installed CLI help supports the commands, then register and install:

```bash
codex plugin marketplace add /absolute/path/to/review-marketplace
codex plugin add harzva-supervisor@harzva-supervisor-review --json
```

Descriptor:

```json
{
  "name": "harzva-supervisor-review",
  "interface": { "displayName": "Harzva Supervisor review fixture" },
  "plugins": [{
    "name": "harzva-supervisor",
    "source": { "source": "local", "path": "./plugins/codex-supervisor" },
    "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
    "category": "Productivity"
  }]
}
```

Start a fresh local desktop conversation so tool discovery sees the new installation. Confirm five skills and seven MCP tools. Check the `supervisor_panel` tool's thread entrypoint and `ui://harzva-supervisor/panel`; the other six controls must be app-only. Compare the native resource bytes with the installed `ui/panel.html`. Discovery itself must not create project state or a model turn. A naturally required app refresh is not proof of an installed fixed toolbar button.

## Tool argument contract

`supervisor_panel` takes `{}`. `supervisor_bind_workspace` takes `{ "workspace": "<absolute real directory>" }`. Status, model discovery and stop each take `{ "bindingId": "<UUID returned by this conversation>" }`. Enable takes `bindingId`, boolean `enabled`, integer `expectedRevision`. Execution settings take `bindingId`, `mode` (`default` or `custom`), `model`, `reasoningEffort`, `expectedRevision`; default mode requires both selection values to be null. Unknown fields are rejected. The host supplies the thread context; never simulate it with an untrusted workspace or assume the MCP launch cwd is the project.

The model cannot call app-only controls as a shortcut. Positive prompts guide the reviewer; the reviewer performs the corresponding panel actions. An SDK protocol probe may test isolation on its own fresh ephemeral threads using the supported `mcpServer/tool/call` route; no arbitrary existing user chat is targeted. The native host overwrites caller `_meta.threadId`.

## Cases and observable checks

| Case | Reproduction | Evidence to record |
| --- | --- | --- |
| P1 | Open unbound panel; explicitly select REVIEW_WORKSPACE; refresh. | Binding belongs to this conversation; correct real path; no jobs; no project writes from binding alone. |
| P2 | Read models; choose an actual model and supported effort; save and refresh. Replay the old settings revision in the isolated SDK fixture. | Saved revision/selection; no turn; stale write rejected without changing file hash; conversationModelAvailable=false. |
| P3 | With no jobs, switch off, refresh, switch on, refresh. | Revision changes; no jobs started; no Goal, roster or execution state created by the switch. |
| P4 | Initialize/assign a sample task, propose/authorize/run the one-attempt file fixture below. | Native completed receipt and exact actual selection; 2/2 checks; progress checkpoint; no parent Goal completion. |
| P5 | Start the separate stop fixture; wait for a durable running receipt; click Stop once and refresh. | Gate false; intent first; confirmed native interrupted/local cancelled, or an explicitly unconfirmed cancelling/uncertain result. No acceptance or replay after cancellation. |
| N1 | Use a second isolated conversation without binding. Attempt first conversation's token via the SDK fixture for status, settings and stop. | UNKNOWN_BINDING and unchanged first-project hashes; second panel cannot discover the first binding. |
| N2 | Select the sample symlink or nonexistent path. Also reproduce replacement during catalog await with the unit fixture. | UNSAFE_PATH/INVALID_WORKSPACE; no foreign state writes or successful binding. |
| N3 | Propose a suggestion; skip authorize; attempt run only in the unapproved fixture. | NOT_RUNNABLE or authorization refusal before any attempt/thread/queue; no manufactured grant. |

### P4 file fixture

Initialize with the packaged setup workflow and assign `review-file`. Save native model/effort values first so proposal resolution binds them before the digest. Place this non-sensitive JSON outside the plugin cache in the sample workspace:

```json
{
  "instruction": "Create review-result.txt in the project root containing HARZVA_SUPERVISOR_REVIEW followed by a newline. Change no other project files. Stop after implementation.",
  "successCriteria": ["review-result.txt exists and its trimmed UTF-8 content equals HARZVA_SUPERVISOR_REVIEW."],
  "verification": [
    { "kind": "file", "path": "review-result.txt", "contains": "HARZVA_SUPERVISOR_REVIEW" },
    { "kind": "command", "argv": ["node", "-e", "if (require('node:fs').readFileSync('review-result.txt', 'utf8').trim() !== 'HARZVA_SUPERVISOR_REVIEW') process.exit(1)"], "timeoutMs": 30000 }
  ],
  "timeoutMs": 120000,
  "maxAttempts": 1
}
```

The reviewed user's P4 prompt authorizes the file change and these acceptance checks. The execute skill runs `propose`, retains its digest, records that existing user grant with `authorize`, and invokes `run`. These are local scripts, not additional MCP tools. Use `settings.mjs show` and the returned proposal to confirm selected model/effort before authorization. Changing defaults afterward must not change this granted job. This real case consumes one native inference turn; do not repeat it to generate cosmetic new evidence.

### P5 stop fixture

Use a separate `review-stop` job, one attempt and a 120-second bound. Authorize only a local sample task that must wait 45 seconds before creating `review-stop-result.txt`; use the same two acceptance forms with a separate marker and path. Start through execute, then wait only until the native turn/running receipt has been saved. Click Stop before the delay ends. Record request time, status transitions and native terminal confirmation, without raw transcripts or access tokens. If the task already finished before Stop, record that outcome and do not call it a successful in-flight cancellation test. If an orphaned process cannot be confirmed stopped, keep the pending result and reconcile it without redispatch.

## Evidence status

Baseline native installation and execution/cancellation proofs exist; unit tests cover the parameter, CAS, authorization and path cases. These are not a completed run by a yet-unspecified dedicated reviewer account. Before submission, run the eight cases with the accepted review environment, create an accessible video walkthrough, freeze its package/evidence hashes, and enter any required reviewer access through the secure portal form. Never put credentials or raw conversation logs in the manifest or ZIP.
