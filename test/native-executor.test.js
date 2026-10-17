import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import { createNativeExecutor, systemProxyEnvironment } from '../plugins/codex-supervisor/scripts/native-executor.mjs'

const THREAD = '019f-native-worker'
const TURN = '019f-native-turn'
const MARKER = 'supervisor-attempt-one'
const QUEUED = '019f-native-queued'
const clone = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function fixture(t, options = {}) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-native-test-')))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const native = { messages: [], processes: [], turns: clone(options.turns || []), queued: clone(options.queued || []), status: options.status || 'idle', goal: options.goal || null }
  const thread = () => ({ id: THREAD, cwd: workspace, status: { type: native.status }, canAcceptDirectInput: true, turns: clone(native.turns) })
  const permissions = () => ({ cwd: workspace, model: options.model || 'host-default-model', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true }, thread: thread(), ...(options.permissions || {}) })
  native.spawnImpl = (command, args, spawnOptions) => {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = signal => { native.killSignals ||= []; native.killSignals.push(signal); process.nextTick(() => child.emit('close', 0)); return true }
    native.processes.push({ command, args, options: spawnOptions, child })
    const send = message => child.stdout.write(`${JSON.stringify(message)}\n`)
    const reply = (message, result) => send({ id: message.id, result })
    const complete = (status = 'completed') => {
      const turn = native.turns.find(turn => turn.id === TURN)
      if (turn) turn.status = status
      native.status = 'idle'
      send({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, status, items: [] } } })
    }
    const start = (marker = MARKER, turnId = TURN) => {
      native.status = 'active'
      native.queued = []
      native.turns.push({ id: turnId, status: 'inProgress', items: [{ id: 'native-user-item', type: 'userMessage', clientId: marker, content: [{ type: 'text', text: 'private prompt' }] }] })
      send({ method: 'turn/started', params: { threadId: THREAD, turn: { id: turnId, status: 'inProgress', items: [] } } })
      send({ method: 'item/completed', params: { threadId: THREAD, turnId, item: native.turns.at(-1).items[0], completedAtMs: Date.now() } })
    }
    native.send = send
    native.complete = complete
    native.start = start
    let buffer = ''
    child.stdin.on('data', chunk => {
      buffer += chunk.toString('utf8')
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        native.messages.push(message)
        if (options.onMessage?.({ message, native, child, send, reply, complete, start, thread, permissions }) === true) continue
        if (message.method === 'initialize') reply(message, { userAgent: 'codex_cli_rs/0.149.0', codexHome: '/not-read', platformFamily: 'unix', platformOs: 'macos' })
        else if (message.method === 'thread/start' || message.method === 'thread/resume') {
          native.status = 'idle'
          reply(message, permissions())
        }
        else if (message.method === 'thread/read') reply(message, { thread: thread() })
        else if (message.method === 'thread/queue/list') reply(message, { data: clone(native.queued), nextCursor: null })
        else if (message.method === 'thread/goal/get') reply(message, { goal: native.goal })
        else if (message.method === 'thread/queue/add') {
          const queued = { id: QUEUED, clientUserMessageId: message.params.clientUserMessageId, input: message.params.input }
          native.queued.push(queued)
          start(message.params.clientUserMessageId)
          // The native scheduler can run and complete before queue/add responds.
          complete()
          reply(message, { queuedSubmission: queued })
        } else if (message.method === 'thread/queue/delete') {
          const before = native.queued.length
          native.queued = native.queued.filter(entry => entry.id !== message.params.queuedSubmissionId)
          reply(message, { deleted: before !== native.queued.length })
        } else if (message.method === 'turn/interrupt') { reply(message, {}); complete('interrupted') }
        else if (message.method === 'command/exec') reply(message, { exitCode: 0, stdout: '3 passed\n', stderr: '' })
      }
    })
    child.stdin.on('finish', () => process.nextTick(() => child.emit('close', 0)))
    return child
  }
  const executor = createNativeExecutor({ spawnImpl: native.spawnImpl, platform: 'linux', ...(options.dependencies || {}) })
  return { workspace, native, executor, execute: values => executor.execute({ workspace, prompt: 'Perform the authorized bounded local task.', marker: MARKER, timeoutMs: 3000, ...values }) }
}

