import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  ExecutionStore, propose, authorize, beginAttempt, updateAttempt, cancel,
  validateProposal, digestProposal, resolveWorkspaceFile,
  acquireRunner, releaseRunner,
} from '../plugins/codex-supervisor/scripts/execution-store.mjs'

const moduleURL = new URL('../plugins/codex-supervisor/scripts/execution-store.mjs', import.meta.url).href

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-execution-store-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const store = new ExecutionStore(workspace)
  return { workspace, store, statePath: path.join(workspace, '.codex', 'supervisor', 'execution.v1.json') }
}

function proposal(changes = {}) {
  return { instruction: 'Create the local report.\nKeep changes inside the workspace.', successCriteria: ['The report contains the accepted result.'], verification: [{ kind: 'file', path: 'report.txt', contains: 'accepted' }], ...changes }
}

function expectError(code, action) {
  assert.throws(action, (error) => error.code === code, `Expected ${code}`)
}

function createAuthorized(store, maxAttempts = 1, jobId = 'job') {
  const job = store.mutate((state) => propose(state, { jobId, taskId: 'task', proposal: proposal({ maxAttempts }) }))
  store.mutate((state) => authorize(state, { jobId, digest: job.digest }))
  return job
}

test('immutable proposal normalization, explicit model and idempotent job reuse survive restart', (t) => {
  const { workspace, store, statePath } = fixture(t)
  assert.equal(store.snapshot().revision, 0)
  assert.equal(fs.existsSync(statePath), false)
  const raw = proposal({ model: 'explicit-model-id', verification: [{ kind: 'file', path: 'report.txt', sha256: 'A'.repeat(64) }, { kind: 'command', argv: ['node', '--test', ''] }] })
  const first = store.mutate((state) => propose(state, { jobId: 'constructor', taskId: 'task', proposal: raw }))
  assert.equal(first.proposal.timeoutMs, 120000)
  assert.equal(first.proposal.verification[1].timeoutMs, 30000)
  assert.equal(first.proposal.verification[0].sha256, 'a'.repeat(64))
  assert.equal(first.proposal.model, 'explicit-model-id')
  assert.equal(first.digest, digestProposal(validateProposal(raw, workspace)))
  assert.equal(first.authorization, null)
  const before = fs.readFileSync(statePath, 'utf8')
  const restarted = new ExecutionStore(workspace)
  assert.deepEqual(restarted.mutate((state) => propose(state, { jobId: 'constructor', taskId: 'task', proposal: raw })), first)
  assert.equal(fs.readFileSync(statePath, 'utf8'), before)
  expectError('PROPOSAL_CONFLICT', () => restarted.mutate((state) => propose(state, { jobId: 'constructor', taskId: 'task', proposal: proposal() })))
  expectError('PROPOSAL_CONFLICT', () => restarted.mutate((state) => propose(state, { jobId: 'constructor', taskId: 'other-task', proposal: raw })))
  expectError('PROPOSAL_DIGEST', () => restarted.mutate((state) => { state.jobs.constructor.proposal.instruction = 'changed' }))
  expectError('PROPOSAL_IMMUTABLE', () => restarted.mutate((state) => {
    state.jobs.constructor.proposal.instruction = 'Changed with a matching recomputed digest.'
    state.jobs.constructor.digest = digestProposal(state.jobs.constructor.proposal)
  }))
  assert.equal(fs.readFileSync(statePath, 'utf8'), before)
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600)
})

