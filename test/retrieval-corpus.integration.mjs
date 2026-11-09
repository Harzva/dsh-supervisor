// Real local SQLite + HARVIS stdio MCP + Host warmSession + Supervisor query path.
// All records are synthetic; no model provider and no formal storage is used.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { readJudgementMemory, memoryContextBlock } from '../src/judgement-context.js'
const base = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
if (process.env.DSH_RETRIEVAL_INTEGRATION !== '1') {
  test('407-record real HARVIS corpus (opt-in)', { skip: 'Set DSH_RETRIEVAL_INTEGRATION=1 with DSH_MEMORY_PACKAGE_DIR and DSH_RETRIEVAL_RUNTIME' }, () => {})
} else {
const memoryDir = process.env.DSH_MEMORY_PACKAGE_DIR || join(base, 'memory')
const runtime = process.env.DSH_RETRIEVAL_RUNTIME || join(base, 'python-memory-overlay/bin/harvis-memory-mcp')
const { McpStdioClient } = await import(pathToFileURL(join(memoryDir, 'lib/mcp-client.js')))
const { HarvisMemoryHostService } = await import(pathToFileURL(join(memoryDir, 'lib/index.js')))
const root = await mkdtemp(join(tmpdir(), 'dsh-retrieval-corpus-'))
const previousDshHome = process.env.DSH_HOME
process.env.DSH_HOME = join(root, 'dsh-home')
const project_id = 'synthetic-task-retrieval'
const wire = new McpStdioClient(runtime, [], 10000)
const proof = { corpusSize: 0, root, modelCalls: 0, queryResults: {} }
const call = (name, data) => wire.callTool(name, { root, profile: 'minimal', project_id, ...data })
const msg = text => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } })
async function add(subject, summary, options = {}) {
  const candidate = await call('harvis_memory_propose', { kind: 'decision', scope: 'project', subject: 'project:' + subject,
    summary, confidence: 0.8, sensitivity: 'public_safe', provenance: [{ source_type: 'synthetic-test', source_id: subject }], ...options })
  if (options.review !== false) await call('harvis_memory_review', { candidate_id: candidate.candidate_id, decision: 'accept', approval_id: 'synthetic:' + candidate.candidate_id })
  assert.equal(candidate.memory.project_id, project_id, 'proposal preserves project scope')
  proof.corpusSize++
  return candidate.memory.memory_id
}
try {
  await wire.initialize()
  const themes = ['天文望远镜镜头清洁保养', '园艺修枝土壤肥料配比', '烘焙面包发酵温度管理', 'UI contrast accessibility keyboard', 'database vacuum retention backup', '天气观测风速降雨湿度', '音频采样混音声道调节', 'atlas catalog orbital astronomy']
  for (let index = 0; index < 400; index++) await add('noise-' + index, themes[index % themes.length] + ' synthetic-note-' + index)
  const payment = await add('payment-idempotency', '支付系统必须保证幂等性，重复请求只扣款一次。')
  const refund14 = await add('refund-window', '退款期限为14天，由人工审批退款。')
  const refund30 = await add('refund-window', '退款期限为30天，由人工审批退款。')
  const english = await add('payment-code', 'Payment API must use idempotency_key for retry requests.')
  const expired = await add('refund-expired', '退款期限为90天，此旧政策已过期。', { valid_until: '2000-01-01T00:00:00Z' })
  const candidate = await add('refund-candidate', '退款期限为365天，尚未审核。', { review: false })
  const superseded = await add('refund-superseded', '退款期限为180天，此政策已被替代。')
  // Exercise the canonical review/store API for supersession, not a SQL rewrite.
  execFileSync(process.env.DSH_RETRIEVAL_PYTHON || 'python3', ['-c',
    'from pathlib import Path; import sys; from digital_me.memory.store import HarvisMemoryStore; HarvisMemoryStore(Path(sys.argv[1])/".harvis/memory-v1/harvis.sqlite3").transition_status(sys.argv[2], "superseded")', root, superseded],
    { env: { ...process.env, PYTHONPATH: join(dirname(dirname(runtime)), 'lib'), PYTHONDONTWRITEBYTECODE: '1' } })
  const scope = { root, project_id, session_id: 'synthetic-session', agent_id: 'synthetic-agent', kind: 'workspace', key: root }
  const host = Object.create(HarvisMemoryHostService.prototype)
  Object.assign(host, { _closed: false, _contexts: new Map(), _warming: new Map(), _ready: Promise.resolve(), _client: wire,
    config: { contextTokenBudget: 1000, profile: 'minimal', scopeRoot: join(root, 'identities') }, sessionScope: () => scope })
  const agent = { id: scope.agent_id, session: { id: scope.session_id, header: { cwd: root } } }
  const scenarios = [
    ['chinese', '检查支付幂等性与退款期限', [payment, refund14, refund30]],
    ['english', 'Verify payment API idempotency_key retry', [english]],
    ['mixed', '验证支付系统的 idempotency_key', [payment, english]],
    ['topic-switch', 'Review UI contrast accessibility keyboard', []],
  ]
  for (const [name, instruction, required] of scenarios) {
    const result = await readJudgementMemory(host, agent, { events: [msg(instruction)] })
    assert.equal(result.audit.status, 'ready', name + ' ' + JSON.stringify(result.audit))
    for (const id of required) assert.ok(result.audit.hitIds.includes(id), name + ' missing ' + id)
    for (const id of [expired, candidate, superseded]) assert.ok(!result.audit.hitIds.includes(id), name + ' included hidden record')
    assert.ok(result.audit.tokenUsed <= 1000)
    if (name === 'chinese') {
      assert.deepEqual(new Set(result.audit.hitIds), new Set(required))
      assert.equal(result.audit.conflicts.length, 1)
      assert.match(memoryContextBlock(result), /未解决的冲突/)
      assert.match(result.text, /14天/); assert.match(result.text, /30天/)
      assert.doesNotMatch(result.text, /90天|180天|365天/)
    }
    if (name === 'topic-switch') for (const id of [payment, refund14, refund30, english]) assert.ok(!result.audit.hitIds.includes(id))
    proof.queryResults[name] = result.audit
  }
  // The same corpus with the original installed provider reproduces zero Chinese hits.
  const original = new McpStdioClient(process.env.DSH_RETRIEVAL_BASELINE_COMMAND || 'harvis-memory-mcp', [], 10000)
  try {
    await original.initialize()
    const before = await original.callTool('harvis_memory_context', { root, project_id, query: '检查支付幂等性与退款期限', token_budget: 1000 })
    proof.originalChineseHitCount = before.hits.length
    assert.equal(before.hits.length, 0)
  } finally { await original.close() }
  proof.pass = true
  await writeFile(join(base, 'retrieval-corpus-proof.json'), JSON.stringify(proof, null, 2) + '\n')
  console.log(JSON.stringify({ pass: true, corpusSize: proof.corpusSize, originalChineseHits: proof.originalChineseHitCount,
    queryHits: Object.fromEntries(Object.entries(proof.queryResults).map(([name, audit]) => [name, audit.hitCount])), modelCalls: 0 }, null, 2))
} finally {
  await wire.close()
  await rm(root, { recursive: true, force: true })
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
}

}
