import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createPanelServer, PANEL_URI, PANEL_MIME } from '../plugins/codex-supervisor/server/panel-server.mjs'
import { ExecutionStore, propose, authorize, beginAttempt, updateAttempt } from '../plugins/codex-supervisor/scripts/execution-store.mjs'
import { run as supervisor } from '../plugins/codex-supervisor/scripts/supervisor.mjs'
import { runJob } from '../plugins/codex-supervisor/scripts/execution.mjs'

const serverModule = new URL('../plugins/codex-supervisor/server/panel-server.mjs', import.meta.url).href

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'supervisor-panel-'))
  const workspace = path.join(root, 'my-project')
  const pluginRoot = path.join(root, 'plugin')
  const dataDirectory = path.join(root, 'data', 'supervisor')
  fs.mkdirSync(workspace)
  fs.mkdirSync(pluginRoot)
  const htmlPath = path.join(pluginRoot, 'panel.html')
  fs.writeFileSync(htmlPath, '<!doctype html><html><body>LOCAL_PANEL</body></html>')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, workspace, pluginRoot, dataDirectory, htmlPath, options: { dataDirectory, pluginRoot, htmlPath } }
}

async function connect(t, options) {
  const server = createPanelServer(options)
  const client = new Client({ name: 'panel-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  await client.listTools()
  t.after(() => client.close())
  return client
}

function call(client, name, args = {}, threadId = undefined, extraMeta = {}) {
  return client.callTool({ name, arguments: args, _meta: { ...extraMeta, ...(threadId ? { threadId } : {}) } })
}

function success(result) {
  assert.equal(result.isError, undefined, result.content[0].text)
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent)
  return result.structuredContent
}

function failure(result, code) {
  assert.equal(result.isError, true)
  assert.deepEqual(result.structuredContent, { error: { code } })
  assert.deepEqual(JSON.parse(result.content[0].text), { error: { code } })
}

const modelCatalog = { configuredModel: 'different-configured-model', configuredReasoningEffort: 'high', models: [
  { id: 'alpha', model: 'alpha', displayName: 'Alpha', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }, { reasoningEffort: 'high', description: 'Detailed' }] },
] }

test('model catalog reads are inert; saved defaults are revision checked and model/effort errors are explicit', async t => {
  const f = fixture(t)
  let reads = 0
  const client = await connect(t, { ...f.options, modelReader: async ({ workspace }) => { assert.equal(workspace, f.workspace); reads++; return modelCatalog } })
  const owner = randomUUID()
  const bound = success(await call(client, 'supervisor_bind_workspace', { workspace: f.workspace }, owner)).binding
  assert.equal(bound.conversationModelAvailable, false)
  assert.equal(bound.executionSettings.configured, false)
  assert.equal(reads, 0)
  const read = success(await call(client, 'supervisor_models', { bindingId: bound.id }, owner)).binding
  assert.deepEqual(read.catalog, modelCatalog)
  assert.deepEqual(fs.readdirSync(f.workspace), [])
  const input = { bindingId: bound.id, mode: 'custom', model: 'alpha', reasoningEffort: 'high', expectedRevision: 0 }
  const saved = success(await call(client, 'supervisor_set_execution', input, owner)).binding
  assert.deepEqual(saved.executionSettings, { mode: 'custom', model: 'alpha', reasoningEffort: 'high', revision: 1, configured: true })
  failure(await call(client, 'supervisor_set_execution', input, owner), 'STALE_SETTINGS')
  failure(await call(client, 'supervisor_set_execution', { ...input, model: 'missing', expectedRevision: 1 }, owner), 'MODEL_UNAVAILABLE')
  failure(await call(client, 'supervisor_set_execution', { ...input, reasoningEffort: 'low', expectedRevision: 1 }, owner), 'REASONING_UNAVAILABLE')
  failure(await call(client, 'supervisor_set_execution', { ...input, mode: 'conversation', expectedRevision: 1 }, owner), 'INVALID_ARGUMENTS')
  failure(await call(client, 'supervisor_models', { bindingId: bound.id }, randomUUID()), 'UNKNOWN_BINDING')
  failure(await call(client, 'supervisor_set_execution', { ...input, expectedRevision: 1 }, randomUUID()), 'UNKNOWN_BINDING')
  assert.deepEqual(fs.readdirSync(path.join(f.workspace, '.codex/supervisor')), ['settings.v1.json'])
  const broken = await connect(t, { ...f.options, modelReader: async () => { throw Error('PRIVATE_CATALOG_SOURCE') } })
  failure(await call(broken, 'supervisor_models', { bindingId: bound.id }, owner), 'MODEL_CATALOG_UNAVAILABLE')
})

