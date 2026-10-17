import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ExecutionStore, acquireRunner, releaseRunner, beginAttempt, updateAttempt } from '../plugins/codex-supervisor/scripts/execution-store.mjs'
import { run, runJob, recoverJob } from '../plugins/codex-supervisor/scripts/execution.mjs'
import { run as supervisor } from '../plugins/codex-supervisor/scripts/supervisor.mjs'
import { verify } from '../plugins/codex-supervisor/scripts/verification.mjs'

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-execution-chain-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  supervisor(['init', '--workspace', workspace])
  supervisor(['assign', '--workspace', workspace, '--task', 'task'])
  const store = new ExecutionStore(workspace)
  return {
    workspace, store,
    job: (jobId = 'job') => store.snapshot().jobs[jobId],
    roster: () => supervisor(['status', '--workspace', workspace, '--task', 'task']),
  }
}

function specification(changes = {}) {
  return { instruction: 'Write an accepted report inside this workspace.', successCriteria: ['The report contains the accepted content.'], verification: [{ kind: 'file', path: 'report.txt', contains: 'accepted' }], ...changes }
}

async function addJob(f, { jobId = 'job', authorized = true, ...changes } = {}) {
  const input = path.join(f.workspace, `${jobId}-proposal.json`)
  fs.writeFileSync(input, JSON.stringify(specification(changes)))
  const proposed = await run(['propose', '--workspace', f.workspace, '--task', 'task', '--job', jobId, '--input', input])
  if (authorized) await run(['authorize', '--workspace', f.workspace, '--job', jobId, '--digest', proposed.digest])
  return proposed
}

async function callbacks(options, turn = 'native-turn-1') {
  const threadId = options.threadId || 'owned-native-thread'
  await options.onThread?.({ threadId })
  await options.onDispatch?.()
  await options.onQueued?.({ threadId, queuedSubmissionId: `queue-${options.marker}` })
  await options.onStarted?.({ threadId, turnId: turn })
  return { status: 'completed', threadId, turnId: turn }
}

function actualVerification(commandVerifier, observe) {
  return async (workspace, checks, options = {}) => {
    observe?.({ workspace, checks, options })
    return verify(workspace, checks, { ...options, ...(commandVerifier ? { commandVerifier } : {}) })
  }
}

function inspection(f, changes = {}) {
  const job = f.job()
  const attempt = job.attempts.at(-1)
  return { threadId: job.threadId, marker: attempt.id, turnId: attempt.turnId, state: 'idle', status: 'completed', latestTurnId: attempt.turnId, queuedCount: 0, queuedSubmissionIds: [], activeGoal: null, ...changes }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function onAbort(signal, result) {
  if (signal.aborted) return Promise.resolve(result)
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(result), { once: true }))
}

test('a suggestion without explicit authorization cannot dispatch or mutate the ordinary task', async (t) => {
  const f = fixture(t)
  await addJob(f, { authorized: false })
  let dispatches = 0
  await assert.rejects(runJob(f.store, 'job', { execute: async () => { dispatches += 1 } }), (error) => error.code === 'NOT_RUNNABLE')
  assert.equal(dispatches, 0)
  assert.equal(f.job().attempts.length, 0)
  assert.equal(f.job().authorization, null)
  assert.equal(f.store.snapshot().runner, null)
  assert.equal(f.roster().checkpointSequence, 0)
})

test('agent completion claims cannot replace independent artifact acceptance', async (t) => {
  for (const artifact of ['missing', 'wrong-content', 'directory', 'symlink']) {
    const f = fixture(t)
    await addJob(f)
    let dispatches = 0
    const result = await runJob(f.store, 'job', {
      execute: async (options) => {
        dispatches += 1
        const receipt = await callbacks(options)
        const target = path.join(f.workspace, 'report.txt')
        if (artifact === 'wrong-content') fs.writeFileSync(target, 'not the expected result')
        if (artifact === 'directory') fs.mkdirSync(target)
        if (artifact === 'symlink') fs.symlinkSync(path.join(f.workspace, 'outside-report'), target)
        return { ...receipt, summary: 'All requested work is complete.' }
      },
      verify: actualVerification(),
    })
    assert.equal(result.status, 'failed', artifact)
    assert.equal(dispatches, 1)
    assert.equal(result.verification.passed, false)
    assert.equal(result.verification.checks[0].passed, false)
    assert.equal(f.job().attempts[0].result.status, 'completed')
    assert.equal(f.roster().checkpointSequence, 0)
  }
})

