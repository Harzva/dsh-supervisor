import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { PANEL_TOOLS } from '../../../plugins/codex-supervisor/server/panel-server.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(directory, '../../..')
const require = createRequire(path.join(root, 'package.json'))
const Ajv2020 = require('ajv/dist/2020').default
const schema = JSON.parse(fs.readFileSync(path.join(directory, 'review.schema.json'), 'utf8'))
const review = JSON.parse(fs.readFileSync(path.join(directory, 'review.json'), 'utf8'))
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema)
assert(validate(review), JSON.stringify(validate.errors))
const actual = new Set(PANEL_TOOLS.map(tool => tool.name))
for (const test of review.test_cases.positive) {
  for (const name of test.tools_triggered.split(',').map(value => value.trim())) assert(actual.has(name), `Unknown MCP tool: ${name}`)
}
const publication = JSON.parse(fs.readFileSync(path.join(directory, 'publication.json'), 'utf8'))
assert.deepEqual(Object.keys(publication), ['release_notes'])
assert(typeof publication.release_notes === 'string' && publication.release_notes.trim())
assert(!JSON.stringify(review).includes('test_credentials') && !JSON.stringify(review).includes('reviewer_instructions'))
process.stdout.write(JSON.stringify({ ok: true, positive: review.test_cases.positive.length, negative: review.test_cases.negative.length, toolNamesValid: true, credentialsIncluded: false, demoRecordingProvided: typeof review.demo_recording_url === 'string', submissionReady: false }) + '\n')