test('native queue handshake preserves permissions and completion arriving before queue acknowledgment', async t => {
  const f = fixture(t)
  const callbacks = []
  const result = await f.execute({
    onThread: async receipt => { callbacks.push('thread'); assert.equal(receipt.threadId, THREAD) },
    onDispatch: async receipt => { callbacks.push('dispatch'); assert.equal(receipt.marker, MARKER); assert.equal(f.native.messages.some(message => message.method === 'thread/queue/add'), false) },
    onQueued: async receipt => { callbacks.push('queued'); assert.equal(receipt.queuedSubmissionId, QUEUED) },
    onStarted: async receipt => { callbacks.push('started'); assert.equal(receipt.turnId, TURN) },
  })
  assert.equal(result.status, 'completed')
  assert.equal(result.turnId, TURN)
  assert.deepEqual(callbacks, ['thread', 'dispatch', 'queued', 'started'])
  const methods = f.native.messages.filter(message => message.method).map(message => message.method)
  assert.deepEqual(methods.slice(0, 4), ['initialize', 'initialized', 'thread/start', 'thread/queue/add'])
  assert.equal(methods.includes('turn/start'), false)
  assert.equal(methods.includes('thread/queue/start'), false)
  const initialized = f.native.messages[0]
  assert.equal(initialized.params.capabilities.experimentalApi, true)
  const controls = f.native.messages.find(message => message.method === 'thread/start').params
  assert.equal(controls.sandbox, 'workspace-write')
  assert.equal(controls.approvalPolicy, 'on-request')
  assert.equal(controls.approvalsReviewer, 'user')
  assert.equal(controls.allowProviderModelFallback, false)
  assert.equal(Object.hasOwn(controls, 'model'), false)
  assert.equal(f.native.processes[0].command, 'codex')
  assert.equal(f.native.processes[0].options.cwd, f.workspace)
  assert.equal(Object.hasOwn(f.native.processes[0].options, 'env'), false)
  assert.doesNotMatch(JSON.stringify(result), /private prompt|not-read/)
})

test('asynchronous persistence barriers prevent dispatch and completion before durable callbacks', async t => {
  const f = fixture(t)
  const dispatchReached = deferred()
  const dispatchGate = deferred()
  const queuedReached = deferred()
  const queuedGate = deferred()
  const startedReached = deferred()
  const startedGate = deferred()
  let completed = false
  const execution = f.execute({
    onDispatch: async () => { dispatchReached.resolve(); await dispatchGate.promise },
    onQueued: async () => { queuedReached.resolve(); await queuedGate.promise },
    onStarted: async () => { startedReached.resolve(); await startedGate.promise },
  }).then(result => { completed = true; return result })
  await dispatchReached.promise
  assert.equal(f.native.messages.some(message => message.method === 'thread/queue/add'), false)
  dispatchGate.resolve()
  await queuedReached.promise
  assert.equal(completed, false)
  queuedGate.resolve()
  await startedReached.promise
  assert.equal(completed, false)
  startedGate.resolve()
  assert.equal((await execution).status, 'completed')
})

const materializationMessage = id => `thread ${id} is not materialized yet; includeTurns is unavailable before first user message`
function acknowledgeQueue({ message, native, reply }) {
  const receipt = { id: QUEUED, clientUserMessageId: message.params.clientUserMessageId, input: message.params.input }
  native.queued.push(receipt)
  reply(message, { queuedSubmission: receipt })
}

test('queue acknowledgment before history materialization is monitored through lifecycle events first', async t => {
  const order = []
  let earlyReads = 0
  const f = fixture(t, { onMessage: context => {
    const { message, native, send } = context
    if (message.method === 'thread/queue/add') {
      acknowledgeQueue(context)
      const timer = setTimeout(() => { native.start(); native.complete() }, 100)
      t.after(() => clearTimeout(timer))
      return true
    }
    if (message.method === 'thread/read') {
      earlyReads += 1
      send({ id: message.id, error: { code: -32603, message: 'PRIVATE premature history error' } })
      return true
    }
  } })
  const result = await f.execute({ onThread: async () => { order.push('thread') }, onDispatch: async () => { order.push('dispatch') }, onQueued: async () => { order.push('queued') }, onStarted: async () => { order.push('started') } })
  assert.equal(result.status, 'completed')
  assert.equal(earlyReads, 0)
  assert.deepEqual(order, ['thread', 'dispatch', 'queued', 'started'])
  assert.equal(f.native.messages[0].params.clientInfo.version, '0.2.1')
})

test('only the exact owned materialization read error retries on the same connection without queue replay', async t => {
  let reads = 0
  const f = fixture(t, { onMessage: context => {
    const { message, send, reply, native, thread } = context
    if (message.method === 'thread/queue/add') { acknowledgeQueue(context); return true }
    if (message.method === 'thread/read') {
      reads += 1
      if (reads === 1) send({ id: message.id, error: { code: -32600, message: materializationMessage(THREAD), data: { log: 'PRIVATE read-only diagnostic' } } })
      else { native.start(); native.complete(); reply(message, { thread: thread() }) }
      return true
    }
  } })
  const result = await f.execute({ timeoutMs: 4000 })
  assert.equal(result.status, 'completed')
  assert.equal(reads, 2)
  assert.equal(f.native.processes.length, 1)
  assert.equal(f.native.messages.filter(message => message.method === 'thread/queue/add').length, 1)
  assert.equal(f.native.messages.some(message => message.method === 'thread/resume'), false)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|diagnostic|first user message/)
})

