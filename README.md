# dsh-supervisor

DSH Host + Client plugin for per-session supervision, role-aware Supervisors, durable responsibility assignments, context-health warnings and recoverable Handoff workflows.

## Codex edition

The independent `harzva-supervisor@0.1.0` Codex development plugin lives in
[`plugins/codex-supervisor/`](plugins/codex-supervisor/README.md). It packages
supervision, faculty review and handoff skills with a bounded local record
helper, reusing the canonical mentor rules. Run `npm run codex:check` to verify
it and `npm run codex:pack` to build its portable ZIP. The repo marketplace is
`.agents/plugins/marketplace.json`.

Codex owns execution, delegation, permissions and native Goals. This edition
does not import DSH host events, start a watchdog or automatically map DSH
model routes. The DSH package remains version `0.2.4`; Smart Supervision v2
and DSH marketplace publication retain their separate implementation tracks.
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
