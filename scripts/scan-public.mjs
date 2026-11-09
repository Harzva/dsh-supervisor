import { readdir, readFile } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { basename, extname, join, relative } from 'node:path'
import { promisify } from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))
const execFile = promisify(execFileCallback)
const ignoredDirectories = new Set(['.git', 'node_modules', 'artifacts', 'baselines'])
const textExtensions = new Set(['', '.js', '.json', '.md', '.mjs', '.txt', '.yaml', '.yml'])
const findings = []
const pathPattern = new RegExp('/(?:' + ['Users', 'Volumes'].join('|') + ')/')
const windowsPathPattern = new RegExp('[A-Za-z]:\\\\' + 'Users\\\\', 'i')
const privateKeyPattern = new RegExp('-----BEGIN ' + '(?:RSA |EC |OPENSSH )?PRIVATE KEY-----')
const credentialAssignment = new RegExp('\\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\\s*[:=]\\s*["\\\']?(?!<|example|redacted)[A-Za-z0-9_./+=-]{16,}', 'i')
const patterns = Object.freeze([
  ['private-unix-path', pathPattern],
  ['private-windows-path', windowsPathPattern],
  ['runtime-session-id', /\bsession-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i],
  ['local-service-endpoint', /\b(?:127\.0\.0\.1|localhost):\d{2,5}\b/i],
  ['private-key', privateKeyPattern],
  ['aws-access-key', /AKIA[0-9A-Z]{16}/],
  ['github-token', /gh[pousr]_[A-Za-z0-9_]{20,}/],
  ['provider-token', /(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{20,}/],
  ['credential-assignment', credentialAssignment],
])

function inspectText(file, text) {
  for (const [code, pattern] of patterns) {
    if (pattern.test(text)) findings.push({ file, code })
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await walk(path)
      continue
    }
    if (!entry.isFile()) continue
    const rel = relative(root, path)
    const isBackup = basename(path).includes('.bak-')
    if (/\.env(?:\.|$)/i.test(entry.name) || /\.(?:jsonl|log)$/i.test(entry.name)) {
      findings.push({ file: rel, code: 'forbidden-public-file' })
      continue
    }
    if (!isBackup && !textExtensions.has(extname(entry.name).toLowerCase())) continue
    inspectText(rel, await readFile(path, 'utf8'))
  }
}

await walk(root)

try {
  const { stdout: trackedOutput } = await execFile(
    'git',
    ['-C', root, 'ls-files', '-z'],
    { encoding: 'utf8' },
  )
  for (const file of trackedOutput.split('\0').filter(Boolean)) {
    if (file.startsWith('baselines/')) {
      findings.push({ file, code: 'tracked-private-baseline' })
    }
    if (/^artifacts\/.*\.tgz$/i.test(file)) {
      findings.push({ file, code: 'tracked-private-rollback-artifact' })
    }
    if (/^lib\/.*\.bak-/i.test(file)) {
      findings.push({ file, code: 'tracked-private-backup' })
    }
  }
} catch {
  // A recovered pre-Git P0 tree has no tracked-file set yet. The same check
  // becomes mandatory automatically as soon as the canonical repository exists.
}

if (findings.length > 0) {
  process.stderr.write(`${JSON.stringify({ ok: false, findings }, null, 2)}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`${JSON.stringify({ ok: true, findingCount: 0 })}\n`)
}
