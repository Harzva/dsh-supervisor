# dsh-supervisor

DSH Host + Client plugin for per-session supervision, role-aware Supervisors, durable responsibility assignments, context-health warnings and recoverable Handoff workflows.

## Platform repositories

This repository maintains the DSH plugin, `dsh-supervisor@0.2.4`.
The Codex edition is developed and packaged independently in
[`Harzva/codex-supervisor`](https://github.com/Harzva/codex-supervisor),
with the plugin identifier `harzva-supervisor`. The two editions have
separate build, installation and marketplace submission flows.

## Screenshot: session matrix integration

![Supervisor controls in the DSH session matrix](docs/images/supervisor-session-matrix.png)

The screenshot shows Supervisor 0.2.7 in a local DSH 0.2.2-rc.1 preview,
with the separate Better Sidebar and session-board plugins providing the
matrix. It contains a single test session. This repository’s current `main`
contains Supervisor 0.2.4; the 0.2.7 working version shown here has not yet
been incorporated into this branch. Model-driven supervision and takeover
were not exercised in this preview.

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
