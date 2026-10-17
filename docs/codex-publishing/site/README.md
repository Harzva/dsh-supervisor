# Harzva Supervisor policy site generator

This directory contains the static page template and a dependency-free Node.js generator for the four public policy pages. The generator reads only these public source documents:

- `../policies/product.md` → `/supervisor/`
- `../policies/support.md` → `/supervisor/support/`
- `../policies/privacy-policy.md` → `/supervisor/privacy/`
- `../policies/terms-of-service.md` → `/supervisor/terms/`

`source-audit.md` and the policy README are intentionally excluded. The output is plain HTML and CSS: no JavaScript, third-party CDN, analytics, cookies, tracking pixel or support form is added.

The default base origin and path are `https://harzva.github.io` and `/supervisor/`. Pass a different origin or path for a staging host. The generator does not publish files or contact a host.

For a one-off staging build, override them directly with `--base-origin https://staging.example --base-path /supervisor/`; the flag names use hyphens even though the JSON keys use camelCase.

## Build a final site

Copy `site.config.example.json` to a private working location, verify the publisher, support inbox and effective date against the deployed policy source, then run:

```bash
node docs/codex-publishing/site/build.mjs \
  --config /path/to/site.config.json \
  --source docs/codex-publishing/policies \
  --out /path/to/public-site/public/supervisor
```

The build fails when a `{{TOKEN}}` remains in one of the four source documents. If a later policy revision introduces a token, provide its value in the config and rebuild. Use `--allow-unresolved` only for a clearly labelled local preview; the generated page then displays a draft notice listing the unresolved tokens.

The four URL fields in `plugin.json` should point to the corresponding deployed pages after the public host has been built and verified. A local preview is not evidence that those URLs are public or that a directory review has been approved.
