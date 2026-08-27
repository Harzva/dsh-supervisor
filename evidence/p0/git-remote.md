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

A fresh clone of stage commit `c9d2490d23f9ef0e671d63b684942d689887f34e` completed `pnpm install --offline --frozen-lockfile` and `npm run verify:p0`: 16/16 tests passed, preflight passed with the private artifact absent, public scan returned zero findings, and the exact 19-file pack passed. Normalizing the originating worktree's three package files from historical `0600` to their Git `0644` mode made its raw tarball SHA-256 equal the fresh clone: `d98bbdcfc6202d6af9dc41fdd276db27c870f96ecd0f370b0609e95e76c38303`. File contents were unchanged.