test('authorization is explicit, workspace/digest bound, immutable and cannot reset attempt budget', (t) => {
  const { store, workspace, statePath } = fixture(t)
  const job = store.mutate((state) => propose(state, { jobId: 'job', taskId: 'task', proposal: proposal() }))
  expectError('AUTHORIZATION', () => store.mutate((state) => beginAttempt(state, 'job')))
  expectError('PROPOSAL_DIGEST', () => store.mutate((state) => authorize(state, { jobId: 'job', digest: 'wrong' })))
  expectError('AUTHORIZATION', () => store.mutate((state) => {
    state.jobs.job.authorization = { proposalDigest: job.digest, workspace, source: 'user', maxAttempts: 1, approvedAt: Date.now() }
    state.jobs.job.status = 'authorized'
  }))
  const authorized = store.mutate((state) => authorize(state, { jobId: 'job', digest: job.digest }))
  assert.equal(authorized.authorization.workspace, fs.realpathSync(workspace))
  const before = fs.readFileSync(statePath, 'utf8')
  assert.deepEqual(store.mutate((state) => authorize(state, { jobId: 'job', digest: job.digest })), authorized)
  assert.equal(fs.readFileSync(statePath, 'utf8'), before)
  const attempt = store.mutate((state) => beginAttempt(state, 'job'))
  store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'failed', result: { summary: 'The host rejected the request before execution.', code: 'rejected' } }))
  store.mutate((state) => authorize(state, { jobId: 'job', digest: job.digest }))
  expectError('ATTEMPT_LIMIT', () => store.mutate((state) => beginAttempt(state, 'job')))
  expectError('AUTHORIZATION_IMMUTABLE', () => store.mutate((state) => { state.jobs.job.authorization.approvedAt += 1 }))
  assert.equal(store.snapshot().jobs.job.attempts.length, 1)
})

test('dispatch intent survives restart; CAS recovery records receipts and uncertainty never redispatches', (t) => {
  const { store, workspace } = fixture(t)
  createAuthorized(store, 3)
  const attempt = store.mutate((state) => beginAttempt(state, 'job'))
  assert.equal(attempt.status, 'dispatching')
  assert.equal(attempt.queuedSubmissionId, null)
  const restarted = new ExecutionStore(workspace)
  assert.equal(restarted.snapshot().jobs.job.attempts[0].id, attempt.id)
  expectError('JOB_STATUS', () => restarted.mutate((state) => beginAttempt(state, 'job')))
  restarted.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, expectedStatus: 'dispatching', status: 'uncertain', threadId: 'native-thread', result: { summary: 'Submission response was interrupted; inspect native receipts.' } }))
  expectError('JOB_STATUS', () => restarted.mutate((state) => beginAttempt(state, 'job')))
  expectError('STALE_ATTEMPT', () => restarted.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: 'other-attempt', status: 'running' })))
  expectError('STALE_ATTEMPT', () => restarted.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, expectedStatus: 'dispatching', status: 'running' })))
  restarted.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, expectedStatus: 'uncertain', status: 'running', queuedSubmissionId: 'queued-receipt', turnId: 'native-turn' }))
  expectError('RECEIPT_CONFLICT', () => restarted.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'running', turnId: 'different-turn' })))
  restarted.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'verifying', result: { summary: 'Native turn completed.', status: 'completed' } }))
  expectError('INVALID_EXECUTION', () => restarted.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'succeeded' })))
  restarted.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'succeeded', verification: { passed: true, checks: [{ kind: 'file', passed: true }] } }))
  assert.equal(restarted.snapshot().jobs.job.status, 'succeeded')
  expectError('JOB_STATUS', () => restarted.mutate((state) => beginAttempt(state, 'job')))
  expectError('RECEIPT_IMMUTABLE', () => restarted.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'succeeded', result: { summary: 'Replaced receipt.' } })))
  expectError('RECEIPT_IMMUTABLE', () => restarted.mutate((state) => { state.jobs.job.verification.checks[0].summary = 'Changed a terminal verification.' }))
})

