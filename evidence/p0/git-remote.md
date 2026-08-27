# P0 Git and remote evidence

Recorded: 2026-08-28

- Canonical owner/repository: `Harzva/dsh-supervisor`
- Remote: `https://github.com/Harzva/dsh-supervisor.git`
- Visibility: private
- Default branch: `main`
- Stage branch: `feat/smart-supervision-v2`
- Transparent root baseline: `e27e9208dda5972916cdc0aee2cfaccf90d05cb1`
- Planned closure tag: `p0-0.2.4` (not created while the Profile drift gate is open)
- History rule: no reconstructed or synthetic pre-import commits

`main` remains at the transparent root baseline. `feat/smart-supervision-v2` is the only branch authorized to receive the subsequent P0 closure-gate evidence while the Profile LKG decision is open. The original rollback tarball, local runtime baselines, legacy Client backup and dependency directory are Git-ignored and absent from the remote. The repository contains their sanitized hashes or disposition only where required.

Both a source-only local copy and a fresh remote clone must complete frozen offline install, build, 16 tests, preflight, public scan and exact 19-file pack before P0 is accepted. The production Profile and protected external worktrees are not part of the Git import.
