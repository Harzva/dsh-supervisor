# Harzva Supervisor Terms of Service

Applies to Harzva Supervisor 0.4.0 and 0.4.1. Version 0.4.1 updates publishing materials without changing execution behavior; behavior validation remains the 0.4.0 baseline with Codex CLI 0.149.0.

Effective date: 2026-10-18  
Publisher: Harzva, developer and maintainer of Harzva Supervisor  
Contact: 626609967@qq.com

These terms describe use of Harzva Supervisor for Codex and its support service. The distributed software licenses govern your rights to use, modify and redistribute the software; these terms do not replace or narrow those licenses. Harzva's code in the distributed plugin is licensed under Apache License 2.0. Bundled dependencies retain their own licenses and notices.

## Product and prerequisites

Harzva Supervisor provides local responsibility profiles, bounded review workflows, project checkpoints and handoffs, and execution of user-authorized tasks through the installed Codex CLI. Versions 0.4.0 and 0.4.1 require Node.js 22 or later, a supported desktop plugin host, a compatible Codex CLI and your own authorized Codex login. Harzva is the independent publisher. Availability through a directory does not guarantee future compatibility or uninterrupted service.

The publisher does not process payments in the plugin. Model-service usage may consume your existing subscription, usage allowance or provider credits. You are responsible for third-party accounts and charges under their terms. The plugin does not enforce a monetary or token-spend ceiling.

## Authorized use

Use the plugin only with projects, files and services you are entitled to access. Provide a concrete scope and approved verification steps. A model recommendation, review consensus or saved handoff is not a new authorization. The software records a proposal digest and authorization scope, but cannot independently authenticate the human conversation on which a caller bases that authorization.

Do not use the plugin to bypass permissions, provider restrictions or platform safeguards, or to perform unlawful or prohibited activities. Do not give it authentication secrets, payment-card data, protected health information, government identifiers or unnecessary sensitive personal information. Use supported host and CLI authentication controls instead.

## Execution, verification and stopping

Approved jobs can change local files and run declared verification commands. Keep backups and inspect meaningful changes before relying on, deploying or distributing them. A successful verification result means only that the proposal's specified checks passed on the recorded artifacts; it is not proof of every requirement, secure operation or completion of the entire parent project.

Jobs have bounded attempt and timeout settings. The workspace switch blocks new dispatch and retries. The stop action additionally requests cancellation of relevant Supervisor jobs; a pending request is not proof that every process has terminated. Completed writes and other effects may remain. The plugin does not promise exactly-once execution, perfect cancellation, automatic rollback or continuous operation until a goal is achieved. Ambiguous results require receipt investigation before another dispatch.

The plugin owns its executor threads. It does not take over arbitrary conversations, create an extra background scheduler or automatically wake future conversations. Review and model-routing capabilities are limited by the host and CLI versions actually installed.

## Data and support

The [privacy policy](https://harzva.github.io/supervisor/privacy/) explains local records, model-service transfers, retention and deletion. You control sharing of your project artifacts. Disabling or uninstalling the plugin does not erase local project records or third-party histories and does not substitute for confirmed cancellation.

Use the [support page](https://harzva.github.io/supervisor/support/) for troubleshooting and private reports. Support does not require your password, API key or full project directory. No response-time or availability service-level agreement is offered unless separately agreed in writing.

## Warranties, rights and changes

The software is provided subject to the warranty disclaimer and liability terms in its applicable licenses. AI-generated work and review findings may be incorrect or incomplete. Nothing here excludes a right or liability that applicable law does not permit to be excluded, or overrides a separate written agreement.

You retain the rights you already have in your project inputs and artifacts. Giving the plugin access to them does not transfer ownership to the publisher. Rights and obligations concerning third-party services and generated content remain governed by their applicable terms and law.

You can stop using or uninstall the plugin at any time after managing active jobs and retained data. Material changes to these terms will be published with a new effective date. Questions about these terms can be sent to 626609967@qq.com.

## 中文摘要

适用 0.4.0 和 0.4.1；0.4.1 更新发布材料，执行行为沿用 0.4.0，行为核验基线为 0.4.0 与 Codex CLI 0.149.0。

软件使用、修改和再分发权利以随包许可证为准，Harzva 代码采用 Apache 2.0，第三方依赖保留各自许可证。插件不是 OpenAI 官方产品。请只执行已经授权的工程任务，并保留备份；模型可能出错，验收通过只证明所列检查通过。停止请求不能撤销已经完成的文件修改，也不保证瞬间终止所有进程。模型账号、额度及第三方费用由用户按其服务条款管理，插件没有强制费用上限。卸载前应处理活跃任务与本地记录。适用法律赋予的权利不因这些条款而被排除。
