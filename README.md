# dsh-supervisor

DSH Host + Client plugin for per-session supervision, role-aware Supervisors, durable responsibility assignments, context-health warnings and recoverable Handoff workflows.

## Codex edition

The independent `harzva-supervisor@0.3.0` Codex development plugin lives in
[`plugins/codex-supervisor/`](plugins/codex-supervisor/README.md). It packages
supervision, authorized execution, faculty review and handoff skills, reusing
the canonical mentor rules. The execution chain binds an immutable proposal
digest and user grant to one workspace, submits work to an owned Codex native
queue, independently checks files or sandboxed commands, and records a
progress checkpoint. Run `npm run codex:check` to verify it and
`npm run codex:pack` to build its portable ZIP. The repo marketplace is
`.agents/plugins/marketplace.json`.

The local MCP App adds a Supervisor conversation tab with a persisted workspace
switch. Select a project explicitly in the panel. Switching off blocks new
dispatch and retry; running work may finish. Switching on does not grant a
proposal, create work or monitor chats. Bindings are isolated by host thread,
and updates use a revision check. The package bundles its MCP/UI SDK dependencies;
development builds require `npm ci`, while installed usage requires no npm install.

The adapter uses the installed Codex 0.149.0 experimental app-server queue
contract and existing login. Defaults are one attempt, bounded execution and
human approvals. Only a confirmed failure can retry within the approved cap;
uncertain dispatches stop for recovery. Native completion alone never marks
the parent task complete. The native queue is the sole job scheduler; this
edition does not scrape chats, install a watchdog or automatically map DSH
model routes. Version 0.2.1 allows native startup events and thread materialization
to settle before bounded receipt reads; it never resubmits acknowledged work to
repair a read error and retains safe transport diagnostics. The calling host must
permit writes to the project's protected `.codex/supervisor/` directory and the
native CLI's own cache/login state. A default workspace-write host may block those
paths; the plugin does not change global permissions. The DSH package remains
version `0.2.4`; Smart Supervision v2 and
DSH marketplace publication retain their separate implementation tracks.
See [`evidence/codex/README.md`](evidence/codex/README.md) for takeover findings
and the verification boundary.

## Supervisor configuration

The plugin accepts an optional legacy-compatible `mentors` array. Existing `faculties` configurations are automatically projected into role-aware Supervisors, so older profiles continue to work.

```yaml
- id: dsh-supervisor
  config:
    handoffWarnCompactions: 2
    handoffRecommendCompactions: 3
    mentors:
      - id: code
        name: Forge
        role: execution
        route: provider/model
        color: '#b45309'
        responsibilities:
          tags: [开发, 实现, 调试]
          workspacePatterns: ['*/engineering/*']
          presets: [standard]
          description: 负责工程实现、调试和交付闭环
```

Supported roles are `architecture`, `research`, `execution`, `verification`, and `handoff`.

## Matrix API

- `GET /dsh-supervisor/states?ids=...` — bounded compact states including mentor, assignment, health and Handoff summary.
- `GET /dsh-supervisor/mentors` — public mentor roster without model routes.
- `POST /dsh-supervisor/assignment` — set one primary mentor and at most two collaborators.
- `POST /dsh-supervisor/state` — update supervision mode/strategy and a per-session, per-Supervisor model override through `patch.supervisorModel: { supervisorId, route }`.
- `GET|POST /dsh-supervisor/handoff` — inspect or advance a Handoff transaction.

The Handoff route uses an idempotent transaction with a preallocated target session id. It supports model-generated drafts, validated safe fallback summaries when a provider is unavailable, cold-session prompting through the official connection API, workspace/Preset inheritance, and bidirectional source/target navigation in the matrix drawer.

All APIs are local-profile JSON routes. They do not expose live Cordis objects or raw session logs.

## State and recovery

Assignments, per-Supervisor model overrides, successful compaction counts, Handoff records and bounded audit metadata are stored atomically under the active DSH home. Removing the plugin row disables the feature without deleting sessions. Source sessions are never automatically deleted or archived.

## Checks

```bash
pnpm install --frozen-lockfile
npm run verify:p0
```

`src/` is the canonical editable source. `lib/` is derived by the single
dependency-free build script and is retained in the package because DSH loads
the JavaScript artifact directly. `npm run check` preserves the existing test
entry point; `npm run verify:p0` additionally checks the public package,
credential/private-path hygiene and pack contents.

The pinned `artifacts/dsh-supervisor-0.2.4.tgz` is the pre-P0 rollback
artifact. Its historical documentation contains a runtime session identifier,
so it is a Git-ignored local-private input and must never be uploaded. Its
digest and the explained post-tarball Client delta are recorded in the
repository-only `evidence/p0/` bundle. A clean clone does not require the
private artifact to build, test or pack, and P0 verification never overwrites
the originating machine's copy.
