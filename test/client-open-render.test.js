import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// Execute the shipped module and its registered dock, including the first open
// render. Effects are deferred as in React; their dependency expressions still
// execute, which catches initialization failures missed by source checks.
test('opening the registered Supervisor dock renders model and shared role controls', async () => {
  const listeners = new Map()
  const slots = new Map()
  let stateHook = 0
  const React = {
    createElement(type, props, ...children) {
      return typeof type === 'function' ? type(props || {}) : { type, props, children }
    },
    useState(initial) { return [stateHook++ === 0 ? { sid: 'smoke-session', value: { mode: 'off' } } : typeof initial === 'function' ? initial() : initial, () => {}] },
    useRef(current) { return { current } },
    useEffect() {},
    useSyncExternalStore(_subscribe, snapshot) { return snapshot() },
  }
  let plugin
  const window = {
    localStorage: { getItem: () => null },
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name),
    dispatchEvent() {},
    __ModuleLoader__: { load(entry) {
      plugin = entry.factory(name => {
        if (name === 'react') return React
        if (name === '@harzva/dsh-role-registry') return {}
        throw new Error('unexpected dependency: ' + name)
      })
    } },
  }
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), { window, console })
  plugin.apply({
    effect: setup => setup(),
    slots: {
      inject: (_name, setup) => setup(),
      register: (options, render) => { slots.set(options.id, render); return () => {} },
    },
    get: () => undefined,
  })
  const render = slots.get('supervisor-controls')
  assert.equal(typeof render, 'function')
  const closed = render({ sessionId: 'smoke-session' })
  assert.ok(closed, 'the dock must show its entry even when closed')
  const opener = closed.children.find(node => node && node.type === 'button')
  assert.ok(opener)
  assert.equal(opener.props['aria-expanded'], false)
  opener.props.onClick()
  const tree = render({ sessionId: 'smoke-session' })
  assert.ok(tree)
  const output = JSON.stringify(tree)
  assert.match(output, /监督模型/)
  assert.match(output, /选择角色/)
  assert.match(output, /data-dsh-supervisor-inline/)
})
