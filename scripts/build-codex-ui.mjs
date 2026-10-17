import { build } from 'esbuild'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const plugin = path.join(root, 'plugins/codex-supervisor')
const checking = process.argv.includes('--check')
const outputs = new Map()
const packages = new Map()
async function bundle(entry, platform, format) {
  // Preserve SDK template string values while emitting their whitespace as escapes.
  const result = await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, write: false, platform, format, minify: platform === 'browser', supported: platform === 'browser' ? { 'template-literal': false } : undefined, target: platform === 'node' ? 'node22' : 'es2022', metafile: true, legalComments: 'inline', charset: 'utf8', banner: platform === 'node' ? { js: "import { createRequire as __supervisorCreateRequire } from 'node:module'; const require = __supervisorCreateRequire(import.meta.url);" } : undefined })
  const emitted = new Set(Object.values(result.metafile.outputs).flatMap(output => Object.entries(output.inputs).filter(([, value]) => value.bytesInOutput > 0).map(([name]) => name)))
  for (const input of emitted) {
    if (!input.includes('node_modules/')) continue
    let directory = path.dirname(path.resolve(root, input))
    let manifest
    while (directory.startsWith(path.join(root, 'node_modules'))) {
      if (existsSync(path.join(directory, 'package.json'))) {
        const candidate = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
        if (candidate.name && candidate.version) { manifest = candidate; break }
      }
      directory = path.dirname(directory)
    }
    if (!manifest) throw Error('Bundled dependency has no package identity')
    packages.set(manifest.name, { directory, manifest })
  }
  return result.outputFiles[0].text
}
outputs.set('runtime/mcp-server.mjs', await bundle('plugins/codex-supervisor/server/panel-server.mjs', 'node', 'esm'))
const ui = await bundle('plugins/codex-supervisor/ui/panel.js', 'browser', 'esm')
const template = await fs.readFile(path.join(plugin, 'ui/panel.template.html'), 'utf8')
if (template.split('/* SUPERVISOR_APP_BUNDLE */').length !== 2) throw Error('UI template requires exactly one bundle slot')
outputs.set('ui/panel.html', template.replace('/* SUPERVISOR_APP_BUNDLE */', () => ui.replace(/<\/script/gi, '<\\/script')))
const notices = []
for (const [name, { directory, manifest }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const licenseFile = (await fs.readdir(directory)).filter(file => /^(?:licen[sc]e|copying)(?:\.[a-z]+)?$/i.test(file)).sort()[0]
  if (!licenseFile) throw Error(`Missing bundled license text: ${name}`)
  const text = await fs.readFile(path.join(directory, licenseFile), 'utf8')
  notices.push(`${name}@${manifest.version}\nDeclared license: ${manifest.license}\n${text.trim()}\n`)
}
outputs.set('THIRD_PARTY_NOTICES.txt', 'Bundled MCP protocol and UI dependencies\n\n' + notices.join('\n---\n\n'))
for (const [relative, content] of outputs) {
  const destination = path.join(plugin, relative)
  if (checking) {
    if (await fs.readFile(destination, 'utf8') !== content) throw Error(`Stale UI build: ${relative}; run codex:build`)
  } else {
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, content)
  }
}
process.stdout.write(JSON.stringify({ ok: true, mode: checking ? 'check' : 'build', files: [...outputs.keys()], bundledPackages: [...packages.keys()].sort() }) + '\n')
