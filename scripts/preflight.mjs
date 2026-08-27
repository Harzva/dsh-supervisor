import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const runtimeFiles = Object.freeze([
  'index.js',
  'client.js',
  'mentor-registry.js',
  'supervisor-store.js',
  'handoff-service.js',
])
const baselineArtifactDigest = '302a5235c4577f040106447951364fe0db05b98d6b4573fb4e67b6d6b962e23a'
const expectedExports = Object.freeze({
  '.': './lib/index.js',
  './client': './lib/client.js',
  './package.json': './package.json',
  './cordis.patch.yml': './cordis.patch.yml',
})

function invariant(condition, message) {
  if (!condition) throw new Error(`P0 preflight failed: ${message}`)
}

async function digest(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const lockfile = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')

invariant(manifest.name === 'dsh-supervisor', 'unexpected package name')
invariant(manifest.version === '0.2.4', 'package version must remain 0.2.4 during P0')
invariant(manifest.type === 'module', 'package must remain ESM')
invariant(manifest.repository?.url === 'git+https://github.com/Harzva/dsh-supervisor.git', 'canonical repository changed')
invariant(manifest.homepage === 'https://github.com/Harzva/dsh-supervisor#readme', 'canonical homepage changed')
invariant(manifest.bugs?.url === 'https://github.com/Harzva/dsh-supervisor/issues', 'canonical issue tracker changed')
invariant(manifest.main === './lib/index.js' || manifest.main === 'lib/index.js', 'main entry changed')
invariant(manifest.packageManager === 'pnpm@11.20.0', 'package manager is not pinned')
invariant(manifest.engines?.node === '^22.19.0 || >=24', 'Node engine changed')
invariant(JSON.stringify(manifest.exports) === JSON.stringify(expectedExports), 'public exports changed')
invariant(lockfile.includes("lockfileVersion: '9.0'"), 'unsupported pnpm lockfile')
invariant(!/\/(?:Users|Volumes)\//.test(lockfile), 'lockfile contains a private absolute path')

for (const file of runtimeFiles) {
  const source = await readFile(join(root, 'src', file))
  const output = await readFile(join(root, 'lib', file))
  invariant(source.equals(output), `${file} is stale; run npm run build`)
  invariant(manifest.files.includes(`lib/${file}`), `${file} is absent from package files`)
}

const indexSource = await readFile(join(root, 'src', 'index.js'), 'utf8')
const clientSource = await readFile(join(root, 'src', 'client.js'), 'utf8')
const inputs = await readFile(join(root, 'INPUTS.md'), 'utf8')
const baselineEvidence = JSON.parse(await readFile(join(root, 'evidence', 'p0', 'digests.json'), 'utf8'))
const ignoreRules = await readFile(join(root, '.gitignore'), 'utf8')
invariant(indexSource.includes("const PACKAGE_VERSION = '0.2.4'"), 'startup diagnostic version is not anchored')
invariant(!/started v0\./.test(indexSource), 'stale startup version remains')
invariant(!/browser half（v0\./.test(clientSource), 'stale Client version remains')
invariant(!/静态包 `dsh-supervisor` v0\./.test(inputs), 'stale package version remains in INPUTS.md')
invariant(baselineEvidence.pinnedRollbackArtifact?.digest === baselineArtifactDigest, 'rollback digest evidence changed')
invariant(/^artifacts\/\*\.tgz$/m.test(ignoreRules), 'private rollback artifacts must be gitignored')

const artifactPath = join(root, 'artifacts', 'dsh-supervisor-0.2.4.tgz')
let artifactState = 'private-local-absent'
try {
  invariant(await digest(artifactPath) === baselineArtifactDigest, 'pinned rollback artifact changed')
  artifactState = 'private-local-verified'
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

process.stdout.write(`P0 preflight passed: version=${manifest.version} modules=${runtimeFiles.length} baseline=${baselineArtifactDigest} artifact=${artifactState}.\n`)