test('similar, foreign-ID, internal and disabled-Goal RPC errors remain fatal and expose only structural transport codes', { concurrency: true }, async t => {
  await Promise.all([
    { label: 'similar', method: 'thread/read', code: -32600, message: `${materializationMessage(THREAD)} with extra PRIVATE details` },
    { label: 'foreign-id', method: 'thread/read', code: -32600, message: materializationMessage('another-thread') },
    { label: 'internal', method: 'thread/read', code: -32603, message: materializationMessage(THREAD) },
    { label: 'goal-disabled', method: 'thread/goal/get', code: -32600, message: 'Goals are disabled; PRIVATE feature configuration' },
  ].map(variant => t.test(variant.label, async child => {
    const f = fixture(child, { onMessage: context => {
      const { message, send } = context
      if (message.method === 'thread/queue/add') { acknowledgeQueue(context); return true }
      if (message.method === variant.method) {
        send({ id: message.id, error: { code: variant.code, message: variant.message, data: { body: 'PRIVATE raw body' } } })
        return true
      }
    } })
    const result = await f.execute({ timeoutMs: 4000 })
    assert.equal(result.status, 'uncertain')
    assert.deepEqual(result.transport, { code: 'NATIVE_RPC', rpcMethod: variant.method, rpcCode: variant.code })
    assert.equal(f.native.messages.filter(message => message.method === 'thread/queue/add').length, 1)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|materialized|another-thread|configuration|raw body/)
  })))
})

test('cold readonly inspection never retries even the exact materialization error', async t => {
  const f = fixture(t, { onMessage: ({ message, send }) => {
    if (message.method !== 'thread/read') return
    send({ id: message.id, error: { code: -32600, message: materializationMessage(THREAD) } })
    return true
  } })
  await assert.rejects(f.executor.inspect({ workspace: f.workspace, threadId: THREAD }), { code: 'NATIVE_RPC', rpcMethod: 'thread/read', rpcCode: -32600 })
  assert.equal(f.native.messages.filter(message => message.method === 'thread/read').length, 1)
  assert.equal(f.native.messages.some(message => message.method === 'thread/resume' || message.method === 'thread/queue/add'), false)
})

test('a repeatedly unmaterialized dispatch exhausts bounded read retries without another dispatch', async t => {
  let reads = 0
  const f = fixture(t, { onMessage: context => {
    const { message, send } = context
    if (message.method === 'thread/queue/add') { acknowledgeQueue(context); return true }
    if (message.method === 'thread/read') {
      reads += 1
      send({ id: message.id, error: { code: -32600, message: materializationMessage(THREAD) } })
      return true
    }
  } })
  const started = Date.now()
  const result = await f.execute({ timeoutMs: 5000 })
  assert.equal(result.status, 'uncertain')
  assert.deepEqual(result.transport, { code: 'NATIVE_RPC', rpcMethod: 'thread/read', rpcCode: -32600 })
  assert.ok(reads <= 5)
  assert.ok(Date.now() - started < 4900)
  assert.equal(f.native.processes.length, 1)
  assert.equal(f.native.messages.filter(message => message.method === 'thread/queue/add').length, 1)
})

test('startup grace never extends the original deadline and an exact pending receipt is cancelled safely', async t => {
  const f = fixture(t, { onMessage: context => {
    const { message, send } = context
    if (message.method === 'thread/queue/add') { acknowledgeQueue(context); return true }
    if (message.method === 'thread/read') {
      send({ id: message.id, error: { code: -32600, message: materializationMessage(THREAD) } })
      return true
    }
  } })
  const started = Date.now()
  const result = await f.execute({ timeoutMs: 40 })
  assert.equal(result.status, 'uncertain')
  assert.equal(result.transport.code, 'NATIVE_TIMEOUT')
  assert.ok(Date.now() - started < 1000)
  assert.equal(f.native.messages.filter(message => message.method === 'thread/queue/add').length, 1)
  assert.deepEqual(f.native.messages.find(message => message.method === 'thread/queue/delete').params, { threadId: THREAD, queuedSubmissionId: QUEUED })
  assert.equal(f.native.messages.some(message => message.method === 'turn/interrupt'), false)
})

