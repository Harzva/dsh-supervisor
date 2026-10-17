import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readControl, setControl } from '../plugins/codex-supervisor/scripts/control.mjs'
import { ExecutionStore, propose, authorize } from '../plugins/codex-supervisor/scripts/execution-store.mjs'
import { run, runJob, recoverJob } from '../plugins/codex-supervisor/scripts/execution.mjs'
import { run as supervisor } from '../plugins/codex-supervisor/scripts/supervisor.mjs'

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-control-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return fs.realpathSync(root)
}

function initialized(t, maxAttempts = 1) {
  const root = workspace(t)
  supervisor(['init', '--workspace', root])
  supervisor(['assign', '--workspace', root, '--task', 'task'])
  const store = new ExecutionStore(root)
  const job = store.mutate(state => propose(state, { jobId: 'job', taskId: 'task', proposal: { instruction: 'Write the approved report.', successCriteria: ['Approved report exists.'], verification: [{ kind: 'file', path: 'report.txt', contains: 'accepted' }], maxAttempts } }))
  store.mutate(state => authorize(state, { jobId: 'job', digest: job.digest }))
  return { root, store, job: () => store.snapshot().jobs.job }
}

async function completed(options, root) {
  const threadId = options.threadId || 'owned-thread'
  await options.onThread({ threadId })
  await options.onDispatch()
  await options.onQueued({ threadId, queuedSubmissionId: 'owned-queue' })
  await options.onStarted({ threadId, turnId: 'owned-turn' })
  fs.writeFileSync(path.join(root, 'report.txt'), 'accepted')
  return { status: 'completed', threadId, turnId: 'owned-turn' }
}

test('reading the compatible enabled default never initializes a project', (t) => {
  const root = workspace(t)
  assert.deepEqual(readControl(root), { workspace: root, enabled: true, revision: 0, configured: false })
  assert.deepEqual(fs.readdirSync(root), [])
})

test('the project switch persists independently of a roster and uses optimistic revision checks', (t) => {
  const root = workspace(t)
  assert.deepEqual(setControl(root, { enabled: false, expectedRevision: 0 }), { workspace: root, enabled: false, revision: 1, configured: true })
  const target = path.join(root, '.codex/supervisor/control.v1.json')
  assert.equal(fs.statSync(target).mode & 0o777, 0o600)
  assert.equal(fs.existsSync(path.join(root, '.codex/supervisor/state.v1.json')), false)
  assert.equal(fs.existsSync(path.join(root, '.codex/supervisor/execution.v1.json')), false)
  const saved = fs.readFileSync(target, 'utf8')
  assert.throws(() => setControl(root, { enabled: true, expectedRevision: 0 }), error => error.code === 'STALE_CONTROL')
  assert.equal(fs.readFileSync(target, 'utf8'), saved)
  assert.equal(fs.existsSync(path.join(root, '.codex/supervisor/.control.lock')), false)
  assert.deepEqual(setControl(root, { enabled: false, expectedRevision: 1 }), readControl(root))
  assert.equal(fs.readFileSync(target, 'utf8'), saved)
  assert.equal(setControl(root, { enabled: true, expectedRevision: 1 }).revision, 2)
  assert.equal(readControl(root).enabled, true)
  assert.equal(fs.existsSync(path.join(root, '.codex/supervisor/state.v1.json')), false)
})

test('control writers use their own exclusive short lock and cannot replace another writer', (t) => {
  const root = workspace(t)
  setControl(root, { enabled: false })
  const directory = path.join(root, '.codex/supervisor')
  fs.writeFileSync(path.join(directory, '.execution.lock'), 'execution writer')
  assert.equal(setControl(root, { enabled: true }).enabled, true)
  assert.equal(fs.readFileSync(path.join(directory, '.execution.lock'), 'utf8'), 'execution writer')
  fs.writeFileSync(path.join(directory, '.control.lock'), 'control writer')
  assert.throws(() => setControl(root, { enabled: false }), error => error.code === 'LOCKED')
  assert.equal(readControl(root).enabled, true)
  assert.equal(fs.readFileSync(path.join(directory, '.control.lock'), 'utf8'), 'control writer')
})

