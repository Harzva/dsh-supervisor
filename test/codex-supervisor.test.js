import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../plugins/codex-supervisor/scripts/supervisor.mjs', import.meta.url))
const stateModule = new URL('../plugins/codex-supervisor/scripts/state.mjs', import.meta.url).href

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-supervisor-test-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  let inputSequence = 0
  const statePath = path.join(workspace, '.codex', 'supervisor', 'state.v1.json')
  return {
    workspace,
    statePath,
    state: () => JSON.parse(fs.readFileSync(statePath, 'utf8')),
    rewrite: (state) => fs.writeFileSync(statePath, JSON.stringify(state)),
    run(command, taskId, input, extra = []) {
      const args = [cli, command, '--workspace', workspace]
      if (taskId !== undefined) args.push('--task', taskId)
      if (input !== undefined) {
        const inputPath = path.join(workspace, `input-${++inputSequence}.json`)
        fs.writeFileSync(inputPath, JSON.stringify(input))
        args.push('--input', inputPath)
      }
      args.push(...extra)
      const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 })
      assert.equal(result.error, undefined)
      const stream = result.status === 0 ? result.stdout : result.stderr
      return { ...result, data: JSON.parse(stream) }
    },
  }
}

function success(result) {
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  return result.data
}

function failure(result, code) {
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.data.error.code, code)
  return result.data.error
}

const checkpoint = (changes = {}) => ({ summary: 'Implemented the bounded local adapter.', evidence: ['node --test: 12 tests passed.'], remaining: ['Review the package.'], blockers: [], outcome: 'progress', ...changes })

test('faculty migration preserves full prompts privately and public views do not leak legacy routing or privileges', (t) => {
  const f = fixture(t)
  const prompt = `PRIVATE_DOMAIN_PROMPT\n${'完整学院提示词内容'.repeat(700)}`
  const input = { faculties: [{ id: 'code', name: '代码学院', prompt, route: 'legacy-provider/private-model' }, { id: 'research', name: '研究学院', prompt: '事实核查与研究', route: 'p/m' }] }
  const initialized = success(f.run('init', undefined, input))
  assert.equal(initialized.mentorCount, 2)
  const state = f.state()
  assert.equal(state.config.faculties[0].prompt, prompt)
  assert.equal(state.config.mentors[0].domainPrompt, prompt)
  assert.equal(state.config.mentors[0].route, input.faculties[0].route)
  assert.equal(state.config.mentors[0].role, 'execution')
  const roster = success(f.run('roster'))
  assert.equal(roster.routing.legacyRouteMapped, false)
  assert.equal(Object.hasOwn(roster.mentors[0], 'permissions'), false)
  assert.equal(Object.hasOwn(roster.mentors[0].responsibilities, 'description'), false)
  assert.doesNotMatch(JSON.stringify(roster), /PRIVATE_DOMAIN_PROMPT|private-model|domainPrompt|"route"/)
  const assignment = success(f.run('assign', 'development', { tags: ['代码'] }))
  assert.equal(assignment.assignment.primaryMentorId, 'code')
  success(f.run('checkpoint', 'development', checkpoint()))
  const handoff = success(f.run('handoff', 'development'))
  for (const result of [f.run('status'), f.run('status', 'development')]) assert.doesNotMatch(result.stdout, /PRIVATE_DOMAIN_PROMPT|private-model|domainPrompt|"route"/)
  assert.doesNotMatch(fs.readFileSync(handoff.path, 'utf8'), /PRIVATE_DOMAIN_PROMPT|private-model/)
  assert.equal(fs.statSync(f.statePath).mode & 0o777, 0o600)
  assert.equal(fs.statSync(handoff.path).mode & 0o777, 0o600)
})

