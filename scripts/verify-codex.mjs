import assert from 'node:assert/strict'
import { readFile, readdir, lstat, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve, relative, sep } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const plugin = join(root, 'plugins/codex-supervisor')
const manifest = JSON.parse(await readFile(join(plugin, 'plugin.json'), 'utf8'))
const compatibility = JSON.parse(await readFile(join(plugin, '.codex-plugin/plugin.json'), 'utf8'))
assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
assert.equal(manifest.name, 'harzva-supervisor')
assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
for (const key of ['name', 'version', 'description', 'license', 'repository', 'author']) {
  assert.deepEqual(manifest[key], compatibility[key], `Compatibility identity drift: ${key}`)
}
const extension = manifest.extensions['com.openai']
assert.deepEqual(extension.interface, compatibility.interface)
assert.equal(compatibility.extensions, undefined)
assert.equal(compatibility.skills, './skills/')
assert(!manifest.mcpServers && !compatibility.mcpServers && !extension.hooks && !extension.apps)
const mcp = JSON.parse(await readFile(join(plugin, 'mcp.json'), 'utf8'))
assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json')
assert.deepEqual(Object.keys(mcp.mcpServers), ['supervisor-panel'])
assert.deepEqual(mcp.mcpServers['supervisor-panel'], { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/runtime/mcp-server.mjs'], env: { HARZVA_SUPERVISOR_DATA: '${PLUGIN_DATA}' } })
for (const path of [extension.onboardingSkill, compatibility.skills]) {
  assert(path.startsWith('./') && !path.split('/').includes('..'), `Bad package path: ${path}`)
  assert((await lstat(resolve(plugin, path))).isDirectory() || (await lstat(resolve(plugin, path))).isFile())
}
const skills = (await readdir(join(plugin, 'skills'))).sort()
assert.deepEqual(skills, ['execute', 'faculty-review', 'handoff', 'setup', 'supervise'])
for (const skill of skills) {
  const text = await readFile(join(plugin, 'skills', skill, 'SKILL.md'), 'utf8')
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/)
  assert(frontmatter, `Missing frontmatter: ${skill}`)
  assert(frontmatter[1].includes(`name: ${skill}\n`), `Name mismatch: ${skill}`)
  assert.match(frontmatter[1], /description: .+/)
  assert(!/\bTODO\b|\[INSERT|\[TODO/.test(text), `Unfinished skill: ${skill}`)
  for (const [, link] of text.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^https?:/.test(link)) continue
    const target = await realpath(resolve(plugin, 'skills', skill, link))
    const rel = relative(plugin, target)
    assert(rel !== '..' && !rel.startsWith(`..${sep}`), `Skill reference escapes package: ${link}`)
  }
}
const marketplace = JSON.parse(await readFile(join(root, '.agents/plugins/marketplace.json'), 'utf8'))
assert.equal(marketplace.name, 'harzva-supervisor-dev')
assert.equal(marketplace.plugins.length, 1)
const entry = marketplace.plugins[0]
assert.equal(entry.name, manifest.name)
assert.equal(entry.source.source, 'local')
assert.equal(resolve(root, entry.source.path), resolve(plugin))
assert.deepEqual(entry.policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' })
assert.equal(entry.category, 'Productivity')
const allowedRoots = new Set(['plugin.json', '.codex-plugin', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.txt', 'mcp.json', 'server', 'ui', 'scripts', 'runtime', 'skills', 'assets'])
for (const entry of await readdir(plugin, { withFileTypes: true })) {
  assert(allowedRoots.has(entry.name), `Unexpected bundled entry: ${entry.name}`)
  assert(!entry.isSymbolicLink(), `Symlink package entry: ${entry.name}`)
}
for (const script of ['control.mjs', 'settings.mjs', 'execution.mjs', 'execution-store.mjs', 'native-executor.mjs', 'verification.mjs', 'state.mjs', 'supervisor.mjs']) {
  const stat = await lstat(join(plugin, 'scripts', script))
  assert(stat.isFile() && !stat.isSymbolicLink(), `Missing or unsafe runtime script: ${script}`)
}
for (const file of ['runtime/mcp-server.mjs', 'ui/panel.html', 'THIRD_PARTY_NOTICES.txt']) assert((await lstat(join(plugin, file))).isFile())
process.stdout.write(JSON.stringify({ ok: true, name: manifest.name, version: manifest.version, skillCount: skills.length }) + '\n')
