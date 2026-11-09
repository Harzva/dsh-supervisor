import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSupervisorStore } from '../lib/supervisor-store.js'

test('assignments, Supervisor model settings and health survive a new store instance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-supervisor-store-'))
  const file = join(dir, 'state.json')
  try {
    const first = createSupervisorStore(file)
    await first.setAssignment('s1', { sessionId: 's1', primaryMentorId: 'atlas', collaboratorIds: [] })
    await first.setSetting('s1', { supervisorModels: { atlas: 'provider/model' } })
    await first.recordCompaction('s1', 10, 5)
    await first.recordCompaction('s1', 20, 8)
    await first.recordCompaction('s1', 30, 8)
    const second = createSupervisorStore(file)
    assert.equal((await second.getAssignment('s1')).primaryMentorId, 'atlas')
    assert.deepEqual(await second.getSetting('s1'), { supervisorModels: { atlas: 'provider/model' } })
    assert.deepEqual(await second.getHealth('s1'), { successfulCompactions: 2, lastCompactionAt: 20, lastCompactionSeq: 8 })
    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw.version, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('roundtable records persist and are retrievable per session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-supervisor-rt-'))
  const file = join(dir, 'state.json')
  try {
    const store = createSupervisorStore(file)
    await store.appendRoundtable({
      roundId: 'rt-a', sessionId: 's1', at: 1,
      opinions: [{ facultyId: 'strategy', name: '策略学院', text: '先做A', ok: true }],
      verdict: '一致', consensus: '先做A',
    })
    await store.appendRoundtable({
      roundId: 'rt-b', sessionId: 's2', at: 2,
      opinions: [{ facultyId: 'code', name: '代码学院', text: '先做B', ok: true }],
      verdict: '', consensus: '',
    })
    const s1 = await store.getRoundtables('s1')
    assert.equal(s1.length, 1, 'per-session roundtables scoped')
    assert.equal(s1[0].roundId, 'rt-a')
    const s2 = await store.getRoundtables('s2')
    assert.equal(s2[0].roundId, 'rt-b')

    // 跨 store 实例（模拟重启）仍能读回。
    const reloaded = createSupervisorStore(file)
    const back = await reloaded.getRoundtables('s1')
    assert.equal(back.length, 1)
    assert.equal(back[0].consensus, '先做A')

    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.ok(Array.isArray(raw.roundtables), 'roundtables array persisted')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('todo plans persist and are retrievable per session across instances', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-supervisor-todo-'))
  const file = join(dir, 'state.json')
  try {
    const first = createSupervisorStore(file)
    assert.equal(await first.getTodos('s1'), null)
    await first.setTodos('s1', [
      { content: '完成 GroupX 徽章闭环', status: 'pending' },
      { content: '核对 todo 计划驱动', status: 'pending' },
    ])
    await first.setTodos('s2', [{ content: '另一会话计划', status: 'pending' }])
    const second = createSupervisorStore(file)
    assert.deepEqual(await second.getTodos('s1'), [
      { content: '完成 GroupX 徽章闭环', status: 'pending' },
      { content: '核对 todo 计划驱动', status: 'pending' },
    ])
    assert.deepEqual(await second.getTodos('s2'), [{ content: '另一会话计划', status: 'pending' }])
    assert.equal(await second.getTodos('s3'), null)
    // 覆盖写入
    await second.setTodos('s1', [{ content: '更新后计划', status: 'completed' }])
    assert.deepEqual(await createSupervisorStore(file).getTodos('s1'), [{ content: '更新后计划', status: 'completed' }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('two independent store instances claim the same adoption only once and preserve spent budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-supervisor-claim-'))
  try {
    const file = join(dir, 'state.json')
    const a = createSupervisorStore(file), b = createSupervisorStore(file)
    const state = { runId: 'run-one', used: 0, done: false, suggestion: '执行一次', suggestionId: 'suggest-one' }
    await a.saveExecution('s', state)
    await b.snapshot()
    const delivery = { id: 'suggest-one', runId: 'run-one', messageId: 'message-one' }
    const results = await Promise.all([a.reserveDelivery('s', delivery, state, 3), b.reserveDelivery('s', delivery, state, 3)])
    assert.equal(results.filter(r => r.reserved).length, 1)
    // A stale UI or another process cannot resurrect the adopted suggestion.
    await b.saveExecution('s', state)
    const disk = await createSupervisorStore(file).getExecution('s')
    assert.equal(disk.state.used, 1)
    assert.equal(disk.state.suggestion, '')
    assert.equal(Object.keys(disk.deliveries).length, 1)
    await a.finishDelivery('s', delivery.id, 'received', { receiptSeq: 9 })
    await b.finishDelivery('s', delivery.id, 'queued')
    assert.equal((await createSupervisorStore(file).getExecution('s')).deliveries[delivery.id].status, 'received')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('execution claim is fail-closed when durable storage cannot be written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-supervisor-no-write-'))
  try {
    const file = join(dir, 'state.json')
    const store = createSupervisorStore(file)
    await store.saveExecution('s', { runId: 'r', used: 0 })
    // A non-directory parent produces a real atomic-write failure even as root.
    const bad = createSupervisorStore(join(file, 'impossible.json'))
    await assert.rejects(bad.reserveDelivery('s', { id: 'd' }, { runId: 'r', used: 0 }, 1))
    assert.equal((await createSupervisorStore(file).getExecution('s')).state.used, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a retired task cannot overwrite the new task or reserve a late old suggestion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-supervisor-epoch-'))
  try {
    const file = join(dir, 'state.json'), a = createSupervisorStore(file), b = createSupervisorStore(file)
    const old = { runId: 'old', used: 1, lastUserSeq: 3 }
    await a.saveExecution('s', old)
    await b.saveExecution('s', { runId: 'new', used: 0, lastUserSeq: 8 })
    await assert.rejects(a.saveExecution('s', old), /替代/)
    await assert.rejects(a.reserveDelivery('s', { id: 'late' }, old, 5), /替代/)
    assert.equal((await createSupervisorStore(file).getExecution('s')).state.runId, 'new')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('unsupported persisted schema fails closed instead of silently resetting execution history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-supervisor-schema-'))
  try {
    const { writeFile } = await import('node:fs/promises')
    const file = join(dir, 'state.json')
    await writeFile(file, JSON.stringify({ version: 999, executions: { s: { state: { used: 3 } } } }))
    const store = createSupervisorStore(file)
    await assert.rejects(store.snapshot(), /状态格式无效/)
    await assert.rejects(store.saveExecution('s', { used: 0 }), /状态格式无效/)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 999)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('multiple OS processes recover one dead lock and cannot delete each other’s replacement lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-supervisor-process-'))
  try {
    const { writeFile } = await import('node:fs/promises')
    const { spawn } = await import('node:child_process')
    const file = join(dir, 'state.json')
    await createSupervisorStore(file).saveExecution('s', { runId: 'r', used: 0 })
    await writeFile(file + '.lock', JSON.stringify({ pid: 2147483647, nonce: 'dead-owner-test' }))
    const moduleURL = new URL('../lib/supervisor-store.js', import.meta.url).href
    const script = `import {createSupervisorStore} from ${JSON.stringify(moduleURL)}; const s=createSupervisorStore(process.argv[1]); const r=await s.reserveDelivery('s',{id:'one',runId:'r',messageId:'one'},{runId:'r',used:0},3); console.log(r.reserved)`
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, file])
      let out = '', err = ''
      child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d)
      child.on('error', reject); child.on('exit', code => code ? reject(new Error(err)) : resolve(out.trim()))
    })
    const results = await Promise.all([run(), run(), run(), run()])
    assert.equal(results.filter(x => x === 'true').length, 1)
    assert.equal((await createSupervisorStore(file).getExecution('s')).state.used, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('disk completion is monotonic and a stale instance cannot claim or reopen the finished run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-supervisor-done-'))
  try {
    const file = join(dir, 'state.json'), current = createSupervisorStore(file), stale = createSupervisorStore(file)
    const unfinished = { runId: 'completed-run', used: 1, done: false, suggestion: '旧建议', suggestionId: 'stale-suggestion' }
    await current.saveExecution('s', unfinished)
    await stale.snapshot()
    await current.saveExecution('s', { ...unfinished, done: true })
    const delivery = { id: 'stale-suggestion', runId: unfinished.runId, messageId: 'must-not-send' }
    await assert.rejects(stale.reserveDelivery('s', delivery, unfinished, 5), /任务已完成/)
    await stale.saveExecution('s', unfinished)
    const finished = await createSupervisorStore(file).getExecution('s')
    assert.equal(finished.state.done, true)
    assert.equal(finished.state.used, 1)
    assert.deepEqual(finished.deliveries, {})
    // A genuinely new user task can start a fresh run; completion belongs to
    // the old run and must not poison the next task's independently saved state.
    const next = { runId: 'new-user-run', used: 0, done: false, suggestion: '新任务', suggestionId: 'new-suggestion' }
    await current.saveExecution('s', next)
    const claimed = await current.reserveDelivery('s', { id: 'new-suggestion', runId: next.runId, messageId: 'new-message' }, next, 5)
    assert.equal(claimed.reserved, true)
    assert.equal(claimed.record.state.done, false)
    assert.equal(claimed.record.state.used, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