test('accepted execution writes a durable progress checkpoint without completing the parent task', async (t) => {
  const f = fixture(t)
  await addJob(f, { model: 'explicit-host-model' })
  let request
  const result = await runJob(f.store, 'job', {
    execute: async (options) => {
      request = options
      const receipt = await callbacks(options)
      fs.writeFileSync(path.join(f.workspace, 'report.txt'), 'accepted result')
      return receipt
    },
    verify: actualVerification(),
  })
  assert.equal(result.status, 'succeeded')
  assert.equal(request.workspace, fs.realpathSync(f.workspace))
  assert.equal(request.model, 'explicit-host-model')
  assert.equal(request.marker, f.job().attempts[0].id)
  assert.match(request.prompt, /already-authorized project task/)
  assert.equal(result.verification.checks[0].bytes, Buffer.byteLength('accepted result'))
  const roster = f.roster()
  assert.equal(roster.latestCheckpoint.data.outcome, 'progress')
  assert.equal(roster.latestCheckpoint.data.remaining.length, 1)
  assert.match(roster.latestCheckpoint.data.remaining[0], /parent task/)
  assert.equal(f.job().attempts[0].result.checkpointSequence, roster.checkpointSequence)
  assert.equal(f.store.snapshot().runner, null)
  const repeated = await runJob(f.store, 'job', { execute: async () => { assert.fail('accepted jobs cannot dispatch again') } })
  assert.equal(repeated.status, 'succeeded')
  assert.equal(f.roster().checkpointSequence, roster.checkpointSequence)
})

test('execution forwards authorized reasoning and persists only confirmed selection through verification', async (t) => {
  const f = fixture(t)
  await addJob(f, { model: 'selected-model', reasoningEffort: 'high' })
  const selection = { model: 'selected-model', reasoningEffort: 'high' }
  const result = await runJob(f.store, 'job', {
    execute: async options => {
      assert.equal(options.model, 'selected-model')
      assert.equal(options.reasoningEffort, 'high')
      const threadId = 'owned-native-thread'
      await options.onThread({ threadId })
      assert.equal(f.job().attempts[0].result?.selection, undefined)
      await options.onDispatch({ selection })
      assert.deepEqual(f.job().attempts[0].result.selection, selection)
      await options.onQueued({ threadId, queuedSubmissionId: 'queue-receipt' })
      await options.onStarted({ threadId, turnId: 'completed-turn' })
      fs.writeFileSync(path.join(f.workspace, 'report.txt'), 'accepted')
      return { status: 'completed', threadId, turnId: 'completed-turn', selection, summary: 'PRIVATE_TRANSCRIPT' }
    },
    verify: actualVerification(undefined, () => { assert.deepEqual(f.job().attempts[0].result.selection, selection) }),
  })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.attempts[0].result.selection, selection)
  assert.deepEqual(new ExecutionStore(f.workspace).snapshot().jobs.job.attempts[0].result.selection, selection)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TRANSCRIPT/)
})

test('cancelled execution retains its confirmed native model and reasoning receipt', async (t) => {
  const f = fixture(t)
  await addJob(f, { model: 'selected-model', reasoningEffort: 'low' })
  const selection = { model: 'selected-model', reasoningEffort: 'low' }
  const controller = new AbortController()
  const result = await runJob(f.store, 'job', {
    signal: controller.signal,
    execute: async options => {
      const receipt = await callbacks({ ...options, onDispatch: () => options.onDispatch({ selection }) })
      controller.abort()
      return { ...receipt, status: 'interrupted', selection }
    },
  })
  assert.equal(result.status, 'cancelled')
  assert.deepEqual(result.attempts[0].result.selection, selection)
})

test('only proven failed acceptance permits retry within the original approved attempt cap', async (t) => {
  const f = fixture(t)
  await addJob(f, { maxAttempts: 2 })
  const requests = []
  const result = await runJob(f.store, 'job', {
    execute: async (options) => {
      requests.push(options)
      const receipt = await callbacks(options, `native-turn-${requests.length}`)
      fs.writeFileSync(path.join(f.workspace, 'report.txt'), requests.length === 1 ? 'wrong' : 'accepted')
      return receipt
    },
    verify: actualVerification(),
  })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.attempts.length, 2)
  assert.equal(result.attempts[0].status, 'failed')
  assert.equal(requests[1].expectedPreviousTurnId, 'native-turn-1')
  assert.equal(requests[1].threadId, result.threadId)
  assert.notEqual(requests[0].marker, requests[1].marker)
  assert.equal(f.job().authorization.maxAttempts, 2)
  const capped = fixture(t)
  const proposed = await addJob(capped, { maxAttempts: 2 })
  let dispatches = 0
  const failEveryTime = async (options) => { dispatches += 1; return callbacks(options, `failed-turn-${dispatches}`) }
  assert.equal((await runJob(capped.store, 'job', { execute: failEveryTime, verify: actualVerification() })).status, 'failed')
  assert.equal(dispatches, 2)
  await run(['authorize', '--workspace', capped.workspace, '--job', 'job', '--digest', proposed.digest])
  await assert.rejects(runJob(capped.store, 'job', { execute: failEveryTime }), (error) => error.code === 'ATTEMPT_LIMIT')
  assert.equal(dispatches, 2)
  assert.equal(capped.job().attempts.length, 2)
})

