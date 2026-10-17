import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fail, SupervisorError, workspacePaths, readState, writeState, withStateLock } from './state.mjs'

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const STATUSES = ['proposed', 'authorized', 'dispatching', 'running', 'verifying', 'succeeded', 'failed', 'needs-user-action', 'uncertain', 'cancelling', 'cancelled']
const ATTEMPT_STATUSES = STATUSES.filter((status) => !['proposed', 'authorized'].includes(status))
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])
const TRANSITIONS = {
  proposed: ['authorized', 'cancelled'],
  authorized: ['dispatching', 'needs-user-action', 'cancelled'],
  dispatching: ['running', 'verifying', 'failed', 'needs-user-action', 'uncertain', 'cancelling'],
  running: ['verifying', 'failed', 'needs-user-action', 'uncertain', 'cancelling'],
  verifying: ['succeeded', 'failed', 'needs-user-action', 'uncertain', 'cancelling'],
  succeeded: [],
  failed: ['dispatching', 'cancelled'],
  'needs-user-action': ['running', 'verifying', 'failed', 'uncertain', 'cancelling', 'cancelled'],
  uncertain: ['running', 'verifying', 'succeeded', 'failed', 'needs-user-action', 'cancelling'],
  cancelling: ['cancelled', 'uncertain'],
  cancelled: [],
}
const newGrants = new WeakSet()
const newAttempts = new WeakSet()
const newRunnerClaims = new WeakSet()
const runnerReleases = new WeakMap()
const CREDENTIAL = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b|\bBearer\s+\S+|\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret)\s*[:=]\s*\S+/i
const RAW_LINE = /^(?:user|assistant|system|developer|tool)\s*:|^\[?(?:20\d\d-\d\d-\d\d[T ]|TRACE\b|DEBUG\b)|^at\s+\S+\s*\(/i

function object(value, label, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_EXECUTION', `${label} must be an object.`)
  if (allowed && Object.keys(value).some((key) => !allowed.includes(key))) fail('INVALID_EXECUTION', `${label} has an unknown field.`)
  return value
}

function string(value, label, max, { required = true, multiline = false, trim = true } = {}) {
  if (typeof value !== 'string' || value.length > max || (required && !value) || (trim && value !== value.trim())) fail('INVALID_EXECUTION', `${label} has an invalid string value.`)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (!multiline && /[\r\n\t]/.test(value))) fail('INVALID_EXECUTION', `${label} contains unsupported control characters.`)
  if (CREDENTIAL.test(value)) fail('SENSITIVE_INPUT', `${label} resembles a credential. Use a redacted description.`)
  if (value.split(/\r?\n/).some((line) => RAW_LINE.test(line.trim()))) fail('RAW_LOG_INPUT', `${label} resembles a transcript or raw log.`)
  return value
}

function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_EXECUTION', `${label} must be a safe 1–64 character identifier.`)
  return value
}

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('INVALID_EXECUTION', `${label} is outside its integer bounds.`)
  return value
}

function strings(value, label, max, width, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > max) fail('INVALID_EXECUTION', `${label} has an invalid list size.`)
  const result = value.map((item) => string(item, label, width))
  if (new Set(result).size !== result.length) fail('INVALID_EXECUTION', `${label} contains duplicate entries.`)
  return result
}

function realWorkspace(workspace) {
  return workspacePaths(workspace).workspace
}

function relativeFileSegments(relativePath) {
  string(relativePath, 'Verification path', 512)
  const segments = relativePath.split('/')
  if (path.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath) || relativePath.includes('\\') || segments.some((part) => !part || part === '.' || part === '..')) fail('UNSAFE_PATH', 'Verification paths must be relative, without traversal.')
  return segments
}

