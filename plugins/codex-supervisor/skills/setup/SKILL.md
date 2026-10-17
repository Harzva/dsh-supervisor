---
name: setup
description: Set up Harzva Supervisor in a Codex project or migrate a provided DSH mentors or faculties JSON configuration.
---

Establish a project-local Supervisor roster. This plugin packages instructions and local scripts; it does not register tools, custom agents or background watchers.

Resolve the plugin root from this skill's location (two levels up). Read [the command contract](../../README.md) before running its helper. Use Node 22 or newer and the actual project directory. Keep the plugin installation directory separate from project state.

1. Inspect existing project instructions, the current Git state and `.codex/supervisor/state.v1.json`, if present. Use `status` to validate existing state. Never reset state to recover from a parse or schema failure.
2. Run `init --workspace <project>` for the default Atlas, Scout, Forge, Verity and Relay roster. If the user supplied a legacy configuration, use an explicit JSON file with top-level `mentors` or `faculties`; do not scan DSH homes, environment variables or unrelated profiles. Do not install another package to parse YAML; translate a provided bounded configuration to JSON if needed.
3. Keep `.codex/supervisor/` out of version control: inspect existing ignore rules and add that exact project-relative ignore entry when necessary. Configuration can contain private domain prompts and legacy routes. Do not upload the state directory with a plugin build.
4. Show the public roster and describe available workflows: `supervise`, `faculty-review`, `handoff`. Preserve the task's existing scope and model preferences.

DSH `provider/model` routes are retained as private migration metadata. They do not map automatically to a Codex model. Do not invent aliases or install `.codex/agents` files. Codex native subagents, permissions and model availability remain the host's responsibility. Use host defaults when no model is specified; preserve an explicit model choice and disclose an unavailable choice rather than silently replacing it. Use only a fallback already authorized by the user.

Existing state is authoritative for this project's Supervisor records. `init` does not replace its roster; an intentional configuration update is a future workflow. If shell/file tools or Node are unavailable, use the skills in conversation and explicitly report that persistent state is unavailable.