test('init never overwrites state or config; explicit mentor prompts and manual assignments survive restart', (t) => {
  const f = fixture(t)
  const input = { mentors: [{ id: 'owner', role: 'execution', domainPrompt: 'Private domain instructions', responsibilities: { tags: ['build'], workspacePatterns: ['*'], presets: ['builder'] } }, { id: 'review', role: 'verification' }, { id: 'relay', role: 'handoff' }] }
  success(f.run('init', undefined, input))
  const first = success(f.run('assign', 'ship', { primaryMentorId: 'owner', collaboratorIds: ['review', 'relay'] }))
  const before = fs.readFileSync(f.statePath, 'utf8')
  const repeated = success(f.run('init', undefined, { mentors: [{ id: 'replacement' }] }))
  assert.equal(repeated.initialized, false)
  assert.equal(fs.readFileSync(f.statePath, 'utf8'), before)
  const reused = success(f.run('assign', 'ship', { tags: ['testing'] }))
  assert.deepEqual(reused.assignment, first.assignment)
  assert.equal(reused.revision, first.revision)
  assert.equal(f.state().config.mentors[0].domainPrompt, 'Private domain instructions')
  failure(f.run('assign', 'invalid', { primaryMentorId: 'missing' }), 'INVALID_ASSIGNMENT')
  failure(f.run('assign', 'invalid', { primaryMentorId: 'owner', collaboratorIds: ['owner'] }), 'INVALID_ASSIGNMENT')
  failure(f.run('assign', 'invalid', { primaryMentorId: 'owner', collaboratorIds: ['review', 'relay', 'owner'] }), 'INVALID_DATA')
  failure(f.run('assign', 'invalid', { primaryMentorId: 'owner', collaboratorIds: ['review', 'review'] }), 'INVALID_DATA')
  assert.equal(Object.hasOwn(f.state().tasks, 'invalid'), false)
})

test('responsibility rules use tags and agentPreset without model aliases', (t) => {
  const f = fixture(t)
  success(f.run('init', undefined, { mentors: [{ id: 'architect', role: 'architecture', responsibilities: { tags: ['design'], presets: ['planner'] }, route: 'not-a-codex-model' }, { id: 'tester', role: 'verification', responsibilities: { tags: ['test'] } }] }))
  assert.equal(success(f.run('assign', 'design', { agentPreset: 'planner' })).assignment.primaryMentorId, 'architect')
  assert.equal(success(f.run('assign', 'test', { tags: ['test'] })).assignment.primaryMentorId, 'tester')
  assert.equal(success(f.run('roster')).routing.mode, 'host-default')
})

test('checkpoint evidence gates completion, caps history and preserves native Goals', (t) => {
  const f = fixture(t)
  success(f.run('init'))
  success(f.run('assign', 'task'))
  const goals = path.join(f.workspace, '.codex', 'goals.json')
  const sentinel = '{"nativeGoal":"unchanged"}\n'
  fs.writeFileSync(goals, sentinel)
  const before = fs.readFileSync(f.statePath, 'utf8')
  failure(f.run('checkpoint', 'task', checkpoint({ evidence: [] })), 'INVALID_CHECKPOINT')
  failure(f.run('checkpoint', 'task', checkpoint({ outcome: 'complete' })), 'INVALID_CHECKPOINT')
  failure(f.run('checkpoint', 'task', checkpoint({ outcome: 'complete', remaining: [], blockers: ['Awaiting review'] })), 'INVALID_CHECKPOINT')
  failure(f.run('checkpoint', 'task', checkpoint({ unknown: 'extra' })), 'INVALID_DATA')
  assert.equal(fs.readFileSync(f.statePath, 'utf8'), before)
  for (let i = 0; i < 21; i += 1) success(f.run('checkpoint', 'task', checkpoint({ summary: `Checkpoint ${i}` })))
  const completed = success(f.run('checkpoint', 'task', checkpoint({ remaining: [], outcome: 'complete', nativeGoalRef: { id: 'native-goal', revision: 3 } })))
  assert.equal(completed.checkpointSequence, 22)
  assert.equal(f.state().tasks.task.checkpoints.length, 20)
  assert.equal(f.state().tasks.task.checkpoints[0].sequence, 3)
  assert.equal(completed.latestCheckpoint.data.nativeGoalRef.revision, 3)
  assert.equal(fs.readFileSync(goals, 'utf8'), sentinel)
})

test('handoff content is deterministic, idempotent and invalidated on checkpoint or assignment change', (t) => {
  const f = fixture(t)
  success(f.run('init'))
  success(f.run('assign', 'task', { primaryMentorId: 'forge' }))
  failure(f.run('handoff', 'task'), 'NO_CHECKPOINT')
  success(f.run('checkpoint', 'task', checkpoint({ evidence: ['Review [details](https://example.com) passed.'] })))
  const first = success(f.run('handoff', 'task'))
  const markdown = fs.readFileSync(first.path, 'utf8')
  assert.equal(createHash('sha256').update(markdown).digest('hex'), first.digest)
  assert.match(markdown, /Review \\\[details\\\]/)
  assert.deepEqual(success(f.run('handoff', 'task')), first)
  const assignedAt = f.state().tasks.task.assignment.assignedAt
  const beforeRetry = fs.readFileSync(f.statePath, 'utf8')
  const manualRetry = success(f.run('assign', 'task', { primaryMentorId: 'forge' }))
  assert.equal(manualRetry.revision, first.revision)
  assert.equal(manualRetry.assignment.assignedAt, assignedAt)
  assert.equal(manualRetry.handoff.digest, first.digest)
  assert.equal(fs.readFileSync(f.statePath, 'utf8'), beforeRetry)
  success(f.run('checkpoint', 'task', checkpoint()))
  assert.equal(success(f.run('status', 'task')).handoff, null)
  const next = success(f.run('handoff', 'task'))
  assert.notEqual(next.path, first.path)
  assert.equal(fs.readFileSync(first.path, 'utf8'), markdown)
  success(f.run('assign', 'task', { primaryMentorId: 'verity' }))
  assert.equal(success(f.run('status', 'task')).handoff, null)
  const reassigned = success(f.run('handoff', 'task'))
  assert.notEqual(reassigned.digest, next.digest)
  fs.writeFileSync(reassigned.path, 'modified')
  failure(f.run('handoff', 'task'), 'HANDOFF_CONFLICT')
})

