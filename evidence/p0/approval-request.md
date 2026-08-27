# P0 closure approval record

Recorded: 2026-08-28
Approved: 2026-08-28

The product owner approved P0-D1 through P0-D7 across two explicit approvals and authorized creation/upload of the canonical repository under Harzva when required. These approvals close the P0 decision gate; they do not authorize P1/P2 implementation, npm publishing, production Profile installation, or execution of the P10 real Council during P0.

## Pre-approval provenance result

The Supervisor canonical Git repository, owner, and remote were unresolved after bounded local and public discovery:

- the pre-import `dsh-supervisor@0.2.4` manifest had no `repository`, `homepage`, `bugs`, or `publishConfig` provenance;
- the pre-import source directory was not a Git worktree and had no parent Git worktree;
- the bounded pre-import stack-manifest, lockfile, configuration, and documentation search found no Supervisor Git URL or owner declaration;
- the bounded pre-import Harzva GitHub repository and code searches did not identify a Supervisor source repository;
- at capture time the public npm name resolved to an unpublished tombstone dated 2026-08-20, which did not expose its historical owner or repository;
- a globally visible third-party repository with the same name has a different owner, version, and product description and is excluded as a namespace collision.

At decision time these checks showed that no visible source could be promoted to canonical. They did not prove that a private or historical repository never existed. The product owner therefore approved a new transparent baseline rather than reconstructed history or attachment to a namespace collision.

## Approved decisions

| ID | Approved value | Guardrail |
| --- | --- | --- |
| P0-D1 | New private canonical repository `Harzva/dsh-supervisor`, default branch `main` | Public visibility requires a separate disclosure decision |
| P0-D2 | One transparent import baseline plus `feat/smart-supervision-v2`; no synthetic pre-import history | Upload only after repository-level secret/path/session scan passes |
| P0-D3 | Rollback: DSH `0.1.1-rc.2`, Cordis `4.0.1`, GroupX `0.1.0-alpha.24.1`; integration: DSH `0.1.2-alpha.1@cd5ef8148158c3a752a658978873241fdf8e2bbc`, Cordis `4.0.1`, GroupX `0.1.0-alpha.24.1@667a5dd095cade3074ddf9db501b848393c3487c` | Integration matrix must pass a disposable isolated Profile before any real run |
| P0-D4 | `deepseek-official/deepseek-v4-flash` | Current Host proves provider active and catalog-resolvable; credentials, quota and inference health remain a P10 runtime gate |
| P0-D5 | One Deliberation, at most 3 exact participants, one advisory round, at most 7 Provider calls | Current GroupX advisory is `2N+1`; P6 must freeze and revalidate the exact roster because GroupX does not truncate advisory candidates |
| P0-D6 | Hard stop CNY 10 | Pre-dispatch worst-case pricing estimate must fit; unknown price means no dispatch, unknown usage settles the full reservation |
| P0-D7 | New P0 Profile LKG: manifest `1b0533552d05842998e7151280d84f5b4a9a9e4915510c1f1738e48df9876af2`; lock/projection `1a75aa1ecd07dfb2a2d35b3e9df5a6c571fc7af8e0b456a82975f2e3819339f1` | All exact digests and lock/projection byte equality must still match immediately before tag; any mismatch prohibits the tag; do not restore the old lock |

`P0-D3` deliberately separates the immutable rollback LKG from the forward integration candidate. The P4 upstream seam is locked to `deepseek-ai/deepseek-harness@master` commit `cd5ef8148158c3a752a658978873241fdf8e2bbc`. No Profile installation or model call occurred in P0.

## Production Profile LKG disposition

The product owner subsequently accepted the following exact current pair as the new P0 LKG:

- manifest SHA-256: `1b0533552d05842998e7151280d84f5b4a9a9e4915510c1f1738e48df9876af2`;
- lockfile and installed lock projection SHA-256: `1a75aa1ecd07dfb2a2d35b3e9df5a6c571fc7af8e0b456a82975f2e3819339f1`.

The disposition is conditional and fail closed: if the manifest, lockfile or installed projection differs at the final pre-tag gate, `p0-0.2.4` must not be created or pushed. If all three exact checks and the byte-equality check pass, creation and push of `p0-0.2.4` are authorized. The old lock must not be restored. This approval accepts the current bytes as a new LKG; it neither proves the cause of earlier drift nor authorizes any production Profile mutation.

## Execution result

- Canonical repository: `https://github.com/Harzva/dsh-supervisor.git`
- Visibility/default branch: private / `main`
- Transparent baseline: `e27e9208dda5972916cdc0aee2cfaccf90d05cb1`
- Stage branch: `feat/smart-supervision-v2`
- Closure tag: `p0-0.2.4` (pushed and verified; annotated tag object `46ec25ffbc9e881505d4e364fabc3bfbc88f6aed` peels to exact commit `910b12298386567f916a06dbdf0750904ed5b124`)
- Approved production Profile LKG: manifest `1b0533552d05842998e7151280d84f5b4a9a9e4915510c1f1738e48df9876af2`; lock/projection `1a75aa1ecd07dfb2a2d35b3e9df5a6c571fc7af8e0b456a82975f2e3819339f1`
- Old-lock restoration: prohibited for this closure
- Private exclusions: original rollback tarball, local runtime baselines, legacy Client backup and dependency directory
- P0 model/Council calls: 0

## Approval source

```text
The product owner approved canonical repository/owner/remote, the transparent Git baseline and stage branch, the exact P10 matrix, Provider/model, Council/Provider call limits, and the bounded cost stop, then authorized upload to Harzva where required.

The product owner accepted manifest `1b0533552d05842998e7151280d84f5b4a9a9e4915510c1f1738e48df9876af2` and lock/projection `1a75aa1ecd07dfb2a2d35b3e9df5a6c571fc7af8e0b456a82975f2e3819339f1` as the candidate P0 LKG. Any digest mismatch before tagging prohibits the tag; an exact match authorizes creation and push of `p0-0.2.4`; the old lock is not restored.
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
@evidence/p0/profile-drift.md
@evidence/p0/git-remote.md
@evidence/p0/rollback-result.md
@evidence/p0/tests-summary.txt

Continue only the P0 closure after verifying the exact product-owner decisions in approval-request.md. Do not enter P1/P2.

Recheck the current worktree, package metadata, P0 gates, rollback artifact, LKG Profile digests, and protected external worktrees before mutation. The only approved Profile LKG is the exact manifest and lock/projection pair recorded above. Never infer approval from a recommendation or placeholder.

Do not publish npm, install or modify a production Profile, execute a real Council, rewrite existing history, or attach a namespace-collision remote. Git push is limited to the already approved P0 stage evidence and, only after all exact gates pass, `p0-0.2.4`. If the tag already exists, verify it instead of recreating or moving it.

After the approved actions, rerun `verify:p0`, public provenance/secret/path checks and a fresh remote clone of the exact tag target. Immediately before tag creation, recheck the approved Profile pair and lock/projection byte equality. Any mismatch stops without a tag. Otherwise create and push `p0-0.2.4`, verify the remote ref, update P0 evidence and `03-开发计划.md`, and stop. P1/P2 still require separate authorization.
```
