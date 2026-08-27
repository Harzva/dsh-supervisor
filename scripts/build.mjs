import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const sourceDir = join(root, 'src')
const outputDir = join(root, 'lib')
const runtimeFiles = Object.freeze([
  'index.js',
  'client.js',
  'mentor-registry.js',
  'supervisor-store.js',
  'handoff-service.js',
])

const sources = await Promise.all(runtimeFiles.map(async (file) => {
  const path = join(sourceDir, file)
  const [content, metadata] = await Promise.all([readFile(path), stat(path)])
  return { file, content, mode: metadata.mode & 0o777 }
}))

await mkdir(outputDir, { recursive: true })

const stagedOutputs = []
try {
  for (const source of sources) {
    const staged = join(outputDir, `.${source.file}.p0-build-${process.pid}`)
    await writeFile(staged, source.content, { mode: source.mode })
    stagedOutputs.push({ staged, output: join(outputDir, source.file) })
  }
  for (const entry of stagedOutputs) await rename(entry.staged, entry.output)
} finally {
  for (const entry of stagedOutputs) await rm(entry.staged, { force: true })
}

process.stdout.write(`Built ${runtimeFiles.length} runtime modules from src/.\n`)
