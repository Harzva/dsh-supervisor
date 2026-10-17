# Harzva Supervisor Support

Applies to Harzva Supervisor 0.4.0 and 0.4.1. Version 0.4.1 updates publishing materials without changing execution behavior; behavior validation remains the 0.4.0 baseline with Codex CLI 0.149.0.

Publisher: Harzva, developer and maintainer of Harzva Supervisor  
Support, privacy and private security reports: 626609967@qq.com

Harzva Supervisor is independently developed for Codex. This is product support from the publisher, not OpenAI account support. For account access, billing, model entitlements or a Codex service outage, use the relevant provider's support channel.

## Getting started

Use Node.js 22 or later, a compatible Codex CLI with an existing supported login, and a desktop host that can run local stdio MCP plugins. Version 0.4.0 has been tested with Codex CLI 0.149.0; it does not promise compatibility with every CLI release or operating system.

After installation, open the Supervisor conversation page provided by the host and explicitly associate an existing project using its full real directory path. Run the setup skill for that project. The plugin installation directory is not your project directory. Host refresh behavior varies; an existing conversation may need a refreshed plugin connection or a new conversation to load changed tools.

Ask Supervisor to implement an already-authorized task with concrete acceptance criteria, or request a bounded faculty review or checked handoff. Enabling the switch permits authorized dispatch; it does not create jobs or approve suggestions.

## Common issues

| Issue | What to check |
| --- | --- |
| Panel opens but project operations fail | Select an existing absolute project path. The host must provide conversation context. Symlinked, missing, installation-cache and plugin-data directories are rejected as project targets. |
| `PATH_ACCESS` or native startup failure | Confirm the current task permits the project's `.codex/supervisor/` state path and the CLI's own login/cache operations. Use the host's supported permissions workflow. Do not change global security settings to make a trial pass. |
| Model catalog unavailable or a selected model rejected | Check the CLI login, installed version and account's native model catalog. Saved settings affect new proposals only. The current conversation's model selector cannot be read automatically by version 0.4.0. |
| `STALE_CONTROL` or `STALE_SETTINGS` | Refresh the panel, inspect the current values and retry the intended change. Another conversation may have changed the same project's settings. |
| `needs-user-action` | Inspect the approval/input request through supported host controls. The plugin does not approve it on your behalf. |
| `uncertain`, damaged state or a stale lock | Preserve the records and inspect the original job's native receipts. Do not erase state, replace thread IDs, repeat a dispatch or remove a lock while its writer may still be active. |

## Stop and recover

Use **Stop workspace execution** to close the dispatch gate and request cancellation of relevant Supervisor jobs. Refresh status: `cancelling` means the request is pending; `cancelled` requires confirmed terminal receipts. If an outcome remains `uncertain`, investigate the saved original job with the execute workflow's `recover` command. Recovery inspects receipts; it does not blindly re-run the job.

The ordinary on/off switch blocks new dispatch and retries but may allow an already-running task to finish. Stop does not undo completed file edits, stop unrelated chats, or delete native histories. Uninstalling is not a cancellation mechanism.

## Send a useful report

Email 626609967@qq.com with the plugin version, operating system, Node and Codex CLI versions, the short error code, steps to reproduce, expected result and actual result. A minimal example with synthetic project data is preferable. For an execution problem, include a redacted job status and the relevant proposal digest or receipt reference only when needed to diagnose it.

Do not send API keys, passwords, MFA codes, authentication files, raw chat transcripts, full logs, entire `.codex` directories, private mentor prompts or unrelated source files. Review screenshots for account information and private project paths. Reports are processed as described in the [privacy policy](https://harzva.github.io/supervisor/privacy/). Local-only files are not remotely visible to the publisher.

For a suspected security issue, use the same private contact with the subject **Security report — Harzva Supervisor** and a minimal reproduction. Do not post secrets or exploit details in a public thread. Support is provided without a guaranteed response-time service level. We may ask for a redacted reproduction; we do not need access to your provider account.

Product information: https://harzva.github.io/supervisor/ · [Terms](https://harzva.github.io/supervisor/terms/)

## 中文摘要

适用 0.4.0 和 0.4.1；0.4.1 更新发布材料，执行行为沿用 0.4.0，行为核验基线为 0.4.0 与 Codex CLI 0.149.0。

支持与隐私、安全问题请联系 626609967@qq.com。提供插件、系统、Node、Codex CLI 版本、短错误码和最小复现；不要发送密码、密钥、登录文件、原始对话、完整日志或整个 `.codex` 目录。当前版本的模型目录取决于本机 CLI 账号，不能自动读取对话输入框的模型。开关关闭只阻止新派发和重试，“立即停止”会另外请求取消；`cancelling` 不是终止证明，`uncertain` 应保留原记录再核对。插件作者不能代替 OpenAI 处理账号或账单问题。