test('cancellation before history materialization interrupts only the marker-correlated live turn', async t => {
  const controller = new AbortController()
  const f = fixture(t, { onMessage: ({ message, start, reply, send }) => {
    if (message.method === 'thread/queue/add') {
      start()
      reply(message, { queuedSubmission: { id: QUEUED, clientUserMessageId: MARKER, input: message.params.input } })
      return true
    }
    if (message.method === 'thread/read') {
      send({ id: message.id, error: { code: -32600, message: materializationMessage(THREAD) } })
      return true
    }
  } })
  const result = await f.execute({ signal: controller.signal, onQueued: async () => { controller.abort() } })
  assert.equal(result.status, 'interrupted')
  assert.equal(result.transport.code, 'NATIVE_CANCELLED')
  assert.deepEqual(f.native.messages.find(message => message.method === 'turn/interrupt').params, { threadId: THREAD, turnId: TURN })
})

test('receipt callback failures stop before dispatch and never continue native work', async t => {
  for (const name of ['onThread', 'onDispatch']) {
    const f = fixture(t)
    const result = await f.execute({ [name]: async () => { throw new Error('sk-private-secret callback failed') } })
    assert.equal(result.status, 'failed')
    assert.equal(f.native.messages.some(message => message.method === 'thread/queue/add'), false)
    assert.doesNotMatch(JSON.stringify(result), /private-secret/)
  }
})

test('post-dispatch receipt failures interrupt an exact correlated turn and remain uncertain', async t => {
  for (const name of ['onQueued', 'onStarted']) {
    const f = fixture(t, { onMessage: ({ message, reply, native, start }) => {
      if (message.method !== 'thread/queue/add') return
      const queued = { id: QUEUED, clientUserMessageId: MARKER, input: message.params.input }
      start()
      reply(message, { queuedSubmission: queued })
      return true
    } })
    const result = await f.execute({ [name]: async () => { throw new Error('receipt disk unavailable') } })
    assert.equal(result.status, 'uncertain')
    assert.deepEqual(f.native.messages.find(message => message.method === 'turn/interrupt').params, { threadId: THREAD, turnId: TURN })
    assert.equal(f.native.messages.filter(message => message.method === 'thread/queue/add').length, 1)
  }
})

test('human approval and user-input requests cancel without permission grants or invented answers', async t => {
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request']) {
    const f = fixture(t, { onMessage: ({ message, start, reply, send }) => {
      if (message.method !== 'thread/queue/add') return
      start()
      send({ id: 'server-approval', method, params: { threadId: THREAD, turnId: TURN, itemId: 'native-tool-item', command: 'private command', questions: [{ id: 'input', question: 'private input' }] } })
      reply(message, { queuedSubmission: { id: QUEUED, clientUserMessageId: MARKER, input: message.params.input } })
      return true
    } })
    const result = await f.execute()
    assert.equal(result.status, 'needs-user-action', method)
    const answer = f.native.messages.find(message => message.id === 'server-approval' && !message.method)
    if (method.includes('commandExecution') || method.includes('fileChange')) assert.deepEqual(answer.result, { decision: 'cancel' })
    if (method.includes('permissions')) assert.deepEqual(answer.result, { permissions: {}, scope: 'turn' })
    if (method.includes('requestUserInput')) assert.deepEqual(answer.result, { answers: {} })
    if (method.includes('elicitation')) assert.deepEqual(answer.result, { action: 'cancel' })
    assert.doesNotMatch(JSON.stringify(result), /private command|private input/)
  }
})

test('approval before marker correlation is buffered and cancelled only for the matching turn', async t => {
  const f = fixture(t, { onMessage: ({ message, start, reply, send }) => {
    if (message.method !== 'thread/queue/add') return
    send({ id: 'approval-first', method: 'item/commandExecution/requestApproval', params: { threadId: THREAD, turnId: TURN } })
    start()
    reply(message, { queuedSubmission: { id: QUEUED, clientUserMessageId: MARKER, input: message.params.input } })
    return true
  } })
  assert.equal((await f.execute()).status, 'needs-user-action')
  assert.deepEqual(f.native.messages.find(message => message.id === 'approval-first' && !message.method).result, { decision: 'cancel' })
})

test('foreign thread requests and lifecycle events never interrupt or correlate unrelated work', async t => {
  const f = fixture(t, { onMessage: ({ message, native, reply, send, start, complete }) => {
    if (message.method !== 'thread/queue/add') return
    send({ id: 'foreign', method: 'item/commandExecution/requestApproval', params: { threadId: 'other-chat', turnId: 'other-turn' } })
    send({ method: 'turn/completed', params: { threadId: 'other-chat', turn: { id: 'other-turn', status: 'completed', items: [] } } })
    start()
    complete()
    reply(message, { queuedSubmission: { id: QUEUED, clientUserMessageId: MARKER, input: message.params.input } })
    return true
  } })
  assert.equal((await f.execute()).turnId, TURN)
  assert.equal(f.native.messages.some(message => message.method === 'turn/interrupt'), false)
  assert.equal(f.native.messages.find(message => message.id === 'foreign' && !message.method).error.code, -32601)
})

