import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readControl, setControl } from '../scripts/control.mjs'
import { ExecutionStore, cancel } from '../scripts/execution-store.mjs'
import { models as nativeModels } from '../scripts/native-executor.mjs'
import { readExecutionSettings, setExecutionSettings, resolveSelection } from '../scripts/settings.mjs'
import { run as supervisor } from '../scripts/supervisor.mjs'
import { SupervisorError } from '../scripts/state.mjs'
import { BindingRegistry, PanelError, reject, threadContext } from './bindings.mjs'

export const PANEL_URI = 'ui://harzva-supervisor/panel'
export const PANEL_MIME = 'text/html;profile=mcp-app'
const VERSION = '0.4.0'
const MAX_RESOURCE_BYTES = 512 * 1024
const pluginRootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SAFE_STATE_ERRORS = new Set(['NOT_INITIALIZED', 'STALE_CONTROL', 'STALE_SETTINGS', 'UNSAFE_PATH', 'PATH_ACCESS', 'WORKSPACE', 'WORKSPACE_BINDING', 'SIZE_LIMIT', 'UNKNOWN_SCHEMA', 'INVALID_CONTROL', 'INVALID_SETTINGS', 'LOCKED', 'REVISION_LIMIT', 'MODEL_CATALOG_UNAVAILABLE', 'MODEL_UNAVAILABLE', 'REASONING_UNAVAILABLE'])
const ERROR_CODES = [...new Set([
  'INVALID_WORKSPACE', 'PATH_ACCESS', 'UNSAFE_PATH', 'INVALID_BINDING', 'DATA_UNAVAILABLE', 'UNSAFE_DATA', 'INVALID_REGISTRY', 'SIZE_LIMIT',
  'THREAD_CONTEXT_REQUIRED', 'UNKNOWN_BINDING', 'BINDING_BUSY', 'BINDING_LIMIT', 'REGISTRY_WRITE', 'INVALID_ARGUMENTS', 'UNKNOWN_TOOL',
  ...SAFE_STATE_ERRORS, 'PANEL_STATE_UNAVAILABLE',
])]
const SAFE_ERRORS = new Set(ERROR_CODES)

