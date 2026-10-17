import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const MAX_BINDINGS = 100
const MAX_REGISTRY_BYTES = 512 * 1024
const PATH_LIMIT = 4096

export class PanelError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

export function reject(code) { throw new PanelError(code) }

function fields(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => names.includes(key))
}

function absolute(value, code = 'INVALID_WORKSPACE') {
  if (typeof value !== 'string' || value.length > PATH_LIMIT || !path.isAbsolute(value) || value !== path.resolve(value) || /[\u0000-\u001f\u007f]/.test(value)) reject(code)
  return value
}

function statOrNull(target) {
  try { return fs.lstatSync(target) } catch (error) {
    if (error.code === 'ENOENT') return null
    reject('PATH_ACCESS')
  }
}

// Never follow a caller-selected symlink or a symlink inserted into plugin data.
// Missing components may only be created by the explicit binding operation.
function directoryPath(target, create = false) {
  absolute(target)
  let current = path.parse(target).root
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    let stat = statOrNull(current)
    if (!stat && create) {
      try { fs.mkdirSync(current, { mode: 0o700 }) } catch (error) {
        if (error.code !== 'EEXIST') reject('PATH_ACCESS')
      }
      stat = statOrNull(current)
    }
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) reject('UNSAFE_PATH')
  }
  return Boolean(statOrNull(target))
}

function under(target, root) { return target === root || target.startsWith(`${root}${path.sep}`) }

export function threadContext(meta) {
  return meta && typeof meta === 'object' && typeof meta.threadId === 'string' && UUID.test(meta.threadId) ? meta.threadId.toLowerCase() : null
}

export function bindingId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) reject('INVALID_BINDING')
  return value.toLowerCase()
}

export class BindingRegistry {
  constructor(dataDirectory, pluginRoot) {
    if (!dataDirectory || !pluginRoot) reject('DATA_UNAVAILABLE')
    try {
      this.root = absolute(dataDirectory, 'DATA_UNAVAILABLE')
      this.pluginRoot = fs.realpathSync(absolute(pluginRoot))
      if (this.root === path.parse(this.root).root || under(this.root, this.pluginRoot)) reject('UNSAFE_DATA')
      directoryPath(this.root)
    } catch (error) {
      if (error instanceof PanelError) throw error
      reject('DATA_UNAVAILABLE')
    }
    this.file = path.join(this.root, 'bindings.v1.json')
    this.lock = path.join(this.root, '.bindings.lock')
  }

  validate(state) {
    if (!fields(state, ['schemaVersion', 'bindings']) || state.schemaVersion !== 1 || !Array.isArray(state.bindings) || state.bindings.length > MAX_BINDINGS) reject('INVALID_REGISTRY')
    const ids = new Set()
    const locations = new Set()
    for (const entry of state.bindings) {
      if (!fields(entry, ['id', 'ownerThreadId', 'workspace', 'label']) || !UUID.test(entry.id ?? '') || !UUID.test(entry.ownerThreadId ?? '') || entry.id !== entry.id.toLowerCase() || entry.ownerThreadId !== entry.ownerThreadId.toLowerCase()) reject('INVALID_REGISTRY')
      absolute(entry.workspace)
      if (typeof entry.label !== 'string' || !entry.label || entry.label.length > 128 || /[\u0000-\u001f\u007f]/.test(entry.label) || under(entry.workspace, this.pluginRoot) || under(entry.workspace, this.root)) reject('INVALID_REGISTRY')
      const location = `${entry.ownerThreadId}:${entry.workspace}`
      if (ids.has(entry.id) || locations.has(location)) reject('INVALID_REGISTRY')
      ids.add(entry.id)
      locations.add(location)
    }
  }

