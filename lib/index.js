// dsh-supervisor — Host（模式三档 + 多导师责任域 + 持久分配/健康度）。
//
// 失败边界：可选服务 ctx.get；注册随 fiber（ctx.effect/on/interval）。
// 状态进程内；客户端经 /supervise 命令通道读写。
//
// Legacy 矩阵批量接口 —— 会话矩阵（zhitro-brandos-session-board）经
// /dsh-supervisor/{states,state,adopt,regen} 读取每会话导师状态并切换，
// 无需逐会话打开。

import {
  mentorById, normalizeMentors, normalizeModelRoute, normalizeSupervisorModels,
  publicMentor, resolveAssignment,
} from './mentor-registry.js'
import { createSupervisorStore, defaultSupervisorStorePath } from './supervisor-store.js'
import { createHandoffService, handoffDraftRequest, renderHandoffPrompt } from './handoff-service.js'

export const name = 'dsh-supervisor'
export const inject = ['timer']

const PACKAGE_VERSION = '0.2.4'

const DEFAULTS = Object.freeze({
  mode: 'off',
  strategy: 'plan',
  rounds: 10,
  intervalMs: 5000,
  faculties: [],
  mentors: [],
  storePath: '',
  handoffWarnCompactions: 2,
  handoffRecommendCompactions: 3,
})

// 多导师学院：每个学院 = 一个 harness/provider×model + 领域提示词。
// 建议时并行调用各学院，再由主会议裁决式综合。
function normalizeFaculties(value = []) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const list = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const route = typeof item.route === 'string' ? item.route.trim() : ''
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
    if (!id || !route || !prompt || seen.has(id)) continue
    if (route.indexOf('/') <= 0) continue
    seen.add(id)
    list.push({ id, name: (typeof item.name === 'string' && item.name.trim()) || id, route, prompt })
  }
  return list
}

function routeOf(faculty) {
  const idx = faculty.route.indexOf('/')
  return { provider: faculty.route.slice(0, idx).trim(), model: faculty.route.slice(idx + 1).trim() }
}

const DEFAULT_FIXED_PROMPTS = Object.freeze(['continue', '继续', '请继续', '继续执行', '继续你的工作', '请继续推进，不要停'])
const NEXT_STEP_TAIL = '\n\n请先陈述你的下一步动作（一句话），然后继续执行。'

// 矩阵批量接口路径（与 zhitro-brandos-session-board 的 JSON 路由同风格）。
export const SUPV_STATES_PATH = '/dsh-supervisor/states'
export const SUPV_STATE_PATH = '/dsh-supervisor/state'
export const SUPV_ADOPT_PATH = '/dsh-supervisor/adopt'
export const SUPV_REGEN_PATH = '/dsh-supervisor/regen'
export const SUPV_MENTORS_PATH = '/dsh-supervisor/mentors'
export const SUPV_ASSIGNMENT_PATH = '/dsh-supervisor/assignment'
export const SUPV_HANDOFF_PATH = '/dsh-supervisor/handoff'
const MAX_MATRIX_IDS = 200
const MAX_JSON_BODY_BYTES = 64 * 1024
const MAX_ID_LENGTH = 128

function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_JSON_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function log(ctx, ...args) {
  if (ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info('[supervisor]', ...args)
  else console.log('[supervisor]', ...args)
}
function logError(ctx, ...args) {
  if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('[supervisor]', ...args)
  else console.warn('[supervisor]', ...args)
}
function planSummaryFrom(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return null
  let completed = 0, inProgress = 0, pending = 0, next = ''
  for (const t of todos) {
    if (t.status === 'completed') completed++
    else if (t.status === 'in_progress') inProgress++
    else pending++
    if (!next && t.status !== 'completed') next = t.content
  }
  return { total: todos.length, completed, inProgress, pending, next }
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...rawConfig }
  const fixedPrompts = Array.isArray(config.fixedPrompts) && config.fixedPrompts.length > 0 ? config.fixedPrompts : DEFAULT_FIXED_PROMPTS
  const defaultRounds = Number.isFinite(config.rounds) && config.rounds >= 1 ? Math.floor(config.rounds) : 10
  const defaultStrategy = config.strategy === 'insight' || config.strategy === 'fixed' ? config.strategy : 'plan'
  const defaultIntervalMs = Number.isFinite(config.intervalMs) && config.intervalMs >= 2000 ? Math.floor(config.intervalMs) : 5000
  const defaultMode = config.mode === 'advice' || config.mode === 'takeover' ? config.mode : 'off'
  const faculties = normalizeFaculties(config.faculties)
  const mentors = normalizeMentors(config.mentors, faculties)
  const storePath = typeof config.storePath === 'string' && config.storePath.trim()
    ? config.storePath.trim()
    : defaultSupervisorStorePath()
  const handoffWarnCompactions = Number.isFinite(config.handoffWarnCompactions)
    ? Math.max(1, Math.floor(config.handoffWarnCompactions))
    : 2
  const handoffRecommendCompactions = Number.isFinite(config.handoffRecommendCompactions)
    ? Math.max(handoffWarnCompactions, Math.floor(config.handoffRecommendCompactions))
    : 3

  // Loader applies sibling include groups concurrently; an apply-time strict
  // ctx.get('agents') can observe dsh-agent's fiber mid-startup and make the
  // whole plugin bail. Wait for the service instead of snapshotting it.
  ctx.inject(['agents'], (agentCtx) => {
    applyWithAgents(agentCtx, rawConfig, {
      defaultRounds, defaultStrategy, defaultIntervalMs, defaultMode, fixedPrompts, faculties,
      mentors, storePath, handoffWarnCompactions, handoffRecommendCompactions,
    })
  })
}