test('command acceptance uses explicit argv and only retains structured evidence; approval blocks retries', async (t) => {
  const f = fixture(t)
  const argv = ['node', '--test', 'tests with spaces.js']
  await addJob(f, { maxAttempts: 3, verification: [{ kind: 'command', argv, timeoutMs: 4000 }] })
  let dispatches = 0
  let received
  const result = await runJob(f.store, 'job', {
    execute: async (options) => { dispatches += 1; return callbacks(options) },
    verify: actualVerification(async (options) => {
      received = options
      return { status: 'needs-user-action', completionConfirmed: true, needsUserAction: true, exitCode: null, stdout: 'raw-native-output-content', outputBytes: 25 }
    }),
  })
  assert.equal(result.status, 'needs-user-action')
  assert.equal(dispatches, 1)
  assert.deepEqual(received.argv, argv)
  assert.equal(received.timeoutMs, 4000)
  assert.equal(result.verification.checks[0].needsUserAction, true)
  assert.doesNotMatch(JSON.stringify(f.store.snapshot()), /raw-native-output-content|"stdout"/)
  await assert.rejects(runJob(f.store, 'job', { execute: async () => { assert.fail('pending approval cannot retry') } }), (error) => error.code === 'NOT_RUNNABLE')
})

test('ambiguous dispatch never replays and completed recovery requires every correlation and inertness gate', async (t) => {
  const f = fixture(t)
  await addJob(f, { maxAttempts: 3 })
  let dispatches = 0
  let verifications = 0
  const first = await runJob(f.store, 'job', {
    execute: async (options) => {
      dispatches += 1
      await callbacks(options)
      fs.writeFileSync(path.join(f.workspace, 'report.txt'), 'accepted')
      throw new Error('synthetic response interruption')
    },
    verify: actualVerification(undefined, () => { verifications += 1 }),
  })
  assert.equal(first.status, 'uncertain')
  assert.equal(verifications, 0)
  await assert.rejects(runJob(f.store, 'job', { execute: async () => { dispatches += 1 } }), (error) => error.code === 'NOT_RUNNABLE')
  const guards = [
    { threadId: 'unrelated-thread' }, { marker: 'unrelated-marker' }, { turnId: 'unrelated-turn' },
    { state: 'busy' }, { latestTurnId: 'another-later-turn' },
    { queuedCount: 1, queuedSubmissionIds: [] }, { queuedCount: 0, queuedSubmissionIds: ['pending-queue'] },
    { activeGoal: { id: 'active-native-goal' } }, { status: 'inProgress' },
  ]
  for (const changes of guards) {
    const recovered = await recoverJob(f.store, 'job', { inspect: async () => inspection(f, changes), verify: actualVerification(undefined, () => { verifications += 1 }) })
    assert.equal(recovered.status, 'uncertain', JSON.stringify(changes))
    assert.equal(recovered.attempts.length, 1)
  }
  assert.equal(dispatches, 1)
  assert.equal(verifications, 0)
  const recovered = await recoverJob(f.store, 'job', { inspect: async () => inspection(f), verify: actualVerification(undefined, () => { verifications += 1 }) })
  assert.equal(recovered.status, 'succeeded')
  assert.equal(recovered.attempts.length, 1)
  assert.equal(dispatches, 1)
  assert.equal(verifications, 1)
  assert.equal(f.roster().latestCheckpoint.data.outcome, 'progress')
})