test('process death after dispatch is uncertain and never retries queue insertion', async t => {
  const f = fixture(t, { onMessage: ({ message, child }) => {
    if (message.method !== 'thread/queue/add') return
    process.nextTick(() => child.emit('close', 1))
    return true
  } })
  const result = await f.execute()
  assert.equal(result.status, 'uncertain')
  assert.equal(f.native.messages.filter(message => message.method === 'thread/queue/add').length, 1)
  assert.equal(f.native.processes.length, 1)
})

test('an uncorrelated completed turn cannot become this dispatch result or be interrupted', async t => {
  const f = fixture(t, { onMessage: ({ message, start, complete, reply }) => {
    if (message.method !== 'thread/queue/add') return
    start('another-native-client-marker')
    complete()
    reply(message, { queuedSubmission: { id: QUEUED, clientUserMessageId: MARKER, input: message.params.input } })
    return true
  } })
  const result = await f.execute({ timeoutMs: 20 })
  assert.equal(result.status, 'uncertain')
  assert.equal(result.turnId, null)
  assert.equal(f.native.messages.some(message => message.method === 'turn/interrupt'), false)
})

test('duplicate marker turns fail closed without dispatching again', async t => {
  const f = fixture(t, { onMessage: ({ message, start, reply }) => {
    if (message.method !== 'thread/queue/add') return
    start(MARKER, TURN)
    start(MARKER, 'duplicate-native-turn')
    reply(message, { queuedSubmission: { id: QUEUED, clientUserMessageId: MARKER, input: message.params.input } })
    return true
  } })
  assert.equal((await f.execute()).status, 'uncertain')
  assert.equal(f.native.messages.filter(message => message.method === 'thread/queue/add').length, 1)
})

test('oversized native protocol lines are bounded and sanitized', async t => {
  const f = fixture(t, { onMessage: ({ message, child }) => {
    if (message.method !== 'initialize') return
    child.stdout.write(`sensitive-untrusted-log-${'x'.repeat(2 * 1024 * 1024)}\n`)
    return true
  } })
  const result = await f.execute()
  assert.equal(result.status, 'failed')
  assert.doesNotMatch(JSON.stringify(result), /sensitive-untrusted-log/)
})

test('timeout interrupts a matching native turn and cancellation before dispatch sends no queue work', async t => {
  const f = fixture(t, { onMessage: ({ message, start, reply }) => {
    if (message.method !== 'thread/queue/add') return
    start()
    reply(message, { queuedSubmission: { id: QUEUED, clientUserMessageId: MARKER, input: message.params.input } })
    return true
  } })
  const result = await f.execute({ timeoutMs: 30 })
  assert.equal(result.status, 'interrupted')
  assert.deepEqual(f.native.messages.find(message => message.method === 'turn/interrupt').params, { threadId: THREAD, turnId: TURN })
  const controller = new AbortController()
  controller.abort()
  const before = fixture(t)
  assert.equal((await before.execute({ signal: controller.signal })).status, 'interrupted')
  assert.equal(before.native.messages.length, 0)
})

test('abort deletes only the exact matching queued receipt, without cancelling other queued work', async t => {
  const controller = new AbortController()
  const f = fixture(t, { onMessage: ({ message, native, reply }) => {
    if (message.method !== 'thread/queue/add') return
    const own = { id: QUEUED, clientUserMessageId: MARKER, input: message.params.input }
    native.queued.push(own, { id: 'foreign-queued', clientUserMessageId: 'foreign-marker', input: [] })
    reply(message, { queuedSubmission: own })
    return true
  } })
  const result = await f.execute({ signal: controller.signal, onQueued: async () => { controller.abort() } })
  assert.equal(result.status, 'uncertain')
  assert.deepEqual(f.native.messages.find(message => message.method === 'thread/queue/delete').params, { threadId: THREAD, queuedSubmissionId: QUEUED })
  assert.deepEqual(f.native.queued.map(entry => entry.id), ['foreign-queued'])
  assert.equal(f.native.messages.some(message => message.method === 'turn/interrupt'), false)
})

