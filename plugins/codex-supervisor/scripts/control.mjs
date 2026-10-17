import fs from 'node:fs'
import path from 'node:path'
import { fail, SupervisorError, workspacePaths, withStateLock, writeState } from './state.mjs'

const MAX_CONTROL_BYTES = 4096
const FIELDS = ['schemaVersion', 'workspace', 'revision', 'enabled', 'updatedAt']

function pathsFor(workspace, create = false) {
  const paths = workspacePaths(workspace, create)
  const result = { ...paths, state: path.join(paths.root, 'control.v1.json'), lock: path.join(paths.root, '.control.lock') }
  for (const target of [result.state, result.lock]) {
    try {
      const stat = fs.lstatSync(target)
      if (stat.isSymbolicLink() || !stat.isFile()) fail('UNSAFE_PATH', 'Supervisor control files must be regular files, without symlinks.')
    } catch (error) {
      if (error instanceof SupervisorError) throw error
      if (error.code !== 'ENOENT') fail('PATH_ACCESS', 'Cannot inspect a Supervisor control path.')
    }
  }
  return result
}

function validate(state, workspace) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || Object.keys(state).some(key => !FIELDS.includes(key))) fail('INVALID_CONTROL', 'Supervisor control must be an object with known fields.')
  if (state.schemaVersion !== 1) fail('UNKNOWN_SCHEMA', 'Supervisor control schema is unsupported; preserve it for migration.')
  if (state.workspace !== workspace) fail('WORKSPACE_BINDING', 'Supervisor control is bound to another real workspace path.')
  if (typeof state.enabled !== 'boolean' || !Number.isSafeInteger(state.revision) || state.revision < 1 || !Number.isSafeInteger(state.updatedAt) || state.updatedAt < 0) fail('INVALID_CONTROL', 'Supervisor control fields are invalid.')
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_CONTROL_BYTES) fail('SIZE_LIMIT', 'Supervisor control exceeds its size limit.')
}

function snapshot(paths) {
  pathsFor(paths.workspace)
  let fd
  try {
    fd = fs.openSync(paths.state, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) fail('UNSAFE_PATH', 'Supervisor control must be a regular file, without symlinks.')
    if (stat.size > MAX_CONTROL_BYTES) fail('SIZE_LIMIT', 'Supervisor control exceeds its size limit.')
    const bytes = Buffer.alloc(MAX_CONTROL_BYTES + 1)
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0)
    if (length > MAX_CONTROL_BYTES) fail('SIZE_LIMIT', 'Supervisor control exceeds its size limit.')
    let state
    try { state = JSON.parse(bytes.subarray(0, length).toString('utf8')) } catch { fail('INVALID_JSON', 'Supervisor control is not valid JSON.') }
    validate(state, paths.workspace)
    return state
  } catch (error) {
    if (error instanceof SupervisorError) throw error
    if (error.code === 'ENOENT') return null
    fail('PATH_ACCESS', 'Cannot read Supervisor control.')
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function publicControl(workspace, state) {
  return { workspace, enabled: state?.enabled ?? true, revision: state?.revision ?? 0, configured: state !== null }
}

// The compatible default is read-only: viewing a new project does not create
// .codex, a roster, an execution store, a lock or a control file.
export function readControl(workspace) {
  const paths = pathsFor(workspace)
  return publicControl(paths.workspace, snapshot(paths))
}

export function setControl(workspace, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['enabled', 'expectedRevision'].includes(key)) || typeof input.enabled !== 'boolean') fail('INVALID_CONTROL', 'Set control requires enabled as a boolean.')
  if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) fail('INVALID_CONTROL', 'Expected control revision must be a nonnegative safe integer.')
  const paths = pathsFor(workspace, true)
  return withStateLock(paths, () => {
    const current = snapshot(paths)
    const revision = current?.revision ?? 0
    if (input.expectedRevision !== undefined && input.expectedRevision !== revision) fail('STALE_CONTROL', 'Supervisor control changed; refresh its state before changing the switch.')
    if (current?.enabled === input.enabled) return publicControl(paths.workspace, current)
    if (revision >= Number.MAX_SAFE_INTEGER) fail('REVISION_LIMIT', 'Supervisor control revision is exhausted; preserve the control file for migration.')
    const state = { schemaVersion: 1, workspace: paths.workspace, revision: revision + 1, enabled: input.enabled, updatedAt: Math.max(Date.now(), current?.updatedAt ?? 0) }
    pathsFor(paths.workspace)
    writeState(paths, state, validate)
    return publicControl(paths.workspace, state)
  })
}