test('acknowledged native transport diagnostics survive inconclusive and terminal recovery without replay', async (t) => {
  const f = fixture(t)
  await addJob(f)
  const transport = { code: 'NATIVE_RPC', rpcMethod: 'thread/read', rpcCode: -32000 }
  const nativeError = { type: 'httpConnectionFailed', httpStatusCode: 503 }
  let dispatches = 0
  const initial = await runJob(f.store, 'job', {
    execute: async (options) => {
      dispatches += 1
      const receipt = await callbacks(options)
      return { ...receipt, status: 'uncertain', transport, nativeError }
    },
    verify: async () => { assert.fail('an uncertain native response cannot run acceptance') },
  })
  assert.equal(initial.status, 'uncertain')
  assert.deepEqual(initial.attempts[0].result.transport, transport)
  assert.deepEqual(initial.attempts[0].result.nativeError, nativeError)
  const restarted = new ExecutionStore(f.workspace)
  const inconclusive = await recoverJob(restarted, 'job', {
    inspect: async () => inspection(f, { state: 'uncertain', status: null }),
    verify: async () => { assert.fail('inconclusive recovery cannot run acceptance') },
  })
  assert.equal(inconclusive.status, 'uncertain')
  assert.deepEqual(inconclusive.attempts[0].result.transport, transport)
  assert.deepEqual(inconclusive.attempts[0].result.nativeError, nativeError)
  const terminalError = { type: 'sandboxError' }
  const terminal = await recoverJob(restarted, 'job', { inspect: async () => inspection(f, { status: 'failed', nativeError: terminalError }) })
  assert.equal(terminal.status, 'failed')
  assert.deepEqual(terminal.attempts[0].result.transport, transport)
  assert.deepEqual(terminal.attempts[0].result.nativeError, terminalError)
  assert.equal(terminal.attempts.length, 1)
  assert.equal(dispatches, 1)
})

test('missing durable thread and unresolved workspace work block recovery verification and new dispatch', async (t) => {
  const f = fixture(t)
  await addJob(f)
  assert.equal((await runJob(f.store, 'job', { execute: async () => { throw new Error('interrupted before a durable thread receipt') } })).status, 'uncertain')
  let inspected = 0
  const recovered = await recoverJob(f.store, 'job', { inspect: async () => { inspected += 1 }, verify: async () => { assert.fail('unknown native thread cannot verify') } })
  assert.equal(recovered.status, 'uncertain')
  assert.equal(inspected, 0)
  await addJob(f, { jobId: 'other-job' })
  await assert.rejects(runJob(f.store, 'other-job', { execute: async () => { assert.fail('unresolved native work blocks another job') } }), (error) => error.code === 'UNRESOLVED_EXECUTION')
  assert.equal(f.job('other-job').attempts.length, 0)
})

test('a queue-acceptance crash window recovers by the original marker without replaying the suggestion', async (t) => {
  const f = fixture(t)
  await addJob(f, { maxAttempts: 3 })
  let dispatches = 0
  await runJob(f.store, 'job', {
    execute: async (options) => {
      dispatches += 1
      await options.onThread({ threadId: 'owned-native-thread' })
      await options.onDispatch()
      await options.onQueued({ threadId: 'owned-native-thread', queuedSubmissionId: 'durable-queue' })
      throw new Error('synthetic process loss before start acknowledgement')
    },
  })
  assert.equal(f.job().status, 'uncertain')
  assert.equal(f.job().attempts[0].turnId, null)
  const pending = await recoverJob(f.store, 'job', { inspect: async () => inspection(f, { queuedCount: 1, queuedSubmissionIds: ['durable-queue'], state: 'busy' }), verify: async () => { assert.fail('pending queue cannot verify') } })
  assert.equal(pending.status, 'uncertain')
  fs.writeFileSync(path.join(f.workspace, 'report.txt'), 'accepted')
  const recovered = await recoverJob(f.store, 'job', { inspect: async () => inspection(f, { turnId: 'marker-matched-turn', latestTurnId: 'marker-matched-turn' }), verify: actualVerification() })
  assert.equal(recovered.status, 'succeeded')
  assert.equal(recovered.attempts[0].turnId, 'marker-matched-turn')
  assert.equal(recovered.attempts[0].queuedSubmissionId, 'durable-queue')
  assert.equal(recovered.attempts.length, 1)
  assert.equal(dispatches, 1)
})

test('a held runner lease excludes run and recover throughout native waits while status remains available', async (t) => {
  const f = fixture(t)
  await addJob(f)
  const started = deferred()
  const finish = deferred()
  const running = runJob(f.store, 'job', {
    execute: async (options) => {
      const receipt = await callbacks(options)
      started.resolve()
      await finish.promise
      fs.writeFileSync(path.join(f.workspace, 'report.txt'), 'accepted')
      return receipt
    },
    verify: actualVerification(),
  })
  await started.promise
  try {
    await assert.rejects(runJob(f.store, 'job', { execute: async () => { assert.fail('a competing runner cannot dispatch') } }), (error) => error.code === 'RUNNER_BUSY')
    await assert.rejects(recoverJob(f.store, 'job', { inspect: async () => { assert.fail('a competing recovery cannot inspect or interrupt') } }), (error) => error.code === 'RUNNER_BUSY')
    assert.equal((await run(['status', '--workspace', f.workspace, '--job', 'job'])).status, 'running')
    assert.equal(fs.existsSync(path.join(f.workspace, '.codex', 'supervisor', '.execution.lock')), false)
  } finally { finish.resolve() }
  assert.equal((await running).status, 'succeeded')
  assert.equal(f.store.snapshot().runner, null)
  const lease = acquireRunner(f.store)
  releaseRunner(f.store, lease.token)
})