const emptySchema = { type: 'object', properties: {}, additionalProperties: false }
const bindingSchema = {
  type: 'object', properties: { bindingId: { type: 'string', format: 'uuid' } }, required: ['bindingId'], additionalProperties: false,
}
const appMeta = { ui: { resourceUri: PANEL_URI, visibility: ['app'] } }
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const publicBindingSchema = {
  type: 'object', properties: { id: { type: 'string', format: 'uuid' }, label: { type: 'string' }, workspace: { type: 'string' } },
  required: ['id', 'label', 'workspace'], additionalProperties: false,
}
const nullableString = { anyOf: [{ type: 'null' }, { type: 'string' }] }
const settingsSchema = {
  type: 'object', additionalProperties: false, required: ['mode', 'model', 'reasoningEffort', 'revision', 'configured'],
  properties: { mode: { enum: ['default', 'custom'] }, model: nullableString, reasoningEffort: nullableString, revision: { type: 'integer', minimum: 0 }, configured: { type: 'boolean' } },
}
const catalogSchema = { anyOf: [{ type: 'null' }, {
  type: 'object', additionalProperties: false, required: ['configuredModel', 'models'], properties: {
    configuredModel: nullableString, configuredReasoningEffort: nullableString,
    models: { type: 'array', maxItems: 1000, items: { type: 'object', additionalProperties: false, required: ['id', 'model', 'displayName', 'isDefault', 'supportedReasoningEfforts', 'defaultReasoningEffort'], properties: {
      id: { type: 'string' }, model: { type: 'string' }, displayName: { type: 'string' }, isDefault: { type: 'boolean' }, defaultReasoningEffort: { type: 'string' },
      supportedReasoningEfforts: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['reasoningEffort', 'description'], properties: { reasoningEffort: { type: 'string' }, description: { type: 'string' } } } },
    } } },
  },
}] }
const snapshotSchema = {
  type: 'object', additionalProperties: false, required: ['schemaVersion', 'bindings', 'binding'],
  properties: {
    schemaVersion: { const: 1 },
    bindings: { type: 'array', maxItems: 100, items: publicBindingSchema },
    binding: { anyOf: [{ type: 'null' }, {
      type: 'object', additionalProperties: false, required: ['id', 'label', 'workspace', 'control', 'initialized', 'mentorCount', 'jobs', 'executionSettings', 'catalog', 'conversationModelAvailable'],
      properties: {
        ...publicBindingSchema.properties,
        control: { type: 'object', additionalProperties: false, required: ['workspace', 'enabled', 'revision', 'configured'], properties: { workspace: { type: 'string' }, enabled: { type: 'boolean' }, revision: { type: 'integer', minimum: 0 }, configured: { type: 'boolean' } } },
        executionSettings: settingsSchema, catalog: catalogSchema, conversationModelAvailable: { const: false },
        initialized: { type: 'boolean' }, mentorCount: { type: 'integer', minimum: 0, maximum: 40 },
        jobs: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['id', 'status', 'authorized', 'attemptCount', 'requestedModel', 'requestedReasoningEffort', 'actualModel', 'actualReasoningEffort'], properties: { id: { type: 'string' }, status: { type: 'string', enum: ['proposed', 'authorized', 'dispatching', 'running', 'verifying', 'succeeded', 'failed', 'needs-user-action', 'uncertain', 'cancelling', 'cancelled'] }, authorized: { type: 'boolean' }, attemptCount: { type: 'integer', minimum: 0, maximum: 3 }, checkpointSequence: { type: 'integer', minimum: 0 }, requestedModel: nullableString, requestedReasoningEffort: nullableString, actualModel: nullableString, actualReasoningEffort: nullableString } } },
      },
    }] },
  },
}
const errorSchema = {
  type: 'object', additionalProperties: false, required: ['error'],
  properties: { error: { type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string', enum: ERROR_CODES } } } },
}
// SDK clients also validate structuredContent on isError results. Declare both
// disjoint shapes so a known CAS/input failure remains a tool result rather
// than being promoted into a transport/schema failure by a cached tools/list.
const outputSchema = {
  type: 'object', properties: { ...snapshotSchema.properties, ...errorSchema.properties }, additionalProperties: false,
  oneOf: [snapshotSchema, errorSchema],
}

export const PANEL_TOOLS = [
  {
    name: 'supervisor_panel', title: 'Supervisor', description: 'Open the Supervisor switch for a workspace explicitly selected in this conversation.', inputSchema: emptySchema,
    outputSchema, annotations: readAnnotations,
    _meta: { ui: { resourceUri: PANEL_URI }, 'openai/ui': { entrypoints: [{ type: 'thread' }] } },
  },
  {
    name: 'supervisor_bind_workspace', title: 'Select workspace', description: 'Bind an existing absolute workspace directory selected in the Supervisor panel to this conversation.',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string', minLength: 1, maxLength: 4096 } }, required: ['workspace'], additionalProperties: false },
    outputSchema, annotations: writeAnnotations, _meta: appMeta,
  },
  { name: 'supervisor_status', title: 'Refresh Supervisor', description: 'Read public Supervisor status for a workspace bound to this conversation.', inputSchema: bindingSchema, outputSchema, annotations: readAnnotations, _meta: appMeta },
  {
    name: 'supervisor_set_enabled', title: 'Set Supervisor switch', description: 'Set the workspace switch using its current revision. This operation does not start or cancel any execution.',
    inputSchema: {
      type: 'object', properties: { bindingId: { type: 'string', format: 'uuid' }, enabled: { type: 'boolean' }, expectedRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } },
      required: ['bindingId', 'enabled', 'expectedRevision'], additionalProperties: false,
    },
    outputSchema, annotations: writeAnnotations, _meta: appMeta,
  },
  { name: 'supervisor_models', title: 'Read execution models', description: 'Read the native execution model catalog and supported reasoning efforts for the bound workspace. It does not run a model.', inputSchema: bindingSchema, outputSchema, annotations: readAnnotations, _meta: appMeta },
  {
    name: 'supervisor_set_execution', title: 'Save execution settings', description: 'Save model and reasoning defaults for new proposals only. Existing authorized jobs retain their immutable settings.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['bindingId', 'mode', 'model', 'reasoningEffort', 'expectedRevision'], properties: {
      bindingId: { type: 'string', format: 'uuid' }, mode: { enum: ['default', 'custom'] }, model: nullableString, reasoningEffort: nullableString, expectedRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    } }, outputSchema, annotations: writeAnnotations, _meta: appMeta,
  },
  { name: 'supervisor_stop', title: 'Stop workspace execution', description: 'Disable new dispatch and request cancellation of authorized or active Supervisor jobs in this bound workspace. Pending cancellation is not proof of termination.', inputSchema: bindingSchema, outputSchema, annotations: writeAnnotations, _meta: appMeta },
]