test('inspect uses inert documented native reads and correlates saved client message IDs', async t => {
  const f = fixture(t, { turns: [{ id: TURN, status: 'completed', items: [{ type: 'userMessage', id: 'item', clientId: MARKER, content: [{ type: 'text', text: 'private transcript' }] }] }] })
  const view = await f.executor.inspect({ workspace: f.workspace, threadId: THREAD, marker: MARKER, turnId: TURN })
  assert.equal(view.status, 'completed')
  assert.equal(view.state, 'idle')
  assert.equal(view.latestTurnId, TURN)
  assert.equal(view.statusSource, 'native-thread-read')
  assert.deepEqual(f.native.messages.filter(message => message.method).map(message => message.method), ['initialize', 'initialized', 'thread/read', 'thread/queue/list', 'thread/goal/get'])
  assert.doesNotMatch(JSON.stringify(view), /private transcript/)
})

test('pending native queue, native goal, active turn and changed history stop before resume', async t => {
  for (const options of [
    { queued: [{ id: QUEUED, clientUserMessageId: 'previous-marker', input: [] }] },
    { goal: { status: 'active' } },
    { status: 'active', turns: [{ id: 'previous-turn', status: 'inProgress', items: [] }] },
    { turns: [{ id: 'human-turn', status: 'completed', items: [] }] },
    { turns: [] },
  ]) {
    const f = fixture(t, options)
    assert.equal((await f.execute({ threadId: THREAD, expectedPreviousTurnId: 'saved-turn' })).status, 'needs-user-action')
    assert.equal(f.native.messages.some(message => message.method === 'thread/resume'), false)
    assert.equal(f.native.messages.some(message => message.method === 'thread/queue/add'), false)
  }
})

test('a stored owned thread resumes only after matching its saved terminal turn receipt', async t => {
  const f = fixture(t, { turns: [{ id: 'saved-turn', status: 'failed', items: [] }], status: 'notLoaded' })
  const result = await f.execute({ threadId: THREAD, expectedPreviousTurnId: 'saved-turn' })
  assert.equal(result.status, 'completed')
  const methods = f.native.messages.filter(message => message.method).map(message => message.method)
  assert.ok(methods.indexOf('thread/read') < methods.indexOf('thread/resume'))
  assert.ok(methods.indexOf('thread/queue/list') < methods.indexOf('thread/resume'))
  assert.ok(methods.indexOf('thread/goal/get') < methods.indexOf('thread/resume'))
})

test('unretained permissions and malformed native responses fail closed before inference', async t => {
  const f = fixture(t, { permissions: { approvalPolicy: 'never' } })
  assert.equal((await f.execute()).status, 'failed')
  assert.equal(f.native.messages.some(message => message.method === 'thread/queue/add'), false)
  const malformed = fixture(t, { onMessage: ({ message, child }) => {
    if (message.method !== 'initialize') return
    child.stdout.write('invalid protocol sk-sensitive-token\n')
    return true
  } })
  const result = await malformed.execute()
  assert.equal(result.status, 'failed')
  assert.doesNotMatch(JSON.stringify(result), /sensitive-token/)
})

test('native verification uses explicit workspace sandbox, trusted argv, bounded output and digests', async t => {
  const f = fixture(t)
  const receipt = await f.executor.verifyCommand({ workspace: f.workspace, argv: ['node', '--test', 'test/project.test.js'], timeoutMs: 1000 })
  assert.equal(receipt.exitCode, 0)
  assert.equal(receipt.outputBytes, Buffer.byteLength('3 passed\n'))
  assert.equal(receipt.stdoutDigest, createHash('sha256').update('3 passed\n').digest('hex'))
  assert.equal(Object.hasOwn(receipt, 'stdout'), false)
  const params = f.native.messages.find(message => message.method === 'command/exec').params
  assert.deepEqual(params.command, ['node', '--test', 'test/project.test.js'])
  assert.deepEqual(params.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [f.workspace], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true })
  assert.equal(params.outputBytesCap, 65536)
  assert.equal(params.timeoutMs, 1000)
})

test('native verification rejects invalid argv rather than accepting shell strings', async t => {
  const f = fixture(t)
  for (const argv of ['node --test', [], ['node', '\0'], ['node', 'x'.repeat(9000)]]) {
    await assert.rejects(f.executor.verifyCommand({ workspace: f.workspace, argv }), { code: 'INVALID_INPUT' })
  }
  assert.equal(f.native.processes.length, 0)
  assert.equal((await f.executor.verifyCommand({ workspace: f.workspace, argv: ['node', '-e', ''] })).exitCode, 0)
  assert.deepEqual(f.native.messages.find(message => message.method === 'command/exec').params.command, ['node', '-e', ''])
})

test('explicit model selection must be retained exactly without fallback', async t => {
  const selected = fixture(t, { model: 'user-selected-model' })
  assert.equal((await selected.execute({ model: 'user-selected-model' })).status, 'completed')
  assert.equal(selected.native.messages.find(message => message.method === 'thread/start').params.model, 'user-selected-model')
  const replaced = fixture(t, { model: 'fallback-model' })
  assert.equal((await replaced.execute({ model: 'user-selected-model' })).status, 'failed')
  assert.equal(replaced.native.messages.some(message => message.method === 'thread/queue/add'), false)
  await assert.rejects(replaced.execute({ model: 'bad\nmodel' }), { code: 'INVALID_INPUT' })
})