test('stop is available with stale settings, closes the gate, interrupts live work and cancels waiting jobs without deleting proposals', async t => {
  const f = fixture(t)
  supervisor(['init', '--workspace', f.workspace])
  supervisor(['assign', '--workspace', f.workspace, '--task', 'work'])
  const store = new ExecutionStore(f.workspace)
  const makeJob = id => store.mutate(state => propose(state, { jobId: id, taskId: 'work', proposal: { instruction: 'Write a report.', successCriteria: ['Report is ready.'], verification: [{ kind: 'file', path: 'report.txt' }] } }))
  for (const id of ['active', 'waiting', 'suggestion']) {
    const job = makeJob(id)
    if (id !== 'suggestion') store.mutate(state => authorize(state, { jobId: id, digest: job.digest }))
  }
  const client = await connect(t, f.options)
  const owner = randomUUID()
  const binding = success(await call(client, 'supervisor_bind_workspace', { workspace: f.workspace }, owner)).binding
  failure(await call(client, 'supervisor_stop', { bindingId: binding.id }, randomUUID()), 'UNKNOWN_BINDING')
  assert.equal(store.snapshot().jobs.waiting.status, 'authorized')
  let started
  const ready = new Promise(resolve => { started = resolve })
  let aborted = false
  const selection = { model: 'alpha', reasoningEffort: 'medium' }
  const running = runJob(store, 'active', { execute: async options => {
    await options.onThread({ threadId: 'owned-thread' })
    await options.onDispatch({ threadId: 'owned-thread', marker: options.marker, selection })
    await options.onQueued({ threadId: 'owned-thread', queuedSubmissionId: 'owned-queue' })
    await options.onStarted({ threadId: 'owned-thread', turnId: 'owned-turn' })
    started()
    return new Promise(resolve => options.signal.addEventListener('abort', () => { aborted = true; resolve({ status: 'interrupted', threadId: 'owned-thread', turnId: 'owned-turn', selection }) }, { once: true }))
  }, verify: async () => { throw Error('A cancelled worker must not start verification') } })
  await ready
  const stopping = success(await call(client, 'supervisor_stop', { bindingId: binding.id }, owner)).binding
  assert.equal(stopping.control.enabled, false)
  assert.equal(stopping.jobs.find(job => job.id === 'active').status, 'cancelling')
  assert.equal(stopping.jobs.find(job => job.id === 'waiting').status, 'cancelled')
  assert.equal(stopping.jobs.find(job => job.id === 'suggestion').status, 'proposed')
  const done = await running
  assert.equal(aborted, true)
  assert.equal(done.status, 'cancelled')
  const stopped = success(await call(client, 'supervisor_status', { bindingId: binding.id }, owner)).binding
  assert.equal(stopped.jobs.find(job => job.id === 'active').actualModel, 'alpha')
  assert.equal(stopped.jobs.find(job => job.id === 'active').actualReasoningEffort, 'medium')
  assert.equal(stopped.jobs.find(job => job.id === 'active').status, 'cancelled')
  assert.equal(success(await call(client, 'supervisor_stop', { bindingId: binding.id }, owner)).binding.control.enabled, false)
})