test('succeeded requires a completed current turn and matching successful verification receipts', (t) => {
  const { store, statePath } = fixture(t)
  createAuthorized(store)
  const attempt = store.mutate((state) => beginAttempt(state, 'job'))
  store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'verifying' }))
  const validChecks = { passed: true, checks: [{ kind: 'file', passed: true }] }
  expectError('INVALID_EXECUTION', () => store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'succeeded', verification: validChecks })))
  store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'verifying', turnId: 'native-turn', result: { status: 'failed', summary: 'The native turn failed.' } }))
  expectError('INVALID_EXECUTION', () => store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'succeeded', verification: validChecks })))
  store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'verifying', result: { status: 'completed', summary: 'Native completion received.' } }))
  const before = fs.readFileSync(statePath, 'utf8')
  for (const verification of [{ summary: 'Success' }, { passed: false, checks: [{ passed: true }] }, { passed: true, checks: [] }, { passed: true, checks: [{ passed: false }] }, { passed: true, checks: [{ passed: true }, { passed: true }] }]) {
    expectError('INVALID_EXECUTION', () => store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'succeeded', verification })))
  }
  assert.equal(fs.readFileSync(statePath, 'utf8'), before)
  store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'succeeded', verification: validChecks, result: { ...state.jobs.job.attempts.at(-1).result, checkpointSequence: 3 } }))
  assert.equal(store.snapshot().jobs.job.attempts[0].result.status, 'completed')
  assert.equal(store.snapshot().jobs.job.attempts[0].result.checkpointSequence, 3)
})

test('failed artifact directories and symlinks do not prevent receipt recovery or cancellation', (t) => {
  for (const artifact of ['directory', 'symlink']) {
    const { store, workspace } = fixture(t)
    const job = createAuthorized(store)
    const attempt = store.mutate((state) => beginAttempt(state, 'job'))
    const target = path.join(workspace, 'report.txt')
    if (artifact === 'directory') fs.mkdirSync(target)
    else fs.symlinkSync(path.join(workspace, 'outside-file'), target)
    assert.equal(new ExecutionStore(workspace).snapshot().jobs.job.digest, job.digest)
    assert.equal(store.mutate((state) => propose(state, { jobId: 'job', taskId: 'task', proposal: proposal() })).digest, job.digest)
    expectError('UNSAFE_PATH', () => resolveWorkspaceFile(workspace, 'report.txt'))
    store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'failed', result: { status: 'completed', summary: 'Native execution completed but produced an unsafe artifact.' }, verification: { passed: false, checks: [{ kind: 'file', passed: false, reason: 'Unsafe artifact path.' }] } }))
    store.mutate((state) => cancel(state, 'job'))
    assert.equal(store.snapshot().jobs.job.status, 'cancelled')
    assert.equal(store.snapshot().jobs.job.attempts[0].status, 'failed')
  }
})

test('only confirmed failure permits a bounded new attempt and previous terminal receipts remain unchanged', (t) => {
  const { store } = fixture(t)
  createAuthorized(store, 2)
  const first = store.mutate((state) => beginAttempt(state, 'job'))
  store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: first.id, status: 'failed', result: { summary: 'Verification failed.', retryable: true } }))
  const failed = store.snapshot().jobs.job.attempts[0]
  const second = store.mutate((state) => beginAttempt(state, 'job'))
  assert.equal(second.number, 2)
  assert.notEqual(second.id, first.id)
  assert.deepEqual(store.snapshot().jobs.job.attempts[0], failed)
  expectError('STALE_ATTEMPT', () => store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: first.id, status: 'failed' })))
  store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: second.id, status: 'needs-user-action', result: { summary: 'Host needs user approval.' } }))
  expectError('JOB_STATUS', () => store.mutate((state) => beginAttempt(state, 'job')))
  store.mutate((state) => cancel(state, 'job'))
  assert.equal(store.snapshot().jobs.job.status, 'cancelling')
  assert.equal(store.snapshot().jobs.job.attempts[1].status, 'cancelling')
  expectError('JOB_STATUS', () => store.mutate((state) => beginAttempt(state, 'job')))
  store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: second.id, status: 'cancelled', result: { status: 'interrupted', summary: 'Native interruption confirmed.' } }))
  assert.equal(store.snapshot().jobs.job.status, 'cancelled')
})

