import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'

// This adapter uses the installed Codex login and app-server protocol. It never
// reads authentication files, changes HOME/CODEX_HOME, or calls a model API directly.
const MAX_LINE_BYTES = 2 * 1024 * 1024
const MAX_READ_BYTES = 16 * 1024 * 1024
const MAX_EVENTS = 20000
const MAX_OUTPUT_BYTES = 64 * 1024
const TERMINAL = new Set(['completed', 'failed', 'interrupted'])
const RPC_METHODS = new Set(['initialize', 'config/read', 'model/list', 'thread/start', 'thread/resume', 'thread/read', 'thread/queue/add', 'thread/queue/list', 'thread/queue/delete', 'thread/goal/get', 'turn/interrupt', 'command/exec', 'command/exec/terminate'])
const RPC_CODES = new Set([-32700, -32600, -32601, -32602, -32603])
const TRANSPORT_CODES = new Set(['INVALID_INPUT', 'NATIVE_PROTOCOL', 'NATIVE_WORKSPACE', 'NATIVE_PERMISSIONS', 'NATIVE_OWNERSHIP', 'NATIVE_START', 'NATIVE_LIMIT', 'NATIVE_IO', 'NATIVE_EXIT', 'NATIVE_RPC', 'NATIVE_TIMEOUT', 'NATIVE_CLOSED', 'NATIVE_DUPLICATE', 'NATIVE_CORRELATION', 'NATIVE_RECEIPT', 'NATIVE_CANCELLED', 'NATIVE_MODEL'])
const STARTUP_READ_GRACE_MS = 2000
const MATERIALIZATION_READ_RETRIES = 3
const SIMPLE_NATIVE_ERRORS = new Set(['contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'serverOverloaded', 'cyberPolicy', 'misalignmentPolicyViolation', 'internalServerError', 'unauthorized', 'badRequest', 'threadRollbackFailed', 'sandboxError', 'other'])
const HTTP_NATIVE_ERRORS = new Set(['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'])
const DEFAULT_ARGS = [
  'app-server', '--listen', 'stdio://',
  '-c', 'approval_policy="on-request"',
  '-c', 'approvals_reviewer="user"',
  '-c', 'sandbox_mode="workspace-write"',
  '-c', 'sandbox_workspace_write.writable_roots=[]',
  '-c', 'sandbox_workspace_write.network_access=false',
  '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
  '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
]

export class NativeExecutorError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'NativeExecutorError'
    this.code = code
  }
}

function fail(code, message) { throw new NativeExecutorError(code, message) }
function validId(value, name) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value)) fail('INVALID_INPUT', `Invalid ${name}.`)
  return value
}
function modelId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(value)) fail('INVALID_INPUT', 'Invalid native model identifier.')
  return value
}
function workspacePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('INVALID_INPUT', 'Workspace must be an absolute directory.')
  try {
    const real = fs.realpathSync(value)
    if (!fs.statSync(real).isDirectory()) fail('INVALID_INPUT', 'Workspace must be an existing directory.')
    return real
  } catch { fail('INVALID_INPUT', 'Workspace must be an existing directory.') }
}
function timeoutValue(value = 120000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3600000) fail('INVALID_INPUT', 'Timeout must be between 1 and 3600000 milliseconds.')
  return value
}
function callback(value, name) {
  if (value !== undefined && typeof value !== 'function') fail('INVALID_INPUT', `${name} must be a function.`)
  return value
}
function rpcFailure(pending, body) {
  const error = new NativeExecutorError('NATIVE_RPC', 'Codex rejected a native protocol request.')
  if (RPC_METHODS.has(pending.method)) error.rpcMethod = pending.method
  if (RPC_CODES.has(body?.code)) error.rpcCode = body.code
  // Installed 0.149.0 has one documented pre-first-message read race. The
  // response body is compared and discarded, never exposed or persisted.
  const threadId = pending.params?.threadId
  if (pending.method === 'thread/read' && pending.params?.includeTurns === true && body?.code === -32600 && typeof threadId === 'string' && body.message === `thread ${threadId} is not materialized yet; includeTurns is unavailable before first user message`) error.materializationThreadId = threadId
  return error
}
function transportReceipt(error) {
  if (!(error instanceof NativeExecutorError) || !TRANSPORT_CODES.has(error.code)) return { code: 'NATIVE_PROTOCOL' }
  return { code: error.code, ...(RPC_METHODS.has(error.rpcMethod) ? { rpcMethod: error.rpcMethod } : {}), ...(RPC_CODES.has(error.rpcCode) ? { rpcCode: error.rpcCode } : {}) }
}
function nativeErrorReceipt(error) {
  const info = error?.codexErrorInfo
  if (typeof info === 'string' && SIMPLE_NATIVE_ERRORS.has(info)) return { type: info }
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null
  const keys = Object.keys(info)
  if (keys.length !== 1) return null
  const type = keys[0]
  if (HTTP_NATIVE_ERRORS.has(type)) {
    const status = info[type]?.httpStatusCode
    return { type, ...(Number.isSafeInteger(status) && status >= 100 && status <= 599 ? { httpStatusCode: status } : {}) }
  }
  if (type === 'activeTurnNotSteerable') return { type }
  return null
}
function normalizeTurn(turn) {
  if (!turn || typeof turn !== 'object' || !['inProgress', ...TERMINAL].includes(turn.status)) fail('NATIVE_PROTOCOL', 'Codex returned an invalid turn receipt.')
  const nativeError = nativeErrorReceipt(turn.error)
  return { id: validId(turn.id, 'native turn ID'), status: turn.status, ...(nativeError ? { nativeError } : {}) }
}