test('stop preserves uncertain orphan work as cancelling rather than claiming termination', async t => {
  const f = fixture(t)
  supervisor(['init', '--workspace', f.workspace])
  const store = new ExecutionStore(f.workspace)
  const job = store.mutate(state => propose(state, { jobId: 'orphan', taskId: 'work', proposal: { instruction: 'Write a report.', successCriteria: ['Ready'], verification: [{ kind: 'file', path: 'report.txt' }] } }))
  store.mutate(state => authorize(state, { jobId: job.id, digest: job.digest }))
  const attempt = store.mutate(state => beginAttempt(state, job.id))
  store.mutate(state => updateAttempt(state, { jobId: job.id, attemptId: attempt.id, status: 'uncertain' }))
  const client = await connect(t, f.options)
  const owner = randomUUID()
  const binding = success(await call(client, 'supervisor_bind_workspace', { workspace: f.workspace }, owner)).binding
  const stopping = success(await call(client, 'supervisor_stop', { bindingId: binding.id }, owner)).binding
  assert.equal(stopping.control.enabled, false)
  assert.equal(stopping.jobs[0].status, 'cancelling')
  assert.notEqual(stopping.jobs[0].status, 'cancelled')
})

test('model discovery revalidates a rebound workspace before reading state or saving settings', async t => {
  for (const tool of ['supervisor_models', 'supervisor_set_execution']) {
    const f = fixture(t)
    const foreign = path.join(f.root, 'foreign-project')
    const preserved = path.join(f.root, 'preserved-project')
    fs.mkdirSync(foreign)
    const client = await connect(t, { ...f.options, modelReader: async () => {
      fs.renameSync(f.workspace, preserved)
      fs.symlinkSync(foreign, f.workspace)
      return modelCatalog
    } })
    const owner = randomUUID()
    const binding = success(await call(client, 'supervisor_bind_workspace', { workspace: f.workspace }, owner)).binding
    const input = tool === 'supervisor_models' ? { bindingId: binding.id } : { bindingId: binding.id, mode: 'custom', model: 'alpha', reasoningEffort: 'medium', expectedRevision: 0 }
    failure(await call(client, tool, input, owner), 'UNSAFE_PATH')
    assert.deepEqual(fs.readdirSync(foreign), [])
    assert.deepEqual(fs.readdirSync(preserved), [])
  }
})

test('official SDK protocol advertises one thread entrypoint and app-only strictly typed controls without writing', async t => {
  const f = fixture(t)
  const client = await connect(t, f.options)
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['supervisor_panel', 'supervisor_bind_workspace', 'supervisor_status', 'supervisor_set_enabled', 'supervisor_models', 'supervisor_set_execution', 'supervisor_stop'].sort())
  assert.deepEqual(tools[0]._meta['openai/ui'].entrypoints, [{ type: 'thread' }])
  assert.equal(tools[0]._meta.ui.resourceUri, PANEL_URI)
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.equal(tool.outputSchema.additionalProperties, false)
    assert.equal(tool.annotations.openWorldHint, false)
  }
  for (const tool of tools.slice(1)) {
    assert.deepEqual(tool._meta.ui.visibility, ['app'])
    assert.equal(tool._meta['openai/ui'], undefined)
  }
  const resources = await client.listResources()
  assert.deepEqual(resources.resources, [{ uri: PANEL_URI, name: 'Supervisor', mimeType: PANEL_MIME }])
  const resource = await client.readResource({ uri: PANEL_URI })
  assert.equal(resource.contents[0].mimeType, PANEL_MIME)
  assert.match(resource.contents[0].text, /LOCAL_PANEL/)
  assert.deepEqual(resource.contents[0]._meta.ui.csp, { connectDomains: [], resourceDomains: [], frameDomains: [] })
  await assert.rejects(() => client.readResource({ uri: 'file:///etc/passwd' }), /RESOURCE_NOT_FOUND/)
  assert.deepEqual(success(await call(client, 'supervisor_panel', {}, randomUUID())), { schemaVersion: 1, bindings: [], binding: null })
  assert.equal(fs.existsSync(f.dataDirectory), false)
  assert.deepEqual(fs.readdirSync(f.workspace), [])
})