export function resolveWorkspaceFile(workspace, relativePath) {
  const root = realWorkspace(workspace)
  const segments = relativeFileSegments(relativePath)
  let target = root
  for (let index = 0; index < segments.length; index += 1) {
    target = path.join(target, segments[index])
    let stat
    try { stat = fs.lstatSync(target) } catch (error) {
      if (error.code === 'ENOENT') continue
      fail('PATH_ACCESS', 'Cannot inspect a verification path.')
    }
    if (stat.isSymbolicLink()) fail('UNSAFE_PATH', 'Verification paths cannot contain symlinks.')
    if (index < segments.length - 1 && !stat.isDirectory()) fail('UNSAFE_PATH', 'Verification parents must be directories.')
    if (index === segments.length - 1 && !stat.isFile()) fail('UNSAFE_PATH', 'A file verifier must target a regular file.')
  }
  return target
}

export function validateProposal(input, workspace, { inspectPaths = true } = {}) {
  object(input, 'Execution proposal', ['instruction', 'successCriteria', 'verification', 'timeoutMs', 'maxAttempts', 'model'])
  const proposal = {
    instruction: string(input.instruction, 'Instruction', 8000, { multiline: true }),
    successCriteria: strings(input.successCriteria, 'Success criteria', 8, 800, 1),
    verification: [],
    timeoutMs: integer(input.timeoutMs ?? 120000, 'Job timeout', 1000, 600000),
    maxAttempts: integer(input.maxAttempts ?? 1, 'Attempt budget', 1, 3),
  }
  if (!Array.isArray(input.verification) || !input.verification.length || input.verification.length > 20) fail('INVALID_EXECUTION', 'Verification must contain 1–20 checks.')
  for (const check of input.verification) {
    object(check, 'Verification check')
    if (check.kind === 'file') {
      object(check, 'File verification', ['kind', 'path', 'contains', 'sha256'])
      relativeFileSegments(check.path)
      if (inspectPaths) resolveWorkspaceFile(workspace, check.path)
      const normalized = { kind: 'file', path: check.path }
      if (check.contains !== undefined) normalized.contains = string(check.contains, 'Expected file content', 2000, { multiline: true, trim: false })
      if (check.sha256 !== undefined) {
        if (typeof check.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(check.sha256)) fail('INVALID_EXECUTION', 'Expected file hash must be SHA-256 hex.')
        normalized.sha256 = check.sha256.toLowerCase()
      }
      proposal.verification.push(normalized)
    } else if (check.kind === 'command') {
      object(check, 'Command verification', ['kind', 'argv', 'timeoutMs'])
      if (!Array.isArray(check.argv) || !check.argv.length || check.argv.length > 32) fail('INVALID_EXECUTION', 'Verifier argv must contain 1–32 arguments.')
      const argv = check.argv.map((argument, index) => string(argument, 'Verifier argument', 8000, { required: index === 0, trim: false }))
      if (argv.reduce((total, argument) => total + argument.length, 0) > 8000 || !argv[0].trim()) fail('INVALID_EXECUTION', 'Verifier argv exceeds its bounds.')
      proposal.verification.push({ kind: 'command', argv, timeoutMs: integer(check.timeoutMs ?? 30000, 'Verifier timeout', 1000, 120000) })
    } else fail('INVALID_EXECUTION', 'Verification kind is unsupported.')
  }
  if (input.model !== undefined) proposal.model = string(input.model, 'Explicit model', 128)
  if (Buffer.byteLength(JSON.stringify(proposal)) > 256 * 1024) fail('SIZE_LIMIT', 'Execution proposal exceeds its size limit.')
  return proposal
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  return value
}

export function digestProposal(proposal) {
  return createHash('sha256').update(JSON.stringify(canonical(proposal))).digest('hex')
}

