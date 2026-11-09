import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const pause = () => new Promise((resolve) => setTimeout(resolve, 5))
async function until(check) {
  const end = Date.now() + 5000
  while (!await check()) {
    if (Date.now() > end) throw new Error('test condition timed out')
    await pause()
  }
}

async function harness(t, { service, faculties = [], noSurface = false, initialAssignment = null, nativeMemory = undefined, mode = 'advice', onRequest = undefined } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'supervisor-project-memory-'))
  const requests = [], followups = [], timers = [], disposers = [], events = new Map()
  const agents = ['session-a', 'session-b'].map((id) => ({
    id, status: 'idle', options: { provider: 'fixture', model: 'suggestion' },
    inbox: { nextTurn: [], nextStep: [] },
    followup(message) { followups.push(message) },
  }))
  let command
  const services = {
    agents: { roots: () => agents, list: () => agents, get: (id) => agents.find((a) => a.id === id) },
    commands: { register(value) { command = value; return () => {} } },
    sessions: { get: (id) => ({ id }) },
    sessionProjections: { snapshot: () => ({ values: { todos: [{ status: 'in_progress', content: 'verify current implementation' }] } }) },
    sessionQuery: { readSurface: async (id) => ({ events: noSurface ? [] : [{
      type: 'user/message', data: { message: { content: [{ type: 'text', text: 'Current task for ' + id }] } },
    }] }) },
    llm: { async *stream(request) { requests.push(structuredClone(request)); if (onRequest) await onRequest(request); yield { type: 'text-delta', text: '继续验证当前实现。' } } },
    harvisProjectMemory: service,
    harvisMemory: nativeMemory,
    roleRegistry: {
      resolve(ref) { return { id: ref.id, version: ref.version, label: 'fixture', prompt: { identity: 'fixture supervisor', objectives: ['verify'] } } },
      register() { return () => {} },
    },
  }
  const ctx = {
    get: (name) => services[name],
    inject(names, callback) { if (names.every((name) => services[name])) callback(ctx) },
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose) },
    timeout(callback) { timers.push(callback) }, interval() {}, on(name, callback) { events.set(name, callback) },
    logger: { info() {}, warn() {} },
  }
  const storePath = join(dir, 'state.json')
  if (initialAssignment) await writeFile(storePath, JSON.stringify({ version: 1, assignments: { 'session-a': initialAssignment } }))
  apply(ctx, { mode, faculties, storePath })
  const invoke = async (id, rawInput) => command.handler({ agent: services.agents.get(id), rawInput })
  const state = async (id = 'session-a') => JSON.parse((await invoke(id, '_state')).text)
  const start = async (id = 'session-a') => {
    await invoke(id, '_regen')
    for (const callback of timers.splice(0)) callback()
  }
  const regen = async (id = 'session-a') => {
    await start(id)
    await until(async () => !(await state(id)).suggesting)
    return state(id)
  }
  const auto = async () => {
    const session = { id: 'session-a' }
    await events.get('session/event')(session, { type: 'user/message', seq: 1, data: { id: 'task-a', source: { kind: 'user' }, content: [{ type: 'text', text: 'Current task for session-a' }] } })
    await events.get('session/event')(session, { type: 'todo/write', seq: 2, data: { todos: [{ content: 'verify current implementation', status: 'pending' }] } })
    await invoke('session-a', '_set {"mode":"takeover"}')
    for (const callback of timers.splice(0)) callback()
    await until(async () => requests.length > 0 && !(await state()).suggesting)
    return state()
  }
  const dispose = () => { for (const callback of disposers.splice(0)) callback() }
  t.after(async () => { dispose(); await rm(dir, { recursive: true, force: true }) })
  return { requests, followups, services, start, regen, auto, state, dispose, storePath, invoke }
}