test('bundled App HTML may exceed 256 KiB but remains bounded at 512 KiB and never follows a resource symlink', async t => {
  const f = fixture(t)
  const client = await connect(t, f.options)
  const html = `<!doctype html><html><body>${'X'.repeat(375000)}</body></html>`
  fs.writeFileSync(f.htmlPath, html)
  assert.equal((await client.readResource({ uri: PANEL_URI })).contents[0].text, html)
  fs.writeFileSync(f.htmlPath, 'X'.repeat(512 * 1024 + 1))
  await assert.rejects(() => client.readResource({ uri: PANEL_URI }), /RESOURCE_UNAVAILABLE/)
  fs.unlinkSync(f.htmlPath)
  const external = path.join(f.root, 'private.html')
  fs.writeFileSync(external, 'PRIVATE_HTML')
  fs.symlinkSync(external, f.htmlPath)
  await assert.rejects(() => client.readResource({ uri: PANEL_URI }), /RESOURCE_UNAVAILABLE/)
  assert.equal(fs.readFileSync(external, 'utf8'), 'PRIVATE_HTML')
  assert.equal(fs.existsSync(f.dataDirectory), false)
})

test('explicit binding persists across server restart with private files and no workspace initialization', async t => {
  const f = fixture(t)
  const owner = randomUUID()
  const client = await connect(t, f.options)
  const bound = success(await call(client, 'supervisor_bind_workspace', { workspace: f.workspace }, owner))
  assert.match(bound.binding.id, /^[a-f0-9-]{36}$/)
  assert.deepEqual(bound.bindings, [{ id: bound.binding.id, label: 'my-project', workspace: f.workspace }])
  assert.deepEqual(bound.binding.control, { workspace: f.workspace, enabled: true, revision: 0, configured: false })
  assert.equal(bound.binding.initialized, false)
  assert.equal(bound.binding.mentorCount, 0)
  assert.deepEqual(bound.binding.jobs, [])
  assert.equal(fs.statSync(f.dataDirectory).mode & 0o777, 0o700)
  const file = path.join(f.dataDirectory, 'bindings.v1.json')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(f.dataDirectory), ['bindings.v1.json'])
  assert.deepEqual(fs.readdirSync(f.workspace), [])
  const before = fs.readFileSync(file)
  const restarted = await connect(t, f.options)
  assert.deepEqual(success(await call(restarted, 'supervisor_panel', {}, owner)), bound)
  assert.deepEqual(success(await call(restarted, 'supervisor_status', { bindingId: bound.binding.id }, owner)), bound)
  assert.deepEqual(success(await call(restarted, 'supervisor_bind_workspace', { workspace: f.workspace }, owner)), bound)
  assert.deepEqual(fs.readFileSync(file), before)
  assert.deepEqual(fs.readdirSync(f.workspace), [])
})