test('live cancellation records intent first, interrupts the matching execution, and skips acceptance', async (t) => {
  const f = fixture(t)
  await addJob(f, { maxAttempts: 3 })
  const started = deferred()
  let verifications = 0
  let observedAbort = false
  const running = runJob(f.store, 'job', {
    execute: async (options) => {
      const receipt = await callbacks(options)
      started.resolve()
      const result = await onAbort(options.signal, { ...receipt, status: 'interrupted' })
      observedAbort = options.signal.aborted
      return result
    },
    verify: actualVerification(undefined, () => { verifications += 1 }),
  })
  await started.promise
  assert.equal((await run(['cancel', '--workspace', f.workspace, '--job', 'job'])).status, 'cancelling')
  assert.equal((await run(['cancel', '--workspace', f.workspace, '--job', 'job'])).status, 'cancelling')
  const result = await running
  assert.equal(observedAbort, true)
  assert.equal(result.status, 'cancelled')
  assert.equal(result.attempts.length, 1)
  assert.equal(result.attempts[0].result.status, 'interrupted')
  assert.equal(verifications, 0)
  assert.equal(f.roster().checkpointSequence, 0)
  assert.equal(f.store.snapshot().runner, null)
})

test('cancellation during queue acceptance preserves late queued and started receipts without restoring running', async (t) => {
  const f = fixture(t)
  await addJob(f)
  const submitted = deferred()
  const acknowledge = deferred()
  let statusAfterLateStart
  const running = runJob(f.store, 'job', {
    execute: async (options) => {
      await options.onThread({ threadId: 'owned-native-thread' })
      await options.onDispatch()
      submitted.resolve()
      await acknowledge.promise
      await options.onQueued({ threadId: 'owned-native-thread', queuedSubmissionId: 'late-queue' })
      await options.onStarted({ threadId: 'owned-native-thread', turnId: 'late-turn' })
      statusAfterLateStart = f.job().status
      return { status: 'interrupted', threadId: 'owned-native-thread', turnId: 'late-turn' }
    },
    verify: async () => { assert.fail('cancelled queue receipt cannot run acceptance') },
  })
  await submitted.promise
  await run(['cancel', '--workspace', f.workspace, '--job', 'job'])
  acknowledge.resolve()
  const result = await running
  assert.equal(statusAfterLateStart, 'cancelling')
  assert.equal(result.status, 'cancelled')
  assert.equal(result.attempts[0].queuedSubmissionId, 'late-queue')
  assert.equal(result.attempts[0].turnId, 'late-turn')
  assert.equal(result.attempts.length, 1)
})

test('cancellation reaches an in-flight verifier and prevents success even when native execution completed', async (t) => {
  const f = fixture(t)
  await addJob(f, { verification: [{ kind: 'file', path: 'report.txt', contains: 'accepted' }, { kind: 'command', argv: ['node', '--test'] }] })
  const verifying = deferred()
  let verifierAborted = false
  const running = runJob(f.store, 'job', {
    execute: async (options) => {
      const receipt = await callbacks(options)
      fs.writeFileSync(path.join(f.workspace, 'report.txt'), 'accepted')
      return receipt
    },
    verify: actualVerification(async ({ signal }) => {
      verifying.resolve()
      await onAbort(signal)
      verifierAborted = signal.aborted
      return { status: 'cancelled', completionConfirmed: true, exitCode: null, outputBytes: 0 }
    }),
  })
  await verifying.promise
  assert.equal(f.job().status, 'verifying')
  assert.equal((await run(['cancel', '--workspace', f.workspace, '--job', 'job'])).status, 'cancelling')
  const result = await running
  assert.equal(verifierAborted, true)
  assert.equal(result.status, 'cancelled')
  assert.equal(result.verification.cancelled, true)
  assert.equal(result.verification.checks[0].passed, true)
  assert.equal(result.verification.checks[1].passed, false)
  assert.equal(f.roster().checkpointSequence, 0)
})

