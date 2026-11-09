import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createRoleRegistry } from '@harzva/dsh-role-registry'
import { apply } from '../lib/index.js'
import { createSupervisorStore } from '../lib/supervisor-store.js'

async function fixture(t, { initialState, initialDeliveries = {}, goal, throwAfterFollowup = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'supervisor-adopt-result-'))
  const storePath = join(dir, 'state.json')
  if (initialState) await writeFile(storePath, JSON.stringify({ version: 1, executions: { s1: { state: initialState, deliveries: initialDeliveries } } }))
  const timers = [], routes = new Map(), disposers = [], followups = []
  const registry = createRoleRegistry()
  let command, active = true
  const agent = { id: 's1', session: { id: 's1' }, status: 'idle', options: { provider: 'fixture', model: 'model' }, inbox: { nextTurn: [], nextStep: [] }, followup(m) { followups.push(m); if (throwAfterFollowup) throw new Error('fixture uncertain queue') } }
  const services = {
    agents: { list: () => active ? [agent] : [], roots: () => active ? [agent] : [], get: id => active && id === 's1' ? agent : undefined },
    roleRegistry: registry, goals: goal,
    commands: { register(c) { command = c; return () => {} } },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {} } },
    sessions: { get: () => agent.session, flush: async () => true },
    sessionQuery: { readSurface: async () => ({ events: [{ type: 'user/message', data: { message: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '核对当前任务' }] } } }] }) },
    llm: { async *stream() { yield { type: 'text-delta', text: '先检查实际结果并验证下一步。' } } },
  }
  const ctx = { get: n => services[n], inject: (ns, cb) => { if (ns.every(n => services[n])) cb(ctx) }, effect: cb => { const d = cb(); if (typeof d === 'function') disposers.push(d) }, on() {}, timeout: cb => timers.push(cb), interval() {}, logger: { info() {}, warn() {}, error() {} } }
  apply(ctx, { mode: 'advice', rounds: 2, storePath, faculties: [{ id: 'code', name: 'Code', route: 'fixture/model', prompt: '核对结果' }] })
  const invoke = rawInput => command.handler({ agent, rawInput })
  const state = async () => JSON.parse((await invoke('_state')).text)
  const generate = async () => {
    await invoke('_regen')
    for (const cb of timers.splice(0)) cb()
    const deadline = Date.now() + 5000
    while (!(await state()).suggestion || (await state()).suggesting) { if (Date.now() > deadline) throw new Error('generation timed out'); await new Promise(r => setTimeout(r, 5)) }
  }
  const request = async (path = '/dsh-supervisor/adopt') => {
    const req = Readable.from([Buffer.from(JSON.stringify({ sessionId: 's1' }))])
    Object.assign(req, { method: 'POST', url: path, headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } })
    let status, body
    await routes.get(path)(req, { writeHead(code) { status = code }, end(value) { body = JSON.parse(value) } })
    return { status, body }
  }
  await state()
  t.after(async () => { await Promise.allSettled(disposers.splice(0).map(d => d())); await rm(dir, { recursive: true, force: true }) })
  return { agent, registry, followups, state, generate, request, storePath, setActive: v => { active = v } }
}

test('HTTP adopt rejects an absent suggestion with a specific explanation', async t => {
  const h = await fixture(t); const result = await h.request()
  assert.equal(result.status, 400); assert.match(result.body.error, /没有可采纳/); assert.equal(h.followups.length, 0)
})

test('HTTP adopt rejects finished, exhausted, and recovery states distinctly', async t => {
  for (const [extra, error] of [[{ done: true, used: 0 }, /已结束/], [{ done: false, used: 2 }, /次数已用完/], [{ done: false, used: 0, recoveryRequired: 'pending-check' }, /需要核对/]]) {
    const initialDeliveries = extra.recoveryRequired ? { pending: { id: 'pending', runId: 'r1', status: 'queued', messageId: 'pending-message' } } : {}
    const h = await fixture(t, { initialState: { runId: 'r1', suggestion: 'fixture advice', suggestionId: 'old', ...extra }, initialDeliveries })
    const result = await h.request()
    assert.equal(result.status, 400); assert.match(result.body.error, error); assert.equal(h.followups.length, 0)
  }
})

test('HTTP adopt rejects a missing active session and Goal-owned continuation', async t => {
  let owned = false
  const h = await fixture(t, { goal: { get: () => owned ? { id: 'g', phase: 'active' } : undefined } })
  await h.generate(); h.setActive(false)
  let result = await h.request(); assert.equal(result.status, 400); assert.match(result.body.error, /会话未运行/)
  h.setActive(true); owned = true
  result = await h.request(); assert.equal(result.status, 400); assert.match(result.body.error, /原生目标/)
  assert.equal(h.followups.length, 0)
})

test('concurrent HTTP adoption sends at most once and reports a competing request', async t => {
  const h = await fixture(t); await h.generate()
  const results = await Promise.all([h.request(), h.request()])
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400])
  assert.match(results.find(r => r.status === 400).body.error, /正在处理|没有可采纳|状态已变化/)
  assert.equal(h.followups.length, 1)
})

test('post-reservation role disappearance reports an error and marks claim superseded', async t => {
  const h = await fixture(t); await h.generate()
  const resolve = h.registry.resolve.bind(h.registry); let calls = 0
  h.registry.resolve = ref => ++calls >= 3 ? undefined : resolve(ref)
  const result = await h.request()
  assert.equal(result.status, 400); assert.match(result.body.error, /角色不可用/); assert.equal(h.followups.length, 0)
  const record = await createSupervisorStore(h.storePath).getExecution('s1')
  assert.equal(Object.values(record.deliveries)[0].status, 'superseded')
})

test('ambiguous followup failure reports recovery needed and cannot blindly retry', async t => {
  const h = await fixture(t, { throwAfterFollowup: true }); await h.generate()
  const first = await h.request()
  assert.equal(first.status, 400); assert.match(first.body.error, /需要核对/); assert.equal(h.followups.length, 1)
  const second = await h.request()
  assert.equal(second.status, 400); assert.match(second.body.error, /需要核对/); assert.equal(h.followups.length, 1)
})