function metadata(value, label) {
  if (!value || typeof value !== 'object') fail('INVALID_EXECUTION', `${label} must be structured metadata.`)
  const visit = (item, depth) => {
    if (depth > 5) fail('SIZE_LIMIT', `${label} metadata is too deeply nested.`)
    if (typeof item === 'string') { string(item, label, 4000, { required: false }); return }
    if (item === null || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object') fail('INVALID_EXECUTION', `${label} contains an unsupported value.`)
    if (Object.keys(item).length > 64) fail('SIZE_LIMIT', `${label} has too many metadata entries.`)
    for (const [key, child] of Object.entries(item)) {
      if (!Array.isArray(item)) {
        string(key, 'Metadata key', 80)
        if (/^(?:stdout|stderr|transcript|messages|rawLogs?|logs|rawOutput)$/i.test(key)) fail('RAW_LOG_INPUT', 'Execution receipts cannot contain raw logs or transcripts.')
      }
      visit(child, depth + 1)
    }
  }
  visit(value, 0)
  if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024) fail('SIZE_LIMIT', `${label} exceeds its metadata size limit.`)
  return value
}

function receiptId(value, label) {
  if (value !== null) string(value, label, 256)
}

function runnerToken(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) fail('INVALID_EXECUTION', 'Runner token must be a UUID.')
}

function validateRunner(runner) {
  if (runner === null) return
  object(runner, 'Execution runner', ['pid', 'token'])
  integer(runner.pid, 'Runner pid', 1, 2147483647)
  runnerToken(runner.token)
}

function runnerAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'EPERM') return true
    if (error.code === 'ESRCH') return false
    fail('RUNNER_ACCESS', 'Cannot determine whether the execution runner is alive.')
  }
}

function validateExecutionState(state, workspace) {
  object(state, 'Execution state', ['schemaVersion', 'revision', 'workspace', 'runner', 'jobs'])
  if (state.schemaVersion !== 1) fail('UNKNOWN_SCHEMA', 'Execution state schema is unsupported; preserve it for migration.')
  integer(state.revision, 'Execution revision')
  if (state.workspace !== workspace) fail('WORKSPACE_BINDING', 'Execution state is bound to another real workspace path.')
  validateRunner(state.runner)
  object(state.jobs, 'Execution jobs')
  if (Object.keys(state.jobs).length > 100) fail('JOB_LIMIT', 'Execution state contains too many jobs.')
  for (const [jobId, job] of Object.entries(state.jobs)) {
    id(jobId, 'Job id')
    object(job, 'Execution job', ['id', 'taskId', 'proposal', 'digest', 'status', 'authorization', 'threadId', 'attempts', 'verification', 'createdAt', 'updatedAt'])
    if (job.id !== jobId) fail('INVALID_EXECUTION', 'Job key and id do not match.')
    id(job.taskId, 'Task id')
    // Failed artifacts can become directories or symlinks. Their current shape
    // must not prevent recovery, cancellation or recording verification failure.
    const normalized = validateProposal(job.proposal, workspace, { inspectPaths: false })
    if (JSON.stringify(canonical(normalized)) !== JSON.stringify(canonical(job.proposal)) || job.digest !== digestProposal(normalized)) fail('PROPOSAL_DIGEST', 'Stored proposal or digest is inconsistent.')
    if (!STATUSES.includes(job.status)) fail('INVALID_EXECUTION', 'Job status is unsupported.')
    integer(job.createdAt, 'Job creation timestamp')
    integer(job.updatedAt, 'Job update timestamp', job.createdAt)
    receiptId(job.threadId, 'Thread id')
    if (!Array.isArray(job.attempts) || job.attempts.length > job.proposal.maxAttempts) fail('ATTEMPT_LIMIT', 'Job attempts exceed the immutable proposal budget.')
    if (job.authorization !== null) {
      object(job.authorization, 'Authorization', ['proposalDigest', 'workspace', 'approvedAt', 'source', 'maxAttempts'])
      if (job.authorization.proposalDigest !== job.digest || job.authorization.workspace !== workspace || job.authorization.source !== 'user' || job.authorization.maxAttempts !== job.proposal.maxAttempts) fail('AUTHORIZATION', 'Execution authorization does not match its immutable proposal and workspace.')
      integer(job.authorization.approvedAt, 'Approval timestamp', job.createdAt)
    } else if (job.attempts.length || !['proposed', 'cancelled'].includes(job.status)) fail('AUTHORIZATION', 'Execution needs an explicit user grant before dispatch.')
    if (job.status === 'proposed' && (job.authorization !== null || job.attempts.length || job.threadId !== null || job.verification !== null)) fail('INVALID_EXECUTION', 'Proposed job contains execution receipts.')
    let previousTime = job.createdAt
    const attemptIds = new Set()
    for (let index = 0; index < job.attempts.length; index += 1) {
      const attempt = job.attempts[index]
      object(attempt, 'Execution attempt', ['id', 'number', 'status', 'intentAt', 'queuedSubmissionId', 'turnId', 'result'])
      id(attempt.id, 'Attempt id')
      if (attemptIds.has(attempt.id) || attempt.number !== index + 1 || !ATTEMPT_STATUSES.includes(attempt.status)) fail('INVALID_EXECUTION', 'Attempt identities, numbering or statuses are inconsistent.')
      attemptIds.add(attempt.id)
      integer(attempt.intentAt, 'Attempt intent timestamp', previousTime)
      previousTime = attempt.intentAt
      receiptId(attempt.queuedSubmissionId, 'Queued submission id')
      receiptId(attempt.turnId, 'Turn id')
      if (attempt.result !== undefined) metadata(attempt.result, 'Attempt result')
      if (index < job.attempts.length - 1 && attempt.status !== 'failed') fail('INVALID_EXECUTION', 'Only a failed attempt may precede another attempt.')
    }
    if (job.attempts.length && job.status !== job.attempts.at(-1).status && !(job.status === 'cancelled' && job.attempts.at(-1).status === 'failed')) fail('INVALID_EXECUTION', 'Job status differs from its latest attempt receipt.')
    if (!job.attempts.length && !['proposed', 'authorized', 'needs-user-action', 'cancelled'].includes(job.status)) fail('INVALID_EXECUTION', 'Job status requires an attempt receipt.')
    if (job.verification !== null) metadata(job.verification, 'Verification result')
    if (job.status === 'succeeded') {
      const latest = job.attempts.at(-1)
      if (!latest?.turnId || latest.result?.status !== 'completed'
        || job.verification?.passed !== true
        || !Array.isArray(job.verification.checks)
        || job.verification.checks.length !== job.proposal.verification.length
        || job.verification.checks.some((check) => !check || typeof check !== 'object' || Array.isArray(check) || check.passed !== true)) {
        fail('INVALID_EXECUTION', 'Success requires the current completed native turn and every proposed verification check to pass.')
      }
    }
  }
}