test('host thread context isolates binding tokens and ignores caller cwd metadata', async t => {
  const f = fixture(t)
  const client = await connect(t, f.options)
  const owner = randomUUID()
  const other = randomUUID()
  const bound = success(await call(client, 'supervisor_bind_workspace', { workspace: f.workspace }, owner))
  assert.deepEqual(success(await call(client, 'supervisor_panel', {}, other, { cwd: f.workspace })).bindings, [])
  assert.deepEqual(success(await call(client, 'supervisor_panel', {}, undefined, { cwd: f.workspace })).bindings, [])
  failure(await call(client, 'supervisor_status', { bindingId: bound.binding.id }, other), 'UNKNOWN_BINDING')
  failure(await call(client, 'supervisor_set_enabled', { bindingId: bound.binding.id, enabled: false, expectedRevision: 0 }, other), 'UNKNOWN_BINDING')
  failure(await call(client, 'supervisor_bind_workspace', { workspace: f.workspace }, undefined, { cwd: f.workspace }), 'THREAD_CONTEXT_REQUIRED')
  failure(await call(client, 'supervisor_status', { bindingId: bound.binding.id }), 'THREAD_CONTEXT_REQUIRED')
  failure(await call(client, 'supervisor_bind_workspace', { workspace: f.workspace }, 'fake-thread'), 'THREAD_CONTEXT_REQUIRED')
  const otherBound = success(await call(client, 'supervisor_bind_workspace', { workspace: f.workspace }, other))
  assert.notEqual(otherBound.binding.id, bound.binding.id)
  assert.equal(otherBound.bindings.length, 1)
  assert.equal(bound.bindings.length, 1)
  assert.doesNotMatch(JSON.stringify(otherBound), /ownerThreadId/)
  assert.deepEqual(fs.readdirSync(f.workspace), [])
})

test('strict tool arguments reject unknown fields, arbitrary paths, invalid tokens and unsafe revisions', async t => {
  const f = fixture(t)
  const client = await connect(t, f.options)
  const owner = randomUUID()
  failure(await call(client, 'supervisor_panel', { workspace: f.workspace }, owner), 'INVALID_ARGUMENTS')
  failure(await call(client, 'supervisor_bind_workspace', { workspace: f.workspace, threadId: owner }, owner), 'INVALID_ARGUMENTS')
  failure(await call(client, 'supervisor_bind_workspace', { workspace: './project' }, owner), 'INVALID_WORKSPACE')
  failure(await call(client, 'supervisor_bind_workspace', { workspace: path.join(f.root, 'missing') }, owner), 'INVALID_WORKSPACE')
  const bound = success(await call(client, 'supervisor_bind_workspace', { workspace: f.workspace }, owner))
  failure(await call(client, 'supervisor_status', { workspace: f.workspace }, owner), 'INVALID_ARGUMENTS')
  failure(await call(client, 'supervisor_status', { bindingId: 'not-a-uuid' }, owner), 'INVALID_BINDING')
  failure(await call(client, 'supervisor_status', { bindingId: randomUUID() }, owner), 'UNKNOWN_BINDING')
  failure(await call(client, 'supervisor_status', { bindingId: bound.binding.id, workspace: f.workspace }, owner), 'INVALID_ARGUMENTS')
  for (const input of [
    { enabled: 'yes', expectedRevision: 0 }, { enabled: true, expectedRevision: -1 }, { enabled: true, expectedRevision: 1.5 }, { enabled: true, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { enabled: true },
  ]) failure(await call(client, 'supervisor_set_enabled', { bindingId: bound.binding.id, ...input }, owner), 'INVALID_ARGUMENTS')
  failure(await call(client, 'execution_run', {}, owner), 'UNKNOWN_TOOL')
  assert.deepEqual(fs.readdirSync(f.workspace), [])
})

test('switch changes are revision checked, shared by workspace and do not create a roster or dispatch jobs', async t => {
  const f = fixture(t)
  const client = await connect(t, f.options)
  const owner = randomUUID()
  const bound = success(await call(client, 'supervisor_bind_workspace', { workspace: f.workspace }, owner))
  const disabled = success(await call(client, 'supervisor_set_enabled', { bindingId: bound.binding.id, enabled: false, expectedRevision: 0 }, owner))
  assert.deepEqual(disabled.binding.control, { workspace: f.workspace, enabled: false, revision: 1, configured: true })
  assert.equal(disabled.binding.initialized, false)
  assert.deepEqual(disabled.binding.jobs, [])
  const controlFile = path.join(f.workspace, '.codex', 'supervisor', 'control.v1.json')
  const before = fs.readFileSync(controlFile)
  failure(await call(client, 'supervisor_set_enabled', { bindingId: bound.binding.id, enabled: true, expectedRevision: 0 }, owner), 'STALE_CONTROL')
  assert.deepEqual(fs.readFileSync(controlFile), before)
  assert.equal(success(await call(client, 'supervisor_set_enabled', { bindingId: bound.binding.id, enabled: false, expectedRevision: 1 }, owner)).binding.control.revision, 1)
  assert.deepEqual(fs.readdirSync(path.dirname(controlFile)), ['control.v1.json'])
  const otherOwner = randomUUID()
  const otherBound = success(await call(client, 'supervisor_bind_workspace', { workspace: f.workspace }, otherOwner))
  assert.equal(otherBound.binding.control.enabled, false)
  assert.equal(success(await call(client, 'supervisor_set_enabled', { bindingId: otherBound.binding.id, enabled: true, expectedRevision: 1 }, otherOwner)).binding.control.revision, 2)
  assert.equal(success(await call(client, 'supervisor_status', { bindingId: bound.binding.id }, owner)).binding.control.enabled, true)
})

test('cached official SDK output schemas preserve structured CAS, foreign binding and missing-context errors', async t => {
  const f = fixture(t)
  const client = await connect(t, f.options)
  const { tools } = await client.listTools()
  const schema = tools.find(tool => tool.name === 'supervisor_set_enabled').outputSchema
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false)
  assert.equal(schema.oneOf.length, 2)
  assert.equal(schema.properties.error.additionalProperties, false)
  assert.ok(schema.properties.error.properties.code.enum.includes('STALE_CONTROL'))
  const owner = randomUUID()
  const binding = success(await call(client, 'supervisor_bind_workspace', { workspace: f.workspace }, owner)).binding
  success(await call(client, 'supervisor_set_enabled', { bindingId: binding.id, enabled: false, expectedRevision: 0 }, owner))
  failure(await call(client, 'supervisor_set_enabled', { bindingId: binding.id, enabled: true, expectedRevision: 0 }, owner), 'STALE_CONTROL')
  failure(await call(client, 'supervisor_status', { bindingId: binding.id }, randomUUID()), 'UNKNOWN_BINDING')
  failure(await call(client, 'supervisor_status', { bindingId: binding.id }), 'THREAD_CONTEXT_REQUIRED')
  failure(await call(client, 'supervisor_set_enabled', { bindingId: binding.id, enabled: 'on', expectedRevision: 1 }, owner), 'INVALID_ARGUMENTS')
  assert.deepEqual(success(await call(client, 'supervisor_status', { bindingId: binding.id }, owner)).binding.control, { workspace: f.workspace, enabled: false, revision: 1, configured: true })
})

