# Harzva Supervisor Privacy Policy

Applies to Harzva Supervisor 0.4.0 and 0.4.1. Version 0.4.1 updates publishing materials without changing execution behavior; behavior validation remains the 0.4.0 baseline with Codex CLI 0.149.0.

Effective date: 2026-10-18  
Responsible publisher: Harzva, developer and maintainer of Harzva Supervisor  
Privacy contact: 626609967@qq.com  
Product: https://harzva.github.io/supervisor/ · Support: https://harzva.github.io/supervisor/support/

## Scope

This policy describes Harzva Supervisor for Codex, including its desktop panel, local MCP server and project helpers. Harzva independently develops this plugin. The plugin runs on your computer. These versions have no Harzva-operated remote execution backend or automatic telemetry endpoint. This does not make model execution offline: Codex and your configured model provider may transmit and retain task data under their own policies and account settings.

## Information processed and why

| Information | Purpose and handling |
| --- | --- |
| An explicitly selected project path, project label, host-provided conversation ID and random binding ID | Associate the panel with the project selected in that conversation. The local binding registry stores these fields; the panel returns project paths and bounded status through the host's MCP bridge. It does not scan other projects or reconstruct your conversation history. |
| Mentor or faculty configuration, including any domain guidance you provide | Assign responsibilities and support bounded reviews. Configuration stays in local project state unless you or a host workflow deliberately include relevant guidance in a model task or share it. |
| Task instructions, acceptance criteria, declared verification files and command arguments | Record the proposed work and its user-authorized scope, send the task to a plugin-owned Codex worker, and independently verify the specified results. This text is stored locally and can include personal or confidential project information. |
| Model and reasoning preferences, authorization digests, job/attempt/queue/turn identifiers, timestamps, statuses and bounded error metadata | Apply new-task settings, correlate execution receipts, prevent blind retries and investigate uncertain results. These are operational records, not behavioral profiling. |
| Checkpoint summaries, evidence references, remaining work, blockers and handoff files | Preserve inspectable project progress and support context recovery. These are local records that may contain sensitive information. |
| Declared verification-file contents and native protocol/command results | Read in memory to check artifacts and execution. Persisted verification receipts contain paths, hashes, byte counts and exit/status information rather than raw command output. The plugin does not retain raw Codex transcripts or native stderr logs in its own state. |

The plugin does not ask you to enter a password, API key, MFA code or payment information, and it does not read Codex authentication files or create its own provider credential store. It starts your installed Codex CLI, which uses your existing login and environment. Codex remains responsible for its own authentication, caches and native records. Use the CLI's supported login flow rather than placing credentials in a task, configuration or support request.

Do not submit authentication secrets, payment-card data, protected health information, government identifiers or other unnecessary sensitive personal data to the plugin. Its limited input filters are not a complete secret scanner and cannot guarantee that arbitrary project files, instructions or summaries contain no private information.

## Recipients and network activity

The local plugin communicates with the desktop host and Codex CLI through local process interfaces. It does not automatically upload project records to Harzva. The host may process tool inputs and results as part of your conversation. The CLI sends task instructions and relevant project context to the model service selected by your Codex configuration. Review the host/provider policies, account data controls and your workspace's permitted tools before using private project material.

The native worker and declared command checks request a workspace write sandbox with worker-tool network access disabled. That restriction does not disable the CLI's model-service connection or change provider retention. An existing proxy configuration may be inherited by the CLI child process. Native integrations, user-directed sharing, synced folders and backups may have their own recipients and data practices.

If you contact support, the publisher and its support-service providers receive the contact details and redacted material you choose to send. There is no automatic support-log upload. Support handling: Email is delivered using your email provider and the publisher’s QQ Mail/Tencent mailbox. The publisher uses your correspondence to address the request, related follow-up, security reports and applicable legal obligations. Support email has no promised fixed automatic expiration; it may remain in the mailbox until manually removed. You can request deletion by emailing the support contact. Provider-controlled delivery records, backups and legally required records can have separate retention and may not disappear immediately when mailbox copies are removed. Do not include sensitive project material that is unnecessary for the request.

Public website handling: The product and policy pages at `harzva.github.io/supervisor/` are static pages hosted by GitHub Pages. The publisher does not add analytics, advertising trackers, web forms or browser storage to these pages. GitHub Pages logs visitor IP addresses for security purposes, independently of whether visitors are signed in to GitHub. GitHub controls the hosting records and their retention under its [privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement); the publisher does not promise a different deletion timeline for those records. See [GitHub’s Pages data-collection explanation](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages#data-collection). Clicking an external link or sending email subjects that interaction to the destination or email provider’s data practices.

## Retention and deletion

Project records are stored under your selected project's `.codex/supervisor/`. Conversation/project bindings are stored in `bindings.v1.json` within the plugin data directory assigned by the host. New private data files use restrictive filesystem permissions where supported. These permissions are not encryption and do not prevent access by your account, administrators, backups or software with equivalent access.

The plugin has no automatic time-based deletion. A task keeps its latest 20 checkpoints in active state; older generated handoff files remain until you remove them. Execution records, settings and bindings remain until you remove them. Size/count limits bound storage but are not a retention timer. Disabling or uninstalling the plugin does not delete project records, cancel all native work or delete Codex/provider histories.

To remove local records safely, first stop new dispatch, request cancellation of active Supervisor work, and confirm terminal receipts. Preserve unresolved receipts while investigating uncertain work. When no relevant work remains active, close the plugin process and remove the project's `.codex/supervisor/` directory and, if desired, the plugin's local binding registry. Removing bindings affects all conversations recorded in that registry. Review your synced copies and backups separately. Use Codex/provider controls to manage their histories; deleting plugin files does not delete those records.

## Your controls and contact

You choose the project, task scope, model preferences and information to share. The workspace switch blocks new dispatch and retries; the stop action also requests cancellation of relevant Supervisor jobs. Cancellation is confirmed only after terminal receipts, and it cannot undo effects already completed. Export or inspect local records before deletion, keep the state directory out of version control, and redact any record before sharing it.

For support-data access, correction or deletion, or to report a privacy concern, contact 626609967@qq.com. The publisher cannot remotely inspect or erase files that exist only on your computer. This policy does not limit privacy rights that apply under law. Changes to product data handling will be reflected here with an updated effective date.

## 中文摘要

适用 0.4.0 和 0.4.1；0.4.1 更新发布材料，执行行为沿用 0.4.0，行为核验基线为 0.4.0 与 Codex CLI 0.149.0。

Harzva Supervisor 是独立开发的本地桌面插件。它在你选择的工程内保存任务指令、授权、验收回执、模型设置、检查点和交接，并在宿主分配的插件目录保存对话与工程的关联。插件没有自有远程执行后端或自动遥测，但 Codex／模型服务仍可能接收任务与相关工程上下文，因此不能视为完全离线。插件不要求输入登录密钥，也不自行读取 Codex 登录文件。请勿输入凭据、医疗、政府身份或支付卡等敏感数据；过滤器不能保证所有内容都无隐私。记录没有自动按时间删除，卸载也不会清除工程记录或第三方历史。删除前应先确认相关执行已停止。产品政策网页由 GitHub Pages 托管，GitHub 会为安全目的记录访客 IP；支持邮件由 QQ Mail／Tencent 等邮件服务处理，没有承诺自动按固定天数删除，可联系作者提出删除请求。隐私与支持联系：626609967@qq.com。
