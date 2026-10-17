import { execFile as callback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile, rm, lstat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve, relative } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(callback)
const root = fileURLToPath(new URL('../', import.meta.url))
const plugin = join(root, 'plugins/codex-supervisor')
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: pack-codex.mjs [--output directory]')
const destination = resolve(args[1] || join(root, 'artifacts/codex'))
if (destination === plugin || destination.startsWith(plugin + '/')) throw new Error('Output must be outside plugin source')
for (const script of ['build-codex.mjs', 'verify-codex.mjs']) {
  await execFile(process.execPath, [join(root, 'scripts', script)], { cwd: root })
}
const manifest = JSON.parse(await readFile(join(plugin, 'plugin.json'), 'utf8'))
const files = []
const digests = {}
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    const packagePath = relative(plugin, path).replaceAll('\\', '/')
    // Development sources are retained in Git; the portable package uses built entrypoints.
    if (packagePath === 'server' || packagePath === 'ui/panel.js' || packagePath === 'ui/panel.template.html') continue
    if (entry.isSymbolicLink()) throw new Error('Symlink in plugin package')
    if (entry.isDirectory()) await walk(path)
    else {
      const file = relative(plugin, path).replaceAll('\\', '/')
      if (!entry.isFile() || /(?:^|\/)\.env|\.log$|state\.v1|\.lock$/.test(file)) throw new Error(`Unexpected package file: ${file}`)
      files.push(file)
      digests[file] = createHash('sha256').update(await readFile(path)).digest('hex')
    }
  }
}
await walk(plugin)
files.sort()
await mkdir(destination, { recursive: true })
const name = `${manifest.name}-${manifest.version}.zip`
const archive = join(destination, name)
try {
  assertPlain(await lstat(archive))
} catch (error) { if (error.code !== 'ENOENT') throw error }
function assertPlain(stat) { if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Archive target is not a plain file') }
await rm(archive, { force: true })
await execFile('zip', ['-X', '-q', archive, ...files], { cwd: plugin })
const { stdout } = await execFile('unzip', ['-Z1', archive])
if (JSON.stringify(stdout.trim().split('\n').sort()) !== JSON.stringify(files)) throw new Error('ZIP contents mismatch')
const evidence = {
  name: manifest.name, version: manifest.version, archive: name,
  sha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
  fileCount: files.length, files: Object.fromEntries(files.map(file => [file, digests[file]])),
}
await writeFile(join(destination, `${manifest.name}-${manifest.version}.checksums.json`), JSON.stringify(evidence, null, 2) + '\n')
process.stdout.write(JSON.stringify({ ok: true, archive: name, sha256: evidence.sha256, fileCount: files.length }) + '\n')