function argumentsFor(value, required) {
  const input = value ?? {}
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !required.includes(key)) || required.some(key => !Object.hasOwn(input, key))) reject('INVALID_ARGUMENTS')
  return input
}

function publicBinding(entry) { return { id: entry.id, label: entry.label, workspace: entry.workspace } }

function summarize(entry) {
  let mentorCount = 0
  let initialized = false
  try {
    const roster = supervisor(['roster', '--workspace', entry.workspace])
    mentorCount = roster.mentors.length
    initialized = true
  } catch (error) {
    if (!(error instanceof SupervisorError) || error.code !== 'NOT_INITIALIZED') throw error
  }
  const execution = new ExecutionStore(entry.workspace).snapshot()
  const jobs = Object.values(execution.jobs).map(job => {
    const selection = job.attempts.at(-1)?.result?.selection
    const result = { id: job.id, status: job.status, authorized: job.authorization !== null, attemptCount: job.attempts.length, requestedModel: job.proposal.model ?? null, requestedReasoningEffort: job.proposal.reasoningEffort ?? null, actualModel: selection?.model ?? null, actualReasoningEffort: selection?.reasoningEffort ?? null }
    const sequence = job.attempts.at(-1)?.result?.checkpointSequence
    if (Number.isSafeInteger(sequence) && sequence >= 0) result.checkpointSequence = sequence
    return result
  })
  return { ...publicBinding(entry), control: readControl(entry.workspace), initialized, mentorCount, jobs, executionSettings: readExecutionSettings(entry.workspace), catalog: null, conversationModelAvailable: false }
}

function snapshot(registry, owner, entry = null, catalog = null) {
  const bindings = registry.list(owner)
  return { schemaVersion: 1, bindings: bindings.map(publicBinding), binding: entry ? { ...summarize(entry), catalog } : null }
}

function result(snapshot) {
  return { content: [{ type: 'text', text: JSON.stringify(snapshot) }], structuredContent: snapshot }
}

function errorResult(error) {
  const code = error instanceof PanelError && SAFE_ERRORS.has(error.code) ? error.code : error instanceof SupervisorError && SAFE_STATE_ERRORS.has(error.code) ? error.code : 'PANEL_STATE_UNAVAILABLE'
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code } }) }], structuredContent: { error: { code } } }
}

