# UI origin confirmation for local MCP review

Checked 2026-10-18. The [official UI metadata reference](https://developers.openai.com/plugins/reference#component-resource-_meta-fields) specifies a dedicated, per-plugin origin in resource `_meta.ui.domain` for public UI submission. The [desktop-only submission guide](https://developers.openai.com/plugins/deploy/desktop-only) does not state an exemption for a bundled stdio UI. Local packaging alone therefore does not establish a waiver.

The currently validated resource returns an inline HTML bundle with an empty network/resource/frame CSP and no explicit domain. It does not host the UI at the product-policy website. This is suitable evidence of the tested local resource, not proof that its default sandbox origin meets public review requirements.

Ask the actual OpenAI representative to confirm how an approved local MCP plugin obtains or registers a unique UI origin, or provide a written applicability decision for the local resource. After confirmation, declare the real approved origin and verify the installed resource and bridge under it. Do not invent a hostname or use a placeholder origin to silence validation.

`https://harzva.github.io/supervisor/` is a product website path. Distinct paths do not create distinct origins; that URL does not by itself establish an origin unique to this plugin. The default shared sandbox also cannot be assumed unique. This item remains open until partner guidance and a final resource check resolve it.
