// Canonical legacy Handoff source recovered from the 0.2.4 runtime.
import { randomUUID } from 'node:crypto'

const ACTIVE_STATUSES = new Set([
  'recommended', 'requesting_draft', 'drafting', 'ready',
  'creating_successor', 'delivering', 'failed_retryable',
])

const SECRET_PATTERNS = [
  /\bsk-[a-z0-9_-]{12,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[a-z0-9._~+/-]{16,}/i,
  /(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*\S{8,}/i,
]

function clean(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function validateHandoffBrief(value) {
  const text = clean(value, 16_000)
  if (text.length < 80) return { ok: false, error: 'handoff 内容过短' }
  if (/\[(?:user|assistant|tool)\]/i.test(text)) return { ok: false, error: 'handoff 不得包含原始聊天日志' }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) return { ok: false, error: 'handoff 疑似包含凭据或令牌' }
  const expected = ['目标', '已完成', '当前状态', '未完成', '验收']
  const covered = expected.filter((label) => text.includes(label)).length
  if (covered < 3) return { ok: false, error: 'handoff 缺少必要结构（目标/已完成/当前状态/未完成/验收）' }
  return { ok: true, text }
}

export function handoffDraftRequest(handoffId) {
  return [
    '【导师 Handoff 请求 ' + handoffId + '】',
    '请暂停继续执行，为接收会话编写结构化交接说明。只输出以下内容，不要附带原始聊天记录或任何凭据：',
    '1. 目标与成功标准',
    '2. 已完成事项与证据',
    '3. 当前状态与关键决策',
    '4. 关键文件或产物（只写完成任务所需的路径）',
    '5. 未完成事项、阻塞与风险',
    '6. 下一步与验收方法',
  ].join('\n')
}

export function renderHandoffPrompt(record) {
  return [
    '【导师交接 · ' + record.id + '】',
    '这是来自会话 ' + record.sourceSessionId + ' 的结构化 Handoff。',
    '先核对交接内容和当前工作区状态，然后从“未完成事项”继续；不要重复已完成工作。',
    '',
    record.briefText,
  ].join('\n')
}

export function createHandoffService(options) {
  const { store, factsFor, assignmentFor, onRecord } = options
  const now = typeof options.now === 'function' ? options.now : Date.now
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : () => randomUUID()

  const save = async (record) => {
    const saved = await store.putHandoff(record)
    if (typeof onRecord === 'function') onRecord(saved)
    return saved
  }

  const activeFor = async (sessionId) => {
    const snapshot = await store.snapshot()
    return Object.values(snapshot.handoffs)
      .filter((record) => record.sourceSessionId === sessionId && ACTIVE_STATUSES.has(record.status))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null
  }

  const requireRecord = async (handoffId) => {
    const record = await store.getHandoff(handoffId)
    if (!record) throw new Error('handoff not found: ' + handoffId)
    return record
  }

  const mergeFacts = (record, facts) => ({
    ...record,
    cwd: clean(facts?.cwd, 2000) || record.cwd,
    workspaceId: clean(facts?.workspaceId, 128) || record.workspaceId,
    agentPreset: clean(facts?.agentPreset, 200) || record.agentPreset,
  })

  return {
    activeFor,
    async recommend(sourceSessionId, receiverMentorId, health, knownFacts) {
      const active = await activeFor(sourceSessionId)
      if (active) {
        const enriched = mergeFacts(active, knownFacts)
        return enriched.cwd !== active.cwd || enriched.workspaceId !== active.workspaceId || enriched.agentPreset !== active.agentPreset
          ? save({ ...enriched, updatedAt: now() })
          : active
      }
      const discoveredFacts = await factsFor(sourceSessionId)
      const facts = {
        cwd: clean(knownFacts?.cwd, 2000) || clean(discoveredFacts?.cwd, 2000),
        workspaceId: clean(knownFacts?.workspaceId, 128) || clean(discoveredFacts?.workspaceId, 128),
        agentPreset: clean(knownFacts?.agentPreset, 200) || clean(discoveredFacts?.agentPreset, 200),
      }
      const assignment = await assignmentFor(sourceSessionId)
      const stamp = now()
      return save({
        id: 'handoff-' + idFactory(),
        sourceSessionId,
        targetSessionId: 'session-' + idFactory(),
        sourceMentorId: assignment?.primaryMentorId || '',
        receiverMentorId: receiverMentorId || assignment?.primaryMentorId || '',
        cwd: clean(facts?.cwd, 2000),
        workspaceId: clean(facts?.workspaceId, 128),
        agentPreset: clean(facts?.agentPreset, 200),
        compactionCount: Number.isFinite(health?.successfulCompactions) ? health.successfulCompactions : 0,
        status: 'recommended',
        briefText: '',
        error: '',
        createdAt: stamp,
        updatedAt: stamp,
        version: 1,
      })
    },
    async requestDraft(handoffId, injectDraftRequest) {
      let record = await requireRecord(handoffId)
      if (record.status === 'drafting' || record.status === 'ready') return record
      if (record.status !== 'recommended' && record.status !== 'failed_retryable') {
        throw new Error('handoff cannot request draft from status ' + record.status)
      }
      record = await save({ ...record, status: 'requesting_draft', error: '', updatedAt: now() })
      try {
        if (typeof injectDraftRequest === 'function') {
          await injectDraftRequest(record.sourceSessionId, handoffDraftRequest(record.id))
        }
        return save({ ...record, status: 'drafting', draftRequestedAt: now(), updatedAt: now() })
      } catch (cause) {
        await save({ ...record, status: 'failed_retryable', error: clean(String(cause), 500), updatedAt: now() })
        throw cause
      }
    },
    async captureDraft(sourceSessionId, text, eventSeq) {
      const record = await activeFor(sourceSessionId)
      if (!record || record.status !== 'drafting') return null
      const checked = validateHandoffBrief(text)
      if (!checked.ok) {
        return save({ ...record, status: 'failed_retryable', error: checked.error, updatedAt: now() })
      }
      return save({
        ...record,
        status: 'ready',
        briefText: checked.text,
        draftEventSeq: Number.isInteger(eventSeq) ? eventSeq : null,
        error: '',
        updatedAt: now(),
      })
    },
    async submitDraft(handoffId, text, knownFacts) {
      const record = mergeFacts(await requireRecord(handoffId), knownFacts)
      if (record.status === 'ready') return record
      if (record.status !== 'drafting' && record.status !== 'failed_retryable') {
        throw new Error('handoff cannot accept draft from status ' + record.status)
      }
      const checked = validateHandoffBrief(text)
      if (!checked.ok) throw new Error(checked.error)
      return save({
        ...record,
        status: 'ready',
        briefText: checked.text,
        draftEventSeq: null,
        error: '',
        updatedAt: now(),
      })
    },
    async beginCreate(handoffId) {
      const record = await requireRecord(handoffId)
      if (record.status === 'creating_successor' || record.status === 'delivering') return record
      if (record.status !== 'ready' && record.status !== 'failed_retryable') {
        throw new Error('handoff cannot create successor from status ' + record.status)
      }
      if (!record.briefText) throw new Error('handoff brief is missing')
      return save({ ...record, status: 'creating_successor', error: '', updatedAt: now() })
    },
    async beginDelivery(handoffId) {
      const record = await requireRecord(handoffId)
      if (record.status === 'delivering') return record
      if (record.status !== 'creating_successor') throw new Error('handoff successor has not been created')
      return save({ ...record, status: 'delivering', updatedAt: now() })
    },
    async complete(handoffId, targetSessionId) {
      const record = await requireRecord(handoffId)
      if (record.status === 'completed') return record
      if (record.status !== 'delivering') throw new Error('handoff is not delivering')
      if (targetSessionId !== record.targetSessionId) throw new Error('handoff target session mismatch')
      return save({ ...record, status: 'completed', completedAt: now(), error: '', updatedAt: now() })
    },
    async fail(handoffId, error) {
      const record = await requireRecord(handoffId)
      if (record.status === 'completed') return record
      return save({ ...record, status: 'failed_retryable', error: clean(error, 500) || 'handoff failed', updatedAt: now() })
    },
  }
}