test('active cancellation stays nonterminal until receipt reconciliation and repeated intent is idempotent', (t) => {
  const { store, workspace, statePath } = fixture(t)
  createAuthorized(store, 2)
  const attempt = store.mutate((state) => beginAttempt(state, 'job'))
  expectError('JOB_STATUS', () => store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'cancelled' })))
  store.mutate((state) => cancel(state, 'job'))
  assert.equal(store.snapshot().jobs.job.status, 'cancelling')
  const beforeRetry = fs.readFileSync(statePath, 'utf8')
  store.mutate((state) => cancel(state, 'job'))
  assert.equal(fs.readFileSync(statePath, 'utf8'), beforeRetry)
  expectError('JOB_STATUS', () => store.mutate((state) => beginAttempt(state, 'job')))
  const restarted = new ExecutionStore(workspace)
  restarted.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, expectedStatus: 'cancelling', status: 'cancelling', threadId: 'native-thread', queuedSubmissionId: 'late-queue', turnId: 'late-turn', result: { status: 'interrupted', summary: 'Late native receipt confirms interruption.' } }))
  assert.equal(restarted.snapshot().jobs.job.attempts[0].turnId, 'late-turn')
  restarted.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, expectedStatus: 'cancelling', status: 'cancelled' }))
  assert.equal(restarted.snapshot().jobs.job.status, 'cancelled')
  assert.equal(restarted.snapshot().jobs.job.attempts[0].result.status, 'interrupted')
  expectError('JOB_STATUS', () => restarted.mutate((state) => beginAttempt(state, 'job')))
})

test('an unconfirmed cancellation becomes uncertain and cannot dispatch another attempt', (t) => {
  const { store } = fixture(t)
  createAuthorized(store, 2)
  const attempt = store.mutate((state) => beginAttempt(state, 'job'))
  store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'running', threadId: 'native-thread', turnId: 'native-turn' }))
  store.mutate((state) => cancel(state, 'job'))
  expectError('JOB_STATUS', () => store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'verifying' })))
  store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'uncertain', result: { summary: 'Transport failed before native interruption could be confirmed.' } }))
  assert.equal(store.snapshot().jobs.job.status, 'uncertain')
  expectError('JOB_STATUS', () => store.mutate((state) => beginAttempt(state, 'job')))
  store.mutate((state) => cancel(state, 'job'))
  assert.equal(store.snapshot().jobs.job.status, 'cancelling')
})

test('cancelling a failed job preserves the terminal attempt receipt and disables further dispatch', (t) => {
  const { store } = fixture(t)
  createAuthorized(store, 2)
  const first = store.mutate((state) => beginAttempt(state, 'job'))
  store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: first.id, status: 'failed', result: { summary: 'First attempt failed.' } }))
  const receipt = store.snapshot().jobs.job.attempts[0]
  store.mutate((state) => cancel(state, 'job'))
  assert.deepEqual(store.snapshot().jobs.job.attempts[0], receipt)
  assert.equal(store.snapshot().jobs.job.status, 'cancelled')
})

test('proposal validators bound instructions, checks, argv and paths without interpreting a shell', (t) => {
  const { workspace } = fixture(t)
  const valid = validateProposal(proposal({ verification: [{ kind: 'command', argv: ['node', '-e', 'console.log("a;b")'] }] }), workspace)
  assert.equal(valid.verification[0].argv[2], 'console.log("a;b")')
  for (const changes of [
    { instruction: 'x'.repeat(8001) }, { successCriteria: [] }, { successCriteria: Array(9).fill('criterion') },
    { verification: [] }, { verification: Array(21).fill({ kind: 'file', path: 'report.txt' }) },
    { timeoutMs: 999 }, { timeoutMs: 600001 }, { maxAttempts: 4 }, { model: 'x'.repeat(129) },
    { verification: [{ kind: 'shell', command: 'echo unsafe' }] },
    { verification: [{ kind: 'command', argv: [] }] },
    { verification: [{ kind: 'command', argv: Array(33).fill('argument') }] },
    { verification: [{ kind: 'command', argv: ['node', 'x'.repeat(8000)] }] },
    { verification: [{ kind: 'file', path: 'report.txt', sha256: 'invalid' }] },
  ]) expectError('INVALID_EXECUTION', () => validateProposal(proposal(changes), workspace))
  for (const relativePath of ['../escape', '/absolute', 'a/../escape', 'a//b', './report.txt', 'a\\b']) expectError('UNSAFE_PATH', () => validateProposal(proposal({ verification: [{ kind: 'file', path: relativePath }] }), workspace))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.symlinkSync(outside, path.join(workspace, 'linked'))
  expectError('UNSAFE_PATH', () => resolveWorkspaceFile(workspace, 'linked/report.txt'))
  fs.mkdirSync(path.join(workspace, 'directory'))
  expectError('UNSAFE_PATH', () => resolveWorkspaceFile(workspace, 'directory'))
})

