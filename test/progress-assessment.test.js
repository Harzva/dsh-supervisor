import test from 'node:test'
import assert from 'node:assert/strict'
import { assessProgress, observeGoal, recordToolEvidence, publicProgress } from '../lib/progress-assessment.js'
import { restoreExecution, newExecution, executionSnapshot } from '../lib/execution-state.js'

test('only persistent task evidence advances progress; repeated reads do not', () => {
  const todos = [{ content: 'verify fix', status: 'pending' }]
  const step = (p, seq, options = {}) => assessProgress(p, { seq, reason: { kind: 'completed' }, todos, ...options })
  let p = step(undefined, 1)
  assert.equal(p.state, 'unknown')
  const event = { data: { message: { content: [{ type: 'tool-result', toolCallId: 'a', content: [{ type: 'text', text: 'fixture read' }] }] } } }
  p = recordToolEvidence(p, event)
  p = step(p, 2)
  assert.equal(p.state, 'unchanged')
  assert.equal(p.evidence.length, 1)
  event.data.message.content[0].toolCallId = 'b'
  assert.deepEqual(recordToolEvidence(p, event), p)
  p = step(p, 3); p = step(p, 4)
  assert.equal(p.stalled, true)
  assert.equal(step(p, 4), p, 'duplicate event cannot consume another round')
  p = step(p, 5, { todos: [{ content: 'verify fix', status: 'completed' }] })
  assert.equal(p.state, 'advanced'); assert.equal(p.stalled, false)
  assert.doesNotMatch(JSON.stringify(publicProgress(p)), /taskDigest|fixture read|seen/)
})

test('abort, changed task and absent evidence remain unknown; current reason.kind error is regression', () => {
  let p = assessProgress(undefined, { seq: 1, reason: { kind: 'error', error: { message: 'private' } } })
  assert.equal(p.state, 'regressed')
  p = assessProgress(p, { seq: 2, reason: { kind: 'aborted', reason: 'user' } })
  assert.equal(p.state, 'unknown'); assert.equal(p.streak, 0)
  p = assessProgress(p, { seq: 3, reason: { kind: 'completed' }, todos: [] })
  assert.equal(p.state, 'unknown')
  assert.doesNotMatch(JSON.stringify(p), /private/)
  assert.equal(recordToolEvidence(p, { data: { message: { content: [{ type: 'tool-result', isError: true, content: [] }] } } }), p)
})

test('every present Goal phase and failed lookup owns continuation', () => {
  for (const phase of ['active', 'paused', 'blocked', 'complete']) assert.equal(observeGoal({ get: () => ({ get: () => ({ phase, activation: 'disarmed' }) }) }, {}).owned, true)
  assert.equal(observeGoal({ get: () => ({ get: () => { throw new Error('offline') } }) }, {}).owned, true)
  assert.equal(observeGoal({ get: () => ({ get: () => undefined }) }, {}).owned, false)
  assert.equal(observeGoal({ get: () => undefined }, {}).owned, false)
})

test('restart retains budget but revokes automation and never replays running council', () => {
  const p = restoreExecution({}, { state: { runId: 'r', used: 0, council: { status: 'running', autoEnabled: true, grantRunId: 'r', discussionsUsed: 1, callsReserved: 8 } }, deliveries: {} })
  assert.equal(p.council.status, 'interrupted'); assert.equal(p.council.autoEnabled, false)
  assert.equal(executionSnapshot(p).council.callsReserved, 8)
  newExecution(p, 'new-message')
  assert.equal(p.council, undefined); assert.equal(p.progress, undefined)
})

test('a completed todo list cannot trigger repeated stagnation consultations', () => {
  const input = { reason: { kind: 'completed' }, todos: [{ content: 'finished', status: 'completed' }] }
  let p
  for (let seq = 1; seq <= 6; seq++) p = assessProgress(p, { ...input, seq })
  assert.equal(p.stalled, false)
})

test('corrupt persisted council budgets fail closed instead of restoring allowance', () => {
  const p = restoreExecution({}, { state: { runId: 'r', used: 0, council: { callsReserved: 'bad', discussionsUsed: 0 } }, deliveries: {} })
  assert.equal(p.council.callsReserved, 12)
  assert.equal(p.council.autoEnabled, false)
  assert.match(p.recoveryRequired, /损坏/)
})