function readMacProxy() {
  return execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 1000, maxBuffer: 16 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
}

/** Honor existing macOS static HTTP(S) settings only for the native child. */
export function systemProxyEnvironment({ platform = process.platform, env = process.env, readProxy = readMacProxy } = {}) {
  if (platform !== 'darwin' || ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].some(key => Object.hasOwn(env, key))) return undefined
  let source
  try { source = readProxy() } catch { return undefined }
  if (typeof source !== 'string' || Buffer.byteLength(source) > 16 * 1024) return undefined
  const values = new Map()
  let depth = 0
  let opened = false
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '}') { if (--depth < 0) return undefined; continue }
    if (!opened) {
      if (line !== '<dictionary> {') return undefined
      opened = true
      depth = 1
      continue
    }
    if (depth === 0) { if (line) return undefined; continue }
    if (depth === 1) {
      const field = line.match(/^(HTTPEnable|HTTPProxy|HTTPPort|HTTPSEnable|HTTPSProxy|HTTPSPort|ProxyAutoConfigEnable|ProxyAutoDiscoveryEnable)\s*:\s*(.*?)\s*$/)
      if (field) { if (values.has(field[1])) return undefined; values.set(field[1], field[2]) }
    }
    if (line.endsWith('{')) depth += 1
  }
  if (!opened || depth !== 0) return undefined
  for (const key of ['HTTPEnable', 'HTTPSEnable', 'ProxyAutoConfigEnable', 'ProxyAutoDiscoveryEnable']) {
    if (values.has(key) && !['0', '1'].includes(values.get(key))) return undefined
  }
  if (values.get('ProxyAutoConfigEnable') === '1' || values.get('ProxyAutoDiscoveryEnable') === '1') return undefined
  const overrides = {}
  for (const [prefix, variable] of [['HTTP', 'HTTP_PROXY'], ['HTTPS', 'HTTPS_PROXY']]) {
    if (values.get(`${prefix}Enable`) !== '1') continue
    const host = values.get(`${prefix}Proxy`)
    const port = values.get(`${prefix}Port`)
    if (!host || !port || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return undefined
    const ip = isIP(host)
    if (!ip && (/^[\d.]+$/.test(host) || host.length > 253 || host.split('.').some(label => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)))) return undefined
    overrides[variable] = `http://${ip === 6 ? `[${host}]` : host}:${Number(port)}`
  }
  return Object.keys(overrides).length ? { ...env, ...overrides } : undefined
}
function checkThread(thread, workspace, expectedId) {
  if (!thread || typeof thread !== 'object') fail('NATIVE_PROTOCOL', 'Codex returned an invalid thread receipt.')
  const id = validId(thread.id, 'native thread ID')
  if (expectedId && id !== expectedId) fail('NATIVE_PROTOCOL', 'Codex returned a different thread.')
  if (thread.cwd !== workspace) fail('NATIVE_WORKSPACE', 'Native thread workspace does not match the authorized workspace.')
  if (!['idle', 'active', 'notLoaded', 'systemError'].includes(thread.status?.type)) fail('NATIVE_PROTOCOL', 'Codex returned an invalid thread status.')
  return thread
}
function checkPermissions(response, workspace) {
  const policy = response.sandbox
  if (response.cwd !== workspace || response.approvalPolicy !== 'on-request' || response.approvalsReviewer !== 'user' || policy?.type !== 'workspaceWrite' || policy.networkAccess === true) {
    fail('NATIVE_PERMISSIONS', 'Codex did not retain the requested workspace sandbox and human approval policy.')
  }
  if (!Array.isArray(policy.writableRoots) || policy.writableRoots.some(root => root !== workspace)) fail('NATIVE_PERMISSIONS', 'Codex returned writable roots outside the authorized workspace.')
  if (policy.excludeSlashTmp !== true || policy.excludeTmpdirEnvVar !== true) fail('NATIVE_PERMISSIONS', 'Codex did not retain the bounded workspace write policy.')
  if (response.thread.canAcceptDirectInput === false) fail('NATIVE_OWNERSHIP', 'Native thread does not accept independent execution.')
}

