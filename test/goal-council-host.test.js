import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { createRoleRegistry } from '@harzva/dsh-role-registry'
import { apply } from '../lib/index.js'
import { createSupervisorStore } from '../lib/supervisor-store.js'

const until = async check => {
  const end = Date.now() + 5000
  while (!await check()) {
    if (Date.now() > end) throw new Error('fixture timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
async function host(t, { goal, council } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'supervisor-goal-council-'))
  const timers = [], events = new Map(), routes = new Map(), disposers = [], followups = [], calls = []
  let command, watchdog
  const agent = { id: 'fixture-session', session: { id: 'fixture-session' }, status: 'idle', options: { provider: 'fixture', model: 'model' }, inbox: { nextTurn: [], nextStep: [] }, followup: m => followups.push(m) }
  const services = {
    agents: { list: () => [agent], roots: () => [agent], get: id => id === agent.id ? agent : undefined },
    roleRegistry: createRoleRegistry(),
    commands: { register: c => { command = c; return () => {} } },
    goals: goal,
    groupxCouncil: council,
    webServer: { register: route => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
    sessions: { get: () => agent.session, flush: async () => true },
    sessionQuery: { readSurface: async () => ({ events: [{ type: 'user/message', data: { message: { content: [{ type: 'text', text: '验证 fixture 实现并完成测试' }] } } }] }) },
    llm: { async *stream(r) { calls.push(r); yield { type: 'text-delta', text: '检查持久化结果并验证下一步行为。' } } },
  }
  const ctx = {
    get: name => services[name],
    inject: (names, callback) => { if (names.every(n => services[n])) callback(ctx) },
    effect: callback => { const d = callback(); if (typeof d === 'function') disposers.push(d) },
    on: (name, callback) => events.set(name, callback),
    timeout: callback => timers.push(callback), interval: callback => { watchdog = callback },
    logger: { info() {}, warn() {}, error() {} },
  }
  const storePath = join(dir, 'state.json')
  apply(ctx, { mode: 'advice', strategy: 'fixed', storePath, faculties: [{ id: 'code', route: 'fixture/model', prompt: '检验真实任务的实现和证据' }] })
  const invoke = async rawInput => command.handler({ agent, rawInput })
  const state = async () => JSON.parse((await invoke('_state')).text)
  const drain = async () => { await Promise.allSettled(timers.splice(0).map(callback => callback())); await new Promise(resolve => setTimeout(resolve, 10)) }
  const emit = async (type, seq, data) => events.get('session/event')(agent.session, { type, seq, data })
  await state()
  t.after(async () => { await Promise.allSettled(disposers.splice(0).map(d => d())); await rm(dir, { recursive: true, force: true }) })
  const request = async (body, { origin = 'http://localhost', remote = '127.0.0.1', method = 'POST' } = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    Object.assign(req, { headers: { host: 'localhost', origin, 'content-type': 'application/json' }, socket: { remoteAddress: remote }, method })
    let status, result
    await routes.get('/dsh-supervisor/council')(req, { writeHead: code => { status = code }, end: text => { result = JSON.parse(text) } })
    return { status, body: result }
  }
  return { invoke, state, drain, emit, request, watchdog: () => watchdog(), followups, calls, services, agent, storePath }
}

for (const phase of ['active', 'paused', 'blocked', 'complete']) test(`Goal ${phase} blocks watchdog, scheduled fixed continuation and adoption`, async t => {
  const h = await host(t, { goal: { get: () => ({ id: 'goal', revision: 1, phase }) } })
  await h.invoke('_regen'); await h.drain()
  assert.ok((await h.state()).suggestion)
  await assert.rejects(h.invoke('_adopt'), /原生目标/ )
  await h.invoke('_set {"mode":"takeover"}')
  h.watchdog(); await h.drain()
  assert.equal(h.followups.length, 0)
  assert.equal((await h.state()).used, 0)
})

test('Goal arriving after the durable delivery claim still prevents dispatch', async t => {
  let reads = 0, arm = false
  const h = await host(t, { goal: { get: () => arm && ++reads >= 3 ? { phase: 'active' } : undefined } })
  await h.invoke('_regen'); await h.drain()
  arm = true
  await assert.rejects(h.invoke('_adopt'), /原生目标/)
  assert.equal(h.followups.length, 0)
  const record = await createSupervisorStore(h.storePath).getExecution(h.agent.id)
  assert.equal(Object.values(record.deliveries)[0].status, 'superseded')
})

test('failed Goal lookup blocks continuation; absence preserves bounded legacy dispatch', async t => {
  const h = await host(t, { goal: { get: () => { throw new Error('offline') } } })
  await h.invoke('_regen'); await h.drain(); await assert.rejects(h.invoke('_adopt'), /原生目标/)
  assert.equal(h.followups.length, 0)
  h.services.goals = undefined
  await h.invoke('_adopt')
  assert.equal(h.followups.length, 1)
  assert.equal((await h.state()).used, 1)
})

test('native todo stagnation triggers only explicitly granted, durable-budgeted advice', async t => {
  const requests = []
  const h = await host(t, { goal: { get: () => ({ id: 'g', revision: 1, phase: 'active' }) }, council: { protocolVersion: 1, request: async r => { requests.push(r); return { status: 'completed', result: { summary: '先补充验收证据再执行下一步。', evidence: [], dissent: [] } } } } })
  await h.emit('todo/write', 1, { todos: [{ content: 'verify fixture', status: 'pending' }] })
  for (let seq = 2; seq <= 5; seq++) await h.emit('turn/end', seq, { reason: { kind: 'completed' } })
  await h.drain(); assert.equal(requests.length, 0)
  await h.invoke('council-auto on')
  await h.emit('turn/end', 6, { reason: { kind: 'completed' } }); await h.drain()
  let s = await h.state()
  assert.equal(requests.length, 1); assert.equal(s.council.callsReserved, 6)
  assert.equal(s.progress.source, 'native-todo'); assert.equal(h.followups.length, 0)
  await h.emit('turn/end', 6, { reason: { kind: 'completed' } }); await h.drain()
  assert.equal(requests.length, 1, 'duplicate round and cooldown cannot reconsult')
  await h.emit('turn/end', 7, { reason: { kind: 'completed' } }); await h.drain()
  await h.emit('turn/end', 8, { reason: { kind: 'completed' } }); await h.drain()
  assert.equal(requests.length, 2); assert.equal(requests[1].budget.maxModelCalls, 6)
  await h.invoke('council'); await h.drain()
  assert.equal(requests.length, 2); assert.equal((await h.state()).council.callsReserved, 12)
  await h.emit('user/message', 9, { message: { id: 'new-task', source: { kind: 'user' }, content: [] } })
  s = await h.state()
  assert.equal(s.council.autoEnabled, false); assert.equal(s.council.callsReserved, 0)
})

test('new user task aborts an in-flight council and suppresses its late result', async t => {
  let release, entered = false
  const h = await host(t, { council: { protocolVersion: 1, request: async () => { entered = true; return new Promise(resolve => { release = resolve }) } } })
  await h.invoke('council')
  const pending = h.drain()
  await until(() => entered)
  await h.emit('user/message', 20, { message: { id: 'replace-task', source: { kind: 'user' } } })
  release({ status: 'completed', result: { summary: 'STALE_RESULT' } })
  await pending
  assert.doesNotMatch(JSON.stringify(await h.state()), /STALE_RESULT/)
})

test('council reservations are monotonic across stale store instances and reset only on a new run', async t => {
  const h = await host(t)
  const a = createSupervisorStore(h.storePath), b = createSupervisorStore(h.storePath)
  const original = (await a.getExecution(h.agent.id))?.state || { runId: 'fixture-run', used: 0, council: { status: 'idle' } }
  await a.saveExecution(h.agent.id, original)
  const first = await a.reserveCouncil(h.agent.id, 'one', original, 8)
  assert.equal(first.reserved, true)
  await b.saveExecution(h.agent.id, { ...original, council: { status: 'completed', callsReserved: 0, discussionsUsed: 0 } })
  const second = await a.reserveCouncil(h.agent.id, 'two', original, 4)
  assert.equal(second.record.state.council.callsReserved, 12)
  await b.saveExecution(h.agent.id, { ...original, council: { status: 'completed' } })
  await assert.rejects(a.reserveCouncil(h.agent.id, 'three', original, 2), /预算已耗尽/)
  await a.saveExecution(h.agent.id, { runId: 'next-run', used: 0 })
  await assert.rejects(b.reserveCouncil(h.agent.id, 'old', original, 2), /已被替代/)
})

test('panel council endpoint closes the request/state loop and rejects cross-origin or malformed actions', async t => {
  let calls = 0
  const h = await host(t, { council: { protocolVersion: 1, cancel: () => false, request: async () => { calls++; return { status: 'completed', result: { summary: 'Panel fixture recommendation', evidence: [], dissent: [] } } } } })
  const input = { sessionId: h.agent.id, action: 'start' }
  assert.equal((await h.request(input, { origin: 'https://foreign.example' })).status, 403)
  assert.equal((await h.request(input, { remote: '203.0.113.1' })).status, 403)
  assert.equal((await h.request(input, { method: 'GET' })).status, 405)
  assert.equal((await h.request({ ...input, rawPrompt: 'bad' })).status, 400)
  assert.equal((await h.request({ ...input, action: 'auto', enabled: 'yes' })).status, 400)
  const queued = await h.request(input)
  assert.equal(queued.status, 200); assert.equal(queued.body.state.council.status, 'queued')
  await h.drain()
  assert.equal(calls, 1); assert.equal((await h.state()).council.callsReserved, 6)
  const grant = await h.request({ ...input, action: 'auto', enabled: true })
  assert.equal(grant.body.state.council.autoEnabled, true)
  const cancel = await h.request({ ...input, action: 'cancel' })
  assert.equal(cancel.body.state.council.autoEnabled, false)
})

test('cancelling a queued council prevents any reservation or model request', async t => {
  let calls = 0
  const h = await host(t, { council: { protocolVersion: 1, request: async () => { calls++; return { status: 'completed' } } } })
  await h.invoke('council'); await h.invoke('council cancel'); await h.drain()
  assert.equal(calls, 0); assert.equal((await h.state()).council.callsReserved, 0)
})