test('strict config rejects duplicate, invalid, oversized and silently discarded values', (t) => {
  const inputs = [
    { mentors: [{ id: 'duplicate' }, { id: 'duplicate' }] },
    { faculties: [{ id: 'duplicate' }, { id: 'duplicate' }] },
    { mentors: [{ id: '../bad' }] },
    { mentors: [{ id: 'one', role: 'unknown' }] },
    { mentors: [{ id: 'one', color: 'invalid' }] },
    { faculties: [{ id: 'one', prompt: 'x'.repeat(8001) }] },
    { mentors: [{ id: 'one', name: 'x'.repeat(81) }] },
    { mentors: [{ id: 'one', domainPrompt: 'x', prompt: 'y' }] },
    { mentors: [{ id: 'one', responsibilities: { tags: ['duplicate', 'duplicate'] } }] },
    { mentors: [{ id: 'one', ignored: 'value' }] },
    { faculties: [{ id: 'one', ignored: 'value' }] },
    { mentors: [], faculties: [] },
    { mentors: null, faculties: [{ id: 'valid' }] },
    { mentors: [{ id: 'one', tags: ['first'], responsibilities: { tags: ['second'] } }] },
  ]
  for (const input of inputs) {
    const f = fixture(t)
    const result = f.run('init', undefined, input)
    assert.equal(result.status, 1)
    assert.equal(fs.existsSync(f.statePath), false)
  }
})

test('basic credential and raw-log filters reject content without echoing it or modifying state', (t) => {
  const f = fixture(t)
  success(f.run('init'))
  success(f.run('assign', 'task'))
  const before = fs.readFileSync(f.statePath, 'utf8')
  const syntheticCredential = 'synthetic-value-for-testing'
  const suspiciousInputs = [
    ['api_key', syntheticCredential].join('='),
    ['Bearer', syntheticCredential].join(' '),
    'sk-' + 'x'.repeat(24),
    ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' '),
  ]
  for (const suspicious of suspiciousInputs) {
    const result = f.run('checkpoint', 'task', checkpoint({ evidence: [suspicious] }))
    failure(result, 'SENSITIVE_INPUT')
    assert.equal(result.stderr.includes(suspicious), false)
  }
  for (const log of ['assistant: raw transcript', '2026-10-17T00:00:00 DEBUG noisy log', 'at function (/app/script.js:1)']) failure(f.run('checkpoint', 'task', checkpoint({ summary: log })), 'RAW_LOG_INPUT')
  failure(f.run('checkpoint', 'task', checkpoint({ evidence: ['first line\nraw log'] })), 'INVALID_DATA')
  assert.equal(fs.readFileSync(f.statePath, 'utf8'), before)
  success(f.run('checkpoint', 'task', checkpoint({ evidence: ['Credential removed; focused unit tests passed.'] })))
})

test('unknown schema, corrupt structure, handoff pointers and workspace binding are refused', (t) => {
  const f = fixture(t)
  success(f.run('init'))
  success(f.run('assign', 'task'))
  const valid = f.state()
  for (const [changes, code] of [
    [{ schemaVersion: 99 }, 'UNKNOWN_SCHEMA'],
    [{ revision: '1' }, 'INVALID_DATA'],
    [{ workspace: '/somewhere/else' }, 'WORKSPACE_BINDING'],
    [{ tasks: { task: { ...valid.tasks.task, handoff: { digest: 'a'.repeat(64), relativePath: '../escape', checkpointSequence: 0 } } } }, 'INVALID_STATE'],
    [{ tasks: { task: { ...valid.tasks.task, assignment: { ...valid.tasks.task.assignment, primaryMentorId: 'missing' } } } }, 'INVALID_ASSIGNMENT'],
  ]) {
    f.rewrite({ ...valid, ...changes })
    const before = fs.readFileSync(f.statePath, 'utf8')
    failure(f.run('status'), code)
    failure(f.run('init'), code)
    assert.equal(fs.readFileSync(f.statePath, 'utf8'), before)
  }
  fs.writeFileSync(f.statePath, '{not-json')
  failure(f.run('status'), 'INVALID_JSON')
})

