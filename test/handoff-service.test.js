import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHandoffService, renderHandoffPrompt, validateHandoffBrief } from '../lib/handoff-service.js'
import { createSupervisorStore } from '../lib/supervisor-store.js'

const BRIEF = [
  '目标与成功标准：完成矩阵导师交接并通过测试。',
  '已完成事项：固定卡片布局，导师注册表已实现。',
  '当前状态与关键决策：宿主持久化，客户端只展示。',
  '未完成事项：创建新会话并完成运行时验收。',
  '下一步与验收方法：运行单测并检查真实页面。',
].join('\n')

test('handoff uses one stable target and is idempotent across repeated calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-handoff-'))
  try {
    const store = createSupervisorStore(join(dir, 'state.json'))
    let serial = 0
    const service = createHandoffService({
      store,
      idFactory: () => String(++serial),
      now: () => 100 + serial,
      factsFor: async () => ({ cwd: '/project', agentPreset: 'standard' }),
      assignmentFor: async () => ({ primaryMentorId: 'relay' }),
    })
    const first = await service.recommend('source', '', { successfulCompactions: 3 })
    const repeated = await service.recommend('source', '', { successfulCompactions: 4 })
    assert.equal(repeated.id, first.id)
    assert.equal(repeated.targetSessionId, first.targetSessionId)
    await service.requestDraft(first.id, async () => {})
    const ready = await service.captureDraft('source', BRIEF, 9)
    assert.equal(ready.status, 'ready')
    assert.match(renderHandoffPrompt(ready), /不要重复已完成工作/)
    const creating = await service.beginCreate(first.id)
    assert.equal((await service.beginCreate(first.id)).targetSessionId, creating.targetSessionId)
    await service.beginDelivery(first.id)
    const done = await service.complete(first.id, creating.targetSessionId)
    assert.equal(done.status, 'completed')
    assert.equal((await service.complete(first.id, creating.targetSessionId)).status, 'completed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('handoff brief rejects raw logs and likely secrets', () => {
  assert.equal(validateHandoffBrief('[user] 原始日志\n' + BRIEF).ok, false)
  assert.equal(validateHandoffBrief(BRIEF + '\napi_key=super-secret-value').ok, false)
  assert.equal(validateHandoffBrief(BRIEF).ok, true)
})

test('handoff can enter drafting when an external session transport owns delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-handoff-external-'))
  try {
    const store = createSupervisorStore(join(dir, 'state.json'))
    let serial = 0
    const service = createHandoffService({
      store,
      idFactory: () => String(++serial),
      now: () => 200 + serial,
      factsFor: async () => ({ cwd: '/project', agentPreset: 'standard' }),
      assignmentFor: async () => ({ primaryMentorId: 'relay' }),
    })
    const record = await service.recommend('cold-source', '', { successfulCompactions: 0 })
    const drafting = await service.requestDraft(record.id)
    assert.equal(drafting.status, 'drafting')
    assert.equal(drafting.error, '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('invalid generated draft becomes retryable instead of hanging in drafting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-handoff-invalid-'))
  try {
    const store = createSupervisorStore(join(dir, 'state.json'))
    let serial = 0
    const service = createHandoffService({
      store,
      idFactory: () => String(++serial),
      now: () => 300 + serial,
      factsFor: async () => ({ cwd: '/project' }),
      assignmentFor: async () => ({ primaryMentorId: 'relay' }),
    })
    const record = await service.recommend('source-with-bad-draft', '', { successfulCompactions: 0 })
    await service.requestDraft(record.id)
    const failed = await service.captureDraft('source-with-bad-draft', 'too short', 10)
    assert.equal(failed.status, 'failed_retryable')
    assert.match(failed.error, /过短/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('validated fallback draft can recover a retryable transaction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-handoff-fallback-'))
  try {
    const store = createSupervisorStore(join(dir, 'state.json'))
    let serial = 0
    const service = createHandoffService({
      store,
      idFactory: () => String(++serial),
      now: () => 400 + serial,
      factsFor: async () => ({ cwd: '/project' }),
      assignmentFor: async () => ({ primaryMentorId: 'relay' }),
    })
    const record = await service.recommend('fallback-source', '', { successfulCompactions: 0 })
    await service.requestDraft(record.id)
    await service.fail(record.id, 'provider unavailable')
    const ready = await service.submitDraft(record.id, BRIEF, { cwd: '/recovered-project', agentPreset: 'recovered' })
    assert.equal(ready.status, 'ready')
    assert.equal(ready.briefText, BRIEF)
    assert.equal(ready.cwd, '/recovered-project')
    assert.equal(ready.agentPreset, 'recovered')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
