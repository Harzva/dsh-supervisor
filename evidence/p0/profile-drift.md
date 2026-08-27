# P0 production Profile drift

Detected: 2026-08-28

## Facts

- The recorded pre-closure Profile lockfile SHA-256 was `fa626cc7fac21243418b39c8c62eddc1da26f7b2ce7fcc125061b473a6029ddb`.
- The current Profile lockfile SHA-256 is `dda3807f397320a959522906e5af2cf90d69bbff9ce01d3e10caba06f806b52b`.
- The current Profile lockfile and the installed package-manager lock projection are byte-identical.
- Filesystem metadata records replacement at `2026-08-28T03:26:51+08:00`; the current DSH process started at `2026-08-28T03:27:01+08:00` under the system service manager.
- The Profile package manifest, base composition, local composition patch, bootstrap patch and Supervisor Loader-row digests remain equal to the P0 baseline.
- The protected GroupX branch, HEAD and dirty-tree digest remain equal to the P0 baseline.
- P0 executed no Profile install command, no explicit restart command, no Loader mutation and no model/Council call.

## Interpretation boundary

The timestamps are correlated but do not prove which process or actor changed the lockfile. A linked-package build may be observed by runtime automation, but causality is unproven and must not be stated as fact.

## Disposition

No attempt was made to overwrite, reconstruct or restore the production lockfile. P0 remains partial until the product owner either accepts the current lockfile as the new LKG after review or provides an authorized, byte-exact recovery source and recovery instruction. The canonical Git baseline and private remote remain valid, but no closure tag is created while this gate is open.