test('a concurrent writer is rejected while the lock holder is active', async (t) => {
  const f = fixture(t)
  success(f.run('init'))
  const before = fs.readFileSync(f.statePath, 'utf8')
  const release = path.join(f.workspace, 'release-lock')
  const source = `import fs from 'node:fs'; import { workspacePaths, withStateLock } from ${JSON.stringify(stateModule)}; withStateLock(workspacePaths(${JSON.stringify(f.workspace)}), () => { process.stdout.write('ready\\n'); const deadline = Date.now() + 15000; while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); });`
  const holder = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
  const done = new Promise((resolve, reject) => { holder.on('error', reject); holder.on('close', resolve) })
  await new Promise((resolve, reject) => {
    holder.on('error', reject)
    holder.stdout.once('data', resolve)
    holder.on('exit', (code) => { if (code !== 0) reject(new Error(`Lock holder failed: ${code}`)) })
  })
  try {
    failure(f.run('assign', 'blocked'), 'LOCKED')
    assert.equal(fs.readFileSync(f.statePath, 'utf8'), before)
  } finally {
    fs.writeFileSync(release, 'release')
  }
  assert.equal(await done, 0)
  success(f.run('assign', 'unblocked'))
  assert.equal(fs.existsSync(path.join(f.workspace, '.codex', 'supervisor', '.lock')), false)
})

test('task traversal, malformed flags, symlink inputs and size limits cannot modify state', (t) => {
  const f = fixture(t)
  success(f.run('init'))
  const before = fs.readFileSync(f.statePath, 'utf8')
  failure(f.run('assign', '../escape'), 'INVALID_DATA')
  failure(f.run('assign', 'task', undefined, ['--task', 'other']), 'USAGE')
  failure(f.run('status', undefined, undefined, ['--unknown', 'x']), 'USAGE')
  const input = path.join(f.workspace, 'input.json')
  const link = path.join(f.workspace, 'input-link.json')
  fs.writeFileSync(input, '{}')
  fs.symlinkSync(input, link)
  failure(f.run('assign', 'task', undefined, ['--input', link]), 'UNSAFE_PATH')
  fs.writeFileSync(input, ' '.repeat(256 * 1024 + 1))
  failure(f.run('assign', 'task', undefined, ['--input', input]), 'SIZE_LIMIT')
  assert.equal(fs.readFileSync(f.statePath, 'utf8'), before)
  fs.writeFileSync(f.statePath, ' '.repeat(1024 * 1024 + 1))
  failure(f.run('status'), 'SIZE_LIMIT')
})

test('symlinked state directories, state file, lock and handoff file are refused', (t) => {
  for (const location of ['.codex', '.codex/supervisor', '.codex/supervisor/state.v1.json', '.codex/supervisor/.lock', '.codex/supervisor/handoffs']) {
    const f = fixture(t)
    success(f.run('init'))
    const target = path.join(f.workspace, location)
    const outside = path.join(f.workspace, 'outside')
    if (location.endsWith('.json') || location.endsWith('.lock')) fs.writeFileSync(outside, '{}')
    else fs.mkdirSync(outside)
    fs.rmSync(target, { recursive: true, force: true })
    fs.symlinkSync(outside, target)
    failure(f.run('status'), 'UNSAFE_PATH')
  }
  const f = fixture(t)
  success(f.run('init'))
  success(f.run('assign', 'task'))
  success(f.run('checkpoint', 'task', checkpoint()))
  const handoff = success(f.run('handoff', 'task'))
  fs.unlinkSync(handoff.path)
  fs.symlinkSync(f.statePath, handoff.path)
  failure(f.run('handoff', 'task'), 'UNSAFE_PATH')
})

test('realpath workspace binding accepts an alias to the same directory', (t) => {
  const f = fixture(t)
  success(f.run('init'))
  const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-supervisor-alias-'))
  t.after(() => fs.rmSync(aliasRoot, { recursive: true, force: true }))
  const alias = path.join(aliasRoot, 'workspace')
  fs.symlinkSync(f.workspace, alias)
  const result = spawnSync(process.execPath, [cli, 'status', '--workspace', alias], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).workspace, fs.realpathSync(f.workspace))
})
