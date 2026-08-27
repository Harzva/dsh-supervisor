// Canonical legacy Store source recovered from the 0.2.4 runtime.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const FORMAT_VERSION = 1
const MAX_AUDIT = 500
const MAX_RELAYS = 500

export function defaultSupervisorStorePath() {
  const root = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(root, 'storages', 'dsh-supervisor', 'supervisor-state.v1.json')
}

function emptyState() {
  return { version: FORMAT_VERSION, assignments: {}, settings: {}, health: {}, handoffs: {}, relays: [], audit: [] }
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || value.version !== FORMAT_VERSION) return emptyState()
  return {
    version: FORMAT_VERSION,
    assignments: value.assignments && typeof value.assignments === 'object' ? value.assignments : {},
    settings: value.settings && typeof value.settings === 'object' ? value.settings : {},
    health: value.health && typeof value.health === 'object' ? value.health : {},
    handoffs: value.handoffs && typeof value.handoffs === 'object' ? value.handoffs : {},
    relays: Array.isArray(value.relays) ? value.relays.slice(-MAX_RELAYS) : [],
    audit: Array.isArray(value.audit) ? value.audit.slice(-MAX_AUDIT) : [],
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

  const load = async () => {
    if (loaded) return state
    try {
      state = normalizeState(JSON.parse(await readFile(filePath, 'utf8')))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      state = emptyState()
    }
    loaded = true
    return state
  }

  const persist = async () => {
    await mkdir(dirname(filePath), { recursive: true })
    const temp = filePath + '.' + process.pid + '.' + randomUUID() + '.tmp'
    await writeFile(temp, JSON.stringify(state, null, 2), 'utf8')
    await rename(temp, filePath)
  }

  const mutate = (operation, action) => enqueue(async () => {
    await load()
    const result = action(state)
    state.audit.push({ operation, at: Date.now() })
    if (state.audit.length > MAX_AUDIT) state.audit.splice(0, state.audit.length - MAX_AUDIT)
    await persist()
    return result
  })

  return {
    filePath,
    ready: () => enqueue(load),
    snapshot: () => enqueue(async () => structuredClone(await load())),
    getAssignment: (sessionId) => enqueue(async () => {
      await load()
      return state.assignments[sessionId] ? structuredClone(state.assignments[sessionId]) : null
    }),
    setAssignment: (sessionId, assignment) => mutate('assignment.set', (draft) => {
      draft.assignments[sessionId] = structuredClone(assignment)
      return structuredClone(draft.assignments[sessionId])
    }),
    setAssignments: (assignments) => mutate('assignment.setMany', (draft) => {
      for (const [sessionId, assignment] of Object.entries(assignments || {})) {
        draft.assignments[sessionId] = structuredClone(assignment)
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
  }
}
