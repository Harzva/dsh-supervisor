import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const root = fileURLToPath(new URL('../', import.meta.url))
const runtimeFiles = Object.freeze([
  'index.js',
  'client.js',
  'mentor-registry.js',
  'supervisor-store.js',
  'handoff-service.js',
  'roundtable-graph.js',
  'judgement-context.js',
  'execution-state.js',
  'progress-assessment.js',
  'project-memory.js',
])
const requiredFiles = Object.freeze([
  'package.json',
  'README.md',
  'INPUTS.md',
  'LICENSE',
  'cordis.patch.yml',
  ...runtimeFiles.map((file) => `lib/${file}`),
  'docs/groupx-supervisor-upgrade.md',
  'docs/images/supervisor-session-matrix.png',
  'docs/01-需求分析.md',
  'docs/02-架构设计.md',
  'docs/03-开发计划.md',
  'docs/05-验收报告.md',
  'docs/smart-supervision-v2/README.md',
  'docs/smart-supervision-v2/01-需求分析.md',
  'docs/smart-supervision-v2/02-架构设计.md',
  'docs/smart-supervision-v2/03-开发计划.md',
  'docs/smart-supervision-v2/04-验收矩阵.md',
  'docs/supervisor-roundtable-graph/01-需求分析.md',
  'docs/supervisor-roundtable-graph/02-架构设计.md',
  'docs/supervisor-roundtable-graph/03-开发计划.md',
  'docs/supervisor-roundtable-graph/NEXT_GOAL.md',
  'docs/supervisor-roundtable-graph/frontend-audit-checklist.md',
  'docs/supervisor-roundtable-graph/issue-11-groupx-badge-evidence.md',
  'docs/supervisor-roundtable-graph/queued-execution.md',
  'docs/supervisor-roundtable-graph/task-brief-for-supervisor.md',
])
const forbiddenPrefixes = Object.freeze(['src/', 'scripts/', 'test/', 'artifacts/', 'evidence/', 'baselines/', '.git/'])

function invariant(condition, message) {
  if (!condition) throw new Error(`Pack verification failed: ${message}`)
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const packRoot = await mkdtemp(join(tmpdir(), 'dsh-supervisor-pack-'))

try {
  const { stdout } = await execFile('npm', [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    packRoot,
  ], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  const result = JSON.parse(stdout)[0]
  const packedFiles = result.files.map((entry) => entry.path).sort()
  const packedSet = new Set(packedFiles)
  const archive = join(packRoot, basename(result.filename))
  const archiveBytes = await readFile(archive)

  invariant(result.name === manifest.name, 'package name drifted')
  invariant(result.version === manifest.version, 'package version drifted')
  for (const file of requiredFiles) invariant(packedSet.has(file), `missing ${file}`)
  invariant(JSON.stringify(packedFiles) === JSON.stringify([...requiredFiles].sort()), 'pack file list changed')
  for (const file of packedFiles) {
    invariant(!forbiddenPrefixes.some((prefix) => file.startsWith(prefix)), `forbidden file ${file}`)
    invariant(!file.includes('.bak-'), `backup file leaked: ${file}`)
  }
  const packedRuntimeFiles = packedFiles.filter((file) => file.startsWith('lib/') && file.endsWith('.js')).sort()
  invariant(JSON.stringify(packedRuntimeFiles) === JSON.stringify(runtimeFiles.map((file) => `lib/${file}`).sort()), 'runtime file set changed')

  const { stdout: packedManifestBytes } = await execFile('tar', ['-xOf', archive, 'package/package.json'], { encoding: null, maxBuffer: 1024 * 1024 })
  const packedManifest = JSON.parse(packedManifestBytes.toString('utf8'))
  invariant(JSON.stringify(packedManifest.exports) === JSON.stringify(manifest.exports), 'packed exports changed')

  const moduleDigests = {}
  for (const file of runtimeFiles) {
    const { stdout: packedBytes } = await execFile('tar', ['-xOf', archive, `package/lib/${file}`], { encoding: null, maxBuffer: 1024 * 1024 })
    const sourceBytes = await readFile(join(root, 'lib', file))
    invariant(packedBytes.equals(sourceBytes), `packed ${file} differs from built output`)
    moduleDigests[file] = digest(sourceBytes)
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    name: result.name,
    version: result.version,
    fileCount: packedFiles.length,
    tarballSha256: digest(archiveBytes),
    moduleDigests,
  }, null, 2)}\n`)
} finally {
  await rm(packRoot, { recursive: true, force: true })
}
