import { createHash } from 'node:crypto'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function observeGoal(ctx, agent) {
  const goals = ctx.get('goals')
  if (!goals) return { available: false, owned: false, phase: 'absent' }
  try {
    const goal = goals.get(agent)
    if (!goal) return { available: true, owned: false, phase: 'absent' }
    return { available: true, owned: true, id: goal.id, revision: goal.revision, phase: ['active', 'paused', 'blocked', 'complete'].includes(goal.phase) ? goal.phase : 'unknown', activation: goal.activation }
  } catch { return { available: true, owned: true, phase: 'unknown' } }
}

// Hashes corroborate an assessment; a successful read/tool call alone is not
// proof that the user's task advanced. Raw tool output is never persisted here.
export function recordToolEvidence(previous, event) {
  const p = previous || { round: 0, lastSeq: -1, seen: [], pending: [] }
  const blocks = event.data?.message?.content
  if (event.data?.error || !blocks?.length || blocks.some(b => b.isError === true)) return p
  const hash = digest(blocks.map(b => b.type === 'tool-result' ? b.content : b))
  if ((p.seen || []).includes(hash) || (p.pending || []).includes(hash)) return p
  return { ...p, pending: [...(p.pending || []), hash].slice(-32) }
}

export function assessProgress(previous, { seq, reason, todos = [], goal = {}, threshold = 3 }) {
  const p = previous || { round: 0, lastSeq: -1, seen: [], pending: [] }
  if (!Number.isSafeInteger(seq) || seq <= p.lastSeq) return p
  const items = todos.slice(0, 2000).map(t => [String(t.content || ''), t.status])
  const completed = items.filter(t => t[1] === 'completed').length
  const taskDigest = digest(items.map(t => t[0]))
  const sameTask = p.taskDigest === taskDigest && p.goalId === goal.id && p.goalRevision === goal.revision
  const kind = reason?.kind || reason?.type || (typeof reason === 'string' ? reason : 'unknown')
  let state = 'unknown', signal = 'insufficient-evidence'
  if (kind === 'error') { state = 'regressed'; signal = 'turn-error' }
  else if (kind === 'completed' && sameTask && items.length) {
    state = completed > p.completed ? 'advanced' : completed < p.completed ? 'regressed' : 'unchanged'
    signal = state === 'advanced' ? 'todo-completed' : state === 'regressed' ? 'todo-reopened' : 'todo-unchanged'
    if (completed === items.length && state === 'unchanged') { state = 'unknown'; signal = 'todos-complete' }
  } else if (kind !== 'completed') signal = ['aborted', 'blocked', 'max-tokens', 'interrupted'].includes(kind) ? kind : 'unknown-end'
  const stuck = state === 'unchanged' || state === 'regressed'
  const streak = stuck ? (sameTask && signal === p.signal ? (p.streak || 0) + 1 : 1) : 0
  const evidence = p.pending || []
  return { round: (p.round || 0) + 1, lastSeq: seq, taskDigest, goalId: goal.id, goalRevision: goal.revision, completed, total: items.length, state, signal, streak, stalled: streak >= threshold, evidence, seen: [...(p.seen || []), ...evidence].slice(-128), pending: [] }
}

export function publicProgress(p) {
  if (!p?.state) return { round: 0, state: 'unknown', signal: 'insufficient-evidence', streak: 0, stalled: false, completed: 0, total: 0, evidence: [] }
  return Object.fromEntries(['round', 'lastSeq', 'state', 'signal', 'streak', 'stalled', 'completed', 'total', 'evidence', 'source'].map(k => [k, p[k]]))
}
