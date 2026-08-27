import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSupervisorStore } from '../lib/supervisor-store.js'

test('assignments, Supervisor model settings and health survive a new store instance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-supervisor-store-'))
  const file = join(dir, 'state.json')
  try {
    const first = createSupervisorStore(file)
    await first.setAssignment('s1', { sessionId: 's1', primaryMentorId: 'atlas', collaboratorIds: [] })
    await first.setSetting('s1', { supervisorModels: { atlas: 'provider/model' } })
    await first.recordCompaction('s1', 10, 5)
    await first.recordCompaction('s1', 20, 8)
    await first.recordCompaction('s1', 30, 8)
    const second = createSupervisorStore(file)
    assert.equal((await second.getAssignment('s1')).primaryMentorId, 'atlas')
    assert.deepEqual(await second.getSetting('s1'), { supervisorModels: { atlas: 'provider/model' } })
    assert.deepEqual(await second.getHealth('s1'), { successfulCompactions: 2, lastCompactionAt: 20, lastCompactionSeq: 8 })
    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw.version, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
