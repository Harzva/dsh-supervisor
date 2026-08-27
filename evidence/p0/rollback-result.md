# P0 rollback readiness

The pinned `0.2.4` rollback artifact remains byte-identical to its pre-P0 digest and is excluded from all temporary pack destinations. Upload review found a historical runtime session identifier inside its documentation, so the original artifact is now an explicitly Git-ignored local-private rollback input. Git records only its digest and sanitized provenance; the binary is never committed or uploaded. P0 did not edit the legacy Store, the LKG Profile, its Loader row, installed packages or running processes.

Static rollback readiness passes on the originating machine: the original artifact is present and verified, and the Profile/Loader digests are unchanged. A clean clone verifies the recorded digest and deliberately reports the private artifact as absent. Physical reinstall or Loader-row changes were intentionally not exercised because P0 does not authorize production Profile mutation.

The post-artifact Client fix is deliberately preserved in canonical `src/client.js`; restoring the pinned tarball would also restore the older Client. Any future runtime rollback must therefore be an explicit operator action with that known UI delta, never an automatic P0 cleanup.
