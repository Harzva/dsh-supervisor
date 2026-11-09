// Phase 2 — 统一角色消费：Supervisor suggestFor 经 roleRegistry.resolve(ref) 取真实定义，
// 并对来源卸载/版本缺失 fail-closed（不静默换角）。
// 证明路径：
//  - 用一个真实 @harzva/dsh-role-registry#createRoleRegistry() 注册测试 domain 角色，
//    resolve 出的真实定义用于构造监督 system（含 identity/objectives），且**不含**本地 mentor 职责文本。
//  - dispose() 卸载该角色后：resolveSupervisorRole/supervisorBaseSystem fail-closed；
//    并通过真实 Cordis 无关 harness 驱动 suggestFor → suggestError 置为角色不可用、不调用 llm、无意见。
//  - 无 roleRef 会话保留本地 mentor 默认行为（回归）。
//  - 会话记录 roleRef 的持久化/幂等（supervisor-store + mentor-registry 携带）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { createRoleRegistry } from '@harzva/dsh-role-registry'
import {
  buildSupervisorSystemForRole,
  resolveSupervisorRole,
  supervisorBaseSystem,
  buildRoundtableParticipantSystem,
  defaultRoleRefFor,
  effectiveRoleSelection,
  apply,
} from '../lib/index.js'
import {
  normalizeRoleRefLike,
  resolveAssignment,
  normalizeMentors,
} from '../lib/mentor-registry.js'
import { createSupervisorStore } from '../lib/supervisor-store.js'

const ROLE_UNAVAILABLE_ERROR = '角色不可用：来源已卸载或版本不存在'

function registerTestRole(registry) {
  return registry.register({
    contributorId: 'testfaculty',
    version: '1',
    roles: [{
      id: 'testfaculty.code',
      version: '1',
      namespace: 'testfaculty',
      kind: 'domain',
      label: '代码学院',
      shortDescription: '代码审查与实现监督',
      capabilityTags: ['code', 'implementation'],
      phases: ['proposal', 'challenge', 'evaluation', 'synthesis'],
      prompt: {
        identity: '你是代码监督者，专注实现质量与可验证性。',
        objectives: ['推进实现并验证', '检查测试覆盖'],
        mustCheck: ['检查测试'],
        mustNot: ['不要臆测未验证的事实'],
        outputContract: ['给出下一步'],
      },
    }],
  })
}

// ── 真实注册表 → buildSupervisorSystemForRole：用真实定义，不含本地 mentor 文本 ──
test('buildSupervisorSystemForRole builds system from a REAL resolved role definition', () => {
  const registry = createRoleRegistry()
  const dispose = registerTestRole(registry)
  const ref = { id: 'testfaculty.code', version: '1' }
  const role = registry.resolve(ref)
  assert.ok(role, 'registry.resolve should return the real definition')
  assert.equal(role.prompt.identity, '你是代码监督者，专注实现质量与可验证性。')
  const system = buildSupervisorSystemForRole(role, 'plan')
  // 定义内容
  assert.match(system, /角色：代码学院/)
  assert.match(system, /身份：你是代码监督者/)
  assert.match(system, /目标：\n- 推进实现并验证/)
  assert.match(system, /必须检查：\n- 检查测试/)
  assert.match(system, /禁止：\n- 不要臆测未验证的事实/)
  assert.match(system, /输出契约：\n- 给出下一步/)
  // 输出契约采纳：采用角色定义的 outputContract，不再强加『不超过80字/一句中文』默认规则
  assert.doesNotMatch(system, /不超过80字/, 'adopted role outputContract must not be shadowed by the 80-char default rule')
  assert.doesNotMatch(system, /只用一句中文/)
  assert.match(system, /输出契约：\n- 给出下一步/, 'definition outputContract must be adopted verbatim')
  // 本地 mentor 职责标记必须不出现（不静默换角、不改用本地提示词）
  assert.doesNotMatch(system, /责任范围：/)
  assert.doesNotMatch(system, /你是“/)
  dispose()
})

// ── resolveSupervisorRole：已注册 → role；卸载 → fail-closed；版本缺失 → fail-closed；无 registry → fail-closed ──
test('resolveSupervisorRole resolves a registered role and fails closed when unloaded or version-missing', () => {
  const registry = createRoleRegistry()
  const dispose = registerTestRole(registry)
  const ref = { id: 'testfaculty.code', version: '1' }
  assert.deepEqual(resolveSupervisorRole(registry, ref).status, 'role')
  // 版本缺失：同一 id 版本不同 → 解析不到
  assert.deepEqual(resolveSupervisorRole(registry, { id: 'testfaculty.code', version: '2' }), {
    status: 'fail-closed', role: null, error: ROLE_UNAVAILABLE_ERROR,
  })
  // 卸载（来源 disposed）
  dispose()
  assert.deepEqual(resolveSupervisorRole(registry, ref), {
    status: 'fail-closed', role: null, error: ROLE_UNAVAILABLE_ERROR,
  })
  // 中立库未挂载（registry 缺失）且携带 roleRef → 同样 fail-closed
  assert.deepEqual(resolveSupervisorRole(undefined, ref), {
    status: 'fail-closed', role: null, error: ROLE_UNAVAILABLE_ERROR,
  })
  // 无 roleRef → none（交由本地 mentor 默认）
  assert.deepEqual(resolveSupervisorRole(registry, undefined), { status: 'none', role: null, error: '' })
})

// ── supervisorBaseSystem：真实决策路径（suggestFor 直接消费）──
test('supervisorBaseSystem uses the real role and never falls back to local mentor on fail-closed', () => {
  const registry = createRoleRegistry()
  const dispose = registerTestRole(registry)
  const mentors = normalizeMentors()
  const ref = { id: 'testfaculty.code', version: '1' }
  const assignment = { sessionId: 's1', primaryMentorId: 'atlas', collaboratorIds: [], roleRef: ref }

  // 已解析：用真实 role 定义构造 system，角色对象透出给圆桌路径
  const roleCase = supervisorBaseSystem(assignment, registry, mentors, 'plan')
  assert.equal(roleCase.failClosed, false)
  assert.equal(roleCase.role.prompt.identity, '你是代码监督者，专注实现质量与可验证性。')
  assert.match(roleCase.system, /角色：代码学院/)
  assert.match(roleCase.system, /身份：你是代码监督者/)
  assert.doesNotMatch(roleCase.system, /责任范围：/)
  // 显式用户选角 → source 'role-registry'，roleRef 精确。
  assert.equal(roleCase.source, 'role-registry')
  assert.deepEqual(roleCase.roleRef, { id: 'testfaculty.code', version: '1' })

  // 卸载 → fail-closed，绝不回退本地 mentor prompt
  dispose()
  const failedCase = supervisorBaseSystem(assignment, registry, mentors, 'plan')
  assert.equal(failedCase.failClosed, true)
  assert.equal(failedCase.error, ROLE_UNAVAILABLE_ERROR)
  assert.equal(failedCase.system, '')
  assert.equal(failedCase.role, null)

  // 中立库未挂载 + 携带 roleRef → 同样 fail-closed（不静默换角）
  const noRegistryCase = supervisorBaseSystem(assignment, undefined, mentors, 'plan')
  assert.equal(noRegistryCase.failClosed, true)

  // 无 roleRef + 默认导师（atlas，其共享角色 dsh-supervisor.atlas 未注册/无匹配学院）
  // → 从共享角色库推导默认角色失败，fail-closed；绝不回退本地 mentor responsibilities 文本（item 9）。
  const localCase = supervisorBaseSystem({ sessionId: 's1', primaryMentorId: 'atlas', collaboratorIds: [] }, registry, mentors, 'plan')
  assert.equal(localCase.failClosed, true)
  assert.equal(localCase.error, ROLE_UNAVAILABLE_ERROR)
  assert.equal(localCase.system, '')
  assert.equal(localCase.role, null)
})

// ── 圆桌/意见路径：roleRef 已解析时用真实定义，否则回退本地职责 ──
test('buildRoundtableParticipantSystem uses the real role when resolved, local responsibilities otherwise', () => {
  const registry = createRoleRegistry()
  const dispose = registerTestRole(registry)
  const mentors = normalizeMentors()
  const role = registry.resolve({ id: 'testfaculty.code', version: '1' })
  const roleSystem = buildRoundtableParticipantSystem(mentors[0], role)
  assert.match(roleSystem, /你是「Atlas」的监管导师。/)
  assert.match(roleSystem, /角色定义：代码审查与实现监督/)
  assert.match(roleSystem, /身份：/, 'item 8: the actual participant prompt must include prompt.identity')
  assert.match(roleSystem, /目标：\n- 推进实现并验证/)
  assert.doesNotMatch(roleSystem, /你关注的领域：/)

  const localSystem = buildRoundtableParticipantSystem(mentors[0], null)
  assert.match(localSystem, /你关注的领域：/)
  dispose()
})

