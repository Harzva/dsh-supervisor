import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { verifyCommand } from './native-executor.mjs'

const MAX_FILE = 1024 * 1024
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

function inspectFile(workspace, relative) {
  const segments = relative.split(/[\\/]/)
  if (!relative || path.isAbsolute(relative) || segments.some(value => !value || value === '.' || value === '..')) throw new Error('unsafe-path')
  let target = workspace
  for (const segment of segments) {
    target = path.join(target, segment)
    const stat = fs.lstatSync(target)
    if (stat.isSymbolicLink()) throw new Error('unsafe-path')
  }
  let fd
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('file-limit')
    const buffer = Buffer.alloc(MAX_FILE + 1)
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0)
    if (count > MAX_FILE) throw new Error('file-limit')
    return buffer.subarray(0, count)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

export async function verify(workspace, checks, { commandVerifier = verifyCommand, signal } = {}) {
  const results = []
  const receipt = () => ({ checkedAt: Date.now(), passed: !signal?.aborted && results.length === checks.length && results.every(result => result.passed), ...(signal?.aborted ? { cancelled: true } : {}), ...(results.some(result => result.kind === 'command' && result.completionConfirmed === false) ? { uncertain: true } : {}), checks: results })
  for (const [index, check] of checks.entries()) {
    if (signal?.aborted) return receipt()
    if (check.kind === 'file') {
      try {
        const bytes = inspectFile(workspace, check.path)
        const sha256 = hash(bytes)
        const passed = (!check.sha256 || sha256 === check.sha256) && (check.contains === undefined || bytes.toString('utf8').includes(check.contains))
        results.push({ index, kind: 'file', path: check.path, passed, sha256, bytes: bytes.length, reason: passed ? 'matched' : 'content-mismatch' })
      } catch (error) {
        results.push({ index, kind: 'file', path: check.path, passed: false, reason: error.code === 'ENOENT' ? 'missing-file' : 'unreadable-or-unsafe-file' })
      }
    } else {
      try {
        const result = await commandVerifier({ workspace, argv: check.argv, timeoutMs: check.timeoutMs, signal })
        const needsUserAction = Boolean(result.needsUserAction || result.status === 'needs-user-action')
        const completionConfirmed = result.completionConfirmed ?? Number.isSafeInteger(result.exitCode)
        const passed = completionConfirmed && result.exitCode === 0 && !result.timedOut && !needsUserAction && !signal?.aborted
        // Store only the native command's structured evidence, never its output.
        const evidence = { index, kind: 'command', passed, completionConfirmed, exitCode: result.exitCode ?? null }
        for (const key of ['status', 'stdoutDigest', 'stderrDigest', 'outputBytes', 'timedOut', 'needsUserAction', 'cancelled']) {
          if (result[key] !== undefined) evidence[key] = result[key]
        }
        if (needsUserAction) evidence.needsUserAction = true
        results.push(evidence)
        if (!completionConfirmed || needsUserAction) return receipt()
      } catch {
        results.push({ index, kind: 'command', passed: false, completionConfirmed: false, reason: 'native-command-receipt-unconfirmed' })
        return receipt()
      }
    }
  }
  return receipt()
}
