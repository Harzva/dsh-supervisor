import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const MAX_INPUT_BYTES = 256 * 1024
export const MAX_STATE_BYTES = 1024 * 1024

export class SupervisorError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function fail(code, message) {
  throw new SupervisorError(code, message)
}

function statOrNull(target) {
  try { return fs.lstatSync(target) } catch (error) {
    if (error.code === 'ENOENT') return null
    fail('PATH_ACCESS', 'Cannot inspect a Supervisor path.')
  }
}

function directory(target, create) {
  let stat = statOrNull(target)
  if (!stat && create) {
    try { fs.mkdirSync(target, { mode: 0o700 }) } catch (error) {
      if (error.code !== 'EEXIST') fail('PATH_ACCESS', 'Cannot create a Supervisor directory.')
    }
    stat = statOrNull(target)
  }
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
    fail('UNSAFE_PATH', 'Supervisor directories must be real directories, without symlinks.')
  }
  return stat !== null
}

export function workspacePaths(workspace, create = false) {
  let resolved
  try {
    resolved = fs.realpathSync(workspace)
    if (!fs.statSync(resolved).isDirectory()) fail('WORKSPACE', 'Workspace must be an existing directory.')
  } catch (error) {
    if (error instanceof SupervisorError) throw error
    fail('WORKSPACE', 'Workspace must be an existing directory.')
  }
  const codex = path.join(resolved, '.codex')
  const root = path.join(codex, 'supervisor')
  const handoffs = path.join(root, 'handoffs')
  directory(codex, create)
  directory(root, create)
  directory(handoffs, false)
  const result = { workspace: resolved, root, handoffs, state: path.join(root, 'state.v1.json'), lock: path.join(root, '.lock') }
  for (const target of [result.state, result.lock]) {
    const stat = statOrNull(target)
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) fail('UNSAFE_PATH', 'Supervisor files must be regular files, without symlinks.')
  }
  return result
}

function readRegularFile(target, maxBytes, kind, missingAllowed = false) {
  const stat = statOrNull(target)
  if (!stat) {
    if (missingAllowed) return null
    fail('MISSING_INPUT', `${kind} file does not exist.`)
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail('UNSAFE_PATH', `${kind} must be a regular file, without symlinks.`)
  if (stat.size > maxBytes) fail('SIZE_LIMIT', `${kind} exceeds its size limit.`)
  let fd
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.size > maxBytes) fail('SIZE_LIMIT', `${kind} exceeds its size limit.`)
    // A bounded read also handles files growing after fstat.
    const bytes = Buffer.alloc(maxBytes + 1)
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0)
    if (length > maxBytes) fail('SIZE_LIMIT', `${kind} exceeds its size limit.`)
    return bytes.subarray(0, length).toString('utf8')
  } catch (error) {
    if (error instanceof SupervisorError) throw error
    fail('PATH_ACCESS', `Cannot read ${kind.toLowerCase()} file.`)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function parseJSON(source, kind) {
  try { return JSON.parse(source) } catch { fail('INVALID_JSON', `${kind} is not valid JSON.`) }
}

export function readInput(file) {
  return parseJSON(readRegularFile(path.resolve(file), MAX_INPUT_BYTES, 'Input'), 'Input')
}

export function readState(paths, validate, missingAllowed = false) {
  workspacePaths(paths.workspace)
  const source = readRegularFile(paths.state, MAX_STATE_BYTES, 'State', true)
  if (source === null) {
    if (missingAllowed) return null
    fail('NOT_INITIALIZED', 'Run init for this workspace first.')
  }
  const state = parseJSON(source, 'State')
  validate(state, paths.workspace)
  return state
}

export function withStateLock(paths, action) {
  workspacePaths(paths.workspace, true)
  let fd
  try {
    fd = fs.openSync(paths.lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') fail('LOCKED', 'Another writer holds the Supervisor lock. Investigate a stale lock before removing it manually.')
    fail('PATH_ACCESS', 'Cannot acquire the Supervisor lock.')
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }))
    fs.fsyncSync(fd)
    return action()
  } finally {
    fs.closeSync(fd)
    fs.unlinkSync(paths.lock)
  }
}

export function writeState(paths, state, validate) {
  workspacePaths(paths.workspace)
  validate(state, paths.workspace)
  const source = `${JSON.stringify(state, null, 2)}\n`
  if (Buffer.byteLength(source) > MAX_STATE_BYTES) fail('SIZE_LIMIT', 'State exceeds its size limit; preserve the current state and start a separate workspace.')
  const temporary = path.join(paths.root, `.state-${randomUUID()}.tmp`)
  let fd
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    fs.writeFileSync(fd, source)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    workspacePaths(paths.workspace)
    fs.renameSync(temporary, paths.state)
  } catch (error) {
    if (error instanceof SupervisorError) throw error
    fail('STATE_WRITE', 'Cannot atomically write Supervisor state.')
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    if (statOrNull(temporary)) fs.unlinkSync(temporary)
  }
}

export function ensureHandoff(paths, filename, content) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}-[a-f0-9]{64}\.md$/i.test(filename)) fail('UNSAFE_PATH', 'Invalid handoff filename.')
  workspacePaths(paths.workspace)
  directory(paths.handoffs, true)
  const target = path.join(paths.handoffs, filename)
  const existing = readRegularFile(target, MAX_INPUT_BYTES, 'Handoff', true)
  if (existing !== null) {
    if (existing !== content) fail('HANDOFF_CONFLICT', 'An existing handoff has different content. Preserve it and investigate.')
    return target
  }
  let fd
  const temporary = path.join(paths.handoffs, `.handoff-${randomUUID()}.tmp`)
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    fs.writeFileSync(fd, content)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    workspacePaths(paths.workspace)
    // Publish a completed file exclusively; never replace another handoff.
    fs.linkSync(temporary, target)
  } catch (error) {
    if (error instanceof SupervisorError) throw error
    fail('HANDOFF_WRITE', 'Cannot write the handoff file.')
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    if (statOrNull(temporary)) fs.unlinkSync(temporary)
  }
  return target
}