test('unconfirmed cancellation keeps intent across uncertainty and late receipt recovery never runs acceptance', async (t) => {
  for (const transport of ['uncertain-response', 'throw']) {
    const f = fixture(t)
    await addJob(f, { maxAttempts: 3 })
    const started = deferred()
    let verifications = 0
    const running = runJob(f.store, 'job', {
      execute: async (options) => {
        const receipt = await callbacks(options)
        started.resolve()
        await onAbort(options.signal)
        if (transport === 'throw') throw new Error('synthetic cancellation transport failure')
        return { ...receipt, status: 'uncertain' }
      },
      verify: actualVerification(undefined, () => { verifications += 1 }),
    })
    await started.promise
    await run(['cancel', '--workspace', f.workspace, '--job', 'job'])
    assert.equal((await running).status, 'uncertain')
    await assert.rejects(runJob(f.store, 'job', { execute: async () => { assert.fail('uncertain cancellation cannot replay') } }), (error) => error.code === 'NOT_RUNNABLE')
    const recovered = await recoverJob(f.store, 'job', { inspect: async () => inspection(f, { status: 'interrupted' }), verify: actualVerification(undefined, () => { verifications += 1 }) })
    assert.equal(recovered.status, 'cancelled', transport)
    assert.equal(recovered.attempts.length, 1)
    assert.equal(verifications, 0)
  }
})

test('unconfirmed verifier receipts become inert uncertainty and native thread completion cannot clear them', async (t) => {
  for (const transport of ['unknown-response', 'throw']) {
    const f = fixture(t)
    await addJob(f, { maxAttempts: 3, verification: [{ kind: 'command', argv: ['node', '--test'] }] })
    let dispatches = 0
    let verifications = 0
    const result = await runJob(f.store, 'job', {
      execute: async (options) => { dispatches += 1; return callbacks(options) },
      verify: actualVerification(async () => {
        verifications += 1
        if (transport === 'throw') throw new Error('synthetic verifier transport interruption')
        return { status: 'uncertain', completionConfirmed: false, exitCode: null }
      }),
    })
    assert.equal(result.status, 'uncertain', transport)
    assert.equal(result.verification.uncertain, true)
    assert.equal(result.attempts[0].result.verificationUncertain, true)
    assert.equal(dispatches, 1)
    await assert.rejects(runJob(f.store, 'job', { execute: async () => { assert.fail('unconfirmed verifier cannot retry') } }), (error) => error.code === 'NOT_RUNNABLE')
    let inspected = 0
    const recovered = await recoverJob(f.store, 'job', {
      inspect: async () => { inspected += 1; return inspection(f) },
      verify: actualVerification(async () => { verifications += 1; return { exitCode: 0 } }),
    })
    assert.equal(recovered.status, 'uncertain')
    assert.equal(inspected, 0)
    assert.equal(verifications, 1)
    assert.equal(f.roster().checkpointSequence, 0)
  }
})

test('persisted verifier dispatch intent without a receipt blocks all inspection and command replay after restart', async (t) => {
  const f = fixture(t)
  await addJob(f, { maxAttempts: 3, verification: [{ kind: 'command', argv: ['node', '--test'] }] })
  const attempt = f.store.mutate((state) => beginAttempt(state, 'job'))
  f.store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'running', threadId: 'owned-native-thread', turnId: 'native-turn-1' }))
  f.store.mutate((state) => updateAttempt(state, { jobId: 'job', attemptId: attempt.id, status: 'verifying', result: { status: 'completed', verificationStarted: true } }))
  assert.equal(f.job().verification, null)
  assert.equal(f.job().attempts[0].result.verificationUncertain, undefined)
  const restarted = new ExecutionStore(f.workspace)
  let inspections = 0
  let verifications = 0
  const recovered = await recoverJob(restarted, 'job', {
    inspect: async () => { inspections += 1; return inspection(f) },
    verify: actualVerification(async () => { verifications += 1; return { exitCode: 0 } }),
  })
  assert.equal(recovered.status, 'uncertain')
  assert.equal(recovered.attempts[0].result.verificationStarted, true)
  assert.equal(recovered.attempts[0].result.verificationUncertain, true)
  assert.equal(inspections, 0)
  assert.equal(verifications, 0)
  assert.equal(recovered.attempts.length, 1)
  await assert.rejects(runJob(restarted, 'job', { execute: async () => { assert.fail('an orphan verifier cannot cause a new attempt') } }), (error) => error.code === 'NOT_RUNNABLE')
})

