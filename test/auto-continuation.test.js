import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoleRegistry } from '@harzva/dsh-role-registry'
import { apply } from '../lib/index.js'
import { createSupervisorStore } from '../lib/supervisor-store.js'

async function fixture(t, { mode = 'advice', onStream, goal, storePath: sharedStorePath } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'supervisor-auto-gate-'))
  const timers = [], events = new Map(), disposers = [], followups = []
  const registry = createRoleRegistry()
  const agent = { id: 's1', session: { id: 's1' }, status: 'idle', options: { provider: 'fixture', model: 'model' }, inbox: { nextTurn: [], nextStep: [] }, followup: m => followups.push(m) }
  let command
  const services = {
    agents: { list: () => [agent], roots: () => [agent], get: id => id === agent.id ? agent : undefined },
    roleRegistry: registry, goals: goal,
    commands: { register(c) { command = c; return () => {} } },
    sessions: { get: () => agent.session, flush: async () => true },
    sessionQuery: { readSurface: async () => ({ events: [{ type: 'user/message', data: { message: { id: 'current-user', source: { kind: 'user' }, content: [{ type: 'text', text: '处理本任务' }] } } }] }) },
    llm: { async *stream(request) { if (onStream) await onStream(request); yield { type: 'text-delta', text: '下一步先核对未完成的工作。' } } },
  }
  const ctx = {
    get: name => services[name], inject: (names, cb) => { if (names.every(n => services[n])) cb(ctx) },
    effect: cb => { const d = cb(); if (typeof d === 'function') disposers.push(d) },
    on: (name, cb) => events.set(name, cb), timeout: cb => timers.push(cb), interval: cb => { events.set('watchdog', cb) },
    logger: { info() {}, warn() {}, error() {} },
  }
  const storePath = sharedStorePath || join(dir, 'state.json')
  apply(ctx, { mode, strategy: 'plan', storePath, faculties: [{ id: 'code', name: 'Code', route: 'fixture/model', prompt: '审阅实现与验收' }] })
  const invoke = async input => command.handler({ agent, rawInput: input })
  const state = async () => JSON.parse((await invoke('_state')).text)
  const emit = async (type, seq, data) => events.get('session/event')(agent.session, { type, seq, data })
  const user = async (id = 'task-1', seq = 1) => emit('user/message', seq, { id, source: { kind: 'user' }, content: [{ type: 'text', text: '处理本任务' }] })
  const todo = async (items, seq = 2) => emit('todo/write', seq, { todos: items })
  const drain = async () => {
    while (timers.length) await Promise.allSettled(timers.splice(0).map(cb => cb()))
    const end = Date.now() + 5000
    while ((await state()).suggesting) { if (Date.now() > end) throw new Error('suggestion timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await state()
  t.after(async () => { await Promise.allSettled(disposers.splice(0).map(d => d())); await rm(dir, { recursive: true, force: true }) })
  return { agent, registry, services, followups, storePath, state, invoke, emit, user, todo, drain, watchdog: () => events.get('watchdog')() }
}

test('one-shot answer without native todo never triggers auto followup or burns a round', async t => {
  const h = await fixture(t)
  await h.user(); await h.invoke('_set {"mode":"takeover"}'); await h.drain()
  h.watchdog(); await h.drain()
  const state = await h.state()
  assert.equal(h.followups.length, 0)
  assert.equal(state.used, 0)
  assert.equal(state.automaticContinuation.allowed, false)
  assert.match(state.automaticContinuation.reason, /待办/)
})

test('explicit manual adoption remains possible without an automatic grant or todo', async t => {
  const h = await fixture(t)
  await h.user(); await h.invoke('_regen'); await h.drain()
  assert.ok((await h.state()).suggestion)
  await h.invoke('_adopt')
  assert.equal(h.followups.length, 1)
})

test('current task pending native todo and explicit takeover grant allow one continuation', async t => {
  const h = await fixture(t, { mode: 'off' })
  await h.user(); await h.todo([{ content: '验证输出', status: 'pending' }])
  await h.invoke('_set {"mode":"takeover"}'); await h.drain()
  assert.equal(h.followups.length, 1)
})

test('completed, malformed, and prior-task todo do not authorize auto continuation', async t => {
  for (const scenario of ['complete', 'invalid', 'prior']) {
    const h = await fixture(t)
    await h.user()
    await h.todo([{ content: '旧任务', status: scenario === 'complete' ? 'completed' : scenario === 'invalid' ? 'mystery' : 'pending' }])
    if (scenario === 'prior') await h.user('task-2', 3)
    await h.invoke('_set {"mode":"takeover"}'); await h.drain()
    assert.equal(h.followups.length, 0, scenario)
    assert.equal((await h.state()).automaticContinuation.allowed, false, scenario)
  }
})

test('new user task revokes takeover grant and old todo evidence', async t => {
  const h = await fixture(t)
  await h.user(); await h.todo([{ content: '进行中', status: 'pending' }]); await h.invoke('_set {"mode":"takeover"}')
  await h.user('task-2', 3); await h.drain()
  assert.equal(h.followups.length, 0)
  assert.match((await h.state()).automaticContinuation.reason, /授权/)
})

test('todo completion during model generation prevents auto dispatch', async t => {
  let h
  h = await fixture(t, { onStream: async () => h.todo([{ content: '已完成', status: 'completed' }], 3) })
  await h.user(); await h.todo([{ content: '待执行', status: 'pending' }]); await h.invoke('_set {"mode":"takeover"}'); await h.drain()
  assert.equal(h.followups.length, 0)
  assert.equal((await h.state()).automaticContinuation.allowed, false)
})

test('role check that makes inbox busy after durable reservation prevents dispatch', async t => {
  let armed = false, count = 0, h
  h = await fixture(t, { onStream: async () => { armed = true } })
  const original = h.registry.resolve.bind(h.registry)
  h.registry.resolve = ref => { if (armed && ++count === 2) h.agent.inbox.nextTurn.push({}); return original(ref) }
  await h.user(); await h.todo([{ content: '待执行', status: 'pending' }]); await h.invoke('_set {"mode":"takeover"}'); await h.drain()
  assert.equal(h.followups.length, 0)
  const record = await createSupervisorStore(h.storePath).getExecution('s1')
  assert.ok(Object.values(record.deliveries).some(d => d.status === 'superseded'))
})

test('owned native Goal blocks continuation even with a pending todo and grant', async t => {
  const h = await fixture(t, { goal: { get: () => ({ id: 'g', phase: 'paused' }) } })
  await h.user(); await h.todo([{ content: '待执行', status: 'pending' }]); await h.invoke('_set {"mode":"takeover"}'); await h.drain()
  assert.equal(h.followups.length, 0)
  assert.match((await h.state()).automaticContinuation.reason, /原生目标/)
})


test('switching away from takeover during generation revokes the grant', async t => {
  let release, entered
  const waiting = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const h = await fixture(t, { onStream: async () => { entered(); await gate } })
  await h.user(); await h.todo([{ content: '待执行', status: 'pending' }]); await h.invoke('_set {"mode":"takeover"}')
  const pending = h.drain()
  await waiting
  await h.invoke('_set {"mode":"advice"}')
  release(); await pending
  assert.equal(h.followups.length, 0)
  assert.equal((await h.state()).automaticContinuation.allowed, false)
})

test('multiple concurrent watchdog callbacks cannot send duplicate followups', async t => {
  const h = await fixture(t)
  await h.user(); await h.todo([{ content: '待执行', status: 'pending' }]); await h.invoke('_set {"mode":"takeover"}')
  h.watchdog(); h.watchdog(); h.watchdog()
  await h.drain()
  assert.equal(h.followups.length, 1)
})

test('restart does not recover a persisted takeover setting as an automatic grant', async t => {
  const first = await fixture(t)
  await first.user(); await first.todo([{ content: '待执行', status: 'pending' }]); await first.invoke('_set {"mode":"takeover"}')
  const second = await fixture(t, { storePath: first.storePath })
  second.watchdog(); await second.drain()
  assert.equal(second.followups.length, 0)
  const state = await second.state()
  assert.equal(state.mode, 'takeover')
  assert.equal(state.automaticContinuation.allowed, false)
  assert.match(state.automaticContinuation.reason, /授权/)
})

test('takeover restored from raw config is not an explicit per-task grant', async t => {
  const h = await fixture(t, { mode: 'takeover' })
  await h.user(); await h.todo([{ content: '待执行', status: 'pending' }])
  h.watchdog(); await h.drain()
  assert.equal(h.followups.length, 0)
  assert.match((await h.state()).automaticContinuation.reason, /授权/)
})

test('authorizing a live user task before its first todo permits continuation after todo arrives', async t => {
  const h = await fixture(t, { mode: 'off' })
  await h.user()
  await h.invoke('_set {"mode":"takeover","strategy":"fixed"}'); await h.drain()
  assert.equal(h.followups.length, 0)
  await h.todo([{ content: '本任务稍后出现的待办', status: 'pending' }], 2)
  h.watchdog(); await h.drain()
  assert.equal(h.followups.length, 1)
})

test('a restarted process cannot grant auto continuation to an unobserved old user even after a new todo', async t => {
  const first = await fixture(t)
  await first.user(); await first.todo([{ content: '旧任务待办', status: 'pending' }]); await first.invoke('_set {"mode":"takeover"}')
  const second = await fixture(t, { storePath: first.storePath })
  await second.invoke('_set {"mode":"takeover","strategy":"fixed"}')
  await second.todo([{ content: '重启后的待办', status: 'pending' }], 3)
  second.watchdog(); await second.drain()
  assert.equal(second.followups.length, 0)
  assert.equal((await second.state()).automaticContinuation.allowed, false)
})

test('an invalid new user sequence revokes prior grant and cannot reuse the previous sequence', async t => {
  for (const invalid of [undefined, NaN, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const h = await fixture(t)
    await h.user(); await h.todo([{ content: '旧任务待办', status: 'pending' }]); await h.invoke('_set {"mode":"takeover","strategy":"fixed"}')
    await h.emit('user/message', invalid, { id: 'ambiguous-new-task', source: { kind: 'user' }, content: [{ type: 'text', text: 'new user task' }] })
    await h.invoke('_set {"mode":"takeover"}')
    await h.todo([{ content: '不可关联的待办', status: 'pending' }], 3)
    h.watchdog(); await h.drain()
    assert.equal(h.followups.length, 0, String(invalid))
    assert.equal((await h.state()).automaticContinuation.allowed, false, String(invalid))
    const stored = await createSupervisorStore(h.storePath).getExecution('s1')
    assert.equal(stored.state.lastUserSeq, undefined, String(invalid))
  }
})

test('turn start invalidates prior todo and stale replay until a newer native todo appears', async t => {
  const h = await fixture(t)
  await h.user(); await h.todo([{ content: '待执行', status: 'pending' }]); await h.invoke('_set {"mode":"takeover"}'); await h.drain()
  assert.equal(h.followups.length, 1)
  await h.emit('turn/start', 3, {})
  assert.equal((await h.state()).automaticContinuation.allowed, false)
  await h.todo([{ content: '旧待办重放', status: 'pending' }], 2)
  assert.equal((await h.state()).automaticContinuation.allowed, false)
  await h.todo([{ content: '新轮次待办', status: 'pending' }], 4)
  assert.equal((await h.state()).automaticContinuation.allowed, true)
})

test('turn start during suggestion generation invalidates prior todo before dispatch', async t => {
  let h
  h = await fixture(t, { onStream: async () => h.emit('turn/start', 3, {}) })
  await h.user(); await h.todo([{ content: '待执行', status: 'pending' }]); await h.invoke('_set {"mode":"takeover"}'); await h.drain()
  assert.equal(h.followups.length, 0)
  assert.equal((await h.state()).automaticContinuation.allowed, false)
})