function jobById(state, jobId) {
  id(jobId, 'Job id')
  if (!Object.hasOwn(state.jobs, jobId)) fail('MISSING_JOB', 'Execution job does not exist.')
  return state.jobs[jobId]
}

function touch(job) {
  job.updatedAt = Math.max(Date.now(), job.updatedAt)
}

export function propose(state, { jobId, taskId, proposal: input }) {
  id(jobId, 'Job id')
  id(taskId, 'Task id')
  const proposal = validateProposal(input, state.workspace, { inspectPaths: false })
  const digest = digestProposal(proposal)
  if (Object.hasOwn(state.jobs, jobId)) {
    const existing = state.jobs[jobId]
    if (existing.taskId !== taskId || existing.digest !== digest) fail('PROPOSAL_CONFLICT', 'Job id already identifies a different immutable proposal.')
    return existing
  }
  if (Object.keys(state.jobs).length >= 100) fail('JOB_LIMIT', 'Workspace already contains 100 execution jobs.')
  for (const check of proposal.verification) if (check.kind === 'file') resolveWorkspaceFile(state.workspace, check.path)
  const now = Date.now()
  const job = { id: jobId, taskId, proposal, digest, status: 'proposed', authorization: null, threadId: null, attempts: [], verification: null, createdAt: now, updatedAt: now }
  Object.defineProperty(state.jobs, jobId, { value: job, enumerable: true, configurable: true, writable: true })
  return job
}

