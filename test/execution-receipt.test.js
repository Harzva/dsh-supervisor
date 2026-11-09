import test from 'node:test'
import assert from 'node:assert/strict'
import { findReceipt } from '../lib/execution-state.js'

const event = (source, id = 'matching-id', wrapper = false) => ({
  type: 'user/message', seq: 12,
  data: wrapper ? { message: { id, source } } : { id, source },
})

test('only Supervisor source with exact message ID is an eligible receipt', () => {
  const unrelated = [
    event({ kind: 'user' }),
    event({ kind: 'plugin:other' }),
    event({ kind: 'plugin', plugin: 'other' }),
    event({ kind: 'plugin:dsh-supervisor-extra' }),
    event(undefined),
    event({ kind: 'plugin:dsh-supervisor' }, 'different-id'),
  ]
  assert.equal(findReceipt(unrelated, 'matching-id'), undefined)
  assert.equal(findReceipt(unrelated, ''), undefined)
  assert.equal(findReceipt(null, 'matching-id'), undefined)
  const newReceipt = event({ kind: 'plugin:dsh-supervisor' })
  const oldReceipt = event({ kind: 'plugin', plugin: 'dsh-supervisor' }, 'matching-id', true)
  assert.equal(findReceipt([...unrelated, newReceipt], 'matching-id'), newReceipt)
  assert.equal(findReceipt([...unrelated, oldReceipt], 'matching-id'), oldReceipt)
  assert.equal(findReceipt([{ ...newReceipt, type: 'assistant/message' }], 'matching-id'), undefined)
})