test('status projects only public job counts and control, never private prompts, routes, grants or native receipts', async t => {
  const f = fixture(t)
  const configFile = path.join(f.workspace, 'private-config.json')
  fs.writeFileSync(configFile, JSON.stringify({ faculties: [{ id: 'academy', prompt: 'PRIVATE_DOMAIN_DESCRIPTION', route: 'legacy-provider/private-model' }] }))
  supervisor(['init', '--workspace', f.workspace, '--input', configFile])
  const store = new ExecutionStore(f.workspace)
  const proposal = { instruction: 'PRIVATE_JOB_INSTRUCTION', successCriteria: ['PRIVATE_CRITERIA'], verification: [{ kind: 'file', path: 'report.txt', contains: 'PRIVATE_CONTENT' }] }
  const job = store.mutate(state => propose(state, { jobId: 'job-one', taskId: 'task-one', proposal }))
  store.mutate(state => authorize(state, { jobId: job.id, digest: job.digest }))
  const attempt = store.mutate(state => beginAttempt(state, job.id))
  store.mutate(state => updateAttempt(state, { jobId: job.id, attemptId: attempt.id, status: 'failed', threadId: 'PRIVATE_NATIVE_THREAD', queuedSubmissionId: 'PRIVATE_QUEUE', result: { summary: 'PRIVATE_RESULT', checkpointSequence: 4 } }))
  const file = path.join(f.workspace, '.codex', 'supervisor', 'execution.v1.json')
  const before = fs.readFileSync(file)
  const client = await connect(t, f.options)
  const owner = randomUUID()
  const bound = success(await call(client, 'supervisor_bind_workspace', { workspace: f.workspace }, owner))
  const status = success(await call(client, 'supervisor_status', { bindingId: bound.binding.id }, owner))
  assert.equal(status.binding.initialized, true)
  assert.equal(status.binding.mentorCount, 1)
  assert.deepEqual(status.binding.jobs, [{ id: 'job-one', status: 'failed', authorized: true, attemptCount: 1, checkpointSequence: 4, requestedModel: null, requestedReasoningEffort: null, actualModel: null, actualReasoningEffort: null }])
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_|legacy-provider|proposal|digest|approvedAt|ownerThreadId|domainPrompt/)
  assert.deepEqual(fs.readFileSync(file), before)
})