export function authorize(state, { jobId, digest }) {
  const job = jobById(state, jobId)
  if (digest !== job.digest) fail('PROPOSAL_DIGEST', 'Authorization digest must exactly match the proposed job.')
  if (job.authorization) return job
  if (job.status !== 'proposed') fail('JOB_STATUS', 'Only a proposed job can receive its initial authorization.')
  job.authorization = { proposalDigest: job.digest, workspace: state.workspace, approvedAt: Math.max(Date.now(), job.createdAt), source: 'user', maxAttempts: job.proposal.maxAttempts }
  newGrants.add(job.authorization)
  job.status = 'authorized'
  touch(job)
  return job
}

export function beginAttempt(state, jobId) {
  const job = jobById(state, jobId)
  if (!job.authorization) fail('AUTHORIZATION', 'Authorize the exact proposal before dispatching an attempt.')
  if (!['authorized', 'failed'].includes(job.status)) fail('JOB_STATUS', 'Only authorized jobs or confirmed failed attempts can dispatch; uncertain work needs receipt recovery.')
  if (job.attempts.length >= job.authorization.maxAttempts) fail('ATTEMPT_LIMIT', 'The immutable authorized attempt budget is exhausted.')
  const attempt = { id: randomUUID(), number: job.attempts.length + 1, status: 'dispatching', intentAt: Math.max(Date.now(), job.updatedAt), queuedSubmissionId: null, turnId: null }
  newAttempts.add(attempt)
  job.attempts.push(attempt)
  job.status = 'dispatching'
  job.verification = null
  touch(job)
  return attempt
}

function transition(from, to) {
  if (from !== to && !TRANSITIONS[from]?.includes(to)) fail('JOB_STATUS', 'Execution status transition is not allowed.')
}

export function updateAttempt(state, patch) {
  object(patch, 'Attempt update', ['jobId', 'attemptId', 'expectedStatus', 'status', 'queuedSubmissionId', 'turnId', 'threadId', 'result', 'verification'])
  const job = jobById(state, patch.jobId)
  const attempt = job.attempts.at(-1)
  if (!attempt || attempt.id !== patch.attemptId) fail('STALE_ATTEMPT', 'Attempt update does not match the current attempt.')
  if (patch.expectedStatus !== undefined && patch.expectedStatus !== attempt.status) fail('STALE_ATTEMPT', 'Attempt status changed before this update.')
  if (!ATTEMPT_STATUSES.includes(patch.status)) fail('INVALID_EXECUTION', 'Attempt update status is unsupported.')
  if (patch.status === 'cancelled' && !['cancelling', 'cancelled'].includes(attempt.status)) fail('JOB_STATUS', 'Active attempts must enter cancelling before cancellation is confirmed.')
  transition(attempt.status, patch.status)
  const previous = JSON.stringify(job)
  if (TERMINAL.has(attempt.status)) {
    const retry = { ...attempt }
    for (const key of ['queuedSubmissionId', 'turnId', 'result']) if (Object.hasOwn(patch, key)) retry[key] = patch[key]
    if (JSON.stringify(retry) !== JSON.stringify(attempt) || (Object.hasOwn(patch, 'threadId') && patch.threadId !== job.threadId) || (Object.hasOwn(patch, 'verification') && JSON.stringify(patch.verification) !== JSON.stringify(job.verification))) fail('RECEIPT_IMMUTABLE', 'Terminal attempt receipts cannot be replaced.')
    return job
  }
  for (const key of ['queuedSubmissionId', 'turnId']) {
    if (Object.hasOwn(patch, key)) {
      receiptId(patch[key], key)
      if (attempt[key] !== null && attempt[key] !== patch[key]) fail('RECEIPT_CONFLICT', 'An existing submission or turn receipt cannot be replaced.')
      attempt[key] = patch[key]
    }
  }
  if (Object.hasOwn(patch, 'threadId')) {
    receiptId(patch.threadId, 'Thread id')
    if (job.threadId !== null && job.threadId !== patch.threadId) fail('RECEIPT_CONFLICT', 'An existing execution thread cannot be replaced.')
    job.threadId = patch.threadId
  }
  if (Object.hasOwn(patch, 'result')) attempt.result = metadata(patch.result, 'Attempt result')
  if (Object.hasOwn(patch, 'verification')) job.verification = patch.verification === null ? null : metadata(patch.verification, 'Verification result')
  attempt.status = patch.status
  job.status = patch.status
  if (JSON.stringify(job) !== previous) touch(job)
  return job
}

