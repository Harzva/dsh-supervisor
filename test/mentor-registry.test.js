import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeMentors, normalizeModelRoute, normalizeSupervisorModels,
  publicMentor, resolveAssignment, participantMentorIds,
} from '../lib/mentor-registry.js'
import { supervisorBaseSystem } from '../lib/index.js'

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

test('reassigning a removed mentor preserves explicit and default role references', () => {
  const mentors = normalizeMentors()
  const roleRef = { id: 'other.expert', version: '7' }
  const defaultRoleRef = { id: 'dsh-supervisor.retired', version: '1' }
  const existing = {
    sessionId: 's1', primaryMentorId: 'retired', collaboratorIds: ['atlas'],
    roleRef, roleRefSource: 'role-registry', defaultRoleRef,
    defaultRoleSource: 'default-migration', version: 4,
  }
  const reassigned = resolveAssignment({ sessionId: 's1', tags: ['验收'] }, mentors, existing)
  assert.equal(reassigned.primaryMentorId, 'verity')
  assert.equal(reassigned.version, 5)
  assert.deepEqual(reassigned.roleRef, roleRef)
  assert.equal(reassigned.roleRefSource, 'role-registry')
  assert.deepEqual(reassigned.defaultRoleRef, defaultRoleRef)
  assert.equal(reassigned.defaultRoleSource, 'default-migration')
  // Only the newly selected mentor's role is available; the saved explicit
  // expert must fail closed rather than silently switching to that role.
  const registry = { resolve: ref => ref.id === 'dsh-supervisor.verity' ? { id: ref.id, version: ref.version } : undefined }
  assert.equal(supervisorBaseSystem(reassigned, registry, mentors).failClosed, true)
  assert.deepEqual(supervisorBaseSystem(reassigned, registry, mentors).roleRef, roleRef)
  const originalRole = { ...roleRef, label: 'Original expert', prompt: { identity: 'Original role' } }
  const preserved = supervisorBaseSystem(reassigned, { resolve: ref => ref.id === roleRef.id && ref.version === roleRef.version ? originalRole : undefined }, mentors)
  assert.equal(preserved.failClosed, false)
  assert.deepEqual(preserved.roleRef, roleRef)
  assert.match(preserved.system, /Original role/)
  const first = resolveAssignment({ sessionId: 'new' }, mentors, null)
  assert.equal(first.version, 1)
  assert.equal(Object.hasOwn(first, 'roleRef'), false)
})

test('reassigning a removed mentor preserves missing or corrupt saved role failure', () => {
  const mentors = normalizeMentors()
  const registry = { resolve: ref => ref.id === 'dsh-supervisor.verity' ? { id: ref.id, version: ref.version } : undefined }
  for (const existing of [
    { roleRef: { id: 'bad/ref', version: '1' } },
    { roleRefCorrupt: true },
    { defaultRoleRef: { id: 'bad/ref', version: '1' }, defaultRoleSource: 'default-migration' },
    { defaultRoleRef: { id: 'dsh-supervisor.retired', version: '1' }, defaultRoleSource: 'default-migration' },
  ]) {
    const reassigned = resolveAssignment({ sessionId: 's1', tags: ['验收'] }, mentors, { primaryMentorId: 'retired', ...existing })
    assert.equal(reassigned.primaryMentorId, 'verity')
    assert.equal(supervisorBaseSystem(reassigned, registry, mentors).failClosed, true)
    if (existing.roleRef || existing.roleRefCorrupt) assert.equal(reassigned.roleRefCorrupt, true)
    if (existing.defaultRoleRef) assert.deepEqual(reassigned.defaultRoleRef, existing.defaultRoleRef)
  }
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

// 方案A：接管真正参与「主责+协作(观众)」的监督者，而非摆设。
test('participantMentorIds keeps primary plus collaborators and drops the empty case', () => {
  // 主责 + 2 协作：三层监督者全部参与接管。
  assert.deepEqual(participantMentorIds({
    sessionId: 's1',
    primaryMentorId: 'atlas',
    collaboratorIds: ['forge', 'scout'],
  }), ['atlas', 'forge', 'scout'])
  // 主责 + 协作里重复/主责自己：去重且只保留合法者。
  assert.deepEqual(participantMentorIds({
    sessionId: 's2',
    primaryMentorId: 'atlas',
    collaboratorIds: ['atlas', 'forge', 'scout', 'forge'],
  }), ['atlas', 'forge', 'scout'])
  // 协作为空：回退到只有主责参与。
  assert.deepEqual(participantMentorIds({
    sessionId: 's3',
    primaryMentorId: 'atlas',
    collaboratorIds: [],
  }), ['atlas'])
  // 无分配：没有任何监督者参与。
  assert.deepEqual(participantMentorIds(null), [])
  assert.deepEqual(participantMentorIds({}), [])
})