test('symlink selections, plugin installation roots and registry symlinks fail closed', async t => {
  const f = fixture(t)
  const owner = randomUUID()
  const linkedWorkspace = path.join(f.root, 'linked-project')
  fs.symlinkSync(f.workspace, linkedWorkspace)
  const client = await connect(t, f.options)
  failure(await call(client, 'supervisor_bind_workspace', { workspace: linkedWorkspace }, owner), 'UNSAFE_PATH')
  failure(await call(client, 'supervisor_bind_workspace', { workspace: f.pluginRoot }, owner), 'INVALID_WORKSPACE')
  assert.equal(fs.existsSync(f.dataDirectory), false)
  fs.mkdirSync(f.dataDirectory, { recursive: true })
  const external = path.join(f.root, 'do-not-read.json')
  fs.writeFileSync(external, 'PRIVATE_EXTERNAL_CONTENT')
  fs.symlinkSync(external, path.join(f.dataDirectory, 'bindings.v1.json'))
  failure(await call(client, 'supervisor_panel', {}, owner), 'UNSAFE_PATH')
  failure(await call(client, 'supervisor_bind_workspace', { workspace: f.workspace }, owner), 'UNSAFE_PATH')
  assert.equal(fs.readFileSync(external, 'utf8'), 'PRIVATE_EXTERNAL_CONTENT')
  assert.deepEqual(fs.readdirSync(f.workspace), [])
})

test('corrupt or oversized registry and workspace state return static errors without raw source', async t => {
  const f = fixture(t)
  const client = await connect(t, f.options)
  const owner = randomUUID()
  fs.mkdirSync(f.dataDirectory, { recursive: true })
  const registryFile = path.join(f.dataDirectory, 'bindings.v1.json')
  fs.writeFileSync(registryFile, 'PRIVATE_INVALID_JSON')
  failure(await call(client, 'supervisor_panel', {}, owner), 'INVALID_REGISTRY')
  fs.writeFileSync(registryFile, 'X'.repeat(512 * 1024 + 1))
  failure(await call(client, 'supervisor_panel', {}, owner), 'SIZE_LIMIT')
  fs.unlinkSync(registryFile)
  const bound = success(await call(client, 'supervisor_bind_workspace', { workspace: f.workspace }, owner))
  fs.mkdirSync(path.join(f.workspace, '.codex', 'supervisor'), { recursive: true })
  const stateFile = path.join(f.workspace, '.codex', 'supervisor', 'state.v1.json')
  fs.writeFileSync(stateFile, 'PRIVATE_INVALID_ROSTER')
  failure(await call(client, 'supervisor_status', { bindingId: bound.binding.id }, owner), 'PANEL_STATE_UNAVAILABLE')
  assert.equal(fs.readFileSync(stateFile, 'utf8'), 'PRIVATE_INVALID_ROSTER')
})