test('malformed, oversized, unsupported and foreign control files fail closed', (t) => {
  const root = workspace(t)
  setControl(root, { enabled: false })
  const target = path.join(root, '.codex/supervisor/control.v1.json')
  const valid = JSON.parse(fs.readFileSync(target, 'utf8'))
  for (const [value, code] of [
    ['not json', 'INVALID_JSON'],
    [' '.repeat(4097), 'SIZE_LIMIT'],
    [JSON.stringify({ ...valid, schemaVersion: 2 }), 'UNKNOWN_SCHEMA'],
    [JSON.stringify({ ...valid, workspace: root + '-other' }), 'WORKSPACE_BINDING'],
    [JSON.stringify({ ...valid, enabled: 'false' }), 'INVALID_CONTROL'],
    [JSON.stringify({ ...valid, revision: 0 }), 'INVALID_CONTROL'],
    [JSON.stringify({ ...valid, unexpected: true }), 'INVALID_CONTROL'],
  ]) {
    fs.writeFileSync(target, value)
    assert.throws(() => readControl(root), error => error.code === code)
    assert.throws(() => setControl(root, { enabled: true }), error => error.code === code)
    assert.equal(fs.readFileSync(target, 'utf8'), value)
  }
})

test('control paths reject symlinks and nonregular files without touching their targets', (t) => {
  for (const kind of ['file-link', 'lock-link', 'directory', 'root-link']) {
    const root = workspace(t)
    const outside = path.join(root, 'outside')
    fs.writeFileSync(outside, 'preserve target')
    if (kind === 'root-link') fs.symlinkSync(root, path.join(root, '.codex'))
    else {
      setControl(root, { enabled: false })
      const target = path.join(root, '.codex/supervisor', kind === 'lock-link' ? '.control.lock' : 'control.v1.json')
      if (kind !== 'lock-link') fs.unlinkSync(target)
      if (kind === 'directory') fs.mkdirSync(target)
      else fs.symlinkSync(outside, target)
    }
    assert.throws(() => readControl(root), error => error.code === 'UNSAFE_PATH')
    assert.throws(() => setControl(root, { enabled: true }), error => error.code === 'UNSAFE_PATH')
    assert.equal(fs.readFileSync(outside, 'utf8'), 'preserve target')
  }
})

test('switch mutations reject loose values and unknown fields before initializing directories', (t) => {
  const root = workspace(t)
  for (const input of [undefined, null, [], {}, { enabled: 1 }, { enabled: true, expectedRevision: -1 }, { enabled: true, expectedRevision: 0.5 }, { enabled: true, extra: true }]) {
    assert.throws(() => setControl(root, input), error => error.code === 'INVALID_CONTROL')
    assert.deepEqual(fs.readdirSync(root), [])
  }
})

test('off blocks run and drain before an attempt while preserving authorized work and enabling starts nothing', async (t) => {
  const f = initialized(t)
  setControl(f.root, { enabled: false })
  const before = f.store.snapshot()
  const dependencies = { execute: async () => assert.fail('off must not open a native executor') }
  await assert.rejects(runJob(f.store, 'job', dependencies), error => error.code === 'SUPERVISOR_DISABLED')
  await assert.rejects(run(['drain', '--workspace', f.root, '--limit', '1'], dependencies), error => error.code === 'SUPERVISOR_DISABLED')
  assert.deepEqual(f.store.snapshot(), before)
  assert.equal(f.job().status, 'authorized')
  assert.equal(f.job().attempts.length, 0)
  assert.equal((await run(['status', '--workspace', f.root, '--job', 'job'])).status, 'authorized')
  setControl(f.root, { enabled: true })
  assert.deepEqual(f.store.snapshot(), before)
  assert.equal((await runJob(f.store, 'job', { execute: options => completed(options, f.root) })).status, 'succeeded')
})

