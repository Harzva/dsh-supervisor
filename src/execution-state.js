import { randomUUID } from 'node:crypto'

const fields = ['runId', 'used', 'done', 'lastInjectAt', 'lastSuggestAt', 'failCount', 'suggestion', 'suggestionId', 'suggestionRole', 'suggestionAt', 'suggestError', 'suggesting', 'facultySuggestions', 'roundtableAt', 'memoryContext', 'memoryText', 'planEmptyWarned', 'planWarnAt', 'lastUserMessageId', 'lastUserSeq', 'recoveryRequired', 'lastDeliveryId', 'progress', 'council', 'nativeTodos', 'nativeTodoSeq']
export function executionSnapshot(p) {
  return Object.fromEntries(fields.filter(key => p[key] !== undefined).map(key => [key, structuredClone(p[key])]))
}
export function restoreExecution(p, record) {
  if (!record) return p
  Object.assign(p, executionSnapshot(record.state || {}))
  if (p.council) {
    p.council.autoEnabled = false
    p.council.grantRunId = ''
    if (!Number.isSafeInteger(p.council.callsReserved) || p.council.callsReserved < 0 || p.council.callsReserved > 12 || !Number.isSafeInteger(p.council.discussionsUsed) || p.council.discussionsUsed < 0 || p.council.discussionsUsed > 2) {
      p.council.callsReserved = 12; p.council.discussionsUsed = 2
      p.council.status = 'budget-corrupt'
      p.recoveryRequired = '会诊额度状态损坏，已暂停推进'
    }
    if (p.council.status === 'running') p.council.status = 'interrupted'
  }
  const corrupt = !Number.isSafeInteger(p.used) || p.used < 0
  if (corrupt) { p.used = Number.MAX_SAFE_INTEGER; p.recoveryRequired = '执行额度状态损坏，已暂停推进' }
  p.done = p.done === true
  if (p.suggesting) {
    p.suggesting = false
    p.suggestError = '上次生成因重启中断，可重新生成建议'
  }
  const unresolved = Object.values(record.deliveries || {}).find(d => d.runId === p.runId && ['dispatching', 'queued', 'uncertain'].includes(d.status))
  if (unresolved) {
    p.recoveryRequired = '上次采纳的接收状态待核对，已暂停自动推进，避免重复执行'
    p.lastDeliveryId = unresolved.id
  }
  p.runId ||= randomUUID()
  return p
}
export function newExecution(p, userMessageId = '') {
  if (userMessageId && p.lastUserMessageId === userMessageId) return false
  Object.assign(p, { runId: randomUUID(), used: 0, done: false, lastInjectAt: 0, lastSuggestAt: 0, suggestion: '', suggestionId: '', suggestionRole: null, suggestionAt: 0, suggestError: '', failCount: 0, recoveryRequired: '', planEmptyWarned: false, planWarnAt: 0, lastUserMessageId: userMessageId, memoryText: '', memoryContext: null, projectMemory: { status: 'idle', memory_ids: [] }, facultySuggestions: {}, roundtableAt: 0 })
  p.nativeTodos = undefined
  p.nativeTodoSeq = undefined
  p.progress = undefined
  p.council = undefined
  return true
}
export function findReceipt(events, messageId) {
  if (!Array.isArray(events) || typeof messageId !== 'string' || !messageId) return undefined
  return events.find(event => {
    if (event?.type !== 'user/message') return false
    const message = event.data?.message || event.data
    if (message?.id !== messageId) return false
    const source = message.source
    return source?.kind === 'plugin:dsh-supervisor'
      || (source?.kind === 'plugin' && source.plugin === 'dsh-supervisor')
  })
}
