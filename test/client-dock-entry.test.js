import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

test('native InputZone and legacy session props provide an always-visible, session-scoped dock toggle', async () => {
  const listeners = new Map(), slots = new Map()
  let plugin
  const mentorKeys = []
  const React = {
    createElement(type, props, ...children) { if (typeof type === 'function' && type.name === 'MentorFloat') mentorKeys.push(props.key); return typeof type === 'function' ? type(props || {}) : { type, props, children } },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useRef(value) { return { current: value } }, useEffect() {}, useSyncExternalStore(_s, snapshot) { return snapshot() },
  }
  const window = { localStorage: { getItem: () => null }, addEventListener: (name, cb) => listeners.set(name, cb), removeEventListener() {}, dispatchEvent() {}, __ModuleLoader__: { load(entry) { plugin = entry.factory(name => name === 'react' ? React : {}) } } }
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), { window, console })
  plugin.apply({ effect: setup => setup(), slots: { inject: (_name, setup) => setup(), register: (options, render) => { slots.set(options.id, { name: options.name, render }); return () => {} } }, get: () => undefined })
  const slot = slots.get('supervisor-controls')
  assert.equal(slot.name, 'conversation.input.dock')
  const entry = props => slot.render(props)
  const action = tree => tree?.children.find(child => child && child.type === 'button')
  const nativeA = { session: { sessionId: 'session-A' }, input: {}, sessionId: 'wrong-flat-id' }
  const nativeB = { session: { sessionId: 'session-B' }, input: {} }
  let a = entry(nativeA)
  assert.equal(action(a).props['aria-expanded'], false)
  assert.match(action(a).props['aria-controls'], /session-A$/)
  action(a).props.onClick()
  a = entry(nativeA)
  assert.equal(action(a).props['aria-expanded'], true)
  assert.match(JSON.stringify(a), /data-dsh-supervisor-loading/)
  assert.equal(action(entry(nativeB)).props['aria-expanded'], false)
  action(entry(nativeB)).props.onClick()
  assert.equal(action(entry(nativeB)).props['aria-expanded'], true)
  assert.ok(mentorKeys.includes('session-A') && mentorKeys.includes('session-B'))
  action(a).props.onClick()
  assert.equal(action(entry(nativeA)).props['aria-expanded'], false)
  assert.equal(action(entry(nativeB)).props['aria-expanded'], true)
  assert.ok(action(entry({ sessionId: 'legacy-flat' })))
  assert.ok(action(entry({ session: { id: 'legacy-nested' } })))
  assert.equal(entry({ session: {}, input: {} }), null)
})