test('the first ambiguous or approval-blocked verifier command prevents dispatching a second command', async (t) => {
  for (const firstOutcome of ['uncertain', 'throw', 'needs-user-action']) {
    const f = fixture(t)
    await addJob(f, { maxAttempts: 3, verification: [{ kind: 'command', argv: ['node', '--test', 'first.js'] }, { kind: 'command', argv: ['node', '--test', 'second.js'] }] })
    const sent = []
    let executions = 0
    const result = await runJob(f.store, 'job', {
      execute: async (options) => { executions += 1; return callbacks(options) },
      verify: actualVerification(async ({ argv }) => {
        sent.push(argv)
        if (firstOutcome === 'throw') throw new Error('synthetic first verifier transport loss')
        if (firstOutcome === 'needs-user-action') return { status: 'needs-user-action', completionConfirmed: true, needsUserAction: true, exitCode: null }
        return { status: 'uncertain', completionConfirmed: false, exitCode: null }
      }),
    })
    assert.deepEqual(sent, [['node', '--test', 'first.js']])
    assert.equal(executions, 1)
    assert.equal(result.status, firstOutcome === 'needs-user-action' ? 'needs-user-action' : 'uncertain')
    assert.equal(result.verification.passed, false)
    assert.equal(result.verification.checks.length, 1)
    assert.equal(result.attempts.length, 1)
    assert.equal(f.roster().checkpointSequence, 0)
  }
})

test('unconfirmed verifier interruption remains uncertain after cancellation and does not reuse execution receipts', async (t) => {
  const f = fixture(t)
  await addJob(f, { verification: [{ kind: 'command', argv: ['node', '--test'] }] })
  const verifying = deferred()
  let verifierAborted = false
  const running = runJob(f.store, 'job', {
    execute: callbacks,
    verify: actualVerification(async ({ signal }) => {
      verifying.resolve()
      await onAbort(signal)
      verifierAborted = signal.aborted
      return { status: 'uncertain', completionConfirmed: false, exitCode: null }
    }),
  })
  await verifying.promise
  await run(['cancel', '--workspace', f.workspace, '--job', 'job'])
  const result = await running
  assert.equal(verifierAborted, true)
  assert.equal(result.status, 'uncertain')
  assert.equal(result.attempts[0].result.cancellationRequested, true)
  assert.equal(result.attempts[0].result.verificationUncertain, true)
  const recovered = await recoverJob(f.store, 'job', { inspect: async () => { assert.fail('execution receipt cannot prove the orphaned command stopped') } })
  assert.equal(recovered.status, 'uncertain')
})

test('recovery acceptance receives live cancellation and external abort signals', async (t) => {
  for (const cancellation of ['command', 'external-signal']) {
    const f = fixture(t)
    await addJob(f, { verification: [{ kind: 'command', argv: ['node', '--test'] }] })
    await runJob(f.store, 'job', { execute: async (options) => { await callbacks(options); throw new Error('synthetic ambiguous completion') } })
    const verifying = deferred()
    const controller = new AbortController()
    let verifierAborted = false
    const recovering = recoverJob(f.store, 'job', {
      signal: controller.signal,
      inspect: async () => inspection(f),
      verify: actualVerification(async ({ signal }) => {
        verifying.resolve()
        await onAbort(signal)
        verifierAborted = signal.aborted
        return { status: 'interrupted', completionConfirmed: true, exitCode: null }
      }),
    })
    await verifying.promise
    if (cancellation === 'command') await run(['cancel', '--workspace', f.workspace, '--job', 'job'])
    else controller.abort()
    const result = await recovering
    assert.equal(verifierAborted, true)
    assert.equal(result.status, 'cancelled', cancellation)
    assert.equal(f.roster().checkpointSequence, 0)
    assert.equal(f.store.snapshot().runner, null)
  }
})

test('checkpoint persistence failure leaves acceptance uncertain until receipt recovery can save the progress', async (t) => {
  const f = fixture(t)
  await addJob(f, { verification: [{ kind: 'file', path: 'report.txt', contains: 'accepted' }, { kind: 'command', argv: ['node', '--test'] }] })
  const lock = path.join(f.workspace, '.codex', 'supervisor', '.lock')
  let verifications = 0
  let commandCalls = 0
  const result = await runJob(f.store, 'job', {
    execute: async (options) => {
      const receipt = await callbacks(options)
      fs.writeFileSync(path.join(f.workspace, 'report.txt'), 'accepted')
      return receipt
    },
    verify: async (workspace, checks, options) => {
      verifications += 1
      const verified = await verify(workspace, checks, { ...options, commandVerifier: async () => { commandCalls += 1; return { exitCode: 0 } } })
      fs.writeFileSync(lock, '{"pid":0}')
      return verified
    },
  })
  assert.equal(result.status, 'uncertain')
  assert.equal(f.roster().checkpointSequence, 0)
  assert.equal(result.attempts[0].result.verificationFinished, true)
  const checkedAt = result.verification.checkedAt
  fs.unlinkSync(lock)
  const recovered = await recoverJob(f.store, 'job', { inspect: async () => inspection(f), verify: async () => { verifications += 1; assert.fail('checkpoint repair must reuse the confirmed command receipt') } })
  assert.equal(recovered.status, 'succeeded')
  assert.equal(verifications, 1)
  assert.equal(commandCalls, 1)
  assert.equal(recovered.verification.checkedAt, checkedAt)
  assert.equal(f.roster().checkpointSequence, 1)
  assert.equal(f.job().attempts[0].result.checkpointSequence, 1)
})

