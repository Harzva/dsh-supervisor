import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conversationContext, readJudgementMemory } from '../src/judgement-context.js'
const msg = (type, text) => ({ type: type + '/message', data: { content: [{ type: 'text', text }] } })
test('preserves early goal and latest instruction through tool event volume and long output', () => {
  const result = conversationContext([msg('user', 'EARLY-GOAL'), ...Array.from({ length: 30 }, (_, n) => msg('assistant', 'work-' + n + 'x'.repeat(300))), msg('user', 'LATEST-CONSTRAINT'), msg('assistant', 'done'), ...Array(30).fill({ type: 'tool/result' })])
  assert.match(result, /EARLY-GOAL/); assert.match(result, /LATEST-CONSTRAINT/); assert.match(result, /done/); assert.ok(result.length < 8300)
})
test('unavailable and failed memory are visible and never injected', async () => {
  assert.equal((await readJudgementMemory(null, {})).audit.status, 'unavailable')
  const failed = await readJudgementMemory({ warmSession: async () => { throw new Error('offline') } }, {})
  assert.equal(failed.text, ''); assert.equal(failed.audit.status, 'degraded')
  const stale = await readJudgementMemory({ warmSession: async () => ({ context: 'OLD', degraded: true, hits: [] }) }, {})
  assert.equal(stale.text, '')
})

test('runtime and skill-catalog injections cannot replace the latest actual user instruction', () => {
  const inject = kind => ({ type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text: 'INJECTED CATALOG' }] } })
  const result = conversationContext([msg('user', 'REAL GOAL'), inject('plugin'), inject('skill-catalog')])
  assert.match(result, /最新用户指令：\nREAL GOAL/); assert.doesNotMatch(result, /INJECTED CATALOG/)
})

test('task query prioritizes real current instruction and unfinished work without injected queries', async () => {
  const { judgementMemoryQuery } = await import('../src/judgement-context.js')
  const injected = kind => ({ type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text: 'INJECTED-RETRIEVAL-TOPIC' }] } })
  const query = judgementMemoryQuery({
    events: [msg('user', '交付支付平台'), msg('assistant', 'ASSISTANT-RETRIEVAL-TOPIC'), msg('user', '检查支付幂等性与退款流程'), injected('plugin'), injected('skill-catalog')],
    todos: [{ content: '数据库备份', status: 'completed' }, { content: '退款 webhook reconciliation', status: 'pending' }, { content: '支付 idempotency-key', status: 'in_progress' }],
  })
  assert.ok(query.startsWith('检查支付幂等性与退款流程'))
  assert.match(query, /支付 idempotency-key/)
  assert.match(query, /退款 webhook reconciliation/)
  assert.match(query, /交付支付平台/)
  assert.ok(query.indexOf('idempotency-key') < query.indexOf('webhook'))
  assert.doesNotMatch(query, /INJECTED|ASSISTANT|数据库备份/)
})

test('bounded queries retain current instruction end, active todos and early goal', async () => {
  const { judgementMemoryQuery } = await import('../src/judgement-context.js')
  const query = judgementMemoryQuery({ events: [msg('user', 'EARLY'), msg('user', 'LATEST-START ' + 'x'.repeat(3000) + ' LATEST-END')], todos: [{ status: 'pending', content: 'ACTIVE-TODO' }] })
  assert.ok(query.length <= 2000)
  assert.match(query, /LATEST-START/)
  assert.match(query, /LATEST-END/)
  assert.match(query, /ACTIVE-TODO/)
  assert.match(query, /EARLY/)
})

test('actual warmSession request and persisted audit use the same bounded task query', async () => {
  let request
  const events = [msg('user', 'payment idempotency')]
  const result = await readJudgementMemory({ warmSession: async (agent, signal, options) => {
    request = options
    assert.ok(signal instanceof AbortSignal)
    return { context: 'payment reviewed evidence', hits: [{ memory: { memory_id: 'mem_payment' } }] }
  } }, {}, { events, todos: [{ content: 'refund review', status: 'pending' }] })
  assert.equal(request.force, true)
  assert.equal(request.query, 'payment idempotency\nrefund review')
  assert.equal(result.audit.retrieval.query, request.query)
  assert.match(result.audit.retrieval.querySha256, /^[0-9a-f]{64}$/)
  assert.equal(result.audit.retrieval.strategy, 'task-lexical-v1')
})

test('conflicting reviewed records remain visible together and explicitly require reconciliation', async () => {
  const { memoryContextBlock } = await import('../src/judgement-context.js')
  const hits = [
    { memory: { memory_id: 'mem_a', kind: 'decision', subject: 'project:refund-window', summary: 'Refund window is 14 days.' } },
    { memory: { memory_id: 'mem_b', kind: 'decision', subject: 'project:refund-window', summary: 'Refund window is 30 days.' } },
  ]
  const result = await readJudgementMemory({ warmSession: async () => ({ context: 'mem_a: 14 days; mem_b: 30 days', hits }) }, {}, { query: 'refund window' })
  assert.deepEqual(result.audit.hitIds, ['mem_a', 'mem_b'])
  assert.equal(result.audit.conflicts.length, 1)
  assert.match(result.audit.warnings[0], /同一主题/)
  assert.match(memoryContextBlock(result), /未解决的冲突/)
  assert.match(result.text, /14 days/)
  assert.match(result.text, /30 days/)
})

test('pending host-folder migration remains visible while existing memory is retained', async () => {
  const { memoryContextBlock } = await import('../src/judgement-context.js')
  const scope = { project_id: 'project:stable', key: 'stable-scope', migrationRequired: {
    reason: 'host-folder-backend-changed', fromBackend: 'shared', toBackend: 'native',
    targetAlias: { backend: 'native', owner: 'workspace-a', path: '研发', root: '/private/storage/do-not-export' },
    storageRoot: '/private/storage/do-not-export',
  } }
  const result = await readJudgementMemory({ warmSession: async () => ({ context: 'EXISTING PROJECT MEMORY', scope, hits: [{ memory: { memory_id: 'mem_original' } }] }) }, {})
  assert.equal(result.audit.status, 'ready')
  assert.equal(result.audit.scope.projectId, 'project:stable')
  assert.deepEqual(result.audit.scope.migrationRequired.targetAlias, { backend: 'native', owner: 'workspace-a', path: '研发' })
  assert.doesNotMatch(JSON.stringify(result.audit.scope.migrationRequired), /private\/storage/)
  assert.match(memoryContextBlock(result), /本轮仍使用原项目及其记忆/)
  assert.match(memoryContextBlock(result), /EXISTING PROJECT MEMORY/)
})
