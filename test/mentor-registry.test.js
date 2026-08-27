import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeMentors, normalizeModelRoute, normalizeSupervisorModels,
  publicMentor, resolveAssignment,
} from '../lib/mentor-registry.js'

test('default roster has distinct roles, colors and bounded public DTOs', () => {
  const mentors = normalizeMentors()
  assert.equal(mentors.length, 5)
  assert.equal(new Set(mentors.map((mentor) => mentor.role)).size, 5)
  assert.equal(new Set(mentors.map((mentor) => mentor.color)).size, 5)
  assert.equal(Object.hasOwn(publicMentor(mentors[0]), 'route'), false)
})

test('responsibility tags select a matching mentor and remain stable', () => {
  const mentors = normalizeMentors()
  const first = resolveAssignment({ sessionId: 's1', tags: ['安全', '验收'] }, mentors, null)
  assert.equal(first.primaryMentorId, 'verity')
  assert.equal(first.assignmentSource, 'rule')
  const kept = resolveAssignment({ sessionId: 's1', tags: ['研究'] }, mentors, first)
  assert.equal(kept.primaryMentorId, 'verity')
})

test('invalid configured mentors are removed and collaborators are bounded', () => {
  const mentors = normalizeMentors([
    { id: 'ok', name: 'OK', role: 'execution' },
    { id: '../bad', name: 'bad' },
  ])
  assert.deepEqual(mentors.map((mentor) => mentor.id), ['ok'])
  const kept = resolveAssignment({ sessionId: 's' }, mentors, {
    sessionId: 's', primaryMentorId: 'ok', collaboratorIds: ['ok', 'missing', 'a'],
    assignmentSource: 'manual', reason: 'manual', assignedAt: 1, version: 1,
  })
  assert.deepEqual(kept.collaboratorIds, [])
})

test('legacy faculties become role-aware mentors', () => {
  const mentors = normalizeMentors([], [
    { id: 'strategy', name: '策略学院', route: 'p/m', prompt: '品牌策略与增长' },
    { id: 'code', name: '代码学院', route: 'p/m', prompt: '工程实现、代码质量、验证与调试' },
    { id: 'research', name: '研究学院', route: 'p/m', prompt: '事实核查与研究' },
  ])
  assert.deepEqual(mentors.map((mentor) => mentor.role), ['architecture', 'execution', 'research'])
  assert.equal(resolveAssignment({ sessionId: 's', tags: ['代码'] }, mentors, null).primaryMentorId, 'code')
})

test('Supervisor model routes are normalized and restricted to the configured roster', () => {
  const mentors = normalizeMentors()
  assert.equal(normalizeModelRoute(' provider/model-v2 '), 'provider/model-v2')
  assert.equal(normalizeModelRoute('missing-separator'), '')
  assert.equal(normalizeModelRoute('provider/'), '')
  assert.deepEqual(normalizeSupervisorModels({
    atlas: 'p/architecture-model',
    scout: 'invalid',
    unknown: 'p/private',
  }, mentors), { atlas: 'p/architecture-model' })
})
