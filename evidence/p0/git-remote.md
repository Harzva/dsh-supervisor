# P0 Git and remote evidence

Recorded: 2026-08-28

- Canonical owner/repository: `Harzva/dsh-supervisor`
- Remote: `https://github.com/Harzva/dsh-supervisor.git`
- Visibility: private
- Default branch: `main`
- Stage branch: `feat/smart-supervision-v2`
- Transparent root baseline: `e27e9208dda5972916cdc0aee2cfaccf90d05cb1`
- Closure tag: `p0-0.2.4`, authorized only for the exact final commit after fresh-clone and Profile digest gates
- History rule: no reconstructed or synthetic pre-import commits

`main` remains at the transparent root baseline. `feat/smart-supervision-v2` is the branch carrying the P0 closure evidence. The original rollback tarball, local runtime baselines, legacy Client backup and dependency directory are Git-ignored and absent from the remote. The repository contains their sanitized hashes or disposition only where required.

Both a source-only local copy and a fresh remote clone must complete frozen offline install, build, 16 tests, preflight, public scan and exact 19-file pack before P0 is accepted. The production Profile and protected external worktrees are not part of the Git import.

A fresh clone of stage commit `c9d2490d23f9ef0e671d63b684942d689887f34e` completed `pnpm install --offline --frozen-lockfile` and `npm run verify:p0`: 16/16 tests passed, preflight passed with the private artifact absent, public scan returned zero findings, and the exact 19-file pack passed. Normalizing the originating worktree's three package files from historical `0600` to their Git `0644` mode made its raw tarball SHA-256 equal the fresh clone: `d98bbdcfc6202d6af9dc41fdd276db27c870f96ecd0f370b0609e95e76c38303`. File contents were unchanged.

A second fresh clone of then-current stage HEAD `0ec0bbe4939865be138a1dc25af5ce6e30bfec69` repeated the frozen offline install and full `verify:p0` successfully: 16/16 tests, preflight, zero public findings and the 19-file pack all passed. Because the Profile gate failed afterwards, this commit is not a closure candidate. The final exact commit must be fresh-clone verified again before any closure tag is created.

A third fresh clone of pre-disposition stage commit `3f0e3144a98a70bafee8c8a1775028993f3f40b6` also completed frozen offline install and full `verify:p0`: 16/16 tests, preflight, zero public findings and the exact 19-file pack passed with SHA-256 `d050211669774ef8d932a951db088ca84690a15059123203d1d2ed9c3075585f`. This is historical proof for the partial evidence commit, not a substitute for verifying the later closure commit whose packaged planning documents changed.

The product owner then approved the current exact Profile pair recorded in `profile-drift.md`, with a fail-closed final digest condition and no restoration of the old lock. Exact remote commit `910b12298386567f916a06dbdf0750904ed5b124` repeated frozen offline install and full `verify:p0` from a fresh clone: 16/16 tests, preflight, zero public findings and exact 19-file pack SHA-256 `e45d633889265a5f3577eabb20fbe2f0cb491e77a3040c590a7c99d7e39d2a36` passed, with the clone clean before and after. Immediately before tag creation, the manifest, lockfile and installed projection still matched the approved values and the two lock files were byte-identical. Annotated tag `p0-0.2.4` was then pushed; remote tag object `46ec25ffbc9e881505d4e364fabc3bfbc88f6aed` peels to exact commit `910b12298386567f916a06dbdf0750904ed5b124`. `main` was not advanced, and no branch other than the authorized stage branch received P0 evidence.