test('a changed declared artifact blocks saved receipt acceptance without repeating its command checks', async (t) => {
  const f = fixture(t)
  await addJob(f, { verification: [{ kind: 'file', path: 'report.txt', contains: 'accepted' }, { kind: 'command', argv: ['node', '--test'] }] })
  const lock = path.join(f.workspace, '.codex', 'supervisor', '.lock')
  let commandCalls = 0
  await runJob(f.store, 'job', {
    execute: async (options) => {
      const receipt = await callbacks(options)
      fs.writeFileSync(path.join(f.workspace, 'report.txt'), 'accepted original content')
      return receipt
    },
    verify: async (workspace, checks, options) => {
      const receipt = await verify(workspace, checks, { ...options, commandVerifier: async () => { commandCalls += 1; return { exitCode: 0 } } })
      fs.writeFileSync(lock, '{"pid":0}')
      return receipt
    },
  })
  assert.equal(f.job().status, 'uncertain')
  const savedHash = f.job().verification.checks[0].sha256
  fs.unlinkSync(lock)
  // The old substring criterion still passes, but its prior evidence hash no
  // longer describes this artifact and must not justify completing the job.
  fs.writeFileSync(path.join(f.workspace, 'report.txt'), 'accepted changed content')
  const recovered = await recoverJob(f.store, 'job', { inspect: async () => inspection(f), verify: async () => { assert.fail('stale receipts must not replay commands') } })
  assert.equal(recovered.status, 'uncertain')
  assert.equal(recovered.attempts[0].result.reason, 'declared-artifact-changed-after-verification')
  assert.equal(recovered.verification.checks[0].sha256, savedHash)
  assert.equal(commandCalls, 1)
  assert.equal(f.roster().checkpointSequence, 0)
})

test('models returns the native catalog through a readonly CLI path without creating execution state', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-models-readonly-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const catalog = { configuredModel: 'host-configured-model', models: [{ id: 'native-model-a', model: 'native-model-a', displayName: 'Native Model A' }] }
  let calls = 0
  const result = await run(['models', '--workspace', workspace], { models: async (options) => { calls += 1; assert.equal(options.workspace, fs.realpathSync(workspace)); return catalog } })
  assert.deepEqual(result, catalog)
  assert.equal(calls, 1)
  assert.deepEqual(fs.readdirSync(workspace), [])
  await assert.rejects(run(['models', '--workspace', workspace, '--job', 'unrelated'], { models: async () => { assert.fail('invalid model flags cannot read the catalog') } }), (error) => error.code === 'USAGE')
  assert.deepEqual(fs.readdirSync(workspace), [])
})

test('drain only dispatches an authorized bounded selection and stops on uncertainty', async (t) => {
  const f = fixture(t)
  await addJob(f, { jobId: 'suggested', authorized: false })
  await addJob(f, { jobId: 'first' })
  await addJob(f, { jobId: 'second' })
  let dispatches = 0
  const first = await run(['drain', '--workspace', f.workspace, '--limit', '3'], {
    execute: async (options) => { dispatches += 1; throw new Error('synthetic ambiguous dispatch') },
    verify: actualVerification(),
  })
  assert.equal(first.processed, 1)
  assert.equal(first.jobs[0].id, 'first')
  assert.equal(first.jobs[0].status, 'uncertain')
  assert.equal(dispatches, 1)
  assert.equal(f.job('suggested').status, 'proposed')
  assert.equal(f.job('second').status, 'authorized')
  assert.equal(f.job('second').attempts.length, 0)
  assert.equal(f.store.snapshot().runner, null)
  const bounded = fixture(t)
  await addJob(bounded, { jobId: 'first' })
  await addJob(bounded, { jobId: 'second' })
  const batch = await run(['drain', '--workspace', bounded.workspace, '--limit', '1'], {
    execute: async (options) => {
      const receipt = await callbacks(options)
      fs.writeFileSync(path.join(bounded.workspace, 'report.txt'), 'accepted')
      return receipt
    },
    verify: actualVerification(),
  })
  assert.equal(batch.processed, 1)
  assert.equal(batch.jobs[0].status, 'succeeded')
  assert.equal(bounded.job('second').status, 'authorized')
  assert.equal(bounded.job('second').attempts.length, 0)
})
