#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fail, SupervisorError, workspacePaths, withStateLock, writeState } from './state.mjs'

const MAX_BYTES = 4096
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const FIELDS = ['schemaVersion', 'workspace', 'revision', 'mode', 'model', 'reasoningEffort', 'updatedAt']

function pathsFor(workspace, create = false) {
  const paths = workspacePaths(workspace, create)
  const result = { ...paths, state: path.join(paths.root, 'settings.v1.json'), lock: path.join(paths.root, '.settings.lock') }
  for (const target of [result.state, result.lock]) {
    try {
      const stat = fs.lstatSync(target)
      if (stat.isSymbolicLink() || !stat.isFile()) fail('UNSAFE_PATH', 'Execution settings paths must be regular files, without symlinks.')
    } catch (error) {
      if (error instanceof SupervisorError) throw error
      if (error.code !== 'ENOENT') fail('PATH_ACCESS', 'Cannot inspect execution settings.')
    }
  }
  return result
}

function validateSelection(input) {
  if (!['default', 'custom'].includes(input.mode)) fail('INVALID_SETTINGS', 'Unsupported execution model mode.')
  if (input.mode === 'default') {
    if (input.model !== null || input.reasoningEffort !== null) fail('INVALID_SETTINGS', 'Default mode resolves the model and effort from the native catalog.')
  } else {
    if (typeof input.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(input.model)) fail('INVALID_SETTINGS', 'An explicit native model is required.')
    if (input.reasoningEffort !== null && !EFFORTS.has(input.reasoningEffort)) fail('INVALID_SETTINGS', 'Unsupported reasoning effort.')
  }
}

function validate(state, workspace) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || Object.keys(state).some(key => !FIELDS.includes(key))) fail('INVALID_SETTINGS', 'Execution settings contain unknown fields.')
  if (state.schemaVersion !== 1) fail('UNKNOWN_SCHEMA', 'Unsupported execution settings schema; preserve it for migration.')
  if (state.workspace !== workspace) fail('WORKSPACE_BINDING', 'Execution settings belong to another workspace.')
  if (!Number.isSafeInteger(state.revision) || state.revision < 1 || !Number.isSafeInteger(state.updatedAt) || state.updatedAt < 0) fail('INVALID_SETTINGS', 'Invalid execution settings revision.')
  validateSelection(state)
}

function snapshot(paths) {
  pathsFor(paths.workspace)
  let fd
  try {
    fd = fs.openSync(paths.state, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) fail('UNSAFE_PATH', 'Execution settings must be a regular file.')
    if (stat.size > MAX_BYTES) fail('SIZE_LIMIT', 'Execution settings exceed the size limit.')
    const bytes = Buffer.alloc(MAX_BYTES + 1)
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0)
    if (length > MAX_BYTES) fail('SIZE_LIMIT', 'Execution settings exceed the size limit.')
    let state
    try { state = JSON.parse(bytes.subarray(0, length).toString('utf8')) } catch { fail('INVALID_JSON', 'Execution settings are not valid JSON.') }
    validate(state, paths.workspace)
    return state
  } catch (error) {
    if (error instanceof SupervisorError) throw error
    if (error.code === 'ENOENT') return null
    fail('PATH_ACCESS', 'Cannot read execution settings.')
  } finally { if (fd !== undefined) fs.closeSync(fd) }
}

function publicSettings(state) {
  return { mode: state?.mode ?? 'default', model: state?.model ?? null, reasoningEffort: state?.reasoningEffort ?? null, revision: state?.revision ?? 0, configured: state !== null }
}

export function readExecutionSettings(workspace) {
  return publicSettings(snapshot(pathsFor(workspace)))
}

export function setExecutionSettings(workspace, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['mode', 'model', 'reasoningEffort', 'expectedRevision'].includes(key))) fail('INVALID_SETTINGS', 'Invalid execution settings input.')
  validateSelection(input)
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail('INVALID_SETTINGS', 'Expected settings revision must be a nonnegative safe integer.')
  const paths = pathsFor(workspace, true)
  return withStateLock(paths, () => {
    const current = snapshot(paths)
    const revision = current?.revision ?? 0
    if (input.expectedRevision !== revision) fail('STALE_SETTINGS', 'Execution settings changed; refresh before saving.')
    if (current && ['mode', 'model', 'reasoningEffort'].every(key => current[key] === input[key])) return publicSettings(current)
    if (revision >= Number.MAX_SAFE_INTEGER) fail('REVISION_LIMIT', 'Settings revision is exhausted; preserve the file for migration.')
    const state = { schemaVersion: 1, workspace: paths.workspace, revision: revision + 1, mode: input.mode, model: input.model, reasoningEffort: input.reasoningEffort, updatedAt: Math.max(Date.now(), current?.updatedAt ?? 0) }
    pathsFor(paths.workspace)
    writeState(paths, state, validate)
    return publicSettings(state)
  })
}

export function resolveSelection(settings, proposal, catalog) {
  const list = catalog?.models
  if (!Array.isArray(list) || !list.length) fail('MODEL_CATALOG_UNAVAILABLE', 'The native model catalog is unavailable.')
  const requested = proposal.model ?? (settings.mode === 'custom' ? settings.model : list.find(entry => entry.isDefault)?.model)
  const entry = list.find(entry => entry.model === requested)
  if (!entry) fail('MODEL_UNAVAILABLE', 'The selected model is unavailable in the native execution catalog.')
  const requestedEffort = proposal.reasoningEffort ?? (settings.mode === 'custom' && settings.model === requested ? settings.reasoningEffort : null) ?? entry.defaultReasoningEffort
  if (!EFFORTS.has(requestedEffort) || !entry.supportedReasoningEfforts?.some(item => item.reasoningEffort === requestedEffort)) fail('REASONING_UNAVAILABLE', 'The selected reasoning effort is unavailable for this model.')
  return { ...proposal, model: entry.model, reasoningEffort: requestedEffort }
}

export async function applyExecutionSettings(workspace, proposal, { models } = {}) {
  const settings = readExecutionSettings(workspace)
  // Existing CLI users and historical proposals remain compatible. Once the
  // user saves panel settings, every new proposal resolves a fresh catalog.
  if (!settings.configured) return proposal
  if (typeof models !== 'function') fail('MODEL_CATALOG_UNAVAILABLE', 'A native catalog reader is required.')
  let catalog
  try { catalog = await models({ workspace: workspacePaths(workspace).workspace }) } catch { fail('MODEL_CATALOG_UNAVAILABLE', 'Cannot read the native model catalog.') }
  return resolveSelection(settings, proposal, catalog)
}

if (process.argv[1] && path.basename(process.argv[1]) === 'settings.mjs' && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 3 || args[0] !== 'show' || args[1] !== '--workspace') fail('USAGE', 'Usage: node scripts/settings.mjs show --workspace <project>')
    process.stdout.write(JSON.stringify(readExecutionSettings(args[2]), null, 2) + '\n')
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: { code: error instanceof SupervisorError ? error.code : 'SETTINGS_FAILED' } }) + '\n')
    process.exitCode = 1
  }
}
