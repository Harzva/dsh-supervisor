# P0 closure approval record

Recorded: 2026-08-28
Approved: 2026-08-28

The product owner approved P0-D1 through P0-D6 and authorized creation/upload of the canonical repository under Harzva when required. This approval closes the P0 decision gate; it does not authorize P1/P2 implementation, npm publishing, production Profile installation, or execution of the P10 real Council during P0.

## Verified provenance result

The Supervisor canonical Git repository, owner, and remote remain unresolved after bounded local and public discovery:

- the current `dsh-supervisor@0.2.4` manifest has no `repository`, `homepage`, `bugs`, or `publishConfig` provenance;
- the source directory is not a Git worktree and has no parent Git worktree;
- public stack manifests, lockfiles, configuration, and documentation contain no Supervisor Git URL or owner declaration;
- current Harzva GitHub repository and code searches do not identify a Supervisor source repository;
- the public npm name currently resolves to an unpublished tombstone dated 2026-08-20, which does not expose its historical owner or repository;
- a globally visible third-party repository with the same name has a different owner, version, and product description and is excluded as a namespace collision.

These checks prove that no presently visible source can be promoted to canonical. They do not prove that a private or historical repository never existed. The product owner therefore approved a new transparent baseline rather than reconstructed history or attachment to a namespace collision.

## Approved decisions

| ID | Approved value | Guardrail |
| --- | --- | --- |
| P0-D1 | New private canonical repository `Harzva/dsh-supervisor`, default branch `main` | Public visibility requires a separate disclosure decision |
| P0-D2 | One transparent import baseline plus `feat/smart-supervision-v2`; no synthetic pre-import history | Upload only after repository-level secret/path/session scan passes |
| P0-D3 | Rollback: DSH `0.1.1-rc.2`, Cordis `4.0.1`, GroupX `0.1.0-alpha.24.1`; integration: DSH `0.1.2-alpha.1@cd5ef8148158c3a752a658978873241fdf8e2bbc`, Cordis `4.0.1`, GroupX `0.1.0-alpha.24.1@667a5dd095cade3074ddf9db501b848393c3487c` | Integration matrix must pass a disposable isolated Profile before any real run |
| P0-D4 | `deepseek-official/deepseek-v4-flash` | Current Host proves provider active and catalog-resolvable; credentials, quota and inference health remain a P10 runtime gate |
| P0-D5 | One Deliberation, at most 3 exact participants, one advisory round, at most 7 Provider calls | Current GroupX advisory is `2N+1`; P6 must freeze and revalidate the exact roster because GroupX does not truncate advisory candidates |
| P0-D6 | Hard stop CNY 10 | Pre-dispatch worst-case pricing estimate must fit; unknown price means no dispatch, unknown usage settles the full reservation |

`P0-D3` deliberately separates the immutable rollback LKG from the forward integration candidate. The P4 upstream seam is locked to `deepseek-ai/deepseek-harness@master` commit `cd5ef8148158c3a752a658978873241fdf8e2bbc`. No Profile installation or model call occurred in P0.

## Execution result

- Canonical repository: `https://github.com/Harzva/dsh-supervisor.git`
- Visibility/default branch: private / `main`
- Transparent baseline: `e27e9208dda5972916cdc0aee2cfaccf90d05cb1`
- Stage branch: `feat/smart-supervision-v2`
- Planned closure tag: `p0-0.2.4` (deferred until the production Profile lock drift is dispositioned)
- Private exclusions: original rollback tarball, local runtime baselines, legacy Client backup and dependency directory
- P0 model/Council calls: 0

## Approval source

```text
The product owner approved canonical repository/owner/remote, the transparent Git baseline and stage branch, the exact P10 matrix, Provider/model, Council/Provider call limits, and the bounded cost stop, then authorized upload to Harzva where required.
```

## P0 closure execution prompt

```text
@docs/smart-supervision-v2/README.md
@docs/smart-supervision-v2/01-需求分析.md
@docs/smart-supervision-v2/02-架构设计.md
@docs/smart-supervision-v2/03-开发计划.md
@docs/smart-supervision-v2/04-验收矩阵.md
@evidence/p0/manifest.json
@evidence/p0/checks.json
@evidence/p0/digests.json
@evidence/p0/approval-request.md

Continue only the P0 closure after verifying the exact product-owner decisions in approval-request.md. Do not enter P1/P2.

Recheck the current worktree, package metadata, P0 gates, rollback artifact, LKG Profile digests, and protected external worktrees before mutation. Execute only the explicitly approved Git/repository actions. Never infer approval from a recommendation or placeholder.

Do not push, publish, install or modify a production Profile, execute a real Council, rewrite existing history, or attach a namespace-collision remote unless that exact action has separate authority. If an existing canonical remote is provided, inspect it read-only before choosing import, merge, or worktree strategy.

After the approved actions, rerun verify:p0 and public provenance/secret/path checks, update P0 evidence and 03-开发计划.md, and stop. P1/P2 still require separate authorization.
```