class RpcSession {
  constructor({ spawnImpl, serverCommand, serverArgs, platform, env, readProxy }, workspace, onMessage) {
    this.nextId = 0
    this.pending = new Map()
    this.waiters = new Set()
    this.revision = 0
    this.bytes = 0
    this.stderrBytes = 0
    this.events = 0
    this.buffer = Buffer.alloc(0)
    this.failure = null
    this.closed = false
    this.onMessage = onMessage
    try {
      const childEnv = systemProxyEnvironment({ platform, env, readProxy })
      this.child = spawnImpl(serverCommand, [...serverArgs], { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(childEnv ? { env: childEnv } : {}) })
    } catch { fail('NATIVE_START', 'Cannot start the installed Codex app-server.') }
    this.child.stdout.on('data', chunk => this.read(chunk))
    this.child.stderr.on('data', chunk => {
      // Logs can contain private context. Count and discard them immediately.
      this.stderrBytes += Buffer.byteLength(chunk)
      if (this.stderrBytes > MAX_READ_BYTES) this.stop(new NativeExecutorError('NATIVE_LIMIT', 'Codex exceeded the bounded log budget.'))
    })
    this.child.stdin.on('error', () => this.stop(new NativeExecutorError('NATIVE_IO', 'Cannot send a native protocol request.')))
    this.child.on('error', () => this.stop(new NativeExecutorError('NATIVE_START', 'Cannot start the installed Codex app-server.')))
    this.child.on('close', () => {
      this.closed = true
      this.stop(new NativeExecutorError('NATIVE_EXIT', 'Codex app-server stopped before a confirmed result.'))
    })
  }

  pulse() {
    this.revision += 1
    for (const resolve of this.waiters) resolve()
    this.waiters.clear()
  }

  stop(error) {
    if (this.failure) return
    this.failure = error
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    this.pulse()
  }

  read(chunk) {
    if (this.failure) return
    this.bytes += chunk.length
    if (this.bytes > MAX_READ_BYTES) return this.stop(new NativeExecutorError('NATIVE_LIMIT', 'Codex exceeded the bounded protocol budget.'))
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)])
    let newline
    while ((newline = this.buffer.indexOf(10)) >= 0) {
      if (newline > MAX_LINE_BYTES) return this.stop(new NativeExecutorError('NATIVE_LIMIT', 'Codex exceeded the bounded protocol line size.'))
      const line = this.buffer.subarray(0, newline).toString('utf8').trim()
      this.buffer = this.buffer.subarray(newline + 1)
      if (!line) continue
      if (++this.events > MAX_EVENTS) return this.stop(new NativeExecutorError('NATIVE_LIMIT', 'Codex exceeded the bounded event budget.'))
      let message
      try { message = JSON.parse(line) } catch { return this.stop(new NativeExecutorError('NATIVE_PROTOCOL', 'Codex emitted invalid protocol JSON.')) }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return this.stop(new NativeExecutorError('NATIVE_PROTOCOL', 'Codex emitted an invalid protocol message.'))
      if (Object.hasOwn(message, 'id') && !message.method) {
        const pending = this.pending.get(message.id)
        if (pending) {
          this.pending.delete(message.id)
          clearTimeout(pending.timer)
          // Never expose error messages or data from the native process.
          if (message.error) pending.reject(rpcFailure(pending, message.error))
          else if (Object.hasOwn(message, 'result')) pending.resolve(message.result)
          else pending.reject(new NativeExecutorError('NATIVE_PROTOCOL', 'Codex emitted an invalid protocol response.'))
        }
      } else {
        try { this.onMessage?.(message, this) } catch (error) {
          return this.stop(error instanceof NativeExecutorError ? error : new NativeExecutorError('NATIVE_PROTOCOL', 'Cannot process a native protocol event.'))
        }
      }
      this.pulse()
      if (this.failure) return
    }
    if (this.buffer.length > MAX_LINE_BYTES) this.stop(new NativeExecutorError('NATIVE_LIMIT', 'Codex exceeded the bounded protocol line size.'))
  }

  send(message) {
    if (this.failure || this.closed) throw this.failure || new NativeExecutorError('NATIVE_EXIT', 'Codex app-server is unavailable.')
    const line = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) fail('INVALID_INPUT', 'Native request exceeds its size limit.')
    this.child.stdin.write(line)
  }

  request(method, params, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new NativeExecutorError('NATIVE_TIMEOUT', 'Native protocol request timed out.'))
      }, timeoutMs)
      // Retain only the controlled fields needed to categorize a read race.
      this.pending.set(id, { resolve, reject, timer, method, params: method === 'thread/read' ? { threadId: params?.threadId, includeTurns: params?.includeTurns } : undefined })
      try { this.send({ id, method, params }) } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  wait(revision, timeoutMs = 1000) {
    if (this.failure) return Promise.reject(this.failure)
    if (this.revision !== revision) return Promise.resolve()
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve() }
      const timer = setTimeout(done, timeoutMs)
      this.waiters.add(done)
    })
  }

  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'harzva_supervisor', title: 'Harzva Supervisor', version: '0.2.1' }, capabilities: { experimentalApi: true } })
    this.send({ method: 'initialized', params: {} })
  }

  async close() {
    if (this.closed) return
    this.child.stdin.end()
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.child.kill('SIGTERM'); resolve() }, 300)
      this.child.once('close', () => { clearTimeout(timer); resolve() })
    })
    if (!this.closed) {
      this.child.kill('SIGKILL')
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 300)
        this.child.once('close', () => { clearTimeout(timer); resolve() })
      })
    }
    this.stop(new NativeExecutorError('NATIVE_CLOSED', 'Native protocol session closed.'))
  }
}

