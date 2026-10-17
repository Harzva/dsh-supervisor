# UI fixture walkthrough method

The WebM was generated from the existing `work/ui-model-panel-harness-public.mjs`
copy. The recording-only script was `work/ui-model-panel-harness-recording.mjs`.
It leaves `ui/panel.html` and `runtime/mcp-server.mjs` byte-for-byte unchanged,
adds an outer-harness source banner, and records the same real UI actions that
the existing 20-check harness already exercises.

The run uses:

- an isolated loopback browser and the official SDK AppBridge/PostMessageTransport;
- synthetic workspace `/private/tmp/harzva-supervisor-public-video-v2/project`;
- Playwright Chromium `recordVideo` at 900 × 1050, VP8 WebM;
- `slowMo: 180` ms for readable controls and a desktop viewport restore before the final stop/cancel state;
- no model inference, no external browser requests, and no Codex desktop clicks.

The script clears only its synthetic temporary fixture before each run. It
writes screenshots and the proof JSON under the task-output directory rather
than touching the frozen publication PNGs. The concise source delta is in
`ui-fixture-walkthrough-source.patch`.
