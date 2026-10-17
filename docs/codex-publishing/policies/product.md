# Harzva Supervisor for Codex

Applies to Harzva Supervisor 0.4.0 and 0.4.1. Version 0.4.1 updates publishing materials without changing execution behavior; behavior validation remains the 0.4.0 baseline with Codex CLI 0.149.0.

Publisher: Harzva, developer and maintainer of Harzva Supervisor

Harzva Supervisor helps developers carry a user-authorized project change through execution, independent acceptance checks and a recoverable handoff. It runs locally as a desktop plugin with a Supervisor conversation page and project-bound controls. Harzva is the independent publisher; OpenAI does not endorse this plugin.

## What it does

- **Execute accepted work.** Save a concrete task and its approved file or command checks, record authorization for that proposal, and dispatch it through an owned Codex native worker queue.
- **Verify results.** Inspect the declared artifacts and run the approved verification steps. Record the actual result rather than treating a worker's success message as acceptance.
- **Assign responsibility.** Use faculty or mentor profiles for architecture, research, implementation, verification and handoff. Review is bounded and uses independent native agents when the host supports them; a serial review is identified as such.
- **Recover project context.** Save concise checkpoints and local handoffs with evidence references and unresolved work. Inspect current project state before resuming from historical records.
- **Control new execution.** Select an available native execution model and reasoning effort for new proposals, disable further dispatch, or request cancellation of relevant Supervisor jobs.

Faculties and mentors are configuration and responsibility profiles. They are not distinct human reviewers, approval authorities or a promise of separate models. The supervising conversation uses its current model; execution settings select the owned worker's model. The shared 0.4.0 execution behavior cannot automatically synchronize with the conversation input's model selector.

## Typical requests

“Implement this authorized project change, verify the declared artifacts and record a checkpoint.”

“Run one architecture and verification review of this proposal, showing evidence and unresolved concerns.”

“Prepare a checked local handoff for the work remaining in this project.”

The plugin does not scan every chat for suggestions. A suggestion, saved handoff or reviewer consensus does not grant permission to execute a new task. Turn on Supervisor after selecting the project; the switch permits dispatch of already-authorized work and does not approve or create proposals.

## Requirements and limits

The full version requires a desktop plugin host that supports local stdio MCP, Node.js 22 or later, a compatible installed Codex CLI and your own supported login. Version 0.4.0 has been tested with CLI 0.149.0. Effective host permissions must allow the project state path and required CLI cache/login operations. Supported versions and operating systems must be checked against the actual release's validation evidence.

Execution uses bounded job timeouts and attempt caps, defaults to one attempt, and accepts at most three approved attempts per proposal. Only a proven terminal failure can use another approved attempt. Ambiguous dispatch or interrupted receipts stop for investigation. The plugin does not create a second scheduler, automatically wake future conversations or force a token or monetary budget.

Turning off the switch blocks new dispatch and retries. The stop action also requests cancellation; an in-progress cancellation or uncertain receipt must still be checked. Completed modifications remain unless separately reversed. Verification proves the recorded checks on the declared artifacts, not every property of a project or completion of its entire parent task.

## Data and documentation

The plugin stores private project records locally and has no Harzva-operated remote execution backend or automatic telemetry endpoint. Codex and the chosen model service still process task instructions and relevant project context; review their data settings before using private material. Do not input secrets or unnecessary sensitive personal data. Disabling or uninstalling does not erase retained project records.

[Privacy policy](https://harzva.github.io/supervisor/privacy/) · [Terms of service](https://harzva.github.io/supervisor/terms/) · [Support](https://harzva.github.io/supervisor/support/)

The distributed Harzva code uses Apache License 2.0; bundled dependencies have their own licenses and notices. Public directory approval, listing and publication are separate steps from local installation and testing. This page does not claim a completed official review.

## 中文摘要

适用 0.4.0 和 0.4.1；0.4.1 更新发布材料，执行行为沿用 0.4.0，行为核验基线为 0.4.0 与 Codex CLI 0.149.0。

Harzva Supervisor 把已授权工程工作连接到 Codex 原生执行队列，独立验收结果，并用学院责任、检查点和交接保留项目进展。对话页可关联工程、选择新任务的执行模型、关闭派发或请求停止。学院是配置与职责，不是审批权；开关不会自动批准建议，也不保证一直运行到目标完成。插件保存本地记录，但模型服务仍处理相关上下文。当前版本不能自动跟随输入框模型，不能撤销已完成副作用，也不能把本地试用成功当作官方市场审核通过。