function rejectServerRequest(message, rpc) {
  if (!Object.hasOwn(message, 'id')) return
  if (message.method === 'currentTime/read') rpc.send({ id: message.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } })
  else rpc.send({ id: message.id, error: { code: -32601, message: 'Unattended native request is unsupported.' } })
}

async function readQueue(rpc, threadId, requestTimeoutMs = 10000) {
  let cursor = null
  const queued = []
  for (let page = 0; page < 10; page += 1) {
    const result = await rpc.request('thread/queue/list', { threadId, limit: 100, ...(cursor ? { cursor } : {}) }, requestTimeoutMs)
    if (!Array.isArray(result.data)) fail('NATIVE_PROTOCOL', 'Codex returned invalid queued receipts.')
    for (const entry of result.data) queued.push({ id: validId(entry.id, 'queued submission ID'), marker: validId(entry.clientUserMessageId, 'client message ID') })
    cursor = result.nextCursor
    if (!cursor) break
    if (page === 9 || typeof cursor !== 'string' || cursor.length > 4096) fail('NATIVE_LIMIT', 'Native queue exceeds the bounded inspection limit.')
  }
  return queued
}

async function readSnapshot(rpc, workspace, threadId, marker, turnId, requestTimeoutMs = 10000) {
  const read = await rpc.request('thread/read', { threadId, includeTurns: true }, requestTimeoutMs)
  const thread = checkThread(read.thread, workspace, threadId)
  if (!Array.isArray(thread.turns)) fail('NATIVE_PROTOCOL', 'Codex returned invalid native history.')
  const queued = await readQueue(rpc, threadId, requestTimeoutMs)
  const goalRead = await rpc.request('thread/goal/get', { threadId }, requestTimeoutMs)
  const activeGoal = goalRead.goal && goalRead.goal.status === 'active'
  const turns = thread.turns.map(turn => ({ ...normalizeTurn(turn), markerMatch: !!marker && Array.isArray(turn.items) && turn.items.some(item => item.type === 'userMessage' && item.clientId === marker) }))
  const matching = turns.filter(turn => turnId ? turn.id === turnId : turn.markerMatch)
  if (matching.length > 1) fail('NATIVE_DUPLICATE', 'Multiple native turns contain the same dispatch marker.')
  const matched = matching[0] || null
  if (turnId && marker && matched && !matched.markerMatch) fail('NATIVE_CORRELATION', 'Native turn does not contain the saved dispatch marker.')
  const latest = turns.at(-1) || null
  const busy = thread.status.type === 'active' || turns.some(turn => turn.status === 'inProgress')
  return { thread, turns, latest, matched, queued, activeGoal: !!activeGoal, busy }
}

function snapshotView(snapshot, marker) {
  return {
    threadId: snapshot.thread.id,
    state: ['systemError', 'notLoaded'].includes(snapshot.thread.status.type) ? 'uncertain' : snapshot.busy ? 'busy' : 'idle',
    busy: snapshot.busy,
    nativeThreadStatus: snapshot.thread.status.type,
    // A fresh server's stored read is evidence, not proof that another native
    // process no longer owns this thread. The parent must not auto retry an
    // uncertain dispatch using this view.
    statusSource: 'native-thread-read',
    turnId: snapshot.matched?.id || null,
    status: snapshot.matched?.status || null,
    latestTurnId: snapshot.latest?.id || null,
    latestTurnStatus: snapshot.latest?.status || null,
    marker: marker || null,
    queuedSubmissionIds: snapshot.queued.filter(entry => !marker || entry.marker === marker).map(entry => entry.id),
    queuedCount: snapshot.queued.length,
    activeGoal: snapshot.activeGoal,
    summary: snapshot.matched ? `Native turn ${snapshot.matched.status}; acceptance requires separate verification.` : 'No matching native turn was found.',
    ...(snapshot.matched?.nativeError ? { nativeError: snapshot.matched.nativeError } : {}),
  }
}

