import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readExecutionSettings, setExecutionSettings, applyExecutionSettings } from '../plugins/codex-supervisor/scripts/settings.mjs'
import { run } from '../plugins/codex-supervisor/scripts/execution.mjs'
import { run as supervisor } from '../plugins/codex-supervisor/scripts/supervisor.mjs'

const catalog = { configuredModel: 'different-configured-model', models: [
  { id: 'alpha', model: 'alpha', displayName: 'Alpha', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }, { reasoningEffort: 'high', description: 'Detailed' }] },
  { id: 'beta', model: 'beta', displayName: 'Beta', isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Quick' }] },
] }
const proposal = { instruction: 'Write report.txt.', successCriteria: ['The report is ready.'], verification: [{ kind: 'file', path: 'report.txt' }] }

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'supervisor-settings-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  return workspace
}

test('reading defaults does not create state; saved settings use CAS and private atomic files', t => {
  const workspace = fixture(t)
  assert.deepEqual(readExecutionSettings(workspace), { mode: 'default', model: null, reasoningEffort: null, revision: 0, configured: false })
  assert.deepEqual(fs.readdirSync(workspace), [])
  const input = { mode: 'custom', model: 'beta', reasoningEffort: 'low', expectedRevision: 0 }
  const saved = setExecutionSettings(workspace, input)
  assert.equal(saved.revision, 1)
  const file = path.join(workspace, '.codex/supervisor/settings.v1.json')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const bytes = fs.readFileSync(file)
  assert.throws(() => setExecutionSettings(workspace, input), error => error.code === 'STALE_SETTINGS')
  assert.deepEqual(fs.readFileSync(file), bytes)
  assert.equal(setExecutionSettings(workspace, { ...input, expectedRevision: 1 }).revision, 1)
  assert.deepEqual(readExecutionSettings(workspace), saved)
})

test('configured settings resolve native catalog defaults and preserve explicit proposal choices', async t => {
  const workspace = fixture(t)
  let calls = 0
  const models = async () => { calls++; return catalog }
  assert.equal(await applyExecutionSettings(workspace, proposal, { models }), proposal)
  assert.equal(calls, 0)
  setExecutionSettings(workspace, { mode: 'default', model: null, reasoningEffort: null, expectedRevision: 0 })
  assert.deepEqual(await applyExecutionSettings(workspace, proposal, { models }), { ...proposal, model: 'alpha', reasoningEffort: 'medium' })
  setExecutionSettings(workspace, { mode: 'custom', model: 'beta', reasoningEffort: 'low', expectedRevision: 1 })
  assert.deepEqual(await applyExecutionSettings(workspace, proposal, { models }), { ...proposal, model: 'beta', reasoningEffort: 'low' })
  assert.deepEqual(await applyExecutionSettings(workspace, { ...proposal, model: 'alpha', reasoningEffort: 'high' }, { models }), { ...proposal, model: 'alpha', reasoningEffort: 'high' })
  await assert.rejects(() => applyExecutionSettings(workspace, { ...proposal, model: 'missing' }, { models }), error => error.code === 'MODEL_UNAVAILABLE')
  await assert.rejects(() => applyExecutionSettings(workspace, { ...proposal, reasoningEffort: 'high' }, { models }), error => error.code === 'REASONING_UNAVAILABLE')
  await assert.rejects(() => applyExecutionSettings(workspace, proposal, { models: async () => { throw Error('PRIVATE_NATIVE_ERROR') } }), error => error.code === 'MODEL_CATALOG_UNAVAILABLE' && !error.message.includes('PRIVATE'))
})

test('new CLI proposals bind saved selection into immutable digest; later settings do not alter an authorized job', async t => {
  const workspace = fixture(t)
  supervisor(['init', '--workspace', workspace])
  supervisor(['assign', '--workspace', workspace, '--task', 'report'])
  const input = path.join(workspace, 'proposal.json')
  fs.writeFileSync(input, JSON.stringify(proposal))
  const models = async () => catalog
  setExecutionSettings(workspace, { mode: 'custom', model: 'beta', reasoningEffort: 'low', expectedRevision: 0 })
  const args = ['--workspace', workspace]
  const first = await run(['propose', ...args, '--task', 'report', '--job', 'first', '--input', input], { models })
  await run(['authorize', ...args, '--job', 'first', '--digest', first.digest])
  setExecutionSettings(workspace, { mode: 'custom', model: 'alpha', reasoningEffort: 'high', expectedRevision: 1 })
  const second = await run(['propose', ...args, '--task', 'report', '--job', 'second', '--input', input], { models })
  assert.notEqual(first.digest, second.digest)
  const state = JSON.parse(fs.readFileSync(path.join(workspace, '.codex/supervisor/execution.v1.json')))
  assert.equal(state.jobs.first.proposal.model, 'beta')
  assert.equal(state.jobs.first.proposal.reasoningEffort, 'low')
  assert.equal(state.jobs.first.authorization.proposalDigest, first.digest)
  assert.equal(state.jobs.second.proposal.model, 'alpha')
  assert.equal(state.jobs.second.proposal.reasoningEffort, 'high')
})

test('unsafe settings paths, corrupt state, unsupported effort and fake follow mode are rejected', t => {
  const workspace = fixture(t)
  for (const input of [
    { mode: 'conversation', model: null, reasoningEffort: null },
    { mode: 'default', model: 'alpha', reasoningEffort: null },
    { mode: 'custom', model: 'alpha', reasoningEffort: 'invented' },
  ]) assert.throws(() => setExecutionSettings(workspace, { ...input, expectedRevision: 0 }), error => error.code === 'INVALID_SETTINGS')
  setExecutionSettings(workspace, { mode: 'default', model: null, reasoningEffort: null, expectedRevision: 0 })
  const file = path.join(workspace, '.codex/supervisor/settings.v1.json')
  fs.writeFileSync(file, 'PRIVATE_INVALID_JSON')
  assert.throws(() => readExecutionSettings(workspace), error => error.code === 'INVALID_JSON' && !error.message.includes('PRIVATE'))
  fs.unlinkSync(file)
  const external = path.join(workspace, 'private.json')
  fs.writeFileSync(external, 'PRIVATE_EXTERNAL')
  fs.symlinkSync(external, file)
  assert.throws(() => readExecutionSettings(workspace), error => error.code === 'UNSAFE_PATH')
  assert.equal(fs.readFileSync(external, 'utf8'), 'PRIVATE_EXTERNAL')
})
