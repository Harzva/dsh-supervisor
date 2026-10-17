# Publication visual evidence

These files preserve the visual material selected for the Harzva Supervisor 0.4.0 publication draft. The source record is [`../ui-panel-0.4.json`](../ui-panel-0.4.json). The source harness uses the official MCP Apps SDK AppBridge and PostMessageTransport over an isolated loopback browser. It uses a random test conversation binding and is separate from the real Codex desktop host.

Do not caption these images as “Codex desktop screenshots”. The real local CLI execution and cancellation evidence is recorded separately in `../native-execution-0.4.json`. The images show the installed panel's rendered UI in a test host.

The two PNGs copied into `plugins/codex-supervisor/assets/` were re-rendered from the same harness source with the synthetic workspace `/private/tmp/harzva-supervisor-public-demo-v2/project`; they are not image-edited derivatives. The 20-check proof is `harness-public-proof.json`. The original source images in `../ui-0.4/` remain private historical evidence and should not be uploaded as listing media.

The five publication rerenders are preserved as `supervisor-panel-harness-public-*.png`; the source proof is `harness-public-proof.json`.

## Captures

| File | Raster size | Directly visible state | Honest caption |
| --- | ---: | --- | --- |
| `supervisor-panel-harness-light.png` | 720 × 1114 | Light panel with the `Supervisor` title, synthetic project binding, enabled switch, execution model `GPT-5.6-Terra`, `high · 深入`, and task controls. | SDK AppBridge test harness · synthetic path · light theme · not the Codex desktop host |
| `supervisor-panel-harness-dark.png` | 720 × 1147 | Dark panel with a waiting `ui-waiting` job, the requested model/effort, and `立即停止` / `刷新` controls. | SDK AppBridge test harness · synthetic path · dark theme · not the Codex desktop host |
| `supervisor-panel-harness-public-mobile-light.png` | 390 × 1374 | Narrow light layout with stacked project, model and effort controls; the synthetic project path wraps. | SDK AppBridge test harness · synthetic path · 390px light viewport · not the Codex desktop host |
| `supervisor-panel-harness-public-mobile-dark.png` | 390 × 1374 | Narrow dark layout with the same stacked controls and no visible horizontal overflow. | SDK AppBridge test harness · synthetic path · 390px dark viewport · not the Codex desktop host |
| `supervisor-panel-harness-public-stale.png` | 720 × 942 | Stale revision state: switch shows `待刷新`, the panel displays a red refresh warning, and stop/refresh remain available. | SDK AppBridge test harness · synthetic path · stale revision state · not the Codex desktop host |

The screenshots do not reveal the actual Codex conversation model selector or prove how a production desktop host places the content entrypoint. Those details were not visually observable in this evidence set.

`policy-site-overview.png` and `policy-site-mobile-cdp.png` are local headless Chrome renders of the generated policy site. The mobile capture uses CDP device metrics at 390px and verified `document.documentElement.scrollWidth === 390`; it does not control the user's Chrome or Codex desktop application.

The matching `public-site-overview.png` and `public-site-mobile-cdp.png` renders were read from the deployment worker's `work/publishing-public-site/public/supervisor/` output after its build. They confirm the same four-page navigation and responsive behavior without modifying that public-site checkout.
