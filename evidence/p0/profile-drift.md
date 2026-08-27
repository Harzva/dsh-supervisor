# P0 production Profile drift and LKG disposition

Detected and revalidated: 2026-08-28

## Facts

- The recorded pre-closure Profile manifest SHA-256 was `8e913f799f500093f26731c3791dd526a2162ecc2b4f22d7b99bed61d0c5f962`; the lockfile SHA-256 was `fa626cc7fac21243418b39c8c62eddc1da26f7b2ce7fcc125061b473a6029ddb`.
- The first closure observation found the manifest unchanged and the lockfile changed to `dda3807f397320a959522906e5af2cf90d69bbff9ce01d3e10caba06f806b52b`. Filesystem metadata recorded that lock replacement at `2026-08-28T03:26:51+08:00`, followed by a runtime start at `2026-08-28T03:27:01+08:00`.
- A later read-only closure revalidation found the manifest changed to `d2f008d6ef739548a323efd6991499251e91fe08875c6f0d5b161c76455f4903` and the lockfile changed again to `5f167a69b308fd840bbd63f65610c99c75255bca864c03370631c340bf91f481`.
- A subsequent observation found the manifest changed again to `1b0533552d05842998e7151280d84f5b4a9a9e4915510c1f1738e48df9876af2` and the lockfile changed again to `1a75aa1ecd07dfb2a2d35b3e9df5a6c571fc7af8e0b456a82975f2e3819339f1`. At that observation the lockfile and installed package-manager projection were byte-identical; filesystem metadata and the runtime start were both `2026-08-28T04:41:36+08:00`.
- The base composition, local composition patch, bootstrap patch and Supervisor Loader row still match the P0 baseline. The Loader row remains unique, enabled and configured with three faculties.
- The protected GroupX branch, HEAD, tracked/untracked status-entry counts and dirty-tree digest still match the P0 baseline.
- P0 executed no Profile install command, no explicit restart command, no Loader mutation and no model/Council call.
- The product owner explicitly accepted the latest exact manifest and lock/projection pair as the new P0 LKG, provided every digest still matches immediately before tagging. The same instruction prohibits restoring the old lock.
- Closure rechecks found manifest `1b0533552d05842998e7151280d84f5b4a9a9e4915510c1f1738e48df9876af2`, lockfile `1a75aa1ecd07dfb2a2d35b3e9df5a6c571fc7af8e0b456a82975f2e3819339f1` and installed projection `1a75aa1ecd07dfb2a2d35b3e9df5a6c571fc7af8e0b456a82975f2e3819339f1`; the two lock files were byte-identical. An independent read-only audit repeated the same result and found the unchanged composition, Loader-row and GroupX safeguards still matched.

## Interpretation boundary

The timestamps are correlated but do not prove which process or actor changed the manifest or lockfile. A linked-package change may be observed by runtime automation, but causality is unproven and must not be stated as fact.

## Disposition

No attempt was made to overwrite, reconstruct or restore the production Profile. The latest observation is the approved candidate for the new P0 LKG because the product owner explicitly approved that exact pair and the local closure rechecks matched; lock/projection equality alone was not treated as approval. Earlier observations remain audit history and their cause remains unproven. Final promotion and `p0-0.2.4` remain conditional on the exact remote commit passing fresh-clone verification while the approved pair still matches immediately before tag creation; any mismatch fails closed. This disposition requires no restoration of the old lock and grants no future Profile mutation authority.
