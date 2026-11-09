import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// Execute the registered client dock, including actual control callbacks, with
// the supplied host state. No backend or browser DOM is simulated in source.
async function renderDock(state) {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const listeners = new Map(), slots = new Map(), requests = []
  let hook = 0, plugin
  const React = {
    createElement(type, props, ...children) { return typeof type === 'function' ? type(props || {}) : { type, props, children } },
    useState(initial) { return [hook++ === 0 ? { sid: 'ui-session', value: state } : typeof initial === 'function' ? initial() : initial, () => {}] },
    useRef(current) { return { current } }, useEffect() {},
    useSyncExternalStore(_subscribe, snapshot) { return snapshot() },
  }
  const window = {
    localStorage: { getItem: () => null }, addEventListener: (name, cb) => listeners.set(name, cb),
    removeEventListener: name => listeners.delete(name), dispatchEvent() {},
    __ModuleLoader__: { load(entry) { plugin = entry.factory(name => name === 'react' ? React : {}) } },
  }
  vm.runInNewContext(source, { window, console, fetch: async (path, options) => {
    if (options?.method === 'POST') requests.push({ path, body: JSON.parse(options.body) })
    return { ok: true, json: async () => ({ state, states: { 'ui-session': state } }) }
  } })
  plugin.apply({ effect: setup => setup(), slots: { inject: (_name, setup) => setup(), register: (options, render) => { slots.set(options.id, render); return () => {} } }, get: () => undefined })
  listeners.get('dsh-supervisor:panel-toggle')({ detail: { sessionId: 'ui-session' } })
  const tree = slots.get('supervisor-controls')({ sessionId: 'ui-session' })
  const nodes = []
  const walk = node => { if (Array.isArray(node)) node.forEach(walk); else if (node && typeof node === 'object') { nodes.push(node); walk(node.children) } }
  walk(tree)
  const button = text => nodes.find(node => node.type === 'button' && node.children.includes(text))
  return { tree, nodes, requests, button }
}

test('blocked takeover renders reason and permits explicit adopt or regeneration', async () => {
  const ui = await renderDock({ mode: 'takeover', status: 'suggested', suggestion: '先检查可见结果。', automaticContinuation: { allowed: false, reason: '请为当前任务重新授权自动接管' } })
  const rendered = JSON.stringify(ui.tree)
  assert.match(rendered, /请为当前任务重新授权自动接管/)
  assert.match(rendered, /先检查可见结果/)
  assert.ok(ui.button('采纳并输入'))
  assert.ok(ui.button('重新建议'))
  assert.doesNotMatch(rendered, /自动生成建议并输入/)
  await ui.button('采纳并输入').props.onClick()
  assert.deepEqual(ui.requests, [{ path: '/dsh-supervisor/adopt', body: { sessionId: 'ui-session' } }])
})

test('blocked takeover without a suggestion can generate one', async () => {
  const ui = await renderDock({ mode: 'takeover', suggestion: '', automaticContinuation: { allowed: false, reason: '当前任务没有可核验的原生待办' } })
  assert.match(JSON.stringify(ui.tree), /当前任务没有可核验的原生待办/)
  assert.equal(ui.button('采纳并输入'), undefined)
  assert.ok(ui.button('生成建议'))
  await ui.button('生成建议').props.onClick()
  assert.deepEqual(ui.requests, [{ path: '/dsh-supervisor/regen', body: { sessionId: 'ui-session' } }])
})

test('old host without gate status cannot enable takeover from this UI and warns if already enabled', async () => {
  const off = await renderDock({ mode: 'off' })
  assert.equal(off.button('接管').props.disabled, true)
  assert.match(JSON.stringify(off.tree), /未提供自动续行状态/)
  const takeover = await renderDock({ mode: 'takeover', suggestion: '旧建议' })
  assert.match(JSON.stringify(takeover.tree), /无法确认是否会自动发送/)
  assert.equal(takeover.button('接管').props.disabled, true)
  assert.ok(takeover.button('采纳并输入'))
})

test('changing strategy does not send mode or silently re-authorize takeover', async () => {
  const ui = await renderDock({ mode: 'takeover', strategy: 'plan', automaticContinuation: { allowed: false, reason: '等待授权' } })
  await ui.button('理解驱动').props.onClick()
  assert.deepEqual(ui.requests, [{ path: '/dsh-supervisor/state', body: { sessionId: 'ui-session', patch: { strategy: 'insight' } } }])
})

test('known eligible takeover describes its conditions and explicit mode click submits only mode', async () => {
  const ui = await renderDock({ mode: 'takeover', automaticContinuation: { allowed: true, reason: '' } })
  assert.match(JSON.stringify(ui.tree), /同任务未完成的原生待办/)
  assert.match(JSON.stringify(ui.tree), /新任务、关闭接管或重启后需要重新授权/)
  await ui.button('接管').props.onClick()
  assert.deepEqual(ui.requests, [{ path: '/dsh-supervisor/state', body: { sessionId: 'ui-session', patch: { mode: 'takeover' } } }])
})
