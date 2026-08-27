import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('Supervisor floating card exposes a bounded persistent drag handle', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /dsh-supervisor\.floatPosition\.v1/)
  assert.match(source, /data-dsh-supervisor-drag-handle/)
  assert.match(source, /Math\.hypot\(dx, dy\) < 5/)
  assert.match(source, /window\.addEventListener\('mousemove', moveDrag\)/)
  assert.match(source, /window\.addEventListener\('mouseup', endDrag\)/)
  assert.match(source, /window\.innerWidth - width - 12/)
  assert.match(source, /window\.innerHeight - height - 12/)
  assert.match(source, /onDoubleClick: resetPosition/)
  assert.match(source, /window\.addEventListener\('resize', keepInViewport\)/)
})

test('Supervisor model selector uses the native directory and persists a role-scoped override', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /ctx\.get\('modelDirectories'\)/)
  assert.doesNotMatch(source, /ctx\.get\('models'\)/)
  assert.match(source, /supervisorModel: \{ supervisorId, route: value \}/)
  assert.match(source, /React\.createElement\('optgroup'/)
  assert.match(source, /仅影响下一轮监督，不改变主对话模型/)
  assert.match(source, /exports\.inject = \[[^\]]*'modelDirectories'/)
  assert.match(source, /const refreshState = \(\) => \{ fetchState\(curSid\)/)
  assert.match(source, /const patch = \(p\) => runAction\('正在保存设置…', \(\) => patchState\(target \|\| curSid/)
})

test('Supervisor uses an inline dock panel without duplicate header or shell overlay entries', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /data-dsh-supervisor-inline/)
  assert.match(source, /inline: true/)
  assert.match(source, /name: 'conversation\.input\.dock', id: 'supervisor-controls'/)
  assert.doesNotMatch(source, /register\(\{ name: 'conversation\.session\.header\.actions', id: 'supervisor'/)
  assert.doesNotMatch(source, /register\(\{ name: 'shell\.overlay', id: 'supervisor-mentor'/)
})

test('Supervisor floating actions use HTTP state routes and expose failures', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /const ADOPT_PATH = '\/dsh-supervisor\/adopt'/)
  assert.match(source, /const REGEN_PATH = '\/dsh-supervisor\/regen'/)
  assert.match(source, /const patch = \(p\) => runAction\('正在保存设置…', \(\) => patchState\(target \|\| curSid/)
  assert.match(source, /const onAdopt = \(\) => runAction\('正在采纳建议…', \(\) => adoptState\(target \|\| curSid\)/)
  assert.match(source, /const onRegen = \(\) => runAction\('正在生成建议…', \(\) => regenState\(target \|\| curSid\)/)
  assert.doesNotMatch(source, /exec\(target \|\| curSid, '\/supervise _(set|adopt|regen)/)
  assert.match(source, /data-dsh-supervisor-action-error/)
  assert.match(source, /role: 'alert'/)
  assert.match(source, /disabled: !!disabled/)
})

test('Supervisor command resolves a role before the floating panel reads state', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /handler: async \(\{ agent, rawInput \}\) => \{/)
  assert.match(source, /const sid = agent\.id\s+\/\/ The floating panel[\s\S]*await ensureAssignment\(sid\)\s+const p = perOf\(sid\)/)
})