export function createPanelServer({ dataDirectory = process.env.HARZVA_SUPERVISOR_DATA, pluginRoot = pluginRootDefault, htmlPath = path.join(pluginRoot, 'ui', 'panel.html'), modelReader = nativeModels } = {}) {
  // Constructing and listing the entrypoint cannot create either plugin data or
  // a workspace. Invalid data configuration is surfaced only as a static error.
  const server = new Server({ name: 'harzva-supervisor-panel', version: VERSION }, { capabilities: { tools: {}, resources: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: structuredClone(PANEL_TOOLS) }))
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: PANEL_URI, name: 'Supervisor', mimeType: PANEL_MIME }] }))
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    if (request.params.uri !== PANEL_URI) throw new Error('RESOURCE_NOT_FOUND')
    let html
    try {
      const stat = fs.lstatSync(htmlPath)
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_RESOURCE_BYTES) throw new Error('RESOURCE_UNAVAILABLE')
      const fd = fs.openSync(htmlPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try {
        const opened = fs.fstatSync(fd)
        if (!opened.isFile() || opened.size > MAX_RESOURCE_BYTES) throw new Error('RESOURCE_UNAVAILABLE')
        const bytes = Buffer.alloc(MAX_RESOURCE_BYTES + 1)
        const length = fs.readSync(fd, bytes, 0, bytes.length, 0)
        if (length > MAX_RESOURCE_BYTES) throw new Error('RESOURCE_UNAVAILABLE')
        html = bytes.subarray(0, length).toString('utf8')
      } finally { fs.closeSync(fd) }
    } catch { throw new Error('RESOURCE_UNAVAILABLE') }
    return { contents: [{ uri: PANEL_URI, mimeType: PANEL_MIME, text: html, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } } }] }
  })
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const owner = threadContext(request.params._meta)
      if (request.params.name === 'supervisor_panel') {
        argumentsFor(request.params.arguments, [])
        if (!owner) return result({ schemaVersion: 1, bindings: [], binding: null })
        const registry = new BindingRegistry(dataDirectory, pluginRoot)
        const bindings = registry.list(owner)
        const entry = bindings.at(-1) ?? null
        if (entry) registry.get(owner, entry.id)
        return result(snapshot(registry, owner, entry))
      }
      if (!owner) reject('THREAD_CONTEXT_REQUIRED')
      const registry = new BindingRegistry(dataDirectory, pluginRoot)
      if (request.params.name === 'supervisor_bind_workspace') {
        const input = argumentsFor(request.params.arguments, ['workspace'])
        const entry = registry.bind(owner, input.workspace)
        return result(snapshot(registry, owner, entry))
      }
      if (request.params.name === 'supervisor_status') {
        const input = argumentsFor(request.params.arguments, ['bindingId'])
        return result(snapshot(registry, owner, registry.get(owner, input.bindingId)))
      }
      if (request.params.name === 'supervisor_set_enabled') {
        const input = argumentsFor(request.params.arguments, ['bindingId', 'enabled', 'expectedRevision'])
        if (typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) reject('INVALID_ARGUMENTS')
        const entry = registry.get(owner, input.bindingId)
        setControl(entry.workspace, { enabled: input.enabled, expectedRevision: input.expectedRevision })
        return result(snapshot(registry, owner, entry))
      }
      if (request.params.name === 'supervisor_models' || request.params.name === 'supervisor_set_execution') {
        const saving = request.params.name === 'supervisor_set_execution'
        const input = argumentsFor(request.params.arguments, saving ? ['bindingId', 'mode', 'model', 'reasoningEffort', 'expectedRevision'] : ['bindingId'])
        const entry = registry.get(owner, input.bindingId)
        if (saving && (!['default', 'custom'].includes(input.mode) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || (input.mode === 'default' && (input.model !== null || input.reasoningEffort !== null)))) reject('INVALID_ARGUMENTS')
        let catalog
        try { catalog = await modelReader({ workspace: entry.workspace }) } catch { reject('MODEL_CATALOG_UNAVAILABLE') }
        // Native discovery awaits another process. Recheck the binding path
        // before any write or state read; it may have been replaced meanwhile.
        registry.get(owner, input.bindingId)
        if (saving) {
          resolveSelection(input, {}, catalog)
          setExecutionSettings(entry.workspace, { mode: input.mode, model: input.model, reasoningEffort: input.reasoningEffort, expectedRevision: input.expectedRevision })
        }
        return result(snapshot(registry, owner, entry, catalog))
      }
      if (request.params.name === 'supervisor_stop') {
        const input = argumentsFor(request.params.arguments, ['bindingId'])
        const entry = registry.get(owner, input.bindingId)
        // Close the dispatch gate first. Cancellation remains available when
        // the switch or settings revision shown in the UI is stale.
        setControl(entry.workspace, { enabled: false })
        const store = new ExecutionStore(entry.workspace)
        const cancellable = new Set(['authorized', 'dispatching', 'running', 'verifying', 'failed', 'needs-user-action', 'uncertain', 'cancelling'])
        if (Object.values(store.snapshot().jobs).some(job => cancellable.has(job.status))) store.mutate(state => {
          for (const job of Object.values(state.jobs)) if (cancellable.has(job.status)) cancel(state, job.id)
        })
        return result(snapshot(registry, owner, entry))
      }
      reject('UNKNOWN_TOOL')
    } catch (error) { return errorResult(error) }
  })
  return server
}

export async function startPanelServer(options) {
  const server = createPanelServer(options)
  await server.connect(new StdioServerTransport())
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startPanelServer().catch(() => { process.stderr.write('Supervisor panel unavailable.\n'); process.exitCode = 1 })
}
