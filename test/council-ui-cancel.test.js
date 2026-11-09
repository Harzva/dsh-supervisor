import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

test('the mounted council control cancels both queued and running requests through the scoped HTTP endpoint', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  for (const status of ['queued', 'running', 'completed']) {
    const state = { mode: 'off', council: { available: true, status, callsReserved: 6, discussionsUsed: 1 } }
    const listeners = new Map()
    const slots = new Map()
    const requests = []
    let hook = 0
    let plugin
    const React = {
      createElement(type, props, ...children) { return typeof type === 'function' ? type(props || {}) : { type, props, children } },
      useState(initial) { return [hook++ === 0 ? { sid: 'ui-session', value: state } : typeof initial === 'function' ? initial() : initial, () => {}] },
      useRef(current) { return { current } },
      useEffect() {},
      useSyncExternalStore(_subscribe, snapshot) { return snapshot() },
    }
    const window = {
      localStorage: { getItem: () => null }, addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: name => listeners.delete(name), dispatchEvent() {},
      __ModuleLoader__: { load(entry) { plugin = entry.factory(name => name === 'react' ? React : {}) } },
    }
    vm.runInNewContext(source, {
      window, console,
      fetch: async (path, options) => {
        if (options?.method === 'POST') requests.push({ path, body: JSON.parse(options.body) })
        return { ok: true, json: async () => ({ state, states: { 'ui-session': state } }) }
      },
    })
    plugin.apply({ effect: setup => setup(), slots: { inject: (_name, setup) => setup(), register: (options, render) => { slots.set(options.id, render); return () => {} } }, get: () => undefined })
    listeners.get('dsh-supervisor:panel-toggle')({ detail: { sessionId: 'ui-session' } })
    const tree = slots.get('supervisor-controls')({ sessionId: 'ui-session' })
    const nodes = []
    const walk = node => { if (Array.isArray(node)) node.forEach(walk); else if (node && typeof node === 'object') { nodes.push(node); walk(node.children) } }
    walk(tree)
    const cancel = nodes.find(node => node.type === 'button' && node.children.includes('取消会诊'))
    assert.ok(cancel)
    assert.equal(cancel.props.disabled, status === 'completed')
    if (status !== 'completed') {
      await cancel.props.onClick()
      assert.deepEqual(requests, [{ path: '/dsh-supervisor/council', body: { sessionId: 'ui-session', action: 'cancel' } }])
    }
  }
})