test('receipt metadata rejects credentials, raw logs and oversized structures without changing the state', (t) => {
  const { store, statePath } = fixture(t)
  createAuthorized(store)
  const attempt = store.mutate((state) => beginAttempt(state, 'job'))
  const before = fs.readFileSync(statePath, 'utf8')
  for (const result of [{ stdout: 'raw output' }, { messages: [] }, { summary: 'assistant: raw transcript' }]) expectError('RAW_LOG_INPUT', () => store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'running', result })))
  const sensitive = ['api_key', 'synthetic-private-value'].join('=')
  expectError('SENSITIVE_INPUT', () => store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'running', result: { summary: sensitive } })))
  expectError('INVALID_EXECUTION', () => store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'running', result: { summary: 'first\nsecond' } })))
  expectError('SIZE_LIMIT', () => store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'running', result: { summaries: Array(10).fill('x'.repeat(2000)) } })))
  expectError('SIZE_LIMIT', () => store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'running', result: { nested: { a: { b: { c: { d: { e: { tooDeep: true } } } } } } } })))
  assert.equal(fs.readFileSync(statePath, 'utf8'), before)
})

test('unknown or corrupt schema, modified digests and workspace bindings are refused on every snapshot', (t) => {
  const { store, statePath } = fixture(t)
  store.mutate((state) => propose(state, { jobId: 'job', taskId: 'task', proposal: proposal() }))
  const valid = store.snapshot()
  for (const [changed, code] of [
    [{ ...valid, schemaVersion: 2 }, 'UNKNOWN_SCHEMA'],
    [{ ...valid, workspace: '/other-workspace' }, 'WORKSPACE_BINDING'],
    [{ ...valid, jobs: { job: { ...valid.jobs.job, digest: 'a'.repeat(64) } } }, 'PROPOSAL_DIGEST'],
    [{ ...valid, jobs: { job: { ...valid.jobs.job, status: 'running' } } }, 'AUTHORIZATION'],
    [{ ...valid, unknown: true }, 'INVALID_EXECUTION'],
  ]) {
    fs.writeFileSync(statePath, JSON.stringify(changed))
    expectError(code, () => store.snapshot())
    expectError(code, () => store.mutate(() => undefined))
  }
  fs.writeFileSync(statePath, '{broken')
  expectError('INVALID_JSON', () => store.snapshot())
  fs.writeFileSync(statePath, ' '.repeat(1024 * 1024 + 1))
  expectError('SIZE_LIMIT', () => store.snapshot())
})

test('transactions reject async waits, audit deletion, forged attempts and preserve supervisor state.v1', (t) => {
  const { store, workspace, statePath } = fixture(t)
  createAuthorized(store)
  const supervisorState = path.join(workspace, '.codex', 'supervisor', 'state.v1.json')
  fs.writeFileSync(supervisorState, '{"independent":"supervisor-state"}\n')
  const before = fs.readFileSync(statePath, 'utf8')
  expectError('ASYNC_TRANSACTION', () => store.mutate(async () => undefined))
  expectError('ASYNC_TRANSACTION', () => store.mutate(() => Promise.resolve()))
  expectError('EXECUTION_IMMUTABLE', () => store.mutate((state) => { delete state.jobs.job }))
  expectError('AUTHORIZATION', () => store.mutate((state) => {
    state.jobs.job.status = 'dispatching'
    state.jobs.job.attempts.push({ id: 'forged-attempt', number: 1, status: 'dispatching', intentAt: Date.now(), queuedSubmissionId: null, turnId: null })
  }))
  expectError('INVALID_EXECUTION', () => store.mutate((state) => {
    beginAttempt(state, 'job')
    return () => 'uncloneable transaction result'
  }))
  assert.equal(fs.readFileSync(statePath, 'utf8'), before)
  assert.equal(fs.readFileSync(supervisorState, 'utf8'), '{"independent":"supervisor-state"}\n')
})