/** Library-only dependency injection. CLI callers always use the installed codex. */
export function createNativeExecutor({ spawnImpl = spawn, serverCommand = 'codex', serverArgs = DEFAULT_ARGS, platform = process.platform, env = process.env, readProxy = readMacProxy } = {}) {
  if (typeof spawnImpl !== 'function' || typeof serverCommand !== 'string' || !Array.isArray(serverArgs) || serverArgs.some(arg => typeof arg !== 'string')) fail('INVALID_INPUT', 'Invalid native adapter dependency injection.')
  if (typeof platform !== 'string' || !env || typeof env !== 'object' || Array.isArray(env) || typeof readProxy !== 'function') fail('INVALID_INPUT', 'Invalid native environment dependency injection.')
  const dependencies = { spawnImpl, serverCommand, serverArgs: [...serverArgs], platform, env, readProxy }

  async function models({ workspace } = {}) {
    workspace = workspacePath(workspace)
    const rpc = new RpcSession(dependencies, workspace, rejectServerRequest)
    try {
      await rpc.initialize()
      const config = await rpc.request('config/read', { cwd: workspace, includeLayers: false })
      const configured = config?.config?.model
      const configuredModel = configured === null || configured === undefined ? null : modelId(configured)
      const catalog = []
      const ids = new Set()
      const cursors = new Set()
      let cursor = null
      for (let page = 0; page < 10; page += 1) {
        const response = await rpc.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) })
        if (!Array.isArray(response?.data) || response.data.length > 100) fail('NATIVE_PROTOCOL', 'Codex returned an invalid model catalog.')
        for (const entry of response.data) {
          if (typeof entry?.displayName !== 'string' || entry.displayName.length > 256 || /[\u0000-\u001f\u007f]/.test(entry.displayName) || typeof entry.isDefault !== 'boolean') fail('NATIVE_PROTOCOL', 'Codex returned an invalid public model label.')
          const id = modelId(entry.id)
          const model = modelId(entry.model)
          if (ids.has(id)) fail('NATIVE_PROTOCOL', 'Codex returned duplicate model catalog IDs.')
          ids.add(id)
          catalog.push({ id, model, isDefault: entry.isDefault, displayName: entry.displayName })
        }
        cursor = response.nextCursor
        if (!cursor) return { configuredModel, models: catalog }
        if (typeof cursor !== 'string' || cursor.length > 4096 || cursors.has(cursor)) fail('NATIVE_PROTOCOL', 'Codex returned an invalid model catalog cursor.')
        cursors.add(cursor)
      }
      fail('NATIVE_LIMIT', 'Native model catalog exceeds the bounded inspection limit.')
    } finally { await rpc.close() }
  }

  async function inspect({ workspace, threadId, turnId, marker } = {}) {
    workspace = workspacePath(workspace)
    validId(threadId, 'native thread ID')
    if (turnId !== undefined && turnId !== null) validId(turnId, 'native turn ID')
    if (marker !== undefined && marker !== null) validId(marker, 'dispatch marker')
    const rpc = new RpcSession(dependencies, workspace, rejectServerRequest)
    try {
      await rpc.initialize()
      return snapshotView(await readSnapshot(rpc, workspace, threadId, marker, turnId), marker)
    } finally { await rpc.close() }
  }

  async function execute({ workspace, prompt, model, threadId, marker = randomUUID(), expectedPreviousTurnId, timeoutMs = 120000, onThread, onDispatch, onQueued, onStarted, signal } = {}) {
    workspace = workspacePath(workspace)
    timeoutMs = timeoutValue(timeoutMs)
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 256 * 1024) fail('INVALID_INPUT', 'Prompt must be nonempty and at most 256 KiB.')
    if (model !== undefined) modelId(model)
    validId(marker, 'dispatch marker')
    if (threadId !== undefined && threadId !== null) validId(threadId, 'native thread ID')
    if (expectedPreviousTurnId !== undefined && expectedPreviousTurnId !== null) validId(expectedPreviousTurnId, 'previous native turn ID')
    for (const [name, handler] of Object.entries({ onThread, onDispatch, onQueued, onStarted })) callback(handler, name)
    if (signal && typeof signal.addEventListener !== 'function') fail('INVALID_INPUT', 'Invalid abort signal.')
    const state = { threadId: threadId || null, turnId: null, queuedSubmissionId: null, dispatched: false, needsAction: false, persistenceFailed: false, starts: new Map(), terminals: new Map(), errors: new Map(), requests: [], startedSaved: false, transport: null }
    const deadline = Date.now() + timeoutMs
    let stopReason = null
    let stopResolve
    const stopped = new Promise(resolve => { stopResolve = resolve })
    const stop = reason => { if (!stopReason) { stopReason = reason; stopResolve() } }
    const abort = () => stop('cancelled')
    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    if (signal?.aborted) abort()
    signal?.addEventListener('abort', abort, { once: true })
    const guarded = promise => Promise.race([promise, stopped.then(() => { throw new NativeExecutorError(stopReason === 'timeout' ? 'NATIVE_TIMEOUT' : 'NATIVE_CANCELLED', 'Native execution stopped before a confirmed result.') })])
    const persist = async (handler, value) => {
      if (!handler) return
      try { await guarded(Promise.resolve().then(() => handler(value))) } catch (error) {
        if (stopReason) throw error
        state.persistenceFailed = true
        fail('NATIVE_RECEIPT', 'Cannot persist a native execution receipt.')
      }
    }
    const cancelRequests = rpc => {
      for (const request of state.requests) {
        if (request.handled || request.params?.threadId !== state.threadId || request.params?.turnId !== state.turnId || !state.turnId) continue
        request.handled = true
        state.needsAction = true
        if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) rpc.send({ id: request.id, result: { decision: 'cancel' } })
        else if (['execCommandApproval', 'applyPatchApproval'].includes(request.method)) rpc.send({ id: request.id, result: { decision: 'abort' } })
        else if (request.method === 'item/permissions/requestApproval') rpc.send({ id: request.id, result: { permissions: {}, scope: 'turn' } })
        else if (request.method === 'item/tool/requestUserInput') rpc.send({ id: request.id, result: { answers: {} } })
        else if (request.method === 'mcpServer/elicitation/request') rpc.send({ id: request.id, result: { action: 'cancel' } })
        else rpc.send({ id: request.id, error: { code: -32601, message: 'Unattended native request is unsupported.' } })
      }
    }
    const correlate = (turnId, rpc) => {
      validId(turnId, 'native turn ID')
      if (state.turnId && state.turnId !== turnId) fail('NATIVE_DUPLICATE', 'Multiple native turns contain the same dispatch marker.')
      state.turnId = turnId
      cancelRequests(rpc)
    }
    const rpc = new RpcSession(dependencies, workspace, (message, session) => {
      if (Object.hasOwn(message, 'id')) {
        if (message.method === 'currentTime/read') return rejectServerRequest(message, session)
        if (message.params?.threadId === state.threadId && state.dispatched) {
          if (state.requests.length >= 32) fail('NATIVE_LIMIT', 'Codex exceeded the bounded request limit.')
          state.requests.push({ id: message.id, method: message.method, params: { threadId: message.params.threadId, turnId: message.params.turnId }, handled: false })
          cancelRequests(session)
        } else rejectServerRequest(message, session)
        return
      }
      const params = message.params
      if (!params || params.threadId !== state.threadId || !state.dispatched) return
      if (message.method === 'error') {
        const nativeError = nativeErrorReceipt(params.error)
        if (nativeError && state.errors.size < 32) state.errors.set(validId(params.turnId, 'native turn ID'), nativeError)
      }
      if (['item/started', 'item/completed'].includes(message.method) && params.item?.type === 'userMessage' && params.item.clientId === marker) correlate(params.turnId, session)
      if (['turn/started', 'turn/completed'].includes(message.method)) {
        const turn = normalizeTurn(params.turn)
        if (state.starts.size >= 32 && !state.starts.has(turn.id)) fail('NATIVE_LIMIT', 'Codex exceeded the bounded turn limit.')
        state.starts.set(turn.id, turn.status)
        if (turn.nativeError) state.errors.set(turn.id, turn.nativeError)
        if (TERMINAL.has(turn.status)) state.terminals.set(turn.id, turn.status)
        if (Array.isArray(params.turn.items) && params.turn.items.some(item => item.type === 'userMessage' && item.clientId === marker)) correlate(turn.id, session)
      }
    })
    const result = (status, summary) => ({ threadId: state.threadId, turnId: state.turnId, marker, queuedSubmissionId: state.queuedSubmissionId, status, summary, ...(state.turnId && state.errors.has(state.turnId) ? { nativeError: state.errors.get(state.turnId) } : {}), ...(state.transport ? { transport: state.transport } : {}) })
    const ownMaterializationRace = error => state.dispatched && state.queuedSubmissionId && state.threadId && error instanceof NativeExecutorError && error.materializationThreadId === state.threadId && error.rpcMethod === 'thread/read' && error.rpcCode === -32600

    async function reconcileLocal(requestTimeoutMs) {
      const snapshot = await readSnapshot(rpc, workspace, state.threadId, marker, state.turnId, requestTimeoutMs)
      if (snapshot.matched) {
        correlate(snapshot.matched.id, rpc)
        if (snapshot.matched.nativeError) state.errors.set(snapshot.matched.id, snapshot.matched.nativeError)
        if (TERMINAL.has(snapshot.matched.status)) state.terminals.set(snapshot.matched.id, snapshot.matched.status)
      }
      return snapshot
    }

    async function stopOwnedWorkInner() {
      if (!state.dispatched || !state.threadId || rpc.failure) return null
      try {
        // Deletion is limited to an exact id + saved marker. A consumed row is
        // not evidence that inference never ran; inspect the matching turn.
        const snapshot = await reconcileLocal(1000)
        const matches = snapshot.queued.filter(entry => entry.marker === marker && (!state.queuedSubmissionId || entry.id === state.queuedSubmissionId))
        if (matches.length > 1) return null
        for (const entry of matches) await rpc.request('thread/queue/delete', { threadId: state.threadId, queuedSubmissionId: entry.id }, 1500)
        if (!state.turnId) return null
        const known = state.terminals.get(state.turnId)
        if (known) return known
        await rpc.request('turn/interrupt', { threadId: state.threadId, turnId: state.turnId }, 1500)
        const deadline = Date.now() + 1500
        while (Date.now() < deadline) {
          if (state.terminals.has(state.turnId)) return state.terminals.get(state.turnId)
          const revision = rpc.revision
          await rpc.wait(revision, 100)
        }
        return (await reconcileLocal(1000)).matched?.status || null
      } catch (error) {
        if (!ownMaterializationRace(error) || rpc.failure) return null
        // A cancellation can arrive before history materializes. Queue receipts
        // and a marker-correlated live turn still allow exact owned cancellation;
        // this fallback does not resume work or retry the failed history read.
        try {
          const queued = await readQueue(rpc, state.threadId, 1000)
          const matches = queued.filter(entry => entry.marker === marker && entry.id === state.queuedSubmissionId)
          if (matches.length > 1) return null
          for (const entry of matches) await rpc.request('thread/queue/delete', { threadId: state.threadId, queuedSubmissionId: entry.id }, 1500)
          if (!state.turnId) return null
          if (state.terminals.has(state.turnId)) return state.terminals.get(state.turnId)
          await rpc.request('turn/interrupt', { threadId: state.threadId, turnId: state.turnId }, 1500)
          const end = Date.now() + 1500
          while (Date.now() < end) {
            if (state.terminals.has(state.turnId)) return state.terminals.get(state.turnId)
            await rpc.wait(rpc.revision, 100)
          }
        } catch { /* Retain uncertainty if exact cancellation is unconfirmed. */ }
        return null
      }
    }

    async function stopOwnedWork() {
      let timer
      try {
        return await Promise.race([stopOwnedWorkInner(), new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000) })])
      } finally { clearTimeout(timer) }
    }

    try {
      if (stopReason) return result('interrupted', 'Native execution cancelled before dispatch.')
      await guarded(rpc.initialize())
      if (state.threadId) {
        // Reading and listing are inert. Resume may execute pending native queue
        // rows, so never resume before this ownership and queue check.
        const previous = await guarded(readSnapshot(rpc, workspace, state.threadId, marker))
        if (previous.matched || previous.queued.length || previous.busy || previous.activeGoal || previous.thread.status.type === 'systemError') return result('needs-user-action', 'Native thread has existing work; manual reconciliation is required before dispatch.')
        if ((expectedPreviousTurnId && previous.latest?.id !== expectedPreviousTurnId) || (previous.latest && (!expectedPreviousTurnId || !TERMINAL.has(previous.latest.status)))) return result('needs-user-action', 'Native thread changed after the saved execution receipt.')
      }
      const controls = { cwd: workspace, runtimeWorkspaceRoots: [workspace], approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', allowProviderModelFallback: false, ...(model === undefined ? {} : { model }) }
      const response = await guarded(rpc.request(state.threadId ? 'thread/resume' : 'thread/start', state.threadId ? { ...controls, threadId: state.threadId, excludeTurns: true } : { ...controls, ephemeral: false }))
      const thread = checkThread(response.thread, workspace, state.threadId)
      state.threadId = thread.id
      await persist(onThread, { threadId: state.threadId })
      checkPermissions(response, workspace)
      if (model !== undefined && response.model !== model) fail('NATIVE_MODEL', 'Codex did not retain the explicitly selected model.')
      if (thread.status.type !== 'idle') return result('needs-user-action', 'Native thread is not idle before dispatch.')
      await persist(onDispatch, { threadId: state.threadId, marker })
      // queue/add is itself dispatch-capable. The durable intent barrier must
      // precede it. clientUserMessageId correlates receipts; it is NOT a native
      // idempotency key. Never blindly retry this call or use turn/start.
      state.dispatched = true
      const added = await guarded(rpc.request('thread/queue/add', { threadId: state.threadId, clientUserMessageId: marker, input: [{ type: 'text', text: prompt }] }))
      if (!added?.queuedSubmission || added.queuedSubmission.clientUserMessageId !== marker) fail('NATIVE_CORRELATION', 'Codex returned a different queued dispatch receipt.')
      state.queuedSubmissionId = validId(added.queuedSubmission.id, 'queued submission ID')
      await persist(onQueued, { threadId: state.threadId, marker, queuedSubmissionId: state.queuedSubmissionId })
      // Lifecycle events can precede history materialization and the add reply.
      // Give those events priority without moving the original job deadline.
      let nextRead = Date.now() + STARTUP_READ_GRACE_MS
      let materializationRetries = 0
      while (true) {
        if (rpc.failure) throw rpc.failure
        if (stopReason) throw new NativeExecutorError(stopReason === 'timeout' ? 'NATIVE_TIMEOUT' : 'NATIVE_CANCELLED', 'Native execution stopped before a confirmed result.')
        if (state.turnId && !state.startedSaved) {
          await persist(onStarted, { threadId: state.threadId, turnId: state.turnId })
          state.startedSaved = true
        }
        if (state.needsAction) {
          await stopOwnedWork()
          return result('needs-user-action', 'Native execution requires human approval or input; the request was cancelled without granting permissions.')
        }
        const terminal = state.turnId && state.terminals.get(state.turnId)
        if (terminal) return result(terminal, `Native turn ${terminal}; acceptance requires separate verification.`)
        if (Date.now() >= nextRead) {
          try { await guarded(reconcileLocal()) } catch (error) {
            if (ownMaterializationRace(error) && materializationRetries < MATERIALIZATION_READ_RETRIES && !stopReason && Date.now() < deadline) {
              materializationRetries += 1
              nextRead = Math.min(Date.now() + 500, deadline)
              continue
            }
            throw error
          }
          nextRead = Date.now() + 1000
          continue
        }
        const revision = rpc.revision
        await guarded(rpc.wait(revision, Math.min(1000, nextRead - Date.now())))
      }
    } catch (error) {
      state.transport = transportReceipt(error)
      const stoppedStatus = await stopOwnedWork()
      if (state.needsAction) return result('needs-user-action', 'Native execution requires human approval or input; no approval was granted.')
      if (state.persistenceFailed) return result(state.dispatched ? 'uncertain' : 'failed', 'Native receipt persistence failed; manual recovery is required.')
      if (state.dispatched) {
        if (stopReason && TERMINAL.has(stoppedStatus)) return result(stoppedStatus, `Native turn ${stoppedStatus} after ${stopReason}; acceptance requires separate verification.`)
        return result('uncertain', 'Native dispatch may have run; inspect the saved marker before any further execution.')
      }
      return result(stopReason ? 'interrupted' : 'failed', stopReason ? 'Native execution stopped before dispatch.' : 'Native execution could not start with the requested protocol and permissions.')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      await rpc.close()
    }
  }

  async function verifyCommand({ workspace, argv, timeoutMs = 120000, signal } = {}) {
    workspace = workspacePath(workspace)
    timeoutMs = timeoutValue(timeoutMs)
    if (!Array.isArray(argv) || !argv.length || argv.length > 64 || argv[0] === '' || argv.some(arg => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > 8192) || Buffer.byteLength(JSON.stringify(argv)) > 65536) fail('INVALID_INPUT', 'Verification requires a bounded, trusted argv vector.')
    if (signal && typeof signal.addEventListener !== 'function') fail('INVALID_INPUT', 'Invalid abort signal.')
    let needsAction = false
    let stopReason = null
    let stopResolve
    let commandSent = false
    const processId = `supervisor-verify-${randomUUID()}`
    const stopped = new Promise(resolve => { stopResolve = resolve })
    const stop = reason => { if (!stopReason) { stopReason = reason; stopResolve() } }
    const abort = () => stop('cancelled')
    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const guarded = promise => Promise.race([promise, stopped.then(() => { throw new NativeExecutorError('NATIVE_CANCELLED', 'Native verification stopped before a confirmed result.') })])
    const rpc = new RpcSession(dependencies, workspace, (message, session) => {
      if (!Object.hasOwn(message, 'id')) return
      if (message.method !== 'currentTime/read') needsAction = true
      rejectServerRequest(message, session)
    })
    const stoppedReceipt = () => ({ status: commandSent ? 'uncertain' : 'interrupted', completionConfirmed: !commandSent, needsUserAction: commandSent, exitCode: null, outputBytes: 0, timedOut: stopReason === 'timeout', cancelled: stopReason === 'cancelled' })
    async function stopCommand(execution) {
      let completed = false
      execution.then(() => { completed = true }, () => {})
      const deadline = Date.now() + 3000
      while (!completed && !rpc.failure && Date.now() < deadline) {
        try {
          // Preprocessing can await native config/network setup before this id
          // is registered. An unknown-id rejection does NOT prove no command
          // ran. Only retry termination of this exact id, never command/exec.
          await rpc.request('command/exec/terminate', { processId }, Math.min(500, deadline - Date.now()))
        } catch { /* Keep monitoring the original completion and exact id. */ }
        if (completed || rpc.failure) break
        await rpc.wait(rpc.revision, Math.min(50, Math.max(1, deadline - Date.now())))
      }
      return { ...stoppedReceipt(), status: completed ? 'interrupted' : 'uncertain', completionConfirmed: completed, needsUserAction: !completed }
    }
    try {
      if (stopReason) return stoppedReceipt()
      await guarded(rpc.initialize())
      // command/exec has no turn approval stage. The caller must supply checks
      // explicitly authorized in the immutable task scope, never model output.
      commandSent = true
      const execution = rpc.request('command/exec', { command: argv, processId, cwd: workspace, sandboxPolicy: { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true }, timeoutMs, outputBytesCap: MAX_OUTPUT_BYTES }, timeoutMs + 5000)
      let executed
      try { executed = await guarded(execution) } catch (error) {
        if (!stopReason) throw error
        return await stopCommand(execution)
      }
      // Cancellation dominates a successful exit racing with the abort event.
      if (stopReason || signal?.aborted) { if (!stopReason) stop('cancelled'); return await stopCommand(execution) }
      if (needsAction) return { status: 'needs-user-action', completionConfirmed: true, needsUserAction: true, exitCode: null, outputBytes: 0 }
      if (!Number.isSafeInteger(executed?.exitCode) || typeof executed.stdout !== 'string' || typeof executed.stderr !== 'string' || Buffer.byteLength(executed.stdout) > MAX_OUTPUT_BYTES || Buffer.byteLength(executed.stderr) > MAX_OUTPUT_BYTES) fail('NATIVE_PROTOCOL', 'Codex returned an invalid verification receipt.')
      const stdoutBytes = Buffer.byteLength(executed.stdout)
      const stderrBytes = Buffer.byteLength(executed.stderr)
      return { completionConfirmed: true, needsUserAction: false, exitCode: executed.exitCode, stdoutDigest: createHash('sha256').update(executed.stdout).digest('hex'), stderrDigest: createHash('sha256').update(executed.stderr).digest('hex'), outputBytes: stdoutBytes + stderrBytes, outputMayBeTruncated: stdoutBytes === MAX_OUTPUT_BYTES || stderrBytes === MAX_OUTPUT_BYTES, timedOut: executed.exitCode === 124 }
    } catch (error) {
      if (stopReason) return stoppedReceipt()
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      await rpc.close()
    }
  }

  return { execute, inspect, verifyCommand, models }
}

const installedExecutor = createNativeExecutor()
export const execute = installedExecutor.execute
export const inspect = installedExecutor.inspect
export const verifyCommand = installedExecutor.verifyCommand
export const models = installedExecutor.models