test('verification abort terminates only its native connection process id and awaits completion', async t => {
  const controller = new AbortController()
  let executionRequest
  const f = fixture(t, { onMessage: ({ message, reply }) => {
    if (message.method === 'command/exec') {
      executionRequest = message
      process.nextTick(() => controller.abort())
      return true
    }
    if (message.method === 'command/exec/terminate') {
      assert.equal(message.params.processId, executionRequest.params.processId)
      reply(message, {})
      reply(executionRequest, { exitCode: 137, stdout: '', stderr: '' })
      return true
    }
  } })
  const result = await f.executor.verifyCommand({ workspace: f.workspace, argv: ['node', '--test'], signal: controller.signal })
  assert.equal(result.status, 'interrupted')
  assert.equal(result.cancelled, true)
  assert.equal(result.needsUserAction, false)
  assert.equal(f.native.messages.filter(message => message.method === 'command/exec').length, 1)
  assert.equal(f.native.messages.filter(message => message.method === 'command/exec/terminate').length, 1)
  const before = fixture(t)
  const stopped = new AbortController()
  stopped.abort()
  assert.equal((await before.executor.verifyCommand({ workspace: before.workspace, argv: ['node', '--test'], signal: stopped.signal })).status, 'interrupted')
  assert.equal(before.native.messages.length, 0)
})

test('verification registration race retries termination of the same id and abort dominates exit zero', async t => {
  const controller = new AbortController()
  let executionRequest
  let terminationCount = 0
  const f = fixture(t, { onMessage: ({ message, reply, send }) => {
    if (message.method === 'command/exec') {
      executionRequest = message
      process.nextTick(() => controller.abort())
      return true
    }
    if (message.method === 'command/exec/terminate') {
      assert.equal(message.params.processId, executionRequest.params.processId)
      if (++terminationCount === 1) send({ id: message.id, error: { code: -32602, message: 'not yet registered sk-private-token' } })
      else {
        reply(message, {})
        reply(executionRequest, { exitCode: 0, stdout: 'succeeded but cancelled', stderr: '' })
      }
      return true
    }
  } })
  const result = await f.executor.verifyCommand({ workspace: f.workspace, argv: ['node', '--test'], signal: controller.signal })
  assert.equal(result.status, 'interrupted')
  assert.equal(result.cancelled, true)
  assert.equal(result.exitCode, null)
  assert.equal(result.needsUserAction, false)
  assert.equal(terminationCount, 2)
  assert.doesNotMatch(JSON.stringify(result), /succeeded but cancelled|private-token/)
})

test('readonly native model discovery returns only configured ID and bounded public catalog fields', async t => {
  const f = fixture(t, { onMessage: ({ message, reply }) => {
    if (message.method === 'config/read') {
      assert.deepEqual(message.params, { cwd: f.workspace, includeLayers: false })
      reply(message, { config: { model: 'desktop-alias', developer_instructions: 'PRIVATE_INSTRUCTIONS', model_provider: 'PRIVATE_PROVIDER', custom_key: 'PRIVATE_KEY' }, origins: { model: { path: '/private/config.toml' } }, layers: ['PRIVATE_LAYER'] })
      return true
    }
    if (message.method === 'model/list') {
      assert.equal(message.params.includeHidden, false)
      const entry = (id, isDefault) => ({ id, model: id, isDefault, displayName: id, description: 'PRIVATE_DESCRIPTION', upgradeInfo: { hidden: 'PRIVATE_UPGRADE' } })
      reply(message, message.params.cursor ? { data: [entry('provider/custom-model', false)], nextCursor: null } : { data: [entry('native-supported-model', true)], nextCursor: 'page-two' })
      return true
    }
  } })
  const result = await f.executor.models({ workspace: f.workspace })
  assert.deepEqual(result, { configuredModel: 'desktop-alias', models: [{ id: 'native-supported-model', model: 'native-supported-model', isDefault: true, displayName: 'native-supported-model' }, { id: 'provider/custom-model', model: 'provider/custom-model', isDefault: false, displayName: 'provider/custom-model' }] })
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|private\/config/)
  assert.equal(f.native.messages.some(message => message.method === 'thread/start' || message.method === 'thread/queue/add'), false)
})