test('execution writes reject another writer and recover only after lock release', async (t) => {
  const { store, workspace, statePath } = fixture(t)
  store.mutate((state) => propose(state, { jobId: 'job', taskId: 'task', proposal: proposal() }))
  const before = fs.readFileSync(statePath, 'utf8')
  const release = path.join(workspace, 'release-lock')
  const code = `import fs from 'node:fs'; import { ExecutionStore } from ${JSON.stringify(moduleURL)}; new ExecutionStore(${JSON.stringify(workspace)}).mutate(() => { process.stdout.write('ready\\n'); const deadline=Date.now()+15000; while(!fs.existsSync(${JSON.stringify(release)}) && Date.now()<deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); });`
  const holder = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })
  const done = new Promise((resolve, reject) => { holder.on('error', reject); holder.on('close', resolve) })
  await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.on('error', reject); holder.on('exit', (code) => { if (code !== 0) reject(new Error(`Lock holder failed: ${code}`)) }) })
  try {
    expectError('LOCKED', () => store.mutate(() => undefined))
    assert.equal(fs.readFileSync(statePath, 'utf8'), before)
  } finally { fs.writeFileSync(release, 'release') }
  assert.equal(await done, 0)
  store.mutate((state) => authorize(state, { jobId: 'job', digest: state.jobs.job.digest }))
  assert.equal(fs.existsSync(path.join(workspace, '.codex', 'supervisor', '.execution.lock')), false)
})

test('execution store symlinks and ancestor symlinks are rejected before reads or writes', (t) => {
  for (const relativePath of ['.codex', '.codex/supervisor', '.codex/supervisor/execution.v1.json', '.codex/supervisor/.execution.lock']) {
    const { store, workspace } = fixture(t)
    store.mutate((state) => propose(state, { jobId: 'job', taskId: 'task', proposal: proposal() }))
    const target = path.join(workspace, relativePath)
    const outside = path.join(workspace, 'outside')
    if (relativePath.endsWith('.json') || relativePath.endsWith('.lock')) fs.writeFileSync(outside, '{}')
    else fs.mkdirSync(outside)
    fs.rmSync(target, { recursive: true, force: true })
    fs.symlinkSync(outside, target)
    expectError('UNSAFE_PATH', () => store.snapshot())
    expectError('UNSAFE_PATH', () => store.mutate(() => undefined))
  }
})

test('runner claims and releases require helper-minted tokens and retain ordinary job operations', (t) => {
  const { store, statePath } = fixture(t)
  const lease = acquireRunner(store)
  assert.equal(lease.pid, process.pid)
  assert.equal(store.snapshot().runner.token, lease.token)
  expectError('RUNNER_BUSY', () => acquireRunner(store))
  const originalKill = process.kill
  try {
    process.kill = () => { throw Object.assign(new Error('synthetic permission denial'), { code: 'EPERM' }) }
    expectError('RUNNER_BUSY', () => acquireRunner(store))
  } finally { process.kill = originalKill }
  expectError('RUNNER_TOKEN', () => releaseRunner(store, randomUUID()))
  expectError('RUNNER_TOKEN', () => store.mutate((state) => { state.runner = null }))
  expectError('RUNNER_TOKEN', () => store.mutate((state) => { state.runner.token = randomUUID() }))
  const job = store.mutate((state) => propose(state, { jobId: 'while-running', taskId: 'task', proposal: proposal() }))
  store.mutate((state) => authorize(state, { jobId: 'while-running', digest: job.digest }))
  store.mutate((state) => cancel(state, 'while-running'))
  assert.equal(store.snapshot().runner.token, lease.token)
  assert.equal(releaseRunner(store, lease.token), true)
  assert.equal(store.snapshot().runner, null)
  const before = fs.readFileSync(statePath, 'utf8')
  assert.equal(releaseRunner(store, lease.token), false)
  assert.equal(fs.readFileSync(statePath, 'utf8'), before)
  expectError('RUNNER_TOKEN', () => store.mutate((state) => { state.runner = { pid: process.pid, token: randomUUID() } }))
  const missing = store.snapshot()
  delete missing.runner
  fs.writeFileSync(statePath, JSON.stringify(missing))
  expectError('INVALID_EXECUTION', () => store.snapshot())
})