function applyWithAgents(ctx, rawConfig, cfg) {
  const {
    defaultRounds, defaultStrategy, defaultIntervalMs, defaultMode, fixedPrompts, faculties,
    mentors, storePath, handoffWarnCompactions, handoffRecommendCompactions,
  } = cfg
  const agents = ctx.get('agents')
  if (agents === undefined) return
  const state = { seq: 0, per: new Map(), groups: new Map() }
  const mentorStore = createSupervisorStore(storePath)
  const assignmentCache = new Map()
  const settingsCache = new Map()
  const healthCache = new Map()
  const handoffCache = new Map()
  const handoffDraftBuffers = new Map()
  const storeReady = mentorStore.snapshot().then((snapshot) => {
    for (const [sid, assignment] of Object.entries(snapshot.assignments)) assignmentCache.set(sid, assignment)
    for (const [sid, setting] of Object.entries(snapshot.settings)) settingsCache.set(sid, setting)
    for (const [sid, health] of Object.entries(snapshot.health)) healthCache.set(sid, health)
    for (const [id, handoff] of Object.entries(snapshot.handoffs)) handoffCache.set(id, handoff)
  }).catch((cause) => {
    logError(ctx, 'mentor state load failed', cause)
  })

  const listRoots = () => {
    try { if (typeof agents.roots === 'function') return agents.roots() } catch { /* ignore */ }
    return agents.list()
  }
  const findById = (sid) => {
    const found = agents.get(sid)
    if (found) return found
    for (const root of listRoots()) if (root && root.id === sid) return root
    return undefined
  }
  const isRoot = (agent) => listRoots().indexOf(agent) >= 0
  const perOf = (sid) => {
    let p = state.per.get(sid)
    if (!p) {
      p = {
        mode: defaultMode, strategy: defaultStrategy, rounds: defaultRounds, intervalMs: defaultIntervalMs,
        mentorModel: '', supervisorModels: {}, used: 0, done: false, lastInjectAt: 0, suggestion: '', suggestionAt: 0,
        suggestError: '', suggesting: false, lastSuggestAt: 0, failCount: 0,
        facultySuggestions: {}, roundtableAt: 0,
      }
      // 持久化恢复：重启后从 mentorStore.settings 读回用户配置（模式等）。
      // 仅快照静默读一次；失败保持默认，不阻塞 apply。
      try {
        const saved = settingsCache.get(sid)
        if (saved && typeof saved === 'object') {
          if (saved.mode === 'off' || saved.mode === 'advice' || saved.mode === 'takeover') p.mode = saved.mode
          if (saved.strategy === 'plan' || saved.strategy === 'insight' || saved.strategy === 'fixed') p.strategy = saved.strategy
          if (Number.isFinite(saved.rounds)) p.rounds = Math.max(1, Math.min(10000, Math.floor(saved.rounds)))
          if (Number.isFinite(saved.intervalMs)) p.intervalMs = Math.max(2000, Math.min(3600000, Math.floor(saved.intervalMs)))
          if (typeof saved.mentorModel === 'string') p.mentorModel = saved.mentorModel.trim().slice(0, 200)
          p.supervisorModels = normalizeSupervisorModels(saved.supervisorModels, mentors)
        }
      } catch { /* keep defaults */ }
      state.per.set(sid, p)
    }
    return p
  }
  const mentorLoad = () => {
    const counts = {}
    for (const assignment of assignmentCache.values()) {
      if (!assignment || typeof assignment.primaryMentorId !== 'string') continue
      counts[assignment.primaryMentorId] = (counts[assignment.primaryMentorId] || 0) + 1
    }
    return counts
  }
  const sessionFacts = async (sid, knownTags) => {
    const agent = findById(sid)
    const session = agent?.session || ctx.get('sessions')?.get(sid)
    const meta = session?.meta || {}
    const cwd = typeof meta.cwd === 'string' ? meta.cwd : ''
    let tags = Array.isArray(knownTags) ? knownTags : []
    let workspaceId = ''
    try {
      const sessionTags = ctx.get('sessionTags')
      if (!Array.isArray(knownTags) && sessionTags && typeof sessionTags.get === 'function') {
        const value = await sessionTags.get(sid)
        if (Array.isArray(value)) tags = value
      }
    } catch (cause) {
      logError(ctx, 'mentor tag lookup failed for ' + sid, cause)
    }
    try {
      const registry = ctx.get('workspaceRegistry')
      const workspaces = registry && typeof registry.list === 'function' ? registry.list() : []
      const workspace = Array.isArray(workspaces)
        ? workspaces.find((item) => item && item.path === cwd && Array.isArray(item.sessionIds) && item.sessionIds.includes(sid))
        : null
      if (workspace && typeof workspace.id === 'string') workspaceId = workspace.id
    } catch (cause) {
      logError(ctx, 'mentor workspace lookup failed for ' + sid, cause)
    }
    return {
      sessionId: sid,
      cwd,
      workspaceId,
      agentPreset: typeof meta.agentPreset === 'string' ? meta.agentPreset : '',
      tags,
    }
  }
  const ensureAssignment = async (sid) => {
    await storeReady
    const cached = assignmentCache.get(sid)
    if (cached && mentorById(mentors, cached.primaryMentorId)) return cached
    const facts = await sessionFacts(sid)
    const resolved = resolveAssignment(facts, mentors, cached, mentorLoad())
    if (!resolved) return null
    if (cached && JSON.stringify(cached) === JSON.stringify(resolved)) return cached
    assignmentCache.set(sid, resolved)
    try { await mentorStore.setAssignment(sid, resolved) } catch (cause) { logError(ctx, 'mentor assignment persist failed', cause) }
    return resolved
  }
  const ensureAssignments = async (ids) => {
    await storeReady
    const missing = ids.filter((sid) => {
      const cached = assignmentCache.get(sid)
      return !cached || !mentorById(mentors, cached.primaryMentorId)
    })
    if (missing.length === 0) return
    let tagsBySession = {}
    try {
      const sessionTags = ctx.get('sessionTags')
      if (sessionTags && typeof sessionTags.all === 'function') {
        const value = await sessionTags.all()
        if (value && typeof value === 'object') tagsBySession = value
      }
    } catch (cause) {
      logError(ctx, 'mentor batch tag lookup failed', cause)
    }
    const additions = {}
    for (const sid of missing) {
      const facts = await sessionFacts(sid, Array.isArray(tagsBySession[sid]) ? tagsBySession[sid] : [])
      const resolved = resolveAssignment(facts, mentors, assignmentCache.get(sid), mentorLoad())
      if (!resolved) continue
      assignmentCache.set(sid, resolved)
      additions[sid] = resolved
    }
    if (Object.keys(additions).length > 0) {
      try { await mentorStore.setAssignments(additions) } catch (cause) { logError(ctx, 'mentor assignment batch persist failed', cause) }
    }
  }
  const setAssignment = async (sid, primaryMentorId, collaboratorIds = []) => {
    await storeReady
    const primary = mentorById(mentors, primaryMentorId)
    if (!primary) throw new Error('unknown mentor: ' + primaryMentorId)
    const collaborators = []
    if (Array.isArray(collaboratorIds)) {
      for (const raw of collaboratorIds) {
        const id = typeof raw === 'string' ? raw.trim() : ''
        if (!id || id === primary.id || collaborators.includes(id) || !mentorById(mentors, id)) continue
        collaborators.push(id)
        if (collaborators.length >= 2) break
      }
    }
    const assignment = {
      sessionId: sid,
      primaryMentorId: primary.id,
      collaboratorIds: collaborators,
      assignmentSource: 'manual',
      reason: '用户指定',
      assignedAt: Date.now(),
      version: 1,
    }
    assignmentCache.set(sid, assignment)
    await mentorStore.setAssignment(sid, assignment)
    return assignment
  }
  const healthLevel = (health) => {
    const count = Number.isFinite(health?.successfulCompactions) ? health.successfulCompactions : 0
    if (count >= handoffRecommendCompactions) return 'handoff-recommended'
    if (count >= handoffWarnCompactions) return 'aging'
    return 'healthy'
  }
  const latestHandoffFor = (sid) => {
    let latest = null
    for (const record of handoffCache.values()) {
      if (!record || (record.sourceSessionId !== sid && record.targetSessionId !== sid)) continue
      if (!latest || (record.updatedAt || 0) > (latest.updatedAt || 0)) latest = record
    }
    return latest
  }
  const publicHandoff = (record, includeBrief = false) => record ? {
    id: record.id,
    sourceSessionId: record.sourceSessionId,
    targetSessionId: record.targetSessionId,
    sourceMentorId: record.sourceMentorId,
    receiverMentorId: record.receiverMentorId,
    workspaceId: record.workspaceId,
    cwd: record.cwd,
    agentPreset: record.agentPreset,
    compactionCount: record.compactionCount,
    status: record.status,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    ...(includeBrief ? {
      briefText: record.briefText,
      draftRequest: handoffDraftRequest(record.id),
      handoffPrompt: record.briefText ? renderHandoffPrompt(record) : '',
    } : {}),
  } : null
  const mentorStateFor = (sid) => {
    const assignment = assignmentCache.get(sid) || null
    const primary = assignment ? mentorById(mentors, assignment.primaryMentorId) : null
    const collaborators = assignment
      ? assignment.collaboratorIds.map((id) => publicMentor(mentorById(mentors, id))).filter(Boolean)
      : []
    const health = healthCache.get(sid) || { successfulCompactions: 0, lastCompactionAt: null, lastCompactionSeq: null }
    return {
      mentor: publicMentor(primary),
      collaborators,
      assignment,
      health: { ...health, level: healthLevel(health) },
      handoff: publicHandoff(latestHandoffFor(sid)),
    }
  }
  const hasPending = (agent) => {
    try { return agent.inbox.nextTurn.length + agent.inbox.nextStep.length > 0 } catch { return true }
  }
  const readTodos = (sid) => {
    try {
      const sessions = ctx.get('sessions')
      const sess = sessions && sessions.get(sid)
      const projections = ctx.get('sessionProjections')
      if (!sess || !projections) return null
      const snap = projections.snapshot(sess)
      const values = snap && snap.values
      const todos = values && values.todos
      return Array.isArray(todos) ? todos : null
    } catch { return null }
  }
  const planSummary = (sid) => planSummaryFrom(readTodos(sid))
  const planTodos = (sid) => {
    const todos = readTodos(sid)
    if (!todos) return []
    return todos.slice(0, 40).map((t) => ({ content: t.content, status: t.status }))
  }
  const readSurfaceEvents = async (sid) => {
    const sessionQuery = ctx.get('sessionQuery')
    if (!sessionQuery || typeof sessionQuery.readSurface !== 'function') return null
    try {
      const surf = await sessionQuery.readSurface(sid)
      return (surf && surf.events) || null
    } catch (cause) { logError(ctx, 'surface read failed', cause); return null }
  }
  const recentSurfaceText = async (sid) => {
    const evs = await readSurfaceEvents(sid)
    if (!evs || evs.length === 0) return ''
    const lines = []
    const start = Math.max(0, evs.length - 12)
    for (let i = start; i < evs.length; i += 1) {
      const e = evs[i]
      if (!e || (e.type !== 'user/message' && e.type !== 'assistant/message')) continue
      const data = e.data || {}
      const msg = data.message ? data.message : data
      const blocks = (msg && msg.content) || []
      let text = ''
      for (const b of blocks) if (b && b.type === 'text') text += b.text
      if (!text) continue
      lines.push('[' + (e.type === 'user/message' ? 'user' : 'assistant') + '] ' + text)
      if (lines.join('\n').length > 6000) break
    }
    return lines.join('\n').slice(0, 4000)
  }
  const lastAssistantText = async (sid) => {
    const evs = await readSurfaceEvents(sid)
    if (!evs) return { ok: false, text: '' }
    for (let i = evs.length - 1; i >= 0; i -= 1) {
      const e = evs[i]
      if (e && e.type === 'assistant/message') {
        const data = e.data || {}
        const msg = data.message ? data.message : data
        const blocks = (msg && msg.content) || []
        let text = ''
        for (const b of blocks) if (b && b.type === 'text') text += b.text
        return { ok: true, text }
      }
    }
    return { ok: true, text: '' }
  }
  const messageText = (event) => {
    const data = event && event.data
    const message = data && data.message ? data.message : data
    const blocks = message && Array.isArray(message.content) ? message.content : []
    let text = ''
    for (const block of blocks) if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
    return text.trim()
  }
  const routeFromString = (value) => {
    const route = normalizeModelRoute(value)
    if (!route) return null
    const idx = route.indexOf('/')
    return { provider: route.slice(0, idx), model: route.slice(idx + 1) }
  }
  const supervisorOverrideRoute = (agent, p) => {
    const assignedSupervisorId = assignmentCache.get(agent && agent.id)?.primaryMentorId
    const supervisorRoute = assignedSupervisorId && p && p.supervisorModels
      ? normalizeModelRoute(p.supervisorModels[assignedSupervisorId])
      : ''
    return routeFromString(supervisorRoute)
  }
  const getRoute = (agent, p) => {
    const legacyRoute = routeFromString(p && p.mentorModel)
    if (legacyRoute) return legacyRoute
    try {
      const def = ctx.get('agentDefaultModel')
      const sel = def && typeof def.currentSelection === 'function' ? def.currentSelection() : undefined
      if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
    } catch { /* ignore */ }
    const opt = (agent && agent.options) || {}
    if (opt.provider && opt.model) return { provider: opt.provider, model: opt.model }
    return {}
  }
  const messageOf = (sid, text) => ({
    id: 'supv-' + sid + '-' + (++state.seq),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-supervisor' },
  })
  const injectText = (sid, text) => {
    const p = perOf(sid)
    const agent = findById(sid)
    if (!agent) return false
    p.used += 1
    p.lastInjectAt = Date.now()
    p.suggestion = ''
    p.suggestionAt = 0
    p.suggestError = ''
    try {
      agent.followup(messageOf(sid, text + NEXT_STEP_TAIL))
      log(ctx, 'inject(' + p.strategy + ') round ' + p.used + '/' + p.rounds + ' -> ' + sid + ': ' + text.slice(0, 60))
      return true
    } catch (cause) {
      logError(ctx, 'inject failed', cause)
      p.used -= 1
      return false
    }
  }
  const handoffService = createHandoffService({
    store: mentorStore,
    factsFor: sessionFacts,
    assignmentFor: ensureAssignment,
    onRecord(record) { handoffCache.set(record.id, record) },
  })
  const injectDraftRequest = async (sid, text) => {
    const agent = findById(sid)
    if (!agent) throw new Error('source session is not active')
    agent.followup(messageOf(sid, text))
  }
  const streamOne = async (llm, sid, route, system, messages, maxTokens) => {
    let text = ''
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages,
      system, maxTokens, sessionId: sid,
    })) {
      if (chunk && chunk.type === 'text-delta') text += chunk.text
    }
    return text.trim()
  }
  const suggestFor = async (agent, forceModel, withTailInjection) => {
    const sid = agent && agent.id
    if (!sid) return
    const p = perOf(sid)
    if (p.suggesting) return
    // 连续失败退避：失败（含无对话内容）后 lastSuggestAt 前移并按 failCount
    // 翻倍间隔，避免每次 watchdog 空转重试造成无谓 LLM/日志噪音。
    const FAIL_BASE_MS = 15000
    if (p.failCount > 0 && Date.now() - p.lastSuggestAt < FAIL_BASE_MS * Math.min(p.failCount, 4)) return
    p.suggesting = true
    try {
      const surfText = await recentSurfaceText(sid)
      if (!surfText) {
        // 新会话/未落盘草稿没有 surface 是正常态：不向 UI 暴露错误文案，
        // 仅内部 debug 日志；failCount 退避照旧，等持久化 surface 出现后自愈。
        log(ctx, 'suggest skipped (no surface) ' + sid)
        p.suggestError = ''
        p.failCount = (p.failCount || 0) + 1
        p.lastSuggestAt = Date.now()
        p.suggesting = false
        return
      }
      const llm = ctx.get('llm')
      const assignedMentor = mentorById(mentors, assignmentCache.get(sid)?.primaryMentorId)
      const assignedRoute = assignedMentor && assignedMentor.route ? routeOf(assignedMentor) : null
      const route = forceModel
        || supervisorOverrideRoute(agent, p)
        || (assignedRoute?.provider && assignedRoute?.model ? assignedRoute : getRoute(agent, p))
      if (!route.provider || !route.model) { p.suggestError = '未配置模型路由'; p.failCount = (p.failCount || 0) + 1; p.lastSuggestAt = Date.now(); return }
      p.failCount = 0
      const todos = readTodos(sid)
      let planBlock = ''
      if (p.strategy !== 'insight' && Array.isArray(todos) && todos.length > 0) {
        planBlock = '当前计划清单（来自会话 todo）：\n' + todos.slice(0, 30).map((t) => '- [' + t.status + '] ' + t.content).join('\n') + '\n\n'
      }
      const baseMessages = [messageOf(sid, '以下是本会话最近对话内容：\n\n' + planBlock + surfText)]
      const mentorIdentity = assignedMentor
        ? '你是“' + assignedMentor.name + '”' + assignedMentor.roleLabel + '，责任范围：' + assignedMentor.responsibilities.description + '。'
        : '你是对话 Supervisor。'
      const baseSystem = mentorIdentity + (p.strategy === 'insight'
        ? '基于你对本对话的理解（不要依赖外部清单），给出简洁、具体、可执行的下一步建议，不超过80字，只用一句中文，不要解释。'
        : '优先围绕计划清单中「未开始/进行中」的条目，给出简洁、具体、可执行的下一步建议，不超过80字，只用一句中文，不要解释。')

      // ── 多导师学院：并行调用各学院（不同 harness/模型 + 领域提示词）──
      if (faculties.length > 0) {
        const facultyResults = await Promise.all(faculties.map(async (faculty) => {
          try {
            const froute = routeOf(faculty)
            if (!froute.provider || !froute.model) return { id: faculty.id, name: faculty.name, ok: false, error: '路由无效' }
            const system = '你是「' + faculty.name + '」学院的监管导师。你关注的领域：' + faculty.prompt + '。\n' + '请从这个领域视角，给出简洁、具体、可执行的下一步建议，不超过80字，只用一句中文，不要解释。'
            const text = await streamOne(llm, sid, froute, system, baseMessages, 200)
            if (!text) return { id: faculty.id, name: faculty.name, ok: false, error: '空响应' }
            return { id: faculty.id, name: faculty.name, ok: true, text }
          } catch (cause) {
            return { id: faculty.id, name: faculty.name, ok: false, error: String((cause && cause.message) || cause) }
          }
        }))
        p.facultySuggestions = {}
        let roundtableInput = '以下是多个导师学院对本会话下一步的独立意见：\n'
        for (const r of facultyResults) {
          p.facultySuggestions[r.id] = { name: r.name, ok: r.ok, text: r.ok ? r.text : '', error: r.ok ? '' : r.error, at: Date.now() }
          roundtableInput += '【' + r.name + '】' + (r.ok ? r.text : '（生成失败：' + r.error + '）') + '\n'
        }
        // ── 裁决式综合：主会议 LLM 汇总裁决 ──
        if (facultyResults.some((r) => r.ok)) {
          const judgeSystem = '你是导师圆桌主席。下面是多个学院导师的意见，请综合它们，产出：1) 一句结论性最优下一步（不超过60字，只用一句中文）；2) 若学院间存在分歧，用「分歧：」开头一句说明；3) 若一致，写「一致」。不要解释过渡。'
          const judgeMsg = messageOf(sid, roundtableInput + '\n请裁决：')
          const judgement = await streamOne(llm, sid, route, judgeSystem, [judgeMsg], 300)
          p.suggestion = judgement
          p.suggestionAt = Date.now()
          p.roundtableAt = Date.now()
          p.suggestError = ''
          log(ctx, 'roundtable -> ' + sid + ': ' + judgement.slice(0, 80))
        } else {
          p.suggestion = ''
          p.suggestError = '所有学院建议生成失败'
        }
      } else {
        // ── 单导师模式（原逻辑）──
        const text = await streamOne(llm, sid, route, baseSystem, baseMessages, 200)
        if (!text) { p.suggestError = '建议生成失败（空响应）'; return }
        p.suggestion = text
        p.suggestionAt = Date.now()
        p.lastSuggestAt = Date.now()
        p.suggestError = ''
        log(ctx, 'suggestion -> ' + sid + ': ' + text.slice(0, 80))
      }
      // 只注入非空建议：空建议（空响应/裁决失败残留）注入纯 NEXT_STEP_TAIL
      // 会变成「用户消息」混入对话，表现为用户收到无内容的「请陈述下一步」。
      if (withTailInjection && p.used < p.rounds && p.mode === 'takeover' &&
          typeof p.suggestion === 'string' && p.suggestion.trim().length > 0) {
        injectText(sid, p.suggestion)
      }
    } catch (cause) {
      p.suggestError = String((cause && cause.message) || cause)
      p.failCount = (p.failCount || 0) + 1
      p.lastSuggestAt = Date.now()
      logError(ctx, 'suggest failed', cause)
    } finally {
      p.suggesting = false
    }
  }
  const maybeInjectFixed = async (agent) => {
    const sid = agent && agent.id
    if (!sid) return
    injectText(sid, fixedPrompts[Math.floor(Math.random() * fixedPrompts.length)])
  }
  const maybeInject = async (agent) => {
    const sid = agent && agent.id
    if (!sid) return
    if (!isRoot(agent)) return
    if (!agent || agent.status !== 'idle') return
    if (hasPending(agent)) return
    const p = perOf(sid)
    if (p.mode !== 'takeover' || p.done || p.used >= p.rounds) return
    const now = Date.now()
    if (now - p.lastInjectAt < p.intervalMs) return
    const plan = planSummary(sid)
    if (plan && plan.completed >= plan.total) {
      p.done = true
      log(ctx, 'done (plan complete) ' + sid)
      return
    }
    const goals = ctx.get('goals')
    if (goals) {
      try {
        const g = goals.get(agent)
        if (g && g.phase === 'active') { log(ctx, 'skip (active goal) ' + sid); return }
      } catch { /* ignore */ }
    }
    if (p.strategy === 'fixed') maybeInjectFixed(agent)
    else suggestFor(agent, undefined, true)
  }
  const schedule = (agent, delay) => { ctx.timeout(() => { maybeInject(agent) }, delay === undefined ? 80 : delay) }
  const scheduleIfIdle = (agent, delay) => {
    if (!agent) return
    if (agent.status === 'idle' && !hasPending(agent)) schedule(agent, delay)
  }
  const watchdog = () => {
    for (const agent of listRoots()) {
      const now = Date.now()
      if (agent && agent.status === 'idle' && !hasPending(agent)) {
        const p = state.per.get(agent.id)
        if (!p || p.done || p.used >= p.rounds) continue
        if (p.mode === 'takeover') {
          const plan = planSummary(agent.id)
          if (plan && plan.completed >= plan.total) { p.done = true; log(ctx, 'done (plan complete) ' + agent.id); continue }
          if (p.strategy === 'fixed') {
            if (now - p.lastInjectAt >= p.intervalMs) ctx.timeout(() => { maybeInjectFixed(agent) }, 50)
          } else if (!p.suggesting && (!p.suggestion || now - p.suggestionAt >= p.intervalMs) && now - p.lastSuggestAt >= p.intervalMs) {
            ctx.timeout(() => { suggestFor(agent, undefined, true) }, 60)
          }
        } else if (p.mode === 'advice') {
          if (!p.suggesting && (!p.suggestion || now - p.suggestionAt >= p.intervalMs) && now - p.lastSuggestAt >= p.intervalMs) {
            ctx.timeout(() => { suggestFor(agent, undefined, false) }, 60)
          }
        }
      }
    }
  }
  try { ctx.interval(watchdog, 2500) } catch (cause) { logError(ctx, 'watchdog start failed', cause) }
  ctx.on('agent/status', (payload) => {
    if (!payload) return
    if (payload.status === 'idle') scheduleIfIdle(payload.agent)
  })
  ctx.on('session/event', (session, event) => {
    const sid = session && session.id
    if (!sid || !event) return
    if (event.type === 'compaction/summary') {
      const seq = Number.isInteger(event.seq) ? event.seq : undefined
      void mentorStore.recordCompaction(sid, Number.isFinite(event.time) ? event.time : Date.now(), seq).then((health) => {
        healthCache.set(sid, health)
        if (health.successfulCompactions >= handoffRecommendCompactions) {
          return ensureAssignment(sid).then((assignment) => handoffService.recommend(
            sid,
            assignment?.primaryMentorId || '',
            health,
          ))
        }
        return null
      }).catch((cause) => {
        logError(ctx, 'compaction health persist failed', cause)
      })
      return
    }
    if (event.type === 'assistant/chunk') {
      const active = latestHandoffFor(sid)
      const chunk = event.data && event.data.chunk
      if (active && active.status === 'drafting' && chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        const current = handoffDraftBuffers.get(active.id) || ''
        handoffDraftBuffers.set(active.id, (current + chunk.text).slice(0, 16_000))
      }
      return
    }
    if (event.type === 'turn/end') {
      const active = latestHandoffFor(sid)
      if (!active || active.status !== 'drafting') return
      const text = handoffDraftBuffers.get(active.id) || ''
      handoffDraftBuffers.delete(active.id)
      if (text.trim()) {
        void handoffService.captureDraft(sid, text, Number.isInteger(event.seq) ? event.seq : undefined).catch((cause) => {
          logError(ctx, 'handoff draft capture failed', cause)
        })
      } else {
        const reason = event.data && event.data.reason
        const error = reason && reason.error && reason.error.message
          ? reason.error.message
          : reason && reason.message ? reason.message : '会话未生成 Handoff 草稿'
        void handoffService.fail(active.id, error).catch((cause) => {
          logError(ctx, 'handoff draft failure persist failed', cause)
        })
      }
      return
    }
    if (event.type === 'assistant/message') {
      const text = messageText(event)
      if (text) {
        const active = latestHandoffFor(sid)
        if (active) handoffDraftBuffers.delete(active.id)
        void handoffService.captureDraft(sid, text, Number.isInteger(event.seq) ? event.seq : undefined).catch((cause) => {
          logError(ctx, 'handoff draft capture failed', cause)
        })
      }
      return
    }
    if (event.type !== 'user/message' || !state.per.has(sid)) return
    const src = event.data && event.data.source
    if (src && src.kind === 'user') {
      const p = state.per.get(sid)
      p.used = 0; p.done = false; p.lastInjectAt = 0; p.lastSuggestAt = 0; p.suggestion = ''; p.suggestionAt = 0; p.suggestError = ''
      log(ctx, 'reset ' + sid)
    }
  })
  ctx.on('agent/disposed', (payload) => {
    const agent = payload && payload.agent
    if (agent) { state.per.delete(agent.id); state.groups.delete(agent.id) }
  })
  const statusOf = (sid, p) => {
    if (!p || p.mode === 'off') return 'off'
    const agent = findById(sid)
    if (agent && agent.status === 'running') return 'working'
    if (p.suggesting) return 'thinking'
    if (p.suggestion) return 'suggested'
    return 'silent'
  }
  const readState = (sid) => {
    if (!sid) return { mode: defaultMode, strategy: defaultStrategy, rounds: defaultRounds, used: 0, intervalMs: defaultIntervalMs, mentorModel: '', supervisorModels: {}, suggestion: '', suggestError: '', suggesting: false, status: 'off', plan: null, planTodos: [], faculties, facultySuggestions: {}, roundtableAt: 0, ...mentorStateFor('') }
    const p = perOf(sid)
    return {
      mode: p.mode, strategy: p.strategy, rounds: p.rounds, used: p.used, intervalMs: p.intervalMs,
      mentorModel: p.mentorModel, supervisorModels: { ...p.supervisorModels }, suggestion: p.suggestion, suggestError: p.suggestError, suggesting: p.suggesting,
      status: statusOf(sid, p), plan: planSummary(sid), planTodos: planTodos(sid),
      faculties, facultySuggestions: p.facultySuggestions, roundtableAt: p.roundtableAt,
      ...mentorStateFor(sid),
    }
  }
  const setState = (sid, patch) => {
    if (!sid || typeof patch !== 'object' || patch === null) return readState(sid)
    const p = perOf(sid)
    if (patch.mode === 'off' || patch.mode === 'advice' || patch.mode === 'takeover') {
      if (patch.mode !== 'off' && p.mode === 'off') {
        p.used = 0; p.done = false; p.lastInjectAt = 0; p.lastSuggestAt = 0; p.suggestion = ''; p.suggestionAt = 0; p.suggestError = ''
      }
      p.mode = patch.mode
    }
    if (patch.strategy === 'plan' || patch.strategy === 'insight' || patch.strategy === 'fixed') p.strategy = patch.strategy
    if (typeof patch.rounds === 'number') {
      const r = Math.floor(patch.rounds)
      if (r >= 1 && r <= 10000) p.rounds = r
    }
    if (typeof patch.intervalMs === 'number') {
      const ms = Math.floor(patch.intervalMs)
      if (ms >= 2000 && ms <= 3600000) p.intervalMs = ms
    }
    if (typeof patch.mentorModel === 'string') {
      const rawLegacyRoute = patch.mentorModel.trim()
      const legacyRoute = normalizeModelRoute(rawLegacyRoute)
      if (rawLegacyRoute && !legacyRoute) throw new Error('Supervisor 模型必须使用 provider/model 格式')
      p.mentorModel = legacyRoute
    }
    if (patch.supervisorModel && typeof patch.supervisorModel === 'object') {
      const supervisorId = typeof patch.supervisorModel.supervisorId === 'string'
        ? patch.supervisorModel.supervisorId.trim().slice(0, 64)
        : ''
      if (!mentorById(mentors, supervisorId)) throw new Error('unknown supervisor: ' + supervisorId)
      const rawRoute = typeof patch.supervisorModel.route === 'string' ? patch.supervisorModel.route.trim() : ''
      const route = normalizeModelRoute(rawRoute)
      if (rawRoute && !route) throw new Error('Supervisor 模型必须使用 provider/model 格式')
      p.supervisorModels = { ...p.supervisorModels }
      if (route) p.supervisorModels[supervisorId] = route
      else delete p.supervisorModels[supervisorId]
    }
    const setting = {
      mode: p.mode, strategy: p.strategy, rounds: p.rounds, intervalMs: p.intervalMs,
      mentorModel: p.mentorModel, supervisorModels: { ...p.supervisorModels },
    }
    settingsCache.set(sid, setting)
    void mentorStore.setSetting(sid, setting).catch((cause) => logError(ctx, 'supervisor setting persist failed', cause))
    if (p.mode !== 'off') scheduleIfIdle(findById(sid), 400)
    return readState(sid)
  }
  const adopt = (sid) => {
    const p = perOf(sid)
    const text = p.suggestion && p.suggestion.trim()
    if (text && !p.done && p.used < p.rounds) injectText(sid, text)
    return readState(sid)
  }
  const regen = (sid) => {
    const p = perOf(sid)
    p.suggestion = ''; p.suggestionAt = 0; p.lastSuggestAt = 0; p.suggestError = ''
    p.facultySuggestions = {}; p.roundtableAt = 0
    const agent = findById(sid)
    if (agent) ctx.timeout(() => { suggestFor(agent, undefined, p.mode === 'takeover') }, 60)
    return readState(sid)
  }
  const groupList = (sid) => {
    const targets = state.groups.get(sid) || []
    const rows = []
    for (const t of targets) {
      const agent = findById(t)
      if (!agent) continue
      const p = perOf(t)
      rows.push({ sid: t, mode: p.mode, strategy: p.strategy, rounds: p.rounds, used: p.used, plan: planSummary(t) })
    }
    return { lead: sid, targets: rows }
  }
  const groupSave = (sid, targetIds) => {
    const valid = []
    if (Array.isArray(targetIds)) {
      for (const t of targetIds) {
        if (typeof t !== 'string' || t === sid) continue
        const agent = findById(t)
        if (agent && isRoot(agent) && valid.indexOf(t) < 0) valid.push(t)
      }
    }
    state.groups.set(sid, valid)
    log(ctx, 'group ' + sid + ' -> [' + valid.join(', ') + ']')
    return groupList(sid)
  }
  const groupRegen = (sid, forceModel) => {
    const targets = state.groups.get(sid) || []
    const leadAgent = findById(sid)
    const leadP = perOf(sid)
    const model = forceModel || getRoute(leadAgent || {}, leadP)
    for (const t of targets) {
      const agent = findById(t)
      if (agent) ctx.timeout(() => { suggestFor(agent, model, perOf(t).mode === 'takeover') }, 50)
    }
    return groupList(sid)
  }
  const strategyName = (s) => s === 'plan' ? '计划驱动' : s === 'insight' ? '理解驱动' : '固定随机'
  const modeName = (m) => m === 'takeover' ? '接管' : m === 'advice' ? '提意见' : '关闭'

  const commands = ctx.get('commands')
  if (commands !== undefined) {
    ctx.effect(() => commands.register({
      name: 'supervise',
      description: 'Supervisor 三态：关闭/提意见/接管；策略：计划驱动/理解驱动/固定随机',
      input: { hint: 'mode [off|advice|takeover] | on [N] | off | strategy [plan|insight|fixed] | interval [秒] | mentor-model <provider/model> | status' },
      handler: async ({ agent, rawInput }) => {
        if (agent === undefined) return { kind: 'error', text: '/supervise 需要一个会话。' }
        if (!isRoot(agent)) return { kind: 'error', text: '仅顶层会话可用。' }
        const sid = agent.id
        // The floating panel polls through this command channel. Resolve the
        // role before returning state so a brand-new session can choose its
        // Supervisor model without first sending a prompt or enabling mode.
        await ensureAssignment(sid)
        const p = perOf(sid)
        const args = String(rawInput || '').trim()
        if (args === 'mode off' || args === 'mode advice' || args === 'mode takeover') {
          return { kind: 'success', text: JSON.stringify(setState(sid, { mode: args.slice(5) })) }
        }
        if (args === 'on' || args.startsWith('on ')) {
          const n = parseInt(args.slice(2).trim(), 10)
          if (!Number.isFinite(n) || n < 1 || n > 10000) return { kind: 'error', text: '请输入有效轮数：/supervise on [N]' }
          return { kind: 'success', text: JSON.stringify(setState(sid, { mode: 'takeover', rounds: n })) }
        }
        if (args === 'off') {
          setState(sid, { mode: 'off' })
          return { kind: 'success', text: '已关闭（Supervisor 静默）。' }
        }
        if (args === 'strategy plan' || args === 'strategy insight' || args === 'strategy fixed') {
          const strategy = args === 'strategy plan' ? 'plan' : args === 'strategy insight' ? 'insight' : 'fixed'
          setState(sid, { strategy })
          return { kind: 'success', text: '策略已设为：' + strategyName(strategy) + '。' }
        }
        if (args.startsWith('interval ')) {
          const s = parseInt(args.slice(9).trim(), 10)
          if (!Number.isFinite(s) || s < 2 || s > 3600) return { kind: 'error', text: '请输入有效间隔秒数（2-3600）：/supervise interval [秒]' }
          setState(sid, { intervalMs: s * 1000 })
          return { kind: 'success', text: '间隔已设为 ' + s + ' 秒。' }
        }
        if (args.startsWith('mentor-model ')) {
          try { setState(sid, { mentorModel: args.slice(13).trim() }) }
          catch (cause) { return { kind: 'error', text: String(cause && cause.message ? cause.message : cause) } }
          return { kind: 'success', text: p.mentorModel ? 'Supervisor 模型已设为 ' + p.mentorModel + '。' : 'Supervisor 模型已恢复为会话默认。' }
        }
        if (args.startsWith('handoff ')) {
          // 会话交接：把源会话的地址 + 最新摘要注入当前会话（导师转交）。
          const rest = args.slice(8).trim()
          const srcId = rest.split(/\s+/)[0] || ''
          const note = rest.slice(srcId.length).trim()
          if (!srcId || srcId === sid) return { kind: 'error', text: '用法：/supervise handoff <源会话id> [交接说明]' }
          const srcAgent = findById(srcId)
          if (!srcAgent) return { kind: 'error', text: '找不到源会话：' + srcId }
          // fire-and-forget：读取源会话摘要后注入当前会话
          void (async () => {
            try {
              const surf = await recentSurfaceText(srcId)
              const summary = (surf || '').split('\n').slice(-3).join('\n').slice(0, 600)
              const body = '【导师转交】源会话 ' + srcId + '（' + (srcAgent.title || srcAgent.displayTitle || '未命名') + '）\n'
                + (note ? '交接说明：' + note + '\n' : '')
                + (summary ? '最新进展摘要：\n' + summary : '（源会话暂无内容）')
              const ok = injectText(sid, body)
              if (!ok) logError(ctx, 'handoff inject failed', new Error('injectText returned false'))
            } catch (cause) {
              logError(ctx, 'handoff failed', cause)
            }
          })()
          return { kind: 'success', text: '已向当前会话注入源会话 ' + srcId + ' 的转交摘要。' }
        }
        if (args === 'status') {
          return { kind: 'success', text: 'Supervisor：' + modeName(p.mode) + '；状态 ' + statusOf(sid, p) + '；策略 ' + strategyName(p.strategy) + '；上限 ' + p.rounds + ' 次；已用 ' + p.used + ' 次；间隔 ' + Math.round(p.intervalMs / 1000) + ' 秒。' }
        }
        if (args === '_state') return { kind: 'success', text: JSON.stringify(readState(sid)) }
        if (args === 'faculties') {
          if (faculties.length === 0) return { kind: 'success', text: '当前未配置多 Supervisor 角色（单 Supervisor 模式）。' }
          return { kind: 'success', text: 'Supervisor 角色：\n' + faculties.map((f) => '- ' + f.name + '（' + f.route + '）：' + f.prompt.slice(0, 40) + '…').join('\n') }
        }
        if (args.startsWith('_set ')) {
          let patch
          try { patch = JSON.parse(args.slice(5).trim()) } catch { return { kind: 'error', text: '_set 参数必须是 JSON' } }
          return { kind: 'success', text: JSON.stringify(setState(sid, patch)) }
        }
        if (args === '_adopt') return { kind: 'success', text: JSON.stringify(adopt(sid)) }
        if (args === '_regen') return { kind: 'success', text: JSON.stringify(regen(sid)) }
        if (args === '_group list') return { kind: 'success', text: JSON.stringify(groupList(sid)) }
        if (args.startsWith('_group set ')) {
          let targets
          try { targets = JSON.parse(args.slice(11).trim()) } catch { return { kind: 'error', text: '_group set 参数必须是 JSON 数组' } }
          return { kind: 'success', text: JSON.stringify(groupSave(sid, targets)) }
        }
        if (args.startsWith('_group regen')) {
          let model
          const rest = args.slice(12).trim()
          if (rest.length > 0) {
            try {
              const parsed = JSON.parse(rest)
              if (typeof parsed === 'object' && parsed !== null && typeof parsed.model === 'string' && parsed.model.indexOf('/') > 0) {
                const idx = parsed.model.indexOf('/')
                model = { provider: parsed.model.slice(0, idx).trim(), model: parsed.model.slice(idx + 1).trim() }
              }
            } catch { /* ignore */ }
          }
          return { kind: 'success', text: JSON.stringify(groupRegen(sid, model)) }
        }
        return { kind: 'error', text: '用法：/supervise mode [off|advice|takeover] | on [N] | off | strategy [plan|insight|fixed] | interval [秒] | mentor-model <provider/model> | handoff <源会话id> [说明] | faculties | status' }
      },
    }), 'dsh-supervisor: command')
  }
  // ── 矩阵批量接口（v0.6）────────────────────────────────────────────
  // 会话矩阵轮询一揽子状态：/dsh-supervisor/states?ids=a,b,c（≤200）。
  // 写路径 /state（单个 patch）、/adopt、/regen 与 /supervise _set 等价，
  // 但不要求会话打开过（readState/setState 对任一 sid 都成立）。
  const compact = (s) => ({
    mode: s.mode, strategy: s.strategy, rounds: s.rounds, used: s.used,
    intervalMs: s.intervalMs, mentorModel: s.mentorModel, supervisorModels: s.supervisorModels,
    suggestion: s.suggestion, suggestError: s.suggestError, suggesting: s.suggesting,
    status: s.status, plan: s.plan, faculties: s.faculties,
    facultySuggestions: s.facultySuggestions, roundtableAt: s.roundtableAt,
    mentor: s.mentor, collaborators: s.collaborators, assignment: s.assignment, health: s.health, handoff: s.handoff,
  })
  // The session board asks for up to 50 rows every poll.  Do not call
  // readState() here: it materializes an otherwise-unused per-session state and
  // folds the complete todo projection for every row.  On workspaces with long
  // transcripts that made one lightweight badge request monopolize the host
  // event loop and left the supervisor controls appearing unclickable.
  const compactState = (sid) => {
    const p = state.per.get(sid) || perOf(sid)
    return {
      mode: p.mode, strategy: p.strategy, rounds: p.rounds, used: p.used,
      intervalMs: p.intervalMs, mentorModel: p.mentorModel, supervisorModels: { ...p.supervisorModels },
      suggestion: p.suggestion, suggestError: p.suggestError,
      suggesting: p.suggesting, status: statusOf(sid, p), plan: null,
      faculties, facultySuggestions: p.facultySuggestions,
      roundtableAt: p.roundtableAt,
      ...mentorStateFor(sid),
    }
  }
  const parseIds = (raw) => {
    if (!Array.isArray(raw)) return []
    const list = []
    const seen = new Set()
    for (const v of raw) {
      if (typeof v !== 'string') continue
      const id = v.trim().slice(0, MAX_ID_LENGTH)
      if (!id || seen.has(id)) continue
      seen.add(id)
      list.push(id)
      if (list.length >= MAX_MATRIX_IDS) break
    }
    return list
  }
  // webServer 可能晚于本 apply 出现；用 inject 等待而不是快照 ctx.get。
  try {
    ctx.inject(['webServer'], (webCtx) => {
      const server = webCtx.get('webServer')
      const registerRoute = (path, handler) => {
        try {
          webCtx.effect(() => server.register({ kind: 'exact', path, handler }), 'dsh-supervisor: route ' + path)
        } catch (cause) { logError(ctx, 'route ' + path + ' failed', cause) }
      }
      registerRoute(SUPV_STATES_PATH, async (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          const ids = parseIds((url.searchParams.get('ids') || '').split(','))
          await ensureAssignments(ids)
          const states = {}
          for (const sid of ids) states[sid] = compactState(sid)
          writeJson(res, 200, { states })
        } catch (cause) {
          writeJson(res, 500, { error: String((cause && cause.message) || cause) })
        }
      })
      registerRoute(SUPV_MENTORS_PATH, async (req, res) => {
        if (req.method !== 'GET') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        await storeReady
        writeJson(res, 200, { mentors: mentors.map(publicMentor) })
      })
      registerRoute(SUPV_ASSIGNMENT_PATH, async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        try {
          const body = await readJson(req)
          const sid = typeof body.sessionId === 'string' ? body.sessionId.trim().slice(0, MAX_ID_LENGTH) : ''
          const mentorId = typeof body.mentorId === 'string' ? body.mentorId.trim().slice(0, 64) : ''
          if (!sid || !mentorId) {
            writeJson(res, 400, { error: 'sessionId and mentorId are required' })
            return
          }
          await setAssignment(sid, mentorId, body.collaboratorIds)
          writeJson(res, 200, { state: compactState(sid) })
        } catch (cause) {
          writeJson(res, 400, { error: String((cause && cause.message) || cause) })
        }
      })
      registerRoute(SUPV_HANDOFF_PATH, async (req, res) => {
        if (req.method === 'GET') {
          try {
            await storeReady
            const url = new URL(req.url || '/', 'http://localhost')
            const handoffId = (url.searchParams.get('handoffId') || '').trim().slice(0, 128)
            const sid = (url.searchParams.get('sessionId') || '').trim().slice(0, MAX_ID_LENGTH)
            const record = handoffId
              ? handoffCache.get(handoffId) || null
              : sid ? latestHandoffFor(sid) : null
            writeJson(res, 200, { handoff: publicHandoff(record, true) })
          } catch (cause) {
            writeJson(res, 500, { error: String((cause && cause.message) || cause) })
          }
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        try {
          const body = await readJson(req)
          const action = typeof body.action === 'string' ? body.action.trim() : ''
          const sid = typeof body.sessionId === 'string' ? body.sessionId.trim().slice(0, MAX_ID_LENGTH) : ''
          const handoffId = typeof body.handoffId === 'string' ? body.handoffId.trim().slice(0, 128) : ''
          let record
          if (action === 'prepare') {
            if (!sid) throw new Error('sessionId is required')
            const assignment = await ensureAssignment(sid)
            const receiver = typeof body.receiverMentorId === 'string' && body.receiverMentorId.trim()
              ? body.receiverMentorId.trim().slice(0, 64)
              : assignment?.primaryMentorId || ''
            if (receiver && !mentorById(mentors, receiver)) throw new Error('unknown receiver mentor: ' + receiver)
            record = await handoffService.recommend(sid, receiver, healthCache.get(sid), body.sourceFacts)
          } else if (action === 'request-draft') {
            if (!handoffId) throw new Error('handoffId is required')
            record = await handoffService.requestDraft(
              handoffId,
              body.externalDispatch === true ? undefined : injectDraftRequest,
            )
          } else if (action === 'begin-create') {
            if (!handoffId) throw new Error('handoffId is required')
            record = await handoffService.beginCreate(handoffId)
          } else if (action === 'submit-draft') {
            if (!handoffId) throw new Error('handoffId is required')
            if (typeof body.briefText !== 'string') throw new Error('briefText is required')
            record = await handoffService.submitDraft(handoffId, body.briefText, body.sourceFacts)
          } else if (action === 'begin-delivery') {
            if (!handoffId) throw new Error('handoffId is required')
            record = await handoffService.beginDelivery(handoffId)
          } else if (action === 'complete') {
            if (!handoffId) throw new Error('handoffId is required')
            const current = handoffCache.get(handoffId) || await mentorStore.getHandoff(handoffId)
            if (!current) throw new Error('handoff not found')
            const targetExists = !!findById(current.targetSessionId) || !!ctx.get('sessions')?.get(current.targetSessionId)
            if (!targetExists) throw new Error('target session does not exist')
            if (current.receiverMentorId) await setAssignment(current.targetSessionId, current.receiverMentorId, [])
            record = await handoffService.complete(handoffId, current.targetSessionId)
          } else if (action === 'fail') {
            if (!handoffId) throw new Error('handoffId is required')
            record = await handoffService.fail(handoffId, typeof body.error === 'string' ? body.error : 'handoff failed')
          } else {
            throw new Error('unknown handoff action')
          }
          writeJson(res, 200, { handoff: publicHandoff(record, true) })
        } catch (cause) {
          writeJson(res, 400, { error: String((cause && cause.message) || cause) })
        }
      })
      registerRoute(SUPV_STATE_PATH, async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        try {
          const body = await readJson(req)
          const sid = typeof body.sessionId === 'string' ? body.sessionId.trim().slice(0, MAX_ID_LENGTH) : ''
          if (!sid) {
            writeJson(res, 400, { error: 'sessionId is required' })
            return
          }
          await ensureAssignment(sid)
          const patch = body.patch && typeof body.patch === 'object' ? body.patch : {}
          writeJson(res, 200, { state: compact(setState(sid, patch)) })
        } catch (cause) {
          writeJson(res, 400, { error: String((cause && cause.message) || cause) })
        }
      })
      registerRoute(SUPV_ADOPT_PATH, async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        try {
          const body = await readJson(req)
          const sid = typeof body.sessionId === 'string' ? body.sessionId.trim().slice(0, MAX_ID_LENGTH) : ''
          if (!sid) {
            writeJson(res, 400, { error: 'sessionId is required' })
            return
          }
          writeJson(res, 200, { state: compact(adopt(sid)) })
        } catch (cause) {
          writeJson(res, 400, { error: String((cause && cause.message) || cause) })
        }
      })
      registerRoute(SUPV_REGEN_PATH, async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }
        try {
          const body = await readJson(req)
          const sid = typeof body.sessionId === 'string' ? body.sessionId.trim().slice(0, MAX_ID_LENGTH) : ''
          if (!sid) {
            writeJson(res, 400, { error: 'sessionId is required' })
            return
          }
          writeJson(res, 200, { state: compact(regen(sid)) })
        } catch (cause) {
          writeJson(res, 400, { error: String((cause && cause.message) || cause) })
        }
      })
      log(ctx, 'matrix routes registered')
    })
  } catch (cause) {
    logError(ctx, 'matrix route wiring failed', cause)
  }

  log(ctx, 'started package ' + PACKAGE_VERSION + ' (mode=' + defaultMode + ', strategy=' + defaultStrategy + ', rounds=' + defaultRounds + ', mentors=' + mentors.length + ')')
}