test('native catalog repeated cursors and oversized labels fail with sanitized errors', async t => {
  for (const variant of ['cursor', 'label']) {
    const f = fixture(t, { onMessage: ({ message, reply }) => {
      if (message.method === 'config/read') { reply(message, { config: { model: null } }); return true }
      if (message.method === 'model/list') {
        reply(message, { data: [{ id: 'model', model: 'model', isDefault: true, displayName: variant === 'label' ? 'PRIVATE_LABEL'.repeat(100) : 'Model' }], nextCursor: variant === 'cursor' ? 'duplicate-cursor' : null })
        return true
      }
    } })
    await assert.rejects(f.executor.models({ workspace: f.workspace }), error => error.code === 'NATIVE_PROTOCOL' && !error.message.includes('PRIVATE_LABEL'))
  }
})

test('native error receipts retain only structural codes of the correlated turn', async t => {
  const f = fixture(t, { onMessage: ({ message, start, send, reply, native }) => {
    if (message.method !== 'thread/queue/add') return
    start()
    send({ method: 'error', params: { threadId: THREAD, turnId: 'foreign-turn', willRetry: false, error: { codexErrorInfo: 'unauthorized', message: 'PRIVATE_FOREIGN_MESSAGE' } } })
    const error = { codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 400 } }, message: 'PRIVATE_MESSAGE sk-private-credential', additionalDetails: 'PRIVATE_DETAILS' }
    send({ method: 'error', params: { threadId: THREAD, turnId: TURN, willRetry: false, error } })
    native.turns.find(turn => turn.id === TURN).status = 'failed'
    native.turns.find(turn => turn.id === TURN).error = error
    native.status = 'idle'
    send({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, status: 'failed', error, items: [] } } })
    reply(message, { queuedSubmission: { id: QUEUED, clientUserMessageId: MARKER, input: message.params.input } })
    return true
  } })
  const result = await f.execute()
  assert.equal(result.status, 'failed')
  assert.deepEqual(result.nativeError, { type: 'responseStreamConnectionFailed', httpStatusCode: 400 })
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|private-credential/)
  const inspected = await f.executor.inspect({ workspace: f.workspace, threadId: THREAD, marker: MARKER, turnId: TURN })
  assert.deepEqual(inspected.nativeError, result.nativeError)
})

const testLoopback = [127, 0, 0, 1].join('.')
const testProxyPort = ['78', '97'].join('')
const expectedProxyUrl = `http://${testLoopback}:${testProxyPort}`
const macProxy = (additional = '') => `<dictionary> {\n  HTTPEnable : 1\n  HTTPProxy : ${testLoopback}\n  HTTPPort : ${testProxyPort}\n  HTTPSEnable : 1\n  HTTPSProxy : ${testLoopback}\n  HTTPSPort : ${testProxyPort}\n${additional}}\n`

test('macOS static proxies apply only to the native child without host environment changes', async t => {
  const env = { PATH: '/known/path', HOME: '/existing/home', CODEX_HOME: '/existing/codex', NO_PROXY: 'existing-bypass' }
  const original = { ...env }
  const f = fixture(t, { dependencies: { platform: 'darwin', env, readProxy: () => macProxy() } })
  assert.equal((await f.execute()).status, 'completed')
  assert.deepEqual(env, original)
  const childEnv = f.native.processes[0].options.env
  assert.deepEqual(childEnv, { ...original, HTTP_PROXY: expectedProxyUrl, HTTPS_PROXY: expectedProxyUrl })
  assert.notEqual(childEnv, env)
})

test('explicit proxy environment, unsupported PAC/SOCKS and malformed system proxies are not rewritten', () => {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    let read = false
    assert.equal(systemProxyEnvironment({ platform: 'darwin', env: { [key]: '' }, readProxy: () => { read = true; return macProxy() } }), undefined)
    assert.equal(read, false)
  }
  for (const source of [macProxy('  ProxyAutoConfigEnable : 1\n'), macProxy('  ProxyAutoDiscoveryEnable : 1\n'), `<dictionary> {\n SOCKSEnable : 1\n SOCKSProxy : ${testLoopback}\n SOCKSPort : 1080\n}\n`, macProxy().replace(testProxyPort, '65536'), macProxy().replace(testLoopback, 'user@host'), macProxy().replace(testLoopback, [127, 0, 0, 999].join('.')), macProxy().replace('HTTPEnable : 1', 'HTTPEnable : 2'), macProxy('  HTTPEnable : 1\n')]) {
    assert.equal(systemProxyEnvironment({ platform: 'darwin', env: {}, readProxy: () => source }), undefined)
  }
  assert.equal(systemProxyEnvironment({ platform: 'linux', env: {}, readProxy: () => { throw new Error('must not read') } }), undefined)
  assert.equal(systemProxyEnvironment({ platform: 'darwin', env: {}, readProxy: () => { throw new Error('scutil unavailable') } }), undefined)
})