  read() {
    directoryPath(this.root)
    const stat = statOrNull(this.file)
    if (!stat) return { schemaVersion: 1, bindings: [] }
    if (stat.isSymbolicLink() || !stat.isFile()) reject('UNSAFE_PATH')
    let fd
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      const opened = fs.fstatSync(fd)
      if (!opened.isFile()) reject('UNSAFE_PATH')
      if (opened.size > MAX_REGISTRY_BYTES) reject('SIZE_LIMIT')
      const bytes = Buffer.alloc(MAX_REGISTRY_BYTES + 1)
      const length = fs.readSync(fd, bytes, 0, bytes.length, 0)
      if (length > MAX_REGISTRY_BYTES) reject('SIZE_LIMIT')
      let state
      try { state = JSON.parse(bytes.subarray(0, length).toString('utf8')) } catch { reject('INVALID_REGISTRY') }
      this.validate(state)
      return state
    } catch (error) {
      if (error instanceof PanelError) throw error
      reject('PATH_ACCESS')
    } finally { if (fd !== undefined) fs.closeSync(fd) }
  }

  list(ownerThreadId) {
    if (!ownerThreadId) return []
    return this.read().bindings.filter(entry => entry.ownerThreadId === ownerThreadId)
  }

  get(ownerThreadId, id) {
    if (!ownerThreadId) reject('THREAD_CONTEXT_REQUIRED')
    const entry = this.list(ownerThreadId).find(item => item.id === bindingId(id))
    if (!entry) reject('UNKNOWN_BINDING')
    this.workspace(entry.workspace)
    return entry
  }

  workspace(input) {
    const workspace = absolute(input)
    if (!directoryPath(workspace)) reject('INVALID_WORKSPACE')
    let real
    try { real = fs.realpathSync(workspace) } catch { reject('INVALID_WORKSPACE') }
    if (real !== workspace) reject('UNSAFE_PATH')
    if (under(real, this.pluginRoot) || under(real, this.root)) reject('INVALID_WORKSPACE')
    return real
  }

  bind(ownerThreadId, input) {
    if (!ownerThreadId) reject('THREAD_CONTEXT_REQUIRED')
    const workspace = this.workspace(input)
    directoryPath(this.root, true)
    let fd
    try {
      fd = fs.openSync(this.lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    } catch (error) {
      if (error.code === 'EEXIST') reject('BINDING_BUSY')
      reject('PATH_ACCESS')
    }
    let temporary
    let temporaryFd
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }))
      fs.fsyncSync(fd)
      const state = this.read()
      const existing = state.bindings.find(entry => entry.ownerThreadId === ownerThreadId && entry.workspace === workspace)
      if (existing) return existing
      if (state.bindings.length >= MAX_BINDINGS) reject('BINDING_LIMIT')
      const entry = { id: randomUUID(), ownerThreadId, workspace, label: path.basename(workspace).slice(0, 128) || workspace }
      state.bindings.push(entry)
      this.validate(state)
      const source = `${JSON.stringify(state, null, 2)}\n`
      if (Buffer.byteLength(source) > MAX_REGISTRY_BYTES) reject('SIZE_LIMIT')
      temporary = path.join(this.root, `.bindings-${randomUUID()}.tmp`)
      temporaryFd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
      fs.writeFileSync(temporaryFd, source)
      fs.fsyncSync(temporaryFd)
      fs.closeSync(temporaryFd)
      temporaryFd = undefined
      directoryPath(this.root)
      const target = statOrNull(this.file)
      if (target && (target.isSymbolicLink() || !target.isFile())) reject('UNSAFE_PATH')
      fs.renameSync(temporary, this.file)
      temporary = undefined
      return entry
    } catch (error) {
      if (error instanceof PanelError) throw error
      reject('REGISTRY_WRITE')
    } finally {
      if (temporaryFd !== undefined) fs.closeSync(temporaryFd)
      if (temporary && statOrNull(temporary)) fs.unlinkSync(temporary)
      fs.closeSync(fd)
      fs.unlinkSync(this.lock)
    }
  }
}
