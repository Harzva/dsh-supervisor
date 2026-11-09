// Canonical legacy Store source recovered from the 0.2.4 runtime.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeRoleRefLike, classifyRoleRef } from './mentor-registry.js'

const FORMAT_VERSION = 1
const MAX_AUDIT = 500
const MAX_RELAYS = 500
const MAX_ROUNDTABLES = 500

export function defaultSupervisorStorePath() {
  const root = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(root, 'storages', 'dsh-supervisor', 'supervisor-state.v1.json')
}

function emptyState() {
  return { version: FORMAT_VERSION, assignments: {}, settings: {}, health: {}, handoffs: {}, relays: [], audit: [], roundtables: [], todos: {}, executions: {} }
}
function councilCount(value, maximum) {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error('会诊额度状态无效，禁止重置预算')
  return value
}
function mergeCouncil(previous, next) {
  if (!previous && !next) return undefined
  return { ...next, discussionsUsed: Math.max(councilCount(previous?.discussionsUsed, 2), councilCount(next?.discussionsUsed, 2)), callsReserved: Math.max(councilCount(previous?.callsReserved, 12), councilCount(next?.callsReserved, 12)) }
}

// Normalize an optional RoleRef on a persisted assignment record. Tri-state:
//  - absent (user never selected / explicitly cleared) -> no roleRef key (default mentor path)
//  - valid   -> normalized frozen roleRef
//  - present but INVALID (corrupt saved ref)           -> keep `roleRefCorrupt:true` so the
//    consumer FAILS CLOSED instead of silently re-roling to a mentor (issue 6). We must NOT drop it.
function normalizeAssignmentRoleRef(assignment) {
  if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) return assignment
  const classified = classifyRoleRef(assignment.roleRef)
  if (classified.valid) return { ...assignment, roleRef: classified.ref }
  if (classified.present) {
    // Corrupt: strip the invalid roleRef key and mark it so the consumer FAILS
    // CLOSED instead of silently re-roling to a mentor (issue 6).
    const { roleRef: _raw, ...rest } = assignment
    return { ...rest, roleRefCorrupt: true }
  }
  // Absent: strip any stray invalid roleRef to a clean "no selection".
  const { roleRef: _dropped, ...rest } = assignment
  return rest
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== FORMAT_VERSION) throw new Error('Supervisor 状态格式无效，必须恢复已验证备份，禁止重置执行额度')
  const assignments = value.assignments && typeof value.assignments === 'object' ? value.assignments : {}
  const normalizedAssignments = {}
  for (const [sessionId, assignment] of Object.entries(assignments)) {
    normalizedAssignments[sessionId] = normalizeAssignmentRoleRef(assignment)
  }
  return {
    version: FORMAT_VERSION,
    assignments: normalizedAssignments,
    settings: value.settings && typeof value.settings === 'object' ? value.settings : {},
    health: value.health && typeof value.health === 'object' ? value.health : {},
    handoffs: value.handoffs && typeof value.handoffs === 'object' ? value.handoffs : {},
    relays: Array.isArray(value.relays) ? value.relays.slice(-MAX_RELAYS) : [],
    audit: Array.isArray(value.audit) ? value.audit.slice(-MAX_AUDIT) : [],
    roundtables: Array.isArray(value.roundtables) ? value.roundtables.slice(-MAX_ROUNDTABLES) : [],
    executions: value.executions && typeof value.executions === 'object' && !Array.isArray(value.executions) ? value.executions : {},
    todos: value.todos && typeof value.todos === 'object' ? value.todos : {},
  }
}

