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
assert.equal(extension.onboardingSkill, compatibility.extensions['com.openai'].onboardingSkill)
assert.equal(compatibility.skills, './skills/')
assert(!manifest.mcpServers && !compatibility.mcpServers && !extension.hooks && !extension.apps)
for (const path of [extension.onboardingSkill, compatibility.skills]) {
  assert(path.startsWith('./') && !path.split('/').includes('..'), `Bad package path: ${path}`)
  assert((await lstat(resolve(plugin, path))).isDirectory() || (await lstat(resolve(plugin, path))).isFile())
}
const skills = (await readdir(join(plugin, 'skills'))).sort()
assert.deepEqual(skills, ['faculty-review', 'handoff', 'setup', 'supervise'])
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
const allowedRoots = new Set(['plugin.json', '.codex-plugin', 'LICENSE', 'README.md', 'scripts', 'runtime', 'skills'])
for (const entry of await readdir(plugin, { withFileTypes: true })) {
  assert(allowedRoots.has(entry.name), `Unexpected bundled entry: ${entry.name}`)
  assert(!entry.isSymbolicLink(), `Symlink package entry: ${entry.name}`)
}
process.stdout.write(JSON.stringify({ ok: true, name: manifest.name, version: manifest.version, skillCount: skills.length }) + '\n')