test('off between thread receipt and queue dispatch preserves uncertainty without a queue or cancellation claim', async (t) => {
  for (const returnsReceipt of [false, true]) {
    const f = initialized(t, 2)
    let queued = 0
    const result = await runJob(f.store, 'job', { execute: async options => {
      await options.onThread({ threadId: 'owned-empty-thread' })
      setControl(f.root, { enabled: false })
      try { await options.onDispatch() } catch (error) {
        if (!returnsReceipt) throw error
        return { status: 'failed', threadId: 'owned-empty-thread', transport: { code: 'NATIVE_RECEIPT' } }
      }
      queued += 1
      return { status: 'completed', threadId: 'owned-empty-thread', turnId: 'impossible-turn' }
    } })
    assert.equal(queued, 0)
    assert.equal(result.status, 'uncertain')
    assert.equal(result.threadId, 'owned-empty-thread')
    assert.equal(result.attempts.length, 1)
    assert.equal(result.attempts[0].queuedSubmissionId, null)
    assert.equal(result.attempts[0].turnId, null)
    assert.equal(result.attempts[0].result.reason, 'supervisor-disabled-before-dispatch')
    assert.equal(result.attempts[0].result.cancellationRequested, undefined)
    assert.equal(f.store.snapshot().runner, null)
    setControl(f.root, { enabled: true })
    await assert.rejects(runJob(f.store, 'job', { execute: async () => assert.fail('uncertain intent must not be replayed') }), error => error.code === 'NOT_RUNNABLE')
  }
})

test('off during a running native turn allows completion and independent acceptance without aborting it', async (t) => {
  const f = initialized(t)
  const result = await runJob(f.store, 'job', { execute: async options => {
    const receipt = await completed(options, f.root)
    setControl(f.root, { enabled: false })
    assert.equal(options.signal.aborted, false)
    return receipt
  } })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.attempts[0].result.cancellationRequested, undefined)
  assert.equal(supervisor(['status', '--workspace', f.root, '--task', 'task']).checkpointSequence, 1)
  assert.equal(readControl(f.root).enabled, false)
})

test('off after a confirmed failure prevents an approved automatic retry without using its next attempt', async (t) => {
  const f = initialized(t, 2)
  let dispatches = 0
  await assert.rejects(runJob(f.store, 'job', { execute: async options => {
    dispatches += 1
    await options.onThread({ threadId: 'owned-thread' })
    await options.onDispatch()
    await options.onQueued({ threadId: 'owned-thread', queuedSubmissionId: 'owned-queue' })
    await options.onStarted({ threadId: 'owned-thread', turnId: 'failed-turn' })
    setControl(f.root, { enabled: false })
    return { status: 'failed', threadId: 'owned-thread', turnId: 'failed-turn' }
  } }), error => error.code === 'SUPERVISOR_DISABLED')
  assert.equal(dispatches, 1)
  assert.equal(f.job().status, 'failed')
  assert.equal(f.job().attempts.length, 1)
  assert.equal(f.store.snapshot().runner, null)
  await assert.rejects(runJob(f.store, 'job', { execute: async () => assert.fail('no retry while off') }), error => error.code === 'SUPERVISOR_DISABLED')
  assert.equal(f.job().attempts.length, 1)
})

test('status, explicit cancellation and receipt recovery remain available while off', async (t) => {
  const f = initialized(t)
  await runJob(f.store, 'job', { execute: async options => {
    await options.onThread({ threadId: 'owned-thread' })
    await options.onDispatch()
    await options.onQueued({ threadId: 'owned-thread', queuedSubmissionId: 'owned-queue' })
    await options.onStarted({ threadId: 'owned-thread', turnId: 'owned-turn' })
    return { status: 'uncertain', threadId: 'owned-thread', turnId: 'owned-turn' }
  } })
  setControl(f.root, { enabled: false })
  assert.equal((await run(['status', '--workspace', f.root, '--job', 'job'])).status, 'uncertain')
  let inspections = 0
  const recovered = await recoverJob(f.store, 'job', { inspect: async options => {
    inspections += 1
    return { threadId: options.threadId, marker: options.marker, turnId: options.turnId, state: 'idle', status: 'failed', latestTurnId: options.turnId, queuedCount: 0, queuedSubmissionIds: [], activeGoal: null }
  } })
  assert.equal(inspections, 1)
  assert.equal(recovered.status, 'failed')
  assert.equal((await run(['cancel', '--workspace', f.root, '--job', 'job'])).status, 'cancelled')
  assert.equal(readControl(f.root).enabled, false)
})