export function createSupervisorStore(filePath = defaultSupervisorStorePath()) {
  let state = emptyState()
  let chain = Promise.resolve()
  let loaded = false

  const enqueue = (task) => {
    const next = chain.then(task, task)
    chain = next.then(() => {}, () => {})
    return next
  }

  const load = async (fresh = false) => {
    if (loaded && !fresh) return state
    try {
      state = normalizeState(JSON.parse(await readFile(filePath, 'utf8')))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      state = emptyState()
    }
    loaded = true
    return state
  }

  const persist = async (nextState) => {
    await mkdir(dirname(filePath), { recursive: true })
    const temp = filePath + '.' + process.pid + '.' + randomUUID() + '.tmp'
    try {
      const handle = await open(temp, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify(nextState, null, 2), 'utf8'); await handle.sync() } finally { await handle.close() }
      await rename(temp, filePath)
    } finally { await rm(temp, { force: true }) }
  }

  const withLock = async (action) => {
    await mkdir(dirname(filePath), { recursive: true })
    const path = filePath + '.lock'
    const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() })
    let acquired = false
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const handle = await open(path, 'wx', 0o600)
        try { await handle.writeFile(owner); await handle.sync() } finally { await handle.close() }
        acquired = true
        break
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        let raw
        try {
          raw = await readFile(path, 'utf8')
          const previous = JSON.parse(raw)
          if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || typeof previous.nonce !== 'string') throw new Error('Supervisor 写锁元数据损坏，需在停止服务后恢复')
          try { process.kill(previous.pid, 0) } catch (cause) {
            if (cause.code === 'ESRCH') {
              // Keep a permanent, nonce-specific reaping claim. Only one process
              // can unlink this dead owner; a late contender cannot remove a
              // replacement live lock after a check/unlink race.
              const claim = path + '.reaped-' + createHash('sha256').update(raw).digest('hex')
              let reaper
              try { reaper = await open(claim, 'wx', 0o600) } catch (error) { if (error.code !== 'EEXIST') throw error }
              if (reaper) {
                try { await reaper.writeFile(JSON.stringify({ pid: process.pid, owner: previous })); await reaper.sync() } finally { await reaper.close() }
                if (await readFile(path, 'utf8').catch(() => '') === raw) await rm(path)
              }
            }
          }
        } catch (cause) { if (cause.code !== 'ENOENT' && !(cause instanceof SyntaxError)) throw cause }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    if (!acquired) throw new Error('Supervisor 状态写入锁仍被占用')
    try { return await action() } finally {
      if (await readFile(path, 'utf8').catch(() => '') === owner) await rm(path)
    }
  }
  const mutate = (operation, action) => enqueue(() => withLock(async () => {
    await load(true)
    const draft = structuredClone(state)
    const result = action(draft)
    draft.audit.push({ operation, at: Date.now() })
    if (draft.audit.length > MAX_AUDIT) draft.audit.splice(0, draft.audit.length - MAX_AUDIT)
    await persist(draft)
    state = draft
    return result
  }))

  return {
    filePath,
    ready: () => enqueue(load),
    snapshot: () => enqueue(async () => structuredClone(await load())),
    getExecution: (sessionId) => enqueue(async () => {
      await load()
      return structuredClone(state.executions[sessionId] || null)
    }),
    saveExecution: (sessionId, executionState) => mutate('execution.save', (draft) => {
      const record = draft.executions[sessionId] ||= { state: {}, deliveries: {} }
      const next = structuredClone(executionState)
      if (next.council) next.council = mergeCouncil(undefined, next.council)
      record.retiredRuns ||= []
      if (next.runId && record.retiredRuns.includes(next.runId)) throw new Error('执行记录已被新的用户任务替代')
      if (record.state.runId && next.runId && record.state.runId !== next.runId) record.retiredRuns.push(record.state.runId)
      if (record.state.runId && record.state.runId === next.runId) {
        next.used = Math.max(record.state.used || 0, next.used || 0)
        next.done = record.state.done === true || next.done === true
        if (record.state.council || next.council) next.council = mergeCouncil(record.state.council, next.council)
      }
      if (next.suggestionId && record.deliveries[next.suggestionId]) { next.suggestion = ''; next.suggestionId = ''; next.suggestionAt = 0 }
      record.state = next
      return structuredClone(record)
    }),
    reserveCouncil: (sessionId, requestId, executionState, calls) => mutate('council.reserve', (draft) => {
      const record = draft.executions[sessionId]
      if (!record || record.state.runId !== executionState.runId || record.retiredRuns?.includes(executionState.runId)) throw new Error('会诊所属任务已被替代')
      record.councilRequests ||= {}
      if (record.councilRequests[requestId]) return { reserved: false, record: structuredClone(record) }
      if (!Number.isSafeInteger(calls) || calls < 2 || calls > 8) throw new Error('会诊预算无效')
      const council = record.state.council || {}
      councilCount(council.discussionsUsed, 2); councilCount(council.callsReserved, 12)
      if (council.status === 'running') throw new Error('已有会诊正在执行')
      if ((council.discussionsUsed || 0) >= 2 || (council.callsReserved || 0) + calls > 12) throw new Error('本任务会诊预算已耗尽')
      record.councilRequests[requestId] = { runId: executionState.runId, calls, at: Date.now() }
      record.state.council = { ...structuredClone(executionState.council), discussionsUsed: (council.discussionsUsed || 0) + 1, callsReserved: (council.callsReserved || 0) + calls, requestId, status: 'running' }
      return { reserved: true, record: structuredClone(record) }
    }),
    reserveDelivery: (sessionId, delivery, executionState, limit) => mutate('execution.reserve', (draft) => {
      const record = draft.executions[sessionId] ||= { state: {}, deliveries: {} }
      if (record.retiredRuns?.includes(executionState.runId)) throw new Error('建议所属任务已被替代')
      if (record.deliveries[delivery.id]) return { reserved: false, record: structuredClone(record) }
      if (Object.values(record.deliveries).some(d => d.runId === executionState.runId && ['dispatching', 'queued', 'uncertain'].includes(d.status))) throw new Error('已有采纳消息待核对，不可重复推进')
      const used = Math.max(record.state.used || 0, executionState.used || 0)
      // Completion is monotonic within one run, including claims from a stale
      // in-memory instance that still believes the task is unfinished.
      if (executionState.done || (record.state.runId === executionState.runId && record.state.done === true)) throw new Error('本轮监督任务已完成')
      if (used >= limit) throw new Error('本轮监督额度已耗尽')
      record.deliveries[delivery.id] = { ...structuredClone(delivery), status: 'dispatching', at: Date.now() }
      const council = mergeCouncil(record.state.runId === executionState.runId ? record.state.council : undefined, executionState.council)
      record.state = { ...structuredClone(executionState), used: used + 1, suggestion: '', suggestionId: '', suggestionAt: 0, lastInjectAt: Date.now(), lastDeliveryId: delivery.id }
      if (council) record.state.council = council
      return { reserved: true, record: structuredClone(record) }
    }),
    finishDelivery: (sessionId, id, status, details = {}) => mutate('execution.delivery', (draft) => {
      const record = draft.executions[sessionId]
      const delivery = record?.deliveries[id]
      if (!delivery) return null
      // A delayed queue acknowledgement cannot overwrite an observed receipt.
      if (!(['received', 'turn-ended'].includes(delivery.status) && ['queued', 'uncertain'].includes(status))) {
        Object.assign(delivery, structuredClone(details), { status, updatedAt: Date.now() })
      }
      if (delivery.runId === record.state.runId && ['received', 'turn-ended', 'dismissed'].includes(delivery.status)) record.state.recoveryRequired = ''
      return structuredClone(record)
    }),
    getAssignment: (sessionId) => enqueue(async () => {
      await load()
      return state.assignments[sessionId] ? structuredClone(state.assignments[sessionId]) : null
    }),
    setAssignment: (sessionId, assignment) => mutate('assignment.set', (draft) => {
      draft.assignments[sessionId] = structuredClone(normalizeAssignmentRoleRef(assignment))
      return structuredClone(normalizeAssignmentRoleRef(draft.assignments[sessionId]))
    }),
    setAssignments: (assignments) => mutate('assignment.setMany', (draft) => {
      for (const [sessionId, assignment] of Object.entries(assignments || {})) {
        draft.assignments[sessionId] = structuredClone(normalizeAssignmentRoleRef(assignment))
      }
      return structuredClone(assignments || {})
    }),
    getSetting: (sessionId) => enqueue(async () => {
      await load()
      return state.settings[sessionId] ? structuredClone(state.settings[sessionId]) : null
    }),
    setSetting: (sessionId, setting) => mutate('setting.set', (draft) => {
      draft.settings[sessionId] = structuredClone(setting)
      return structuredClone(draft.settings[sessionId])
    }),
    getHealth: (sessionId) => enqueue(async () => {
      await load()
      return state.health[sessionId]
        ? structuredClone(state.health[sessionId])
        : { successfulCompactions: 0, lastCompactionAt: null, lastCompactionSeq: null }
    }),
    recordCompaction: (sessionId, at, seq) => mutate('health.compaction', (draft) => {
      const current = draft.health[sessionId] || { successfulCompactions: 0, lastCompactionAt: null, lastCompactionSeq: null }
      if (Number.isInteger(seq) && Number.isInteger(current.lastCompactionSeq) && seq <= current.lastCompactionSeq) {
        return structuredClone(current)
      }
      draft.health[sessionId] = {
        successfulCompactions: current.successfulCompactions + 1,
        lastCompactionAt: at,
        lastCompactionSeq: Number.isInteger(seq) ? seq : current.lastCompactionSeq,
      }
      return structuredClone(draft.health[sessionId])
    }),
    getHandoff: (handoffId) => enqueue(async () => {
      await load()
      return state.handoffs[handoffId] ? structuredClone(state.handoffs[handoffId]) : null
    }),
    putHandoff: (handoff) => mutate('handoff.put', (draft) => {
      draft.handoffs[handoff.id] = structuredClone(handoff)
      return structuredClone(draft.handoffs[handoff.id])
    }),
    appendRelay: (relay) => mutate('relay.append', (draft) => {
      draft.relays.push(structuredClone(relay))
      if (draft.relays.length > MAX_RELAYS) draft.relays.splice(0, draft.relays.length - MAX_RELAYS)
      return structuredClone(relay)
    }),
    appendRoundtable: (record) => mutate('roundtable.append', (draft) => {
      draft.roundtables.push(structuredClone(record))
      if (draft.roundtables.length > MAX_ROUNDTABLES) draft.roundtables.splice(0, draft.roundtables.length - MAX_ROUNDTABLES)
      return structuredClone(record)
    }),
    getRoundtables: (sessionId) => enqueue(async () => {
      await load()
      const rows = state.roundtables.filter((r) => r && r.sessionId === sessionId)
      return structuredClone(rows)
    }),
    getTodos: (sessionId) => enqueue(async () => {
      await load()
      const list = state.todos[sessionId]
      return Array.isArray(list) ? structuredClone(list) : null
    }),
    setTodos: (sessionId, todos) => mutate('todos.set', (draft) => {
      draft.todos[sessionId] = structuredClone(Array.isArray(todos) ? todos : [])
      return structuredClone(draft.todos[sessionId])
    }),
  }
}
