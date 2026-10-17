# Review material preparation

Prepared against the official [submission field reference](https://developers.openai.com/plugins/deploy/submission#configure-onboarding-review-and-publication) and [desktop-only flow](https://developers.openai.com/plugins/deploy/desktop-only) on 2026-10-18.

`review.json` supplies `plugin.json.extensions.com.openai.review`; its structured cases have been merged into the 0.4.1 portable manifest. If this source changes before the final freeze, synchronize that object again. `publication.json` supplies prepared release-note text for `extensions.com.openai.publication`; the final manifest may retain the maintainer's equivalent wording and translations. This external preparation directory is not automatically included in the portable plugin. Do not append review/publication inside `interface` or add a second independent MCP server declaration. The compatibility manifest deliberately retains its existing layout; the portable OpenAI extension is authoritative for submission.

The review object contains exactly five positive and three negative cases. Positive cases use string fields `description`, `prompt`, `tools_triggered`, `expected_behavior`; negative cases use `description` and `prompt`, with the expected refusal explained in the description. Optional attachment and reference-output URLs are omitted because no real public attachment is required. The local schema is an authored validation subset of the field reference, not a claim to be the complete official importer schema.

The review object declares the real walkthrough URL `https://harzva.github.io/supervisor/review/`. It records SDK AppBridge interactions with synthetic sample data and makes no model inference. Production desktop end-to-end recording remains unconfirmed; the representative/review team must confirm whether this preview is sufficient for the local MCP route. No credentials, organization IDs, reviewer login secrets or `reviewer_instructions` belong in the public review object. Supply private access details through the portal's secure review form if required. The runbook is an external preparation document, not a proposed manifest field.

For this single stdio MCP server, the documented desktop-only submission route requires confirmed partner eligibility and organization allowlisting before upload. The separate `requires_local_executor` guidance applies to desktop skills-only packages without MCP and does not replace that approval. Identity verification and portal access must be confirmed by the actual submitting organization. The unresolved dedicated UI origin question is recorded in `ui-domain.md`; no local-MCP exemption has been established.

These are 0.4.1 submission materials, not evidence of submission, allowlist acceptance or publication. Existing 0.4.0 behavior evidence is indexed in `evidence-baseline.json`; final reviewer-account execution and clean-install recording remain separate from component unit tests. No new paid native inference was dispatched while preparing this directory.

Preparation checks from the repository root:

```bash
node docs/codex-publishing/review/validate-review.mjs
python3 docs/codex-publishing/review/scan-package.py /absolute/path/to/submission.zip
node --test test/panel-server.test.js test/execution-settings.test.js test/execution-store.test.js test/execution-chain.test.js
```

Freeze the final version, ZIP checksum and matching evidence after public metadata, assets and URLs are complete. A passing baseline scan does not scan a later package automatically.