function spawnRunner(workspace, releaseFile) {
  const code = `import fs from 'node:fs'; import { ExecutionStore, acquireRunner, releaseRunner } from ${JSON.stringify(moduleURL)}; const store = new ExecutionStore(${JSON.stringify(workspace)}); let lease; try { lease=acquireRunner(store); process.stdout.write(JSON.stringify({lease})+'\\n'); const deadline=Date.now()+15000; while(!fs.existsSync(${JSON.stringify(releaseFile)}) && Date.now()<deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); releaseRunner(store,lease.token); } catch(error) { process.stdout.write(JSON.stringify({error:error.code})+'\\n'); }`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code) => resolve(code)) })
  const ready = new Promise((resolve, reject) => {
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
      if (output.includes('\n')) {
        try { resolve(JSON.parse(output.slice(0, output.indexOf('\n')))) } catch (error) { reject(error) }
      }
    })
    child.on('error', reject)
    child.on('exit', (code) => { if (code !== 0) reject(new Error(`Runner child failed: ${code}`)) })
  })
  return { child, ready, done }
}

test('actual separate runner processes contend while short store transactions remain available', async (t) => {
  const { workspace, store } = fixture(t)
  const release = path.join(workspace, 'release-runner')
  const first = spawnRunner(workspace, release)
  t.after(() => first.child.kill())
  const firstResult = await first.ready
  assert.equal(firstResult.lease.pid, first.child.pid)
  const second = spawnRunner(workspace, release)
  t.after(() => second.child.kill())
  try {
    assert.equal((await second.ready).error, 'RUNNER_BUSY')
    assert.equal(await second.done, 0)
    expectError('RUNNER_BUSY', () => acquireRunner(store))
    store.mutate((state) => propose(state, { jobId: 'available', taskId: 'task', proposal: proposal() }))
    assert.equal(store.snapshot().jobs.available.status, 'proposed')
    assert.equal(fs.existsSync(path.join(workspace, '.codex', 'supervisor', '.execution.lock')), false)
  } finally { fs.writeFileSync(release, 'release') }
  assert.equal(await first.done, 0)
  assert.equal(store.snapshot().runner, null)
})

test('a dead runner PID can be recovered by only one of two concurrent claimant processes', async (t) => {
  const { workspace, store } = fixture(t)
  const oldRelease = path.join(workspace, 'old-release')
  const original = spawnRunner(workspace, oldRelease)
  t.after(() => original.child.kill())
  const deadLease = (await original.ready).lease
  original.child.kill('SIGKILL')
  await original.done
  expectError('ESRCH', () => process.kill(deadLease.pid, 0))
  assert.equal(store.snapshot().runner.token, deadLease.token)
  const release = path.join(workspace, 'release-recovered')
  const contenders = [spawnRunner(workspace, release), spawnRunner(workspace, release)]
  t.after(() => contenders.forEach(({ child }) => child.kill()))
  try {
    const outcomes = await Promise.all(contenders.map(({ ready }) => ready))
    const winners = outcomes.filter((outcome) => outcome.lease)
    const losers = outcomes.filter((outcome) => outcome.error)
    assert.equal(winners.length, 1)
    assert.equal(losers.length, 1)
    assert.ok(['RUNNER_BUSY', 'LOCKED'].includes(losers[0].error))
    assert.notEqual(winners[0].lease.token, deadLease.token)
    assert.equal(store.snapshot().runner.token, winners[0].lease.token)
    expectError('RUNNER_BUSY', () => acquireRunner(store))
  } finally { fs.writeFileSync(release, 'release') }
  assert.deepEqual(await Promise.all(contenders.map(({ done }) => done)), [0, 0])
  assert.equal(store.snapshot().runner, null)
  const lease = acquireRunner(store)
  assert.equal(lease.pid, process.pid)
  releaseRunner(store, lease.token)
})