// ── 会话记录 roleRef 持久化 + 原子写 + 重启恢复（supervisor-store）──
test('supervisor-store atomically persists roleRef to disk and recovers it in a fresh instance (restart)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-supervisor-role-store-'))
  const file = join(dir, 'state.json')
  try {
    const store = createSupervisorStore(file)
    await store.setAssignment('s1', {
      sessionId: 's1', primaryMentorId: 'atlas', collaboratorIds: [],
      roleRef: { id: 'testfaculty.code', version: '1' },
    })
    const loaded = await store.getAssignment('s1')
    assert.deepEqual(loaded.roleRef, { id: 'testfaculty.code', version: '1' })

    // 原子写（writeFile+rename）落盘：直接从磁盘读回原始 JSON 确认 roleRef 已写入。
    const raw = await readFile(file, 'utf8')
    const disk = JSON.parse(raw)
    assert.deepEqual(disk.assignments.s1.roleRef, { id: 'testfaculty.code', version: '1' }, 'roleRef must be written to disk')

    // 重启恢复：全新 store 实例（新进程语义）读取同一文件 → roleRef 仍存在。
    const restarted = createSupervisorStore(file)
    const recovered = await restarted.getAssignment('s1')
    assert.deepEqual(recovered.roleRef, { id: 'testfaculty.code', version: '1' }, 'roleRef must survive a fresh store instance')

    // 已存损坏 roleRef（present 但形状非法）→ 保留 roleRefCorrupt 标记，不静默丢弃回退导师（issue 6）。
    await restarted.setAssignment('s2', {
      sessionId: 's2', primaryMentorId: 'verity', collaboratorIds: [],
      roleRef: { id: 'bad id!!', version: '' },
    })
    const loadedBad = await restarted.getAssignment('s2')
    assert.equal(loadedBad.roleRefCorrupt, true, 'corrupt saved ref must be preserved as corrupt, not dropped')
    assert.equal(Object.hasOwn(loadedBad, 'roleRef'), false, 'invalid shape must not be exposed as a valid roleRef')

    // 清除（null）→ 记录无 roleRef，且落盘后仍无
    await restarted.setAssignment('s1', {
      sessionId: 's1', primaryMentorId: 'atlas', collaboratorIds: [],
      roleRef: null,
    })
    assert.equal(Object.hasOwn(await restarted.getAssignment('s1'), 'roleRef'), false)
    const disk2 = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(Object.hasOwn(disk2.assignments.s1, 'roleRef'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── mentor-registry：resolveAssignment 携带 roleRef；损坏 ref 保留为 corrupt（issue 6） ──
test('resolveAssignment preserves a valid roleRef and marks a corrupt one (fail-closed, not dropped)', () => {
  const mentors = normalizeMentors()
  const existing = {
    sessionId: 's1', primaryMentorId: 'atlas', collaboratorIds: ['verity'],
    assignmentSource: 'manual', reason: '用户指定', assignedAt: 1, version: 1,
    roleRef: { id: 'testfaculty.code', version: '1' },
  }
  const kept = resolveAssignment({ sessionId: 's1', tags: [] }, mentors, existing)
  assert.deepEqual(kept.roleRef, { id: 'testfaculty.code', version: '1' })
  assert.deepEqual(kept.collaboratorIds, ['verity'])

  const bad = { ...existing, roleRef: { id: 'no spaces!!', version: '' } }
  const corrupt = resolveAssignment({ sessionId: 's1', tags: [] }, mentors, bad)
  assert.equal(corrupt.roleRefCorrupt, true, 'present-but-invalid roleRef must be preserved as corrupt, not silently dropped')
  assert.equal(Object.hasOwn(corrupt, 'roleRef'), false)

  assert.deepEqual(normalizeRoleRefLike({ id: 'a.b.c', version: '1' }), { id: 'a.b.c', version: '1' })
  assert.equal(normalizeRoleRefLike(null), undefined)
  assert.equal(normalizeRoleRefLike('garbage'), undefined)
})

// ── 真实 harness 驱动 suggestFor：卸载后 fail-closed（suggestError 置位、无 llm、无意见）──
async function bootSupervisor(registry, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-supervisor-role-harness-'))
  const storePath = opts.storePath || join(dir, 'state.json')
  if (opts.initialAssignment) await writeFile(storePath, JSON.stringify({ version: 1, assignments: { s1: opts.initialAssignment } }))
  const contributionDisposers = []
  const faculties = Array.isArray(opts.faculties) ? opts.faculties : []
  let commandHandler = null
  const llmCalls = []
  const pending = []
  const intervals = []
  const effectDisposers = []
  const routes = new Map()
  let agentDisposed = false
  const llm = {
    async *stream(opts2) {
      llmCalls.push(opts2)
      if (opts.streamForCall) { yield* opts.streamForCall(llmCalls.length, opts2); return }
      const text = opts.responseForCall ? opts.responseForCall(llmCalls.length, opts2) : '推进代码实现并验证'
      yield { type: 'text-delta', text }
    },
  }
  const followups = []
  const agent = { session: { id: 's1', header: { cwd: dir } }, followup: msg => { followups.push(msg); if (opts.throwAfterFollowup) throw new Error('simulated crash after queue'); if (opts.receipts) opts.receipts.push({ type: 'user/message', data: msg, seq: opts.receipts.length + 1 }) }, id: 's1', status: 'idle', options: { provider: 'provider', model: 'model' } }
  const services = {
    harvisMemory: opts.memoryService,
    groupxCouncil: opts.groupxCouncil,
    roleRegistry: registry,
    llm,
    agents: { get: (id) => (!agentDisposed && id === 's1' ? agent : undefined), list: () => agentDisposed ? [] : [agent], roots: () => agentDisposed ? [] : [agent] },
    commands: { register: (opts2) => { commandHandler = opts2.handler } },
    sessionQuery: { readSurface: async () => ({ events: [{ type: 'user/message', data: { message: { id: 'initial-user', source: { kind: 'user' }, content: [{ type: 'text', text: '请继续' }] } } }, ...(opts.receipts || [])] }) },
    sessions: { get: () => agent.session, flush: async session => opts.flushSession ? opts.flushSession(session) : true },
    sessionFolders: opts.sessionFolders,
    sessionTags: { get: async () => [], all: async () => ({}) },
    workspaceRegistry: { list: () => [] },
    sessionProjections: { snapshot: () => ({ values: {} }) },
  }
  const listeners = new Map()
  const agentCtx = {
    get: (key) => services[key],
    timeout: (fn) => { const r = fn(); if (r && typeof r.then === 'function') pending.push(r); return undefined },
    interval: (fn, ms) => { intervals.push({ fn, ms }); return 0 },
    on: (name, fn) => { listeners.set(name, fn) },
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') effectDisposers.push(dispose); return () => {} },
    inject: (keys, fn) => { if (keys.includes('webServer')) fn({ get: key => key === 'webServer' ? { register: row => { routes.set(row.path, row.handler); return () => routes.delete(row.path) } } : undefined, effect: f => { const d = f(); if (typeof d === 'function') effectDisposers.push(d) } }) },
    logger: { info() {}, warn() {}, error() {} },
  }
  let roleRegistryInjectCb = null
  let agentsInjectCb = null
  const outer = {
    inject: (keys, cb) => {
      if (keys.includes('roleRegistry')) roleRegistryInjectCb = cb
      if (keys.includes('agents')) agentsInjectCb = cb
    },
    logger: agentCtx.logger,
  }
  apply(outer, { storePath, ...(opts.omitFaculties ? {} : { faculties }), ...opts.config })
  const mountRegistry = (nextRegistry = registry) => {
    services.roleRegistry = nextRegistry
    if (roleRegistryInjectCb) roleRegistryInjectCb({ get: (k) => (k === 'roleRegistry' ? nextRegistry : undefined), effect: (fn) => { contributionDisposers.push(fn()) } })
  }
  if (opts.agentsFirst) {
    services.roleRegistry = undefined
    if (agentsInjectCb) agentsInjectCb(agentCtx)
    if (!opts.delayRegistry) mountRegistry()
  } else {
    if (roleRegistryInjectCb) {
      try { mountRegistry() } catch { /* ignored */ }
    }
    if (agentsInjectCb) agentsInjectCb(agentCtx)
  }
  assert.ok(commandHandler, 'supervise command should be registered')
  const runCommand = async (rawInput) => {
    const line = String(rawInput).replace(/^\/supervise\s+/, '')
    const r = await commandHandler({ agent, rawInput: line })
    return r && r.text ? JSON.parse(r.text) : null
  }
  const drain = async () => { while (pending.length) { const p = pending.shift(); try { await p } catch { /* ignored */ } } }
  const unload = async () => { for (const dispose of effectDisposers.reverse()) await dispose(); effectDisposers.length = 0 }
  const request = async (path, body) => {
    const req = new EventEmitter()
    Object.assign(req, { method: 'POST', url: path, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost' }, destroy() {} })
    let status, data
    const result = routes.get(path)(req, { writeHead: code => { status = code }, end: text => { data = JSON.parse(text) } })
    req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end')
    await result
    return { status, data }
  }
  const get = async (url) => {
    let status, data
    await routes.get(new URL(url, 'http://localhost').pathname)({ method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost' } },
      { writeHead: code => { status = code }, end: text => { data = JSON.parse(text) } })
    return { status, data }
  }
  return { runCommand, runRaw: rawInput => commandHandler({ agent, rawInput }), drain, llmCalls, agent, followups, storePath, request, get, unload, mountRegistry, setRegistry: value => { services.roleRegistry = value },
    disposeAgent: () => { agentDisposed = true; return listeners.get('agent/disposed')?.({ agent }) }, emit: (name, ...args) => listeners.get(name)?.(...args), watchdog: () => intervals.find(entry => entry.ms === 2500).fn(), unloadContributors: () => contributionDisposers.forEach(fn => fn()), teardown: () => rm(dir, { recursive: true, force: true }) }
}


test('fresh install contributes five default role definitions and generates one suggestion', async () => {
  const registry = createRoleRegistry()
  const harness = await bootSupervisor(registry, { omitFaculties: true, config: { mode: 'advice' } })
  try {
    for (const id of ['atlas', 'scout', 'forge', 'verity', 'relay']) {
      const role = registry.resolve({ id: 'dsh-supervisor.' + id, version: '1' })
      assert.ok(role, 'missing shared default role ' + id)
      assert.ok(role.prompt.objectives[0])
    }
    await harness.runCommand('/supervise _regen')
    await harness.drain()
    const state = await harness.runCommand('/supervise _state')
    assert.equal(state.suggestError, '')
    assert.ok(state.suggestion)
    assert.equal(harness.llmCalls.length, 1, 'default roles must not create a multi-agent round')
    assert.deepEqual(state.faculties, [], 'registry defaults must not populate the execution faculty list')
    assert.equal(state.assignment.defaultRoleRef.id.startsWith('dsh-supervisor.'), true)
  } finally { await harness.unload(); harness.unloadContributors(); await harness.teardown() }
})


test('agents can load before registry and later use the mounted shared default roles', async () => {
  const registry = createRoleRegistry()
  const harness = await bootSupervisor(registry, { omitFaculties: true, agentsFirst: true, delayRegistry: true, config: { mode: 'advice' } })
  try {
    harness.mountRegistry()
    await harness.runCommand('/supervise _regen')
    await harness.drain()
    const state = await harness.runCommand('/supervise _state')
    assert.equal(state.suggestError, '')
    assert.ok(state.suggestion)
    assert.equal(harness.llmCalls.length, 1)
    assert.ok(state.assignment.defaultRoleRef)
  } finally { await harness.unload(); harness.unloadContributors(); await harness.teardown() }
})

test('replacing or unloading a registry does not remap a pinned role to a different role', async () => {
  const original = createRoleRegistry()
  const harness = await bootSupervisor(original, { omitFaculties: true, agentsFirst: true, delayRegistry: true, config: { mode: 'advice' } })
  try {
    harness.mountRegistry()
    await harness.runCommand('/supervise _regen')
    await harness.drain()
    assert.equal(harness.llmCalls.length, 1)
    const pinned = (await harness.runCommand('/supervise _state')).assignment.defaultRoleRef
    assert.ok(pinned)
    harness.unloadContributors()
    harness.setRegistry(undefined)
    await harness.runCommand('/supervise _regen')
    await harness.drain()
    assert.equal((await harness.runCommand('/supervise _state')).suggestError, ROLE_UNAVAILABLE_ERROR)
    assert.equal(harness.llmCalls.length, 1)
    const replacement = createRoleRegistry()
    registerTestRole(replacement)
    harness.setRegistry(replacement)
    await harness.runCommand('/supervise _regen')
    await harness.drain()
    const failed = await harness.runCommand('/supervise _state')
    assert.equal(failed.suggestError, ROLE_UNAVAILABLE_ERROR)
    assert.deepEqual(failed.assignment.defaultRoleRef, pinned)
    assert.equal(harness.llmCalls.length, 1)
    harness.mountRegistry(replacement)
    await harness.runCommand('/supervise _regen')
    await harness.drain()
    const restored = await harness.runCommand('/supervise _state')
    assert.equal(restored.suggestError, '')
    assert.deepEqual(restored.assignment.defaultRoleRef, pinned)
    assert.equal(harness.llmCalls.length, 2)
  } finally { await harness.unload(); harness.unloadContributors(); await harness.teardown() }
})

test('explicitly empty faculties opt out of default role contributions and remain fail closed', async () => {
  const registry = createRoleRegistry()
  const harness = await bootSupervisor(registry, { faculties: [], config: { mode: 'advice' } })
  try {
    assert.equal(registry.resolve({ id: 'dsh-supervisor.atlas', version: '1' }), undefined)
    await harness.runCommand('/supervise _regen')
    await harness.drain()
    const state = await harness.runCommand('/supervise _state')
    assert.equal(state.suggestError, ROLE_UNAVAILABLE_ERROR)
    assert.equal(harness.llmCalls.length, 0)
  } finally { await harness.unload(); harness.unloadContributors(); await harness.teardown() }
})

test('custom mentors do not implicitly install the five default roles', async () => {
  const registry = createRoleRegistry()
  const harness = await bootSupervisor(registry, { omitFaculties: true, config: { mentors: [{ id: 'custom', name: 'Custom', role: 'research' }], mode: 'advice' } })
  try {
    assert.equal(registry.resolve({ id: 'dsh-supervisor.atlas', version: '1' }), undefined)
    assert.equal(registry.resolve({ id: 'dsh-supervisor.custom', version: '1' }), undefined)
    await harness.runCommand('/supervise _regen')
    await harness.drain()
    const state = await harness.runCommand('/supervise _state')
    assert.equal(state.suggestError, ROLE_UNAVAILABLE_ERROR)
    assert.equal(harness.llmCalls.length, 0)
  } finally { await harness.unload(); harness.unloadContributors(); await harness.teardown() }
})

test('unloading default role contribution still fails closed after a successful first round', async () => {
  const registry = createRoleRegistry()
  const harness = await bootSupervisor(registry, { omitFaculties: true, config: { mode: 'advice' } })
  try {
    await harness.runCommand('/supervise _regen')
    await harness.drain()
    assert.equal(harness.llmCalls.length, 1)
    harness.unloadContributors()
    await harness.runCommand('/supervise _regen')
    await harness.drain()
    const state = await harness.runCommand('/supervise _state')
    assert.equal(state.suggestError, ROLE_UNAVAILABLE_ERROR)
    assert.equal(harness.llmCalls.length, 1)
  } finally { await harness.unload(); await harness.teardown() }
})


test('manual adoption rejects a generated suggestion after its exact role is unloaded', async () => {
  const registry = createRoleRegistry()
  const harness = await bootSupervisor(registry, { omitFaculties: true, config: { mode: 'advice' } })
  try {
    await harness.runCommand('/supervise _regen')
    await harness.drain()
    assert.ok((await harness.runCommand('/supervise _state')).suggestion)
    harness.unloadContributors()
    await assert.rejects(() => harness.runCommand('/supervise _adopt'), /角色不可用/)
    assert.equal(harness.followups.length, 0)
  } finally { await harness.unload(); await harness.teardown() }
})

test('manual adoption rejects changed role content under the same id and version', async () => {
  const registry = createRoleRegistry()
  const harness = await bootSupervisor(registry, { omitFaculties: true, config: { mode: 'advice' } })
  try {
    await harness.runCommand('/supervise _regen')
    await harness.drain()
    const pinned = (await harness.runCommand('/supervise _state')).assignment.defaultRoleRef
    const role = registry.resolve(pinned)
    harness.unloadContributors()
    registry.register({ contributorId: 'dsh-supervisor', version: '1', roles: [{ ...role, prompt: { ...role.prompt, identity: 'A changed definition' } }] })
    await assert.rejects(() => harness.runCommand('/supervise _adopt'), /角色定义已改变/)
    assert.equal(harness.followups.length, 0)
  } finally { await harness.unload(); await harness.teardown() }
})

test('automatic takeover blocks if the role is unloaded during model generation', async () => {
  const registry = createRoleRegistry()
  let harness
  harness = await bootSupervisor(registry, {
    omitFaculties: true, config: { mode: 'takeover' },
    streamForCall: async function* () { harness.unloadContributors(); yield { type: 'text-delta', text: '建议先核对任务验收结果。' } },
  })
  try {
    harness.agent.inbox = { nextTurn: [], nextStep: [] }
    await harness.emit('session/event', harness.agent.session, { type: 'user/message', seq: 1, data: { id: 'task-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the explicitly unfinished task' }] } })
    await harness.emit('session/event', harness.agent.session, { type: 'todo/write', seq: 2, data: { todos: [{ content: 'Finish the task', status: 'pending' }] } })
    await harness.runCommand('/supervise _set {"mode":"takeover"}')
    await harness.drain()
    const state = await harness.runCommand('/supervise _state')
    assert.match(state.suggestError, /角色不可用/)
    assert.equal(harness.followups.length, 0)
  } finally { await harness.unload(); await harness.teardown() }
})

test('automatic takeover sends once when the exact generation role remains available', async () => {
  const registry = createRoleRegistry()
  const harness = await bootSupervisor(registry, { omitFaculties: true, config: { mode: 'takeover' } })
  try {
    harness.agent.inbox = { nextTurn: [], nextStep: [] }
    await harness.emit('session/event', harness.agent.session, { type: 'user/message', seq: 1, data: { id: 'task-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the explicitly unfinished task' }] } })
    await harness.emit('session/event', harness.agent.session, { type: 'todo/write', seq: 2, data: { todos: [{ content: 'Finish the task', status: 'pending' }] } })
    await harness.runCommand('/supervise _set {"mode":"takeover"}')
    await harness.drain()
    assert.equal(harness.followups.length, 1)
  } finally { await harness.unload(); harness.unloadContributors(); await harness.teardown() }
})


test('post-reservation role removal cancels a durable claim before followup', async () => {
  const registry = createRoleRegistry()
  const harness = await bootSupervisor(registry, { omitFaculties: true, config: { mode: 'advice' } })
  try {
    await harness.runCommand('/supervise _regen'); await harness.drain()
    let reads = 0
    const original = registry.resolve.bind(registry)
    registry.resolve = ref => { if (++reads === 3) harness.unloadContributors(); return original(ref) }
    await assert.rejects(harness.runCommand('/supervise _adopt'), /角色不可用/)
    assert.equal(harness.followups.length, 0)
    const state = await harness.runCommand('/supervise _state')
    assert.match(state.suggestError, /角色不可用/)
    const record = await createSupervisorStore(harness.storePath).getExecution('s1')
    assert.equal(Object.values(record.deliveries).at(-1).status, 'superseded')
  } finally { await harness.unload(); await harness.teardown() }
})

test('a completed GroupX receipt remains independently adoptable without a Supervisor role fingerprint', async () => {
  const registry = createRoleRegistry()
  const harness = await bootSupervisor(registry, {
    omitFaculties: true, config: { mode: 'advice' },
    groupxCouncil: { protocolVersion: 1, request: async () => ({ status: 'completed', result: { summary: '先核对 GroupX 会诊建议。' } }) },
  })
  try {
    harness.agent.inbox = { nextTurn: [], nextStep: [] }
    await harness.runRaw('council'); await harness.drain()
    const before = await harness.runCommand('/supervise _state')
    assert.equal(before.council.status, 'completed')
    assert.equal(before.suggestion, '先核对 GroupX 会诊建议。')
    harness.unloadContributors()
    await harness.runCommand('/supervise _adopt')
    assert.equal(harness.followups.length, 1)
  } finally { await harness.unload(); await harness.teardown() }
})


test('suggestion fingerprint survives restart; older unbound advice fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'supervisor-role-restart-'))
  const storePath = join(dir, 'state.json')
  const first = await bootSupervisor(createRoleRegistry(), { omitFaculties: true, storePath, config: { mode: 'advice' } })
  let second, third
  try {
    await first.runCommand('/supervise _regen'); await first.drain()
    const before = await first.runCommand('/supervise _state')
    assert.ok(before.suggestion)
    await first.unload(); first.unloadContributors()
    const store = createSupervisorStore(storePath)
    const record = await store.getExecution('s1')
    assert.match(record.state.suggestionRole.digest, /^[a-f0-9]{64}$/)
    second = await bootSupervisor(createRoleRegistry(), { omitFaculties: true, storePath, config: { mode: 'advice' } })
    await second.runCommand('/supervise _adopt')
    assert.equal(second.followups.length, 1)
    await second.unload(); second.unloadContributors()
    // Re-create an upgrade-era pending suggestion with no fingerprint.
    const fresh = createSupervisorStore(storePath)
    const saved = await fresh.getExecution('s1')
    const oldState = { ...saved.state, runId: 'old-upgrade-run', used: 0, suggestion: '旧版建议需要重新生成。', suggestionId: 'old-suggestion', suggesting: false, suggestionRole: undefined }
    await fresh.saveExecution('s1', oldState)
    third = await bootSupervisor(createRoleRegistry(), { omitFaculties: true, storePath, config: { mode: 'advice' } })
    await assert.rejects(() => third.runCommand('/supervise _adopt'), /缺少角色定义校验信息/)
    assert.equal(third.followups.length, 0)
  } finally {
    if (third) { await third.unload(); third.unloadContributors(); await third.teardown() }
    if (second) await second.teardown()
    await first.teardown(); await rm(dir, { recursive: true, force: true })
  }
})

test('faculty specialty follows its identity before overlapping prompt vocabulary', async () => {
  const registry = createRoleRegistry()
  const harness = await bootSupervisor(registry, { faculties: [
    { id: 'code', name: '代码学院', route: 'provider/model', prompt: '关注架构、代码质量与实现，验证交付策略。' },
    { id: 'research', name: '研究学院', route: 'provider/model', prompt: '研究工程与代码方案，评估策略和风险。' },
    { id: 'custom', name: '代码专家', route: 'provider/model', prompt: '审查架构与策略。' },
  ] })
  try {
    const roles = registry.snapshot()
    assert.ok(roles.find(role => role.id === 'dsh-supervisor.code').capabilityTags.includes('specialty.engineering'))
    assert.ok(roles.find(role => role.id === 'dsh-supervisor.research').capabilityTags.includes('specialty.research'))
    assert.ok(roles.find(role => role.id === 'dsh-supervisor.custom').capabilityTags.includes('specialty.engineering'))
  } finally { await harness.teardown() }
})

test('suggestFor fails closed when the selected role is unloaded: no llm, no opinion, no local fallback', async () => {
  const registry = createRoleRegistry()
  const dispose = registerTestRole(registry)
  const harness = await bootSupervisor(registry)
  try {
    // 写入会话 roleRef（角色此刻已注册）
    const roleResult = await harness.runCommand('/supervise _role {"id":"testfaculty.code","version":"1"}')
    assert.ok(roleResult && roleResult.assignment, 'role command should persist the assignment')
    assert.deepEqual(roleResult.assignment.roleRef, { id: 'testfaculty.code', version: '1' })

    // 卸载角色（来源 disposed）
    dispose()

    // 重新生成建议 → suggestFor 应在 fail-closed 分支直接返回
    await harness.runCommand('/supervise _regen')
    await harness.drain()
    const state = await harness.runCommand('/supervise _state')
    assert.equal(state.suggestError, ROLE_UNAVAILABLE_ERROR, 'suggestError should be the role-unavailable message')
    assert.equal(state.suggestion, '', 'no opinion should be produced')
    assert.equal(harness.llmCalls.length, 0, 'llm must not be called on fail-closed')
    // 状态仍暴露 assignment.roleRef（供 picker 展示 + 审计）
    assert.ok(state.assignment, 'state should expose the assignment')
    assert.deepEqual(state.assignment.roleRef, { id: 'testfaculty.code', version: '1' })
  } finally {
    await harness.teardown()
  }
})

// ── 真实 harness 驱动 suggestFor：角色被采纳时确实用定义执行，且审计记录 roleRef/source/adoptedPrompt ──
test('suggestFor adopts the resolved role (outputContract, not the 80-char default) and records role provenance in the audit', async () => {
  const registry = createRoleRegistry()
  const dispose = registerTestRole(registry)
  const harness = await bootSupervisor(registry, {
    faculties: [{ id: 'strat', name: '策略学院', route: 'provider/model', prompt: '策略监督' }],
  })
  try {
    // 写入会话 roleRef（角色已注册）
    const roleResult = await harness.runCommand('/supervise _role {"id":"testfaculty.code","version":"1"}')
    assert.deepEqual(roleResult.assignment.roleRef, { id: 'testfaculty.code', version: '1' })

    // 重新生成 → suggestFor 运行圆桌路径，使用采纳的角色定义
    await harness.runCommand('/supervise _regen')
    await harness.drain()

    // 实际执行的监督 prompt 是角色定义（含 outputContract），而非本地 mentor 文本/80 字默认规则
    assert.ok(harness.llmCalls.length > 0, 'llm should be called when the role is adopted')
    const opinionCall = harness.llmCalls.find((c) => c && typeof c.system === 'string' && /角色定义：代码审查与实现监督/.test(c.system))
    assert.ok(opinionCall, 'a participant call should carry the adopted role definition')
    assert.match(opinionCall.system, /输出契约：\n- 给出下一步/, 'adopted role outputContract must be used')
    assert.doesNotMatch(opinionCall.system, /不超过80字/, 'the 80-char default rule must NOT shadow the adopted outputContract')
    assert.doesNotMatch(opinionCall.system, /责任范围：/, 'the local mentor responsibilities text must NOT be used')

    // 状态携带：facultySuggestions 上带 roleRef + source
    const state = await harness.runCommand('/supervise _state')
    assert.ok(state.suggestion && state.suggestion.length > 0, 'a suggestion should be produced with the adopted role')
    const fs = Object.values(state.facultySuggestions || {})[0]
    assert.ok(fs, 'faculty suggestions should exist for the roundtable path')
    assert.deepEqual(fs.roleRef, { id: 'testfaculty.code', version: '1' })
    assert.equal(fs.source, 'role-registry')

    // 圆桌落盘审计记录：每条意见记录【实际发送给该专家的 prompt】+ roleRef/version（审计 accuracy），
    // 主持人汇总单独标注（chair.verdict）。不得用未真正调用的 baseSys.system 冒充 adoptedPrompt。
    let roundtables = []
    for (let i = 0; i < 25; i += 1) {
      const readStore = createSupervisorStore(harness.storePath)
      roundtables = await readStore.getRoundtables('s1')
      if (roundtables.length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(roundtables.length > 0, 'a persisted roundtable audit record should exist')
    const record = roundtables[roundtables.length - 1]
    assert.deepEqual(record.roleRef, { id: 'testfaculty.code', version: '1' })
    assert.equal(record.definitionSource, 'role-registry')
    // 实际专家提示词（buildRoundtableParticipantSystem 产物）+ 精确 ref/version。
    const opinion = record.opinions[0]
    assert.ok(opinion, 'each opinion should record its actual prompt + roleRef')
    assert.equal(opinion.prompt, opinionCall.system, 'audit prompt must equal the actual LLM system')
    assert.equal(record.chair.prompt, harness.llmCalls.at(-1).system, 'chair audit must record the real chair system')
    assert.equal(typeof opinion.prompt, 'string', 'the ACTUAL expert prompt (buildRoundtableParticipantSystem output) must be recorded, not baseSys.system')
    assert.match(opinion.prompt, /角色定义：代码审查与实现监督/, 'recorded prompt should carry the adopted role definition')
    assert.doesNotMatch(opinion.prompt, /责任范围：/, 'recorded prompt must not be the local mentor responsibilities text')
    assert.deepEqual(opinion.roleRef, { id: 'testfaculty.code', version: '1' })
    // 主持人汇总单独标注（非专家意见）。
    assert.ok(record.chair && typeof record.chair.verdict === 'string', 'the chair summary must be recorded separately')
  } finally {
    await harness.teardown()
  }
})

// ── item 9：默认/旧会话统一从共享角色库消费（default-migration），不再用本地 mentor 文本 ──
const TEST_FACULTY = { id: 'strat', name: '策略学院', route: 'provider/model', prompt: '策略监督' }

// 注册一个「dsh-supervisor.<facultyId>」domain 角色（模拟真实 instructor 注册：contributorId='dsh-supervisor'）。
function registerFacultyRole(registry, faculty) {
  return registry.register({
    contributorId: 'dsh-supervisor',
    version: '1',
    roles: [{
      id: 'dsh-supervisor.' + faculty.id,
      version: '1',
      namespace: 'dsh-supervisor',
      kind: 'domain',
      label: faculty.name,
      shortDescription: faculty.prompt,
      capabilityTags: ['supervisor', 'domain'],
      phases: ['proposal', 'challenge', 'evaluation', 'synthesis'],
      prompt: {
        identity: '你是「' + faculty.name + '」的监管导师。',
        objectives: [faculty.prompt],
        mustCheck: ['基于领域视角给出可执行的下一步建议。'],
        mustNot: ['不要解释过度。'],
        outputContract: ['一句不超过80字的中文总结性建议。'],
      },
    }],
  })
}

// (a) 无用户 roleRef + 学院衍生导师 + 已注册学院角色 → 解析出真实共享库定义（default-migration），
//     不含本地 mentor responsibilities 文本。
test('(item 9a) no user roleRef resolves the real shared-library default role (default-migration, not local responsibilities)', () => {
  const registry = createRoleRegistry()
  const dispose = registerFacultyRole(registry, TEST_FACULTY)
  const faculties = [TEST_FACULTY]
  const mentors = normalizeMentors([], faculties) // 学院衍生：mentor.id === faculty.id
  const strat = mentors.find((m) => m.id === 'strat')
  assert.ok(strat, 'faculty-derived mentor should exist with id == faculty.id')
  const assignment = { sessionId: 's1', primaryMentorId: 'strat', collaboratorIds: [] } // 无 roleRef

  // defaultRoleRefFor 推导出真实 ref，并经 registry.resolve 命中定义。
  const dr = defaultRoleRefFor(assignment, registry, mentors, faculties)
  assert.equal(dr.status, 'default')
  assert.deepEqual(dr.ref, { id: 'dsh-supervisor.strat', version: '1' })
  assert.equal(dr.source, 'default-migration')
  assert.equal(dr.role.id, 'dsh-supervisor.strat')

  // supervisorBaseSystem 用真实共享库定义构造 system，且 provenance 为 default-migration。
  const system = supervisorBaseSystem(assignment, registry, mentors, 'plan', faculties)
  assert.equal(system.failClosed, false)
  assert.equal(system.source, 'default-migration')
  assert.deepEqual(system.roleRef, { id: 'dsh-supervisor.strat', version: '1' })
  assert.equal(system.role.id, 'dsh-supervisor.strat')
  assert.match(system.system, /角色：策略学院/, 'uses the real shared-library role label')
  assert.match(system.system, /身份：你是「策略学院」的监管导师。/)
  assert.match(system.system, /目标：\n- 策略监督/)
  assert.doesNotMatch(system.system, /责任范围：/, 'must NOT use the local mentor responsibilities text')
  assert.doesNotMatch(system.system, /你是“/, 'must NOT use the mentorIdentity local text')

  // 表面/选角 view 也反映 default-migration ref + 版本。
  const effective = effectiveRoleSelection(assignment, registry, mentors, faculties)
  assert.deepEqual(effective.roleRef, { id: 'dsh-supervisor.strat', version: '1' })
  assert.equal(effective.source, 'default-migration')

  // 圆桌/意见路径同用共享库定义（buildRoundtableParticipantSystem 收到已解析角色 → 非本地职责文本）。
  const participant = buildRoundtableParticipantSystem(strat, system.role)
  assert.match(participant, /你是「策略学院」的监管导师。/)
  assert.match(participant, /角色定义：策略监督/)
  assert.match(participant, /目标：\n- 策略监督/)
  assert.doesNotMatch(participant, /你关注的领域：/, 'suggestion prompt must NOT use the local responsibilities text')
  dispose()
})

// (b) 中立库未挂载或映射的默认 ref 不 resolve → fail-closed，绝不回退本地 mentor 文本。
test('(item 9b) the default path fails closed when the registry is unavailable or no default role resolves', () => {
  const faculties = [TEST_FACULTY]
  const mentors = normalizeMentors([], faculties)
  const assignment = { sessionId: 's1', primaryMentorId: 'strat', collaboratorIds: [] }

  // 中立库未挂载（registry undefined）+ 无 roleRef → fail-closed。
  const noRegistry = supervisorBaseSystem(assignment, undefined, mentors, 'plan', faculties)
  assert.equal(noRegistry.failClosed, true)
  assert.equal(noRegistry.error, ROLE_UNAVAILABLE_ERROR)
  assert.equal(noRegistry.system, '')
  assert.equal(noRegistry.role, null)
  assert.equal(noRegistry.source, '')
  assert.equal(defaultRoleRefFor(assignment, undefined, mentors, faculties).status, 'unavailable')

  // 中立库已挂载，但没有 dsh-supervisor.<facultyId> 角色、也无匹配学院 → fail-closed。
  const otherRegistry = createRoleRegistry()
  const dispose = registerTestRole(otherRegistry) // 只注册 testfaculty.code
  const noRole = supervisorBaseSystem(assignment, otherRegistry, mentors, 'plan', faculties)
  assert.equal(noRole.failClosed, true)
  assert.equal(noRole.error, ROLE_UNAVAILABLE_ERROR)
  assert.equal(noRole.system, '')
  assert.equal(noRole.role, null)
  assert.equal(defaultRoleRefFor(assignment, otherRegistry, mentors, faculties).status, 'fail-closed')
  dispose()
})

// (c) 显式用户选角 roleRef 永不被默认迁移覆盖：显式选择（role-registry）优先。
test('(item 9c) an explicit user-selected roleRef is never overwritten by the default migration', () => {
  const registry = createRoleRegistry()
  const disposeFaculty = registerFacultyRole(registry, TEST_FACULTY) // dsh-supervisor.strat 可用
  const disposeCode = registerTestRole(registry) // testfaculty.code（显式用户选择）
  const faculties = [TEST_FACULTY]
  const mentors = normalizeMentors([], faculties)
  const explicitRef = { id: 'testfaculty.code', version: '1' }
  // 主导师是学院衍生 'strat'，但用户显式选择了 testfaculty.code（不同于学院默认角色）。
  const assignment = { sessionId: 's1', primaryMentorId: 'strat', collaboratorIds: [], roleRef: explicitRef }

  // supervisorBaseSystem 必须用显式选择，而非学院默认角色（default-migration 不得覆盖）。
  const system = supervisorBaseSystem(assignment, registry, mentors, 'plan', faculties)
  assert.equal(system.failClosed, false)
  assert.equal(system.source, 'role-registry', 'explicit selection is preserved, not default-migration')
  assert.deepEqual(system.roleRef, explicitRef)
  assert.equal(system.role.prompt.identity, '你是代码监督者，专注实现质量与可验证性。')
  assert.match(system.system, /角色：代码学院/)
  assert.doesNotMatch(system.system, /角色：策略学院/, 'the faculty default must NOT replace the explicit selection')

  // 表面 view 也反映显式选择，而非默认迁移。
  const effective = effectiveRoleSelection(assignment, registry, mentors, faculties)
  assert.deepEqual(effective.roleRef, explicitRef)
  assert.equal(effective.source, 'role-registry')

  // 持久赋值不被改写：默认迁移不落盘、不改写用户的显式 choice。
  const storeAssign = { sessionId: 's1', primaryMentorId: 'strat', collaboratorIds: [], roleRef: explicitRef }
  const effectivePersisted = effectiveRoleSelection(storeAssign, registry, mentors, faculties)
  assert.deepEqual(effectivePersisted.roleRef, explicitRef)
  assert.equal(effectivePersisted.source, 'role-registry')

  disposeFaculty()
  disposeCode()
})

test('failed atomic write rolls back store memory and cannot leak a failed role selection into a later commit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sup-role-write-'))
  const file = join(dir, 'state.json')
  try {
    const store = createSupervisorStore(file)
    const original = { sessionId: 's1', primaryMentorId: 'atlas', roleRef: { id: 'test.old', version: '1' } }
    await store.setAssignment('s1', original)
    const before = await readFile(file)
    await rm(file)
    await mkdir(file)
    await assert.rejects(store.setAssignment('s1', { ...original, roleRef: { id: 'test.new', version: '1' } }))
    assert.deepEqual((await store.getAssignment('s1')).roleRef, original.roleRef)
    await rm(file, { recursive: true })
    await writeFile(file, before)
    await store.setAssignment('s2', { sessionId: 's2', primaryMentorId: 'atlas' })
    assert.deepEqual((await createSupervisorStore(file).getAssignment('s1')).roleRef, original.roleRef)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('corrupt selection can be repaired and the actual single-model execution is audited', async () => {
  const registry = createRoleRegistry()
  registerTestRole(registry)
  const harness = await bootSupervisor(registry, { initialAssignment: { sessionId: 's1', primaryMentorId: 'atlas', collaboratorIds: [], roleRefCorrupt: true } })
  try {
    const repair = await harness.runCommand('/supervise _role {"id":"testfaculty.code","version":"1"}')
    assert.equal(repair.assignment.roleRefCorrupt, undefined)
    await harness.runCommand('/supervise _regen')
    await harness.drain()
    assert.equal(harness.llmCalls.length, 1)
    let records = []
    for (let i = 0; i < 30; i++) {
      records = await createSupervisorStore(harness.storePath).getRoundtables('s1')
      if (records.length) break
      await new Promise(r => setTimeout(r, 5))
    }
    const record = records.at(-1)
    assert.equal(record.kind, 'single')
    assert.deepEqual(record.roleRef, { id: 'testfaculty.code', version: '1' })
    assert.equal(record.opinions[0].prompt, harness.llmCalls[0].system)
  } finally { await harness.teardown() }
})

test('retry audit records the actual reinforced prompt and configured route/budget without changing the role', async () => {
  const registry = createRoleRegistry()
  registerTestRole(registry)
  const harness = await bootSupervisor(registry, {
    faculties: [TEST_FACULTY], config: { opinionMaxTokens: 2222 },
    responseForCall: index => index === 1 ? '' : '完整专家意见与核验依据已经返回',
  })
  try {
    await harness.runCommand('/supervise _role {"id":"testfaculty.code","version":"1"}')
    await harness.runCommand('/supervise _set {"supervisorModel":{"supervisorId":"strat","route":"alternate/model-b"}}')
    await harness.runCommand('/supervise _regen')
    await harness.drain()
    assert.equal(harness.llmCalls.length, 3, 'two expert attempts and one chair')
    assert.ok(harness.llmCalls.every(call => call.provider === 'alternate' && call.model === 'model-b' && call.maxTokens === 2222))
    const record = (await createSupervisorStore(harness.storePath).getRoundtables('s1')).at(-1)
    const opinion = record.opinions[0]
    assert.deepEqual(record.roleRef, { id: 'testfaculty.code', version: '1' })
    assert.equal(opinion.attempts.length, 2)
    assert.equal(opinion.attempts[0].prompt, harness.llmCalls[0].system)
    assert.equal(opinion.attempts[1].prompt, harness.llmCalls[1].system)
    assert.notEqual(opinion.attempts[0].prompt, opinion.attempts[1].prompt)
    assert.equal(opinion.prompt, harness.llmCalls[1].system)
    assert.equal(opinion.attempts[0].text, '')
    assert.equal(opinion.text, opinion.attempts[1].text)
    assert.equal(record.chair.attempts[0].prompt, harness.llmCalls[2].system)
    assert.equal(record.chair.attempts[0].maxTokens, 2222)
  } finally { await harness.teardown() }
})

test('empty expert responses retain increasing failure backoff instead of restarting on every watchdog interval', async (t) => {
  let now = 100000
  t.mock.method(Date, 'now', () => now)
  const registry = createRoleRegistry()
  const harness = await bootSupervisor(registry, { faculties: [TEST_FACULTY], config: { mode: 'advice' }, responseForCall: () => '' })
  try {
    await harness.runCommand('/supervise _regen')
    await harness.drain()
    assert.equal(harness.llmCalls.length, 2)
    harness.agent.inbox = { nextTurn: [], nextStep: [] }
    now += 16000
    harness.watchdog(); await harness.drain()
    assert.equal(harness.llmCalls.length, 4)
    now += 16000
    harness.watchdog(); await harness.drain()
    assert.equal(harness.llmCalls.length, 4, 'second failure needs 30 seconds before retry')
    now += 15000
    harness.watchdog(); await harness.drain()
    assert.equal(harness.llmCalls.length, 6)
    const records = await createSupervisorStore(harness.storePath).getRoundtables('s1')
    assert.equal(records.length, 3)
    assert.ok(records.every(record => record.opinions[0].attempts.length === 2 && !record.opinions[0].ok))
  } finally { await harness.teardown() }
})

test('default migration is persisted before execution, recovered by a fresh store and remains fixed after unload', async () => {
  const registry = createRoleRegistry()
  const harness = await bootSupervisor(registry, { faculties: [TEST_FACULTY] })
  try {
    await harness.runCommand('/supervise _regen')
    await harness.drain()
    assert.ok(harness.llmCalls.length > 0)
    const restored = await createSupervisorStore(harness.storePath).getAssignment('s1')
    assert.deepEqual(restored.defaultRoleRef, { id: 'dsh-supervisor.strat', version: '1' })
    assert.equal(restored.defaultRoleSource, 'default-migration')
    harness.unloadContributors()
    const before = harness.llmCalls.length
    await harness.runCommand('/supervise _regen')
    await harness.drain()
    assert.equal(harness.llmCalls.length, before)
    const state = await harness.runCommand('/supervise _state')
    assert.match(state.suggestError, /角色不可用/)
    assert.deepEqual(state.assignment.roleRef, restored.defaultRoleRef)
  } finally { await harness.teardown() }
})


test('actual expert and chair messages both consume project memory with persisted provenance', async () => {
  const registry = createRoleRegistry()
  registerTestRole(registry)
  let loads = 0
  const harness = await bootSupervisor(registry, {
    memoryService: { warmSession: async (_agent, signal, options) => {
      loads++; assert.equal(options.force, true); assert.ok(signal)
      return { context: 'SYNTHETIC-MEMORY: only use blue widgets.', hits: [{ id: 'synthetic-approved-1' }], token_used: 12,
        scope: { kind: 'folder', project_id: 'folder:alpha', folderPath: 'alpha', label: 'alpha', key: 'alpha' } }
    }, sessionScope: () => ({ key: 'alpha' }) },
    faculties: [{ id: 'strat', name: '策略学院', route: 'provider/model', prompt: '策略监督' }],
  })
  try {
    await harness.runCommand('/supervise _role {"id":"testfaculty.code","version":"1"}')
    await harness.runCommand('/supervise _regen'); await harness.drain()
    assert.equal(loads, 1)
    assert.ok(harness.llmCalls.length >= 2)
    for (const call of harness.llmCalls) assert.match(JSON.stringify(call.messages), /SYNTHETIC-MEMORY/)
    const state = await harness.runCommand('/supervise _state')
    assert.equal(state.memoryContext.status, 'ready')
    assert.equal(state.memoryContext.scope.projectId, 'folder:alpha')
    const disk = JSON.parse(await readFile(harness.storePath, 'utf8'))
    const round = disk.roundtables.at(-1)
    assert.deepEqual(round.memoryContext.hitIds, ['synthetic-approved-1'])
    assert.match(JSON.stringify(round.chair.attempts), /SYNTHETIC-MEMORY/)
    await harness.runCommand('/supervise _adopt')
    assert.equal(harness.followups.length, 1)
    assert.match(JSON.stringify(harness.followups[0]), /SYNTHETIC-MEMORY/)
    assert.match(JSON.stringify(harness.followups[0]), /synthetic-approved-1/)
  } finally { await harness.teardown() }
})


test('empty chair output gets one bounded retry with the same memory and both attempts retained', async () => {
  const registry = createRoleRegistry(); registerTestRole(registry)
  let chairCalls = 0
  const harness = await bootSupervisor(registry, {
    faculties: [{ id: 'strat', name: '策略学院', route: 'provider/model', prompt: '策略监督' }],
    responseForCall: (_n, call) => call.system.includes('圆桌主席') && ++chairCalls === 1 ? '' : '请依据项目记忆完成验收回复',
  })
  try {
    await harness.runCommand('/supervise _role {"id":"testfaculty.code","version":"1"}')
    await harness.runCommand('/supervise _regen'); await harness.drain()
    const disk = JSON.parse(await readFile(harness.storePath, 'utf8'))
    const attempts = disk.roundtables.at(-1).chair.attempts
    assert.equal(chairCalls, 2); assert.equal(attempts.length, 2)
    assert.equal(attempts[0].text, ''); assert.ok(attempts[1].text)
    assert.deepEqual(attempts[0].messages, attempts[1].messages)
  } finally { await harness.teardown() }
})


test('a restarted Supervisor never reuses durable input message IDs for the same session', async () => {
  const ids = []
  for (let restart = 0; restart < 2; restart++) {
    const registry = createRoleRegistry(); registerTestRole(registry)
    const harness = await bootSupervisor(registry)
    try {
      await harness.runCommand('/supervise _role {"id":"testfaculty.code","version":"1"}')
      await harness.runCommand('/supervise _regen'); await harness.drain()
      await harness.runCommand('/supervise _adopt')
      assert.equal(harness.followups.length, 1)
      ids.push(harness.followups[0].id)
    } finally { await harness.teardown() }
  }
  assert.notEqual(ids[0], ids[1]); assert.ok(ids.every(id => /^supv-s1-[0-9a-f-]{36}$/.test(id)))
})

// Durable execution regression uses the actual plugin, store and command paths.
const durabilityFaculties = [{ id: 'code', name: '代码学院', route: 'provider/model', prompt: '以证据核对实现' }]
async function durableHarness(options = {}) {
  return bootSupervisor(createRoleRegistry(), { faculties: durabilityFaculties, ...options })
}
async function readySuggestion(h) {
  await h.runCommand('/supervise _set {"mode":"advice","strategy":"insight","rounds":3}')
  await h.drain()
  await h.runCommand('/supervise _regen')
  await h.drain()
  return h.runCommand('/supervise _state')
}

test('pending suggestion, exact memory evidence and remaining rounds restore after process replacement', async () => {
  const receipts = []
  const memoryService = { warmSession: async () => ({ context: '审核事实：恢复代号 PERSIST-410', hits: [{ memory: { memory_id: 'persist-fact' } }], token_used: 30, scope: { key: 'stable-project', project_id: 'project-1' } }), sessionScope: () => ({ key: 'stable-project' }) }
  const first = await durableHarness({ receipts, memoryService })
  let second
  try {
    const initial = await readySuggestion(first)
    assert.ok(initial.suggestion)
    assert.ok(initial.execution.suggestionId)
    second = await durableHarness({ storePath: first.storePath, receipts, memoryService })
    const restored = await second.runCommand('/supervise _state')
    assert.equal(restored.suggestion, initial.suggestion)
    assert.equal(restored.execution.suggestionId, initial.execution.suggestionId)
    assert.equal(restored.execution.remaining, 3)
    assert.equal(restored.memoryContext.hitIds[0], 'persist-fact')
    const attempts = await Promise.allSettled([second.runCommand('/supervise _adopt'), second.runCommand('/supervise _adopt')])
    assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1)
    assert.equal(attempts.filter(a => a.status === 'rejected').length, 1)
    assert.equal(second.followups.length, 1)
    assert.match(second.followups[0].content[0].text, /PERSIST-410/)
    const disk = await createSupervisorStore(first.storePath).getExecution('s1')
    assert.equal(disk.state.used, 1)
    assert.equal(Object.keys(disk.deliveries).length, 1)
    assert.equal(disk.state.suggestion, '')
  } finally { await second?.teardown(); await first.teardown() }
})

test('restart reconciles a persisted host receipt without resending or replenishing rounds', async () => {
  const receipts = []
  const first = await durableHarness({ receipts })
  let second
  try {
    await readySuggestion(first)
    await first.runCommand('/supervise _adopt')
    second = await durableHarness({ storePath: first.storePath, receipts })
    let recovered = await second.runCommand('/supervise _state')
    assert.equal(recovered.used, 1)
    assert.equal(recovered.execution.remaining, 2)
    assert.ok(recovered.execution.recoveryRequired)
    recovered = await second.runCommand('/supervise _recover')
    assert.equal(recovered.execution.recoveryRequired, '')
    assert.equal(second.followups.length, 0)
    const disk = await createSupervisorStore(first.storePath).getExecution('s1')
    assert.equal(Object.values(disk.deliveries)[0].status, 'received')
    await assert.rejects(second.runCommand('/supervise _adopt'), /没有可采纳/)
    assert.equal(second.followups.length, 0)
    assert.equal((await second.runCommand('/supervise _state')).used, 1)
  } finally { await second?.teardown(); await first.teardown() }
})


test('restart does not reconcile a same-ID message from the user or another plugin', async () => {
  const receipts = []
  const first = await durableHarness({ receipts })
  let second
  try {
    await readySuggestion(first)
    await first.runCommand('/supervise _adopt')
    const unrelated = ['user', 'plugin:other'].map(kind => {
      const item = structuredClone(receipts[0]); item.data.source = { kind }; return item
    })
    second = await durableHarness({ storePath: first.storePath, receipts: unrelated })
    const recovered = await second.runCommand('/supervise _recover')
    assert.ok(recovered.execution.recoveryRequired)
    assert.equal(second.followups.length, 0)
    const disk = await createSupervisorStore(first.storePath).getExecution('s1')
    assert.equal(Object.values(disk.deliveries)[0].status, 'queued')
  } finally { await second?.teardown(); await first.teardown() }
})

test('restart safely reconciles a historical Supervisor plugin receipt', async () => {
  const receipts = []
  const first = await durableHarness({ receipts })
  let second
  try {
    await readySuggestion(first)
    await first.runCommand('/supervise _adopt')
    const historical = structuredClone(receipts[0])
    historical.data.source = { kind: 'plugin', plugin: 'dsh-supervisor' }
    second = await durableHarness({ storePath: first.storePath, receipts: [historical] })
    const recovered = await second.runCommand('/supervise _recover')
    assert.equal(recovered.execution.recoveryRequired, '')
    assert.equal(second.followups.length, 0)
    const disk = await createSupervisorStore(first.storePath).getExecution('s1')
    assert.equal(Object.values(disk.deliveries)[0].status, 'received')
  } finally { await second?.teardown(); await first.teardown() }
})

test('crash at dispatch boundary pauses an uncertain adoption across restart, never blind-replays', async () => {
  const first = await durableHarness({ throwAfterFollowup: true })
  let second
  try {
    await readySuggestion(first)
    await assert.rejects(first.runCommand('/supervise _adopt'), /需要核对/)
    assert.equal(first.followups.length, 1)
    assert.ok((await first.runCommand('/supervise _state')).execution.recoveryRequired)
    second = await durableHarness({ storePath: first.storePath })
    await assert.rejects(second.runCommand('/supervise _adopt'), /需要核对/)
    second.watchdog(); await second.drain()
    let restored = await second.runCommand('/supervise _recover')
    assert.ok(restored.execution.recoveryRequired)
    assert.equal(restored.used, 1)
    assert.equal(second.followups.length, 0)
    assert.equal(second.llmCalls.length, 0)
    // A genuinely new user instruction starts a new budget; replaying it does not.
    const event = { type: 'user/message', seq: 44, data: { id: 'new-user', source: { kind: 'user' }, content: [{ type: 'text', text: '确认旧任务已处理，开始新任务' }] } }
    await second.emit('session/event', { id: 's1' }, event)
    restored = await second.runCommand('/supervise _state')
    assert.equal(restored.used, 0)
    assert.equal(restored.execution.recoveryRequired, '')
    const runId = restored.execution.runId
    await second.emit('session/event', { id: 's1' }, event)
    assert.equal((await second.runCommand('/supervise _state')).execution.runId, runId)
  } finally { await second?.teardown(); await first.teardown() }
})

test('done and interrupted-generation states survive cold store load without background model calls', async () => {
  const first = await durableHarness()
  let second
  try {
    await readySuggestion(first)
    const store = createSupervisorStore(first.storePath)
    const record = await store.getExecution('s1')
    await store.saveExecution('s1', { ...record.state, used: 3, done: true, suggesting: true, suggestion: '', suggestionId: '' })
    second = await durableHarness({ storePath: first.storePath })
    const restored = await second.runCommand('/supervise _state')
    assert.equal(restored.used, 3)
    assert.equal(restored.execution.done, true)
    assert.equal(restored.execution.remaining, 0)
    assert.equal(restored.suggesting, false)
    assert.match(restored.suggestError, /重启中断/)
    second.watchdog(); await second.drain()
    assert.equal(second.llmCalls.length, 0)
  } finally { await second?.teardown(); await first.teardown() }
})

test('a new user task arriving while a durable dispatch waits cannot send or restore the old task', async () => {
  const h = await durableHarness()
  try {
    const before = await readySuggestion(h)
    await writeFile(h.storePath + '.lock', JSON.stringify({ pid: process.pid, nonce: 'test-barrier' }))
    const adoption = assert.rejects(h.runCommand('/supervise _adopt'), /任务已变化|建议状态已变化|没有可采纳/)
    await new Promise(resolve => setTimeout(resolve, 30))
    const reset = h.emit('session/event', { id: 's1' }, { type: 'user/message', seq: 99, data: { id: 'new-task-racing', source: { kind: 'user' }, content: [{ type: 'text', text: '换成新任务' }] } })
    await new Promise(resolve => setTimeout(resolve, 10))
    await rm(h.storePath + '.lock')
    await Promise.all([adoption, reset])
    const after = await h.runCommand('/supervise _state')
    assert.notEqual(after.execution.runId, before.execution.runId)
    assert.equal(after.used, 0)
    assert.equal(h.followups.length, 0)
    const record = await createSupervisorStore(h.storePath).getExecution('s1')
    assert.equal(record.state.runId, after.execution.runId)
    assert.equal(Object.values(record.deliveries)[0].status, 'superseded')
  } finally { await rm(h.storePath + '.lock', { force: true }); await h.teardown() }
})

function deferredReview() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
async function startReviewGeneration(h) {
  await h.runCommand('/supervise _set {"mode":"advice","strategy":"insight","rounds":3}')
  await h.drain()
  await h.runCommand('/supervise _regen')
}
const actualReviewUserEvent = id => ({ type: 'user/message', seq: 201, data: { id, source: { kind: 'user' }, content: [{ type: 'text', text: '停止旧目标，按新的项目约定执行' }] } })

test('new user input during memory read cannot restore old evidence into the new task', async () => {
  const entered = deferredReview(), gate = deferredReview()
  let reads = 0
  const memoryService = { sessionScope: () => ({ key: 'scope-a' }), warmSession: async () => {
    if (++reads === 1) { entered.resolve(); await gate.promise }
    return { context: reads === 1 ? 'OLD-EVIDENCE-DO-NOT-REUSE' : 'CURRENT-EVIDENCE', hits: [], token_used: 4, scope: { key: 'scope-a', project_id: 'project-a' } }
  } }
  const h = await durableHarness({ memoryService })
  try {
    await startReviewGeneration(h); await entered.promise
    await h.emit('session/event', h.agent.session, actualReviewUserEvent('updated-during-memory'))
    gate.resolve(); await h.drain()
    const state = await h.runCommand('/supervise _state')
    assert.equal(state.suggestion, '')
    assert.equal(state.memoryContext, null)
    assert.equal(state.suggesting, false)
    const disk = await createSupervisorStore(h.storePath).getExecution('s1')
    assert.equal(disk.state.memoryText, '')
    assert.deepEqual(disk.state.facultySuggestions, {})
    assert.equal(h.llmCalls.length, 0)
    await h.runCommand('/supervise _regen'); await h.drain()
    assert.ok((await h.runCommand('/supervise _state')).suggestion)
  } finally { gate.resolve(); await h.drain(); await h.teardown() }
})

test('new user input aborts old model generation and prevents stale opinions or suggestion writes', async () => {
  const entered = deferredReview(), gate = deferredReview()
  let signal
  const h = await durableHarness({ streamForCall: async function* (number, options) {
    if (number === 1) { signal = options.signal; entered.resolve(); await gate.promise }
    yield { type: 'text-delta', text: 'OLD-GENERATION-WRITE-MUST-BE-DROPPED' }
  } })
  try {
    await startReviewGeneration(h); await entered.promise
    await h.emit('session/event', h.agent.session, actualReviewUserEvent('updated-during-model'))
    assert.equal(signal.aborted, true)
    gate.resolve(); await h.drain()
    const state = await h.runCommand('/supervise _state')
    assert.equal(state.suggestion, '')
    assert.equal(state.suggesting, false)
    assert.deepEqual(state.facultySuggestions, {})
    const disk = await createSupervisorStore(h.storePath).snapshot()
    assert.equal(disk.roundtables.length, 0)
    assert.equal(disk.executions.s1.state.memoryText, '')
  } finally { gate.resolve(); await h.drain(); await h.teardown() }
})

test('plugin unload aborts and drains model work without late suggestion, audit, or followup effects', async () => {
  const entered = deferredReview(), gate = deferredReview(), aborted = deferredReview()
  const h = await durableHarness({ streamForCall: async function* (_number, options) {
    options.signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    entered.resolve(); await gate.promise
    yield { type: 'text-delta', text: 'DISPOSED-SUPERVISOR-MUST-NOT-PUBLISH' }
  } })
  try {
    await startReviewGeneration(h); await entered.promise
    const unloading = h.unload()
    await aborted.promise
    gate.resolve(); await unloading; await h.drain()
    const disk = await createSupervisorStore(h.storePath).snapshot()
    assert.equal(disk.roundtables.length, 0)
    assert.equal(disk.executions.s1.state.suggestion, '')
    assert.equal(disk.executions.s1.state.suggesting, true, 'durable interrupted generation is left for restart recovery')
    assert.equal(h.followups.length, 0)
  } finally { gate.resolve(); await h.drain(); await h.teardown() }
})

test('agent disposal invalidates captured executor and prevents late generation persistence', async () => {
  const entered = deferredReview(), gate = deferredReview()
  let signal
  const h = await durableHarness({ streamForCall: async function* (_number, options) {
    signal = options.signal; entered.resolve(); await gate.promise
    yield { type: 'text-delta', text: 'RETIRED-AGENT-MUST-NOT-WRITE' }
  } })
  try {
    await startReviewGeneration(h); await entered.promise
    h.disposeAgent()
    assert.equal(signal.aborted, true)
    gate.resolve(); await h.drain()
    const disk = await createSupervisorStore(h.storePath).snapshot()
    assert.equal(disk.roundtables.length, 0)
    assert.equal(disk.executions.s1.state.suggestion, '')
    assert.equal(h.followups.length, 0)
  } finally { gate.resolve(); await h.drain(); await h.teardown() }
})


test('new Supervisor followups use the producer-owned source and durable receipts are recognized', async () => {
  const receipts = []
  const h = await durableHarness({ receipts })
  try {
    await h.runCommand('/supervise _regen'); await h.drain()
    await h.runCommand('/supervise _adopt')
    assert.equal(h.followups.length, 1)
    const message = h.followups[0]
    assert.equal(message.role, 'user')
    assert.match(message.id, /^supv-/)
    assert.deepEqual(message.source, { kind: 'plugin:dsh-supervisor' })
    assert.ok(Array.isArray(message.content) && message.content.some(block => block.type === 'text' && block.text.includes('Supervisor 建议')))
    await h.emit('session/event', h.agent.session, receipts[0])
    const saved = await createSupervisorStore(h.storePath).getExecution('s1')
    assert.equal(Object.values(saved.deliveries)[0].status, 'received')
  } finally { await h.unload(); h.unloadContributors(); await h.teardown() }
})

test('historical generic plugin receipts remain recognized for recovery', async () => {
  const receipts = []
  const h = await durableHarness({ receipts })
  try {
    await h.runCommand('/supervise _regen'); await h.drain()
    await h.runCommand('/supervise _adopt')
    const historical = structuredClone(receipts[0])
    historical.data.source = { kind: 'plugin', plugin: 'dsh-supervisor' }
    await h.emit('session/event', h.agent.session, historical)
    const saved = await createSupervisorStore(h.storePath).getExecution('s1')
    assert.equal(Object.values(saved.deliveries)[0].status, 'received')
  } finally { await h.unload(); h.unloadContributors(); await h.teardown() }
})

test('a visible receipt becomes received only after the host durability checkpoint succeeds', async () => {
  const entered = deferredReview(), gate = deferredReview(), receipts = []
  const h = await durableHarness({ receipts, flushSession: async () => { entered.resolve(); return gate.promise } })
  try {
    await readySuggestion(h); await h.runCommand('/supervise _adopt')
    const observed = h.emit('session/event', h.agent.session, receipts[0])
    await entered.promise
    const before = await createSupervisorStore(h.storePath).getExecution('s1')
    assert.equal(Object.values(before.deliveries)[0].status, 'queued')
    gate.resolve(true); await observed
    const after = await createSupervisorStore(h.storePath).getExecution('s1')
    assert.equal(Object.values(after.deliveries)[0].status, 'received')
    assert.equal(Object.values(after.deliveries)[0].receiptDurable, true)
  } finally { gate.resolve(true); await h.teardown() }
})

test('failed receipt flush remains uncertain after crash even when the old live surface showed the message', async () => {
  const receipts = []
  const first = await durableHarness({ receipts, flushSession: async () => false })
  let second
  try {
    await readySuggestion(first); await first.runCommand('/supervise _adopt')
    await first.emit('session/event', first.agent.session, receipts[0])
    assert.ok((await first.runCommand('/supervise _state')).execution.recoveryRequired)
    assert.ok((await first.runCommand('/supervise _recover')).execution.recoveryRequired, 'live-preferred surface cannot bypass failed flush')
    const disk = await createSupervisorStore(first.storePath).getExecution('s1')
    assert.equal(Object.values(disk.deliveries)[0].status, 'uncertain')
    second = await durableHarness({ storePath: first.storePath, receipts: [] }) // hard-crash lost the unflushed event
    const restored = await second.runCommand('/supervise _recover')
    assert.ok(restored.execution.recoveryRequired)
    await assert.rejects(second.runCommand('/supervise _adopt'), /需要核对/); second.watchdog(); await second.drain()
    assert.equal(second.followups.length, 0)
    assert.equal(second.llmCalls.length, 0)
    assert.equal(restored.used, 1)
  } finally { await second?.teardown(); await first.teardown() }
})

test('folder changes are blocked during claim and externally changed scope is rechecked before dispatch', async () => {
  let key = 'project-a', assignments = 0
  const memoryService = { workspaceFor: () => null, sessionScope: () => ({ key }), warmSession: async () => ({ context: 'PROJECT-A-ONLY-FACT', hits: [], token_used: 2, scope: { key, project_id: 'project-a' } }) }
  const h = await durableHarness({ memoryService, sessionFolders: { assign: async () => { assignments++ } } })
  try {
    await readySuggestion(h)
    await writeFile(h.storePath + '.lock', JSON.stringify({ pid: process.pid, nonce: 'scope-race' }))
    const adoption = assert.rejects(h.runCommand('/supervise _adopt'), /项目作用域已改变|会话未运行|没有可采纳/)
    await new Promise(resolve => setTimeout(resolve, 30))
    const blocked = await h.request('/dsh-supervisor/memory', { sessionId: 's1', action: 'assign', folderPath: 'B' })
    assert.equal(blocked.status, 400)
    assert.match(blocked.data.error, /当前执行结束/)
    assert.equal(assignments, 0)
    key = 'project-b' // external native folder owner changed outside this endpoint
    await rm(h.storePath + '.lock'); await adoption
    assert.equal(h.followups.length, 0)
    const disk = await createSupervisorStore(h.storePath).getExecution('s1')
    assert.equal(Object.values(disk.deliveries)[0].status, 'superseded')
  } finally { await rm(h.storePath + '.lock', { force: true }); await h.teardown() }
})

test('unload during a durable adoption claim never calls a retained executor', async () => {
  const h = await durableHarness()
  try {
    await readySuggestion(h)
    await writeFile(h.storePath + '.lock', JSON.stringify({ pid: process.pid, nonce: 'dispose-claim' }))
    const adoption = assert.rejects(h.runCommand('/supervise _adopt'), /项目作用域已改变|会话未运行|没有可采纳/)
    await new Promise(resolve => setTimeout(resolve, 30))
    const unloading = h.unload()
    await new Promise(resolve => setTimeout(resolve, 10))
    await rm(h.storePath + '.lock')
    await Promise.all([adoption, unloading])
    assert.equal(h.followups.length, 0)
    const disk = await createSupervisorStore(h.storePath).getExecution('s1')
    assert.equal(Object.values(disk.deliveries)[0].status, 'superseded')
  } finally { await rm(h.storePath + '.lock', { force: true }); await h.teardown() }
})

test('receipt arriving after the captured flush prefix cannot be promoted by a later live surface read', async () => {
  const first = await durableHarness()
  const volatileEvents = []
  let second
  try {
    await readySuggestion(first); await first.runCommand('/supervise _adopt')
    const message = first.followups[0]
    second = await durableHarness({ storePath: first.storePath, receipts: volatileEvents, flushSession: async () => {
      // The checkpoint has flushed its prior prefix; this event appears in the
      // live surface after that prefix and has not been flushed by this call.
      volatileEvents.push({ type: 'user/message', data: message, seq: 77 })
      return true
    } })
    const result = await second.runCommand('/supervise _recover')
    assert.ok(result.execution.recoveryRequired)
    const disk = await createSupervisorStore(first.storePath).getExecution('s1')
    assert.equal(Object.values(disk.deliveries)[0].status, 'queued')
  } finally { await second?.teardown(); await first.teardown() }
})

test('memory GET during cold startup cannot replace persisted supervision settings with defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-supervisor-startup-settings-'))
  const storePath = join(directory, 'state.json')
  const saved = { mode: 'takeover', strategy: 'fixed', rounds: 7, intervalMs: 10000, mentorModel: 'provider/saved-model', supervisorModels: { code: 'provider/saved-supervisor' } }
  await writeFile(storePath, JSON.stringify({ version: 1, assignments: {}, settings: { s1: saved }, executions: { s1: { state: { runId: 'saved-run', used: 4, done: false }, deliveries: {} } } }))
  const h = await durableHarness({ storePath })
  try {
    // This was a synchronous perOf() path that ran before snapshot I/O. It must
    // now wait for configuration plus execution before returning any projection.
    const memory = await h.get('/dsh-supervisor/memory?sessionId=s1')
    assert.equal(memory.status, 200)
    const state = await h.runCommand('/supervise _state')
    for (const [key, value] of Object.entries(saved)) assert.deepEqual(state[key], value, key)
    assert.equal(state.used, 4)
    assert.equal(state.execution.remaining, 3)
    assert.equal(state.execution.runId, 'saved-run')
    assert.equal(h.followups.length, 0)
    // A later unrelated edit must persist the loaded settings, not defaults.
    await h.runCommand('/supervise _set {"intervalMs":12000}')
    const disk = await createSupervisorStore(storePath).getSetting('s1')
    assert.equal(disk.mode, 'takeover')
    assert.equal(disk.rounds, 7)
    assert.equal(disk.mentorModel, 'provider/saved-model')
  } finally { await h.unload(); await h.teardown(); await rm(directory, { recursive: true, force: true }) }
})

test('memory GET fails closed when startup state cannot be restored', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-supervisor-startup-invalid-'))
  const storePath = join(directory, 'state.json')
  await writeFile(storePath, JSON.stringify({ version: 999, settings: { s1: { mode: 'takeover', rounds: 7 } } }))
  const h = await durableHarness({ storePath })
  try {
    const response = await h.get('/dsh-supervisor/memory?sessionId=s1')
    assert.equal(response.status, 400)
    assert.match(response.data.error, /状态格式无效/)
    assert.equal(h.followups.length, 0)
    assert.equal(JSON.parse(await readFile(storePath, 'utf8')).version, 999)
  } finally { await h.unload(); await h.teardown(); await rm(directory, { recursive: true, force: true }) }
})