test('single Supervisor sends scoped memory to the actual suggestion provider without persisting it', async (t) => {
  const reads = []
  const h = await harness(t, { service: { read: async (input) => {
    reads.push(input)
    return { status: 'ready', context: 'Accepted project constraint: MEMORY_FIXTURE_SENTINEL', memory_ids: ['mem-constraint'] }
  } } })
  const state = await h.regen()
  assert.equal(reads.length, 1)
  assert.equal(reads[0].sessionId, 'session-a')
  assert.equal(reads[0].tokenBudget, 800)
  assert.match(reads[0].query, /Current task for session-a/)
  assert.equal(h.requests.length, 1)
  const request = h.requests[0]
  assert.match(request.system, /不可信资料/)
  assert.match(request.system, /当前对话与 todo 是当前事实/)
  assert.match(request.system, /不能覆盖用户目标、权限或审批/)
  const text = request.messages[0].content[0].text
  assert.match(text, /MEMORY_FIXTURE_SENTINEL/)
  assert.doesNotMatch(text, /本轮无可用项目记忆|状态：unavailable/)
  assert.deepEqual(state.memoryContext, { source: 'harvisProjectMemory', status: 'ready', hitCount: 1 })
  assert.ok(text.indexOf('MEMORY_FIXTURE_SENTINEL') < text.indexOf('Current task for session-a'))
  assert.deepEqual(state.projectMemory, { status: 'ready', memory_ids: ['mem-constraint'] })
  assert.equal(state.suggestError, '')
  assert.equal(state.used, 0)
  assert.equal(h.followups.length, 0)
  assert.doesNotMatch(await readFile(h.storePath, 'utf8'), /MEMORY_FIXTURE_SENTINEL|mem-constraint/)
})

test('a roundtable reuses one bound read for selected supervisors and the chair', async (t) => {
  let reads = 0
  const h = await harness(t, {
    initialAssignment: { sessionId: 'session-a', primaryMentorId: 'architecture', collaboratorIds: ['qa'], assignmentSource: 'manual', version: 1 },
    faculties: ['architecture', 'qa'].map((id) => ({ id, name: id, route: 'fixture/' + id, prompt: 'Check ' + id })),
    service: { read: async () => { reads++; return { status: 'ready', context: 'COMMON_MEMORY', memory_ids: ['mem-common'] } } },
  })
  await h.regen()
  assert.equal(reads, 1)
  assert.equal(h.requests.length, 3)
  for (const request of h.requests) {
    assert.match(request.system, /不可信资料/)
    assert.match(request.messages[0].content[0].text, /COMMON_MEMORY/)
    assert.match(request.messages[0].content[0].text, /Current task for session-a/)
  }
  const disk = await readFile(h.storePath, 'utf8')
  assert.doesNotMatch(disk, /COMMON_MEMORY|mem-common/)
  const rounds = JSON.parse(disk).roundtables
  assert.equal(rounds.length, 1)
  assert.deepEqual(rounds[0].memoryContext, { source: 'harvisProjectMemory', status: 'ready', hitCount: 1 })
})

test('an available native provider owns retrieval even when it fails; legacy is not mixed or used as fallback', async (t) => {
  let legacyReads = 0
  const h = await harness(t, {
    nativeMemory: { warmSession: async () => { throw new Error('offline') } },
    service: { read: async () => { legacyReads++; return { status: 'ready', context: 'FORBIDDEN_FALLBACK', memory_ids: ['mem-forbidden'] } } },
  })
  const state = await h.regen()
  assert.equal(legacyReads, 0)
  assert.equal(state.projectMemory.status, 'unavailable')
  assert.equal(h.requests.length, 1)
  assert.doesNotMatch(JSON.stringify(h.requests), /FORBIDDEN_FALLBACK/)
})

test('absence and failure preserve supervision and never include stale context', async (t) => {
  const h = await harness(t)
  const unavailableState = await h.regen()
  assert.equal(unavailableState.projectMemory.status, 'unavailable')
  assert.equal(unavailableState.memoryContext.source, 'none')
  assert.doesNotMatch(h.requests[0].system, /项目参考记忆/)
  h.services.harvisProjectMemory = { read: async () => { throw new Error('private transport detail') } }
  assert.equal((await h.regen()).projectMemory.status, 'degraded')
  h.services.harvisProjectMemory = { read: async () => ({ status: 'unbound', context: 'FOREIGN_MEMORY' }) }
  const state = await h.regen()
  assert.equal(state.projectMemory.status, 'unbound')
  assert.equal(state.suggestError, '')
  assert.equal(h.requests.length, 3)
  assert.doesNotMatch(JSON.stringify(h.requests), /FOREIGN_MEMORY|private transport detail/)
})