export function cancel(state, jobId) {
  const job = jobById(state, jobId)
  if (['cancelling', 'cancelled'].includes(job.status)) return job
  const active = job.attempts.length && !TERMINAL.has(job.attempts.at(-1).status)
  const nextStatus = active ? 'cancelling' : 'cancelled'
  transition(job.status, nextStatus)
  job.status = nextStatus
  if (active) job.attempts.at(-1).status = nextStatus
  touch(job)
  return job
}

export function acquireRunner(store) {
  return store.mutate((state) => {
    if (state.runner !== null && runnerAlive(state.runner.pid)) fail('RUNNER_BUSY', 'A live process owns the execution runner lease; status and cancellation remain available.')
    const runner = { pid: process.pid, token: randomUUID() }
    newRunnerClaims.add(runner)
    state.runner = runner
    return runner
  })
}

export function releaseRunner(store, token) {
  runnerToken(token)
  return store.mutate((state) => {
    if (state.runner === null) return false
    if (state.runner.token !== token) fail('RUNNER_TOKEN', 'Runner lease release requires its current owner token.')
    runnerReleases.set(state, token)
    state.runner = null
    return true
  })
}

function validateChanges(before, after) {
  if (before.schemaVersion !== after.schemaVersion || before.workspace !== after.workspace || before.revision !== after.revision) fail('EXECUTION_IMMUTABLE', 'Transaction cannot change the state schema, workspace or revision directly.')
  if (JSON.stringify(before.runner) !== JSON.stringify(after.runner)) {
    if (after.runner === null) {
      if (!before.runner || runnerReleases.get(after) !== before.runner.token) fail('RUNNER_TOKEN', 'Runner leases must be released through the matching owner token.')
    } else {
      if (!newRunnerClaims.has(after.runner) || after.runner.pid !== process.pid) fail('RUNNER_TOKEN', 'Runner leases must be minted by acquireRunner.')
      if (before.runner !== null && runnerAlive(before.runner.pid)) fail('RUNNER_BUSY', 'A live process already owns the execution runner lease.')
    }
  }
  for (const [jobId, previous] of Object.entries(before.jobs)) {
    if (!Object.hasOwn(after.jobs, jobId)) fail('EXECUTION_IMMUTABLE', 'Execution jobs cannot be deleted from the audit store.')
    const next = after.jobs[jobId]
    for (const key of ['id', 'taskId', 'digest', 'createdAt', 'proposal']) {
      if (JSON.stringify(canonical(previous[key])) !== JSON.stringify(canonical(next[key]))) fail('PROPOSAL_IMMUTABLE', 'An existing execution proposal cannot be changed.')
    }
    if (previous.authorization !== null && JSON.stringify(previous.authorization) !== JSON.stringify(next.authorization)) fail('AUTHORIZATION_IMMUTABLE', 'An execution grant cannot be replaced or reset.')
    if (previous.threadId !== null && next.threadId !== previous.threadId) fail('RECEIPT_CONFLICT', 'Execution thread identity cannot be replaced.')
    if (TERMINAL.has(previous.status) && !(previous.status === 'failed' && next.status === 'dispatching') && JSON.stringify(previous.verification) !== JSON.stringify(next.verification)) fail('RECEIPT_IMMUTABLE', 'Terminal verification receipts cannot be replaced.')
    if (next.attempts.length < previous.attempts.length) fail('RECEIPT_IMMUTABLE', 'Attempt history cannot be removed.')
    transition(previous.status, next.status)
    for (let index = 0; index < previous.attempts.length; index += 1) {
      const oldAttempt = previous.attempts[index]
      const newAttempt = next.attempts[index]
      if (newAttempt.status === 'cancelled' && !['cancelling', 'cancelled'].includes(oldAttempt.status)) fail('JOB_STATUS', 'Active cancellation requires prior cancelling intent.')
      for (const key of ['id', 'number', 'intentAt']) if (oldAttempt[key] !== newAttempt[key]) fail('RECEIPT_IMMUTABLE', 'Attempt identity and intent cannot be replaced.')
      if (TERMINAL.has(oldAttempt.status) && JSON.stringify(oldAttempt) !== JSON.stringify(newAttempt)) fail('RECEIPT_IMMUTABLE', 'Terminal attempt receipts cannot be replaced.')
      for (const key of ['queuedSubmissionId', 'turnId']) if (oldAttempt[key] !== null && newAttempt[key] !== oldAttempt[key]) fail('RECEIPT_CONFLICT', 'Submission and turn identities cannot be replaced.')
      transition(oldAttempt.status, newAttempt.status)
    }
    if (next.updatedAt < previous.updatedAt) fail('INVALID_EXECUTION', 'Job update timestamp cannot move backwards.')
  }
  for (const [jobId, next] of Object.entries(after.jobs)) {
    const previous = Object.hasOwn(before.jobs, jobId) ? before.jobs[jobId] : null
    if (!previous?.authorization && next.authorization && !newGrants.has(next.authorization)) fail('AUTHORIZATION', 'New grants must be minted by an explicit authorize call.')
    const count = previous?.attempts.length ?? 0
    for (const attempt of next.attempts.slice(count)) if (!newAttempts.has(attempt)) fail('AUTHORIZATION', 'New attempts must be created by beginAttempt after explicit authorization.')
  }
}