test('unavailable or unsafe plugin data configuration never falls back to the installation cache', async t => {
  const f = fixture(t)
  const owner = randomUUID()
  for (const [dataDirectory, code] of [[null, 'DATA_UNAVAILABLE'], ['./data', 'DATA_UNAVAILABLE'], [f.pluginRoot, 'UNSAFE_DATA'], [path.parse(f.root).root, 'UNSAFE_DATA']]) {
    const client = await connect(t, { ...f.options, dataDirectory })
    assert.deepEqual(success(await call(client, 'supervisor_panel')), { schemaVersion: 1, bindings: [], binding: null })
    failure(await call(client, 'supervisor_panel', {}, owner), code)
    failure(await call(client, 'supervisor_bind_workspace', { workspace: f.workspace }, owner), code)
  }
  const link = path.join(f.root, 'linked-data')
  fs.symlinkSync(f.pluginRoot, link)
  const linkedClient = await connect(t, { ...f.options, dataDirectory: link })
  failure(await call(linkedClient, 'supervisor_bind_workspace', { workspace: f.workspace }, owner), 'UNSAFE_PATH')
  assert.deepEqual(fs.readdirSync(f.pluginRoot), ['panel.html'])
  assert.deepEqual(fs.readdirSync(f.workspace), [])
  assert.equal(fs.existsSync(f.dataDirectory), false)
})

test('another binding writer and a rebound workspace symlink are preserved and rejected', async t => {
  const f = fixture(t)
  const owner = randomUUID()
  const client = await connect(t, f.options)
  fs.mkdirSync(f.dataDirectory, { recursive: true })
  const lock = path.join(f.dataDirectory, '.bindings.lock')
  fs.writeFileSync(lock, 'EXISTING_LOCK')
  failure(await call(client, 'supervisor_bind_workspace', { workspace: f.workspace }, owner), 'BINDING_BUSY')
  assert.equal(fs.readFileSync(lock, 'utf8'), 'EXISTING_LOCK')
  fs.unlinkSync(lock)
  const bound = success(await call(client, 'supervisor_bind_workspace', { workspace: f.workspace }, owner))
  const replacement = path.join(f.root, 'replacement')
  fs.mkdirSync(replacement)
  fs.rmdirSync(f.workspace)
  fs.symlinkSync(replacement, f.workspace)
  failure(await call(client, 'supervisor_status', { bindingId: bound.binding.id }, owner), 'UNSAFE_PATH')
  failure(await call(client, 'supervisor_set_enabled', { bindingId: bound.binding.id, enabled: false, expectedRevision: 0 }, owner), 'UNSAFE_PATH')
  assert.deepEqual(fs.readdirSync(replacement), [])
})

test('official SDK stdio transport serves the same installed-style protocol without stdout noise', async t => {
  const f = fixture(t)
  const source = `import { startPanelServer } from ${JSON.stringify(serverModule)}; await startPanelServer(${JSON.stringify(f.options)});`
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--input-type=module', '-e', source], stderr: 'pipe' })
  let stderr = ''
  transport.stderr?.on('data', chunk => { stderr += chunk.toString() })
  const client = new Client({ name: 'stdio-test', version: '1.0.0' })
  t.after(() => client.close())
  await client.connect(transport)
  assert.equal((await client.listTools()).tools[0].name, 'supervisor_panel')
  assert.equal((await client.readResource({ uri: PANEL_URI })).contents[0].mimeType, PANEL_MIME)
  assert.deepEqual(success(await call(client, 'supervisor_panel', {}, randomUUID())), { schemaVersion: 1, bindings: [], binding: null })
  assert.equal(stderr, '')
  assert.equal(fs.existsSync(f.dataDirectory), false)
  assert.deepEqual(fs.readdirSync(f.workspace), [])
})
