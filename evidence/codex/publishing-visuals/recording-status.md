# Recording status

A playable walkthrough is available at the task output path
`outputs/codex-submission-0.4.1/ui-fixture-walkthrough.webm`. It was
recorded from the installed 0.4.0 runtime with Playwright `recordVideo` and
180 ms `slowMo`, using the actual SDK AppBridge/PostMessageTransport fixture.
The opening banner says:

> UI fixture walkthrough · SDK AppBridge test host · synthetic sample data · no model inference · not Codex desktop

The recording shows real fixture interactions for workspace binding, the
Supervisor switch, model/reasoning-effort selection and save, stale settings
refresh, the empty-queue stop control, a waiting synthetic job, and its stop
and refresh cancellation. It does not claim a Codex desktop placement or a
real desktop conversation. The installed runtime and panel HTML hashes and
the 20-check result are preserved in `ui-fixture-walkthrough-proof.json`.

No new paid model inference or external browser request was dispatched while
recording. The official Codex desktop end-to-end recording remains a separate
review limitation.