export class ExecutionStore {
  constructor(workspace) {
    this.workspace = realWorkspace(workspace)
    const paths = workspacePaths(this.workspace)
    this.paths = { ...paths, state: path.join(paths.root, 'execution.v1.json'), lock: path.join(paths.root, '.execution.lock') }
    this.checkPaths()
  }

  checkPaths(create = false) {
    workspacePaths(this.workspace, create)
    for (const file of [this.paths.state, this.paths.lock]) {
      try {
        const stat = fs.lstatSync(file)
        if (stat.isSymbolicLink() || !stat.isFile()) fail('UNSAFE_PATH', 'Execution files must be regular files, without symlinks.')
      } catch (error) {
        if (error instanceof SupervisorError) throw error
        if (error.code !== 'ENOENT') fail('PATH_ACCESS', 'Cannot inspect an execution store path.')
      }
    }
  }

  snapshot() {
    this.checkPaths()
    return readState(this.paths, validateExecutionState, true) ?? { schemaVersion: 1, revision: 0, workspace: this.workspace, runner: null, jobs: {} }
  }

  mutate(action) {
    if (typeof action !== 'function') fail('INVALID_EXECUTION', 'Execution transaction requires a synchronous callback.')
    if (action.constructor?.name === 'AsyncFunction') fail('ASYNC_TRANSACTION', 'Execution transactions must not await model or verifier work.')
    this.checkPaths(true)
    return withStateLock(this.paths, () => {
      const state = this.snapshot()
      const before = structuredClone(state)
      const result = action(state)
      if (result && typeof result.then === 'function') fail('ASYNC_TRANSACTION', 'Execution transactions must not await model or verifier work.')
      let resultCopy
      try { resultCopy = result === undefined ? undefined : structuredClone(result) } catch { fail('INVALID_EXECUTION', 'Transaction result must be structured-cloneable.') }
      validateExecutionState(state, this.workspace)
      validateChanges(before, state)
      if (JSON.stringify(before) !== JSON.stringify(state)) {
        state.revision += 1
        this.checkPaths()
        writeState(this.paths, state, validateExecutionState)
      }
      return resultCopy
    })
  }
}
