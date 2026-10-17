import assert from 'node:assert/strict'
import { readFile, lstat, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, relative } from 'node:path'

// Checks the prepared artifact. Publisher verification and partner approval are
// external prerequisites and cannot be inferred from a successful local check.
const plugin = fileURLToPath(new URL('../plugins/codex-supervisor/', import.meta.url))
const manifest = JSON.parse(await readFile(resolve(plugin, 'plugin.json'), 'utf8'))
const extension = manifest.extensions['com.openai']
const listing = extension.interface
assert.equal(listing.displayName, 'Harzva Supervisor')
assert(listing.shortDescription.length <= 30)
assert(listing.longDescription.length <= 4000)
for (const key of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
  const url = new URL(listing[key])
  assert.equal(url.protocol, 'https:')
  assert(!url.username && !url.password)
  assert.equal(url.origin, new URL(listing.websiteURL).origin)
}
for (const key of ['composerIcon', 'logo']) {
  const path = listing[key]
  assert(path.startsWith('./assets/'))
  const resolved = await realpath(resolve(plugin, path))
  assert(!relative(plugin, resolved).startsWith('..'))
  assert((await lstat(resolved)).size <= 5 * 1024 * 1024)
  const svg = await readFile(resolved, 'utf8')
  assert.match(svg, /<svg\b/)
  assert(!/<script\b|<foreignObject\b|(?:href|src)\s*=\s*["'](?:https?:|data:)/i.test(svg))
  const viewBox = svg.match(/viewBox=["']0 0 (\d+) (\d+)["']/)
  assert(viewBox && viewBox[1] === viewBox[2] && Number(viewBox[1]) >= 48)
}
for (const path of listing.screenshots || []) {
  assert(path.startsWith('./assets/') && path.endsWith('.png'))
  const resolved = await realpath(resolve(plugin, path))
  assert(!relative(plugin, resolved).startsWith('..'))
  const bytes = await readFile(resolved)
  assert(bytes.length <= 5 * 1024 * 1024)
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert(bytes.readUInt32BE(16) <= 4096 && bytes.readUInt32BE(20) <= 4096)
}
const cases = extension.review.test_cases
assert.equal(cases.positive.length, 5)
assert.equal(cases.negative.length, 3)
for (const item of cases.positive) {
  for (const key of ['description', 'prompt', 'tools_triggered', 'expected_behavior']) {
    assert.equal(typeof item[key], 'string')
    assert(item[key].trim())
  }
}
for (const item of cases.negative) {
  for (const key of ['description', 'prompt']) assert.equal(typeof item[key], 'string')
}
assert.equal(extension.review.commerce, false)
assert(!extension.review.test_credentials && !extension.review.reviewer_instructions)
assert(!/\{\{|\[INSERT|\[TODO/.test(JSON.stringify(manifest)))
const publicChecks = []
if (process.argv.includes('--public')) {
  for (const key of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
    const response = await fetch(listing[key], { signal: AbortSignal.timeout(20000) })
    assert.equal(response.status, 200, `Public URL unavailable: ${key}`)
    const html = await response.text()
    assert(html.includes('Harzva') && !html.includes('{{'))
    publicChecks.push({ field: key, status: response.status })
  }
  if (extension.review.demo_recording_url) {
    const response = await fetch(extension.review.demo_recording_url, { signal: AbortSignal.timeout(20000) })
    assert.equal(response.status, 200, 'Demo URL unavailable')
    publicChecks.push({ field: 'demo_recording_url', status: response.status })
  }
}
process.stdout.write(JSON.stringify({
  ok: true, name: manifest.name, version: manifest.version,
  positiveCases: cases.positive.length, negativeCases: cases.negative.length,
  publicChecks,
  demoRecordingDeclared: Boolean(extension.review.demo_recording_url),
  externalPrerequisites: ['verified-publisher', 'organization-local-mcp-allowlist', 'partner-ui-review-configuration'],
  officialSubmissionOrApprovalConfirmed: false,
}) + '\n')
