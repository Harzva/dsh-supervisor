import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const plugin = join(root, 'plugins/codex-supervisor')
const files = [['src/mentor-registry.js', 'runtime/mentor-registry.mjs'], ['LICENSE', 'LICENSE']]
await mkdir(join(plugin, 'runtime'), { recursive: true })
for (const [source, target] of files) {
  const bytes = await readFile(join(root, source))
  const destination = join(plugin, target)
  if (process.argv.includes('--check')) {
    if (!bytes.equals(await readFile(destination))) throw new Error(`Stale Codex resource: ${target}; run codex:build`)
  } else {
    await writeFile(destination, bytes)
  }
}
process.stdout.write(`Codex resources ${process.argv.includes('--check') ? 'verified' : 'built'} from canonical source.\n`)