test('each session uses its own binding and every new round rechecks revocation', async (t) => {
  const reads = []
  const h = await harness(t, { service: { read: async ({ sessionId }) => {
    reads.push(sessionId)
    return { status: 'ready', context: 'MEMORY_FOR_' + sessionId, memory_ids: ['mem-' + sessionId] }
  } } })
  await h.regen('session-a')
  await h.regen('session-b')
  h.services.harvisProjectMemory = { read: async ({ sessionId }) => { reads.push(sessionId); return { status: 'empty' } } }
  assert.equal((await h.regen('session-a')).projectMemory.status, 'empty')
  assert.deepEqual(reads, ['session-a', 'session-b', 'session-a'])
  assert.doesNotMatch(JSON.stringify(h.requests[0]), /MEMORY_FOR_session-b/)
  assert.doesNotMatch(JSON.stringify(h.requests[1]), /MEMORY_FOR_session-a/)
  assert.doesNotMatch(JSON.stringify(h.requests[2]), /MEMORY_FOR/)
})

test('a nonresponsive memory provider times out and the real suggestion still runs', async (t) => {
  let signal
  const h = await harness(t, { service: { read: (input) => {
    signal = input.signal
    return new Promise(() => {})
  } } })
  const state = await h.regen()
  assert.equal(signal.aborted, true)
  assert.equal(state.projectMemory.status, 'degraded')
  assert.equal(state.suggestError, '')
  assert.equal(h.requests.length, 1)
})

test('unload cancels a pending memory read and prevents a stale suggestion request', async (t) => {
  let signal
  const h = await harness(t, { service: { read: (input) => {
    signal = input.signal
    return new Promise(() => {})
  } } })
  await h.start()
  await until(() => signal)
  h.dispose()
  await until(() => signal.aborted)
  await pause()
  assert.equal(signal.aborted, true)
  assert.equal(h.requests.length, 0)
})


test('revoked legacy authorization blocks concurrent manual adoption while retaining visible advice', async (t) => {
  let revoked = false
  const h = await harness(t, { service: { read: async () => revoked
    ? { status: 'unbound' }
    : { status: 'ready', context: 'approved scoped fact', memory_ids: ['bound-id'] } } })
  const state = await h.regen()
  assert.ok(state.suggestion)
  revoked = true
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => h.invoke('session-a', '_adopt')))
  for (const attempt of attempts) {
    assert.equal(attempt.status, 'rejected')
    assert.match(attempt.reason.message, /授权无法在发送时核验/)
  }
  assert.equal(h.followups.length, 0)
  assert.ok((await h.state()).suggestion, 'advice stays visible for user review')
})

test('legacy authorization revoked during generation blocks takeover before dispatch', async (t) => {
  let authorized = true
  const h = await harness(t, {
    mode: 'takeover',
    service: { read: async () => authorized
      ? { status: 'ready', context: 'approved scoped fact', memory_ids: ['bound-id'] }
      : { status: 'unbound' } },
    onRequest: async () => { authorized = false },
  })
  const state = await h.auto()
  assert.equal(authorized, false)
  assert.ok(state.suggestion)
  assert.match(state.suggestError, /授权无法在发送时核验/)
  assert.equal(h.followups.length, 0)
})

test('legacy ready advice is not auto-dispatched even without an observable revocation', async (t) => {
  const h = await harness(t, { mode: 'takeover', service: { read: async () => ({ status: 'ready', context: 'scoped fact', memory_ids: ['bound-id'] }) } })
  const state = await h.auto()
  assert.ok(state.suggestion)
  assert.match(state.suggestError, /授权无法在发送时核验/)
  assert.equal(h.followups.length, 0)
})

test('an empty session does not query project memory or start a suggestion', async (t) => {
  let reads = 0
  const h = await harness(t, { noSurface: true, service: { read: async () => { reads++ } } })
  await h.regen()
  assert.equal(reads, 0)
  assert.equal(h.requests.length, 0)
})
