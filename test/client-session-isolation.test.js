import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

test('target changes hide previous suggestions until the matching response arrives', async () => {
  const listeners = new Map(), slots = new Map(), pending = new Map(), hooks = [], effects = []
  let cursor = 0, plugin
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], v => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v }] },
    useRef(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i] },
    useEffect(fn, deps) { const i = cursor++; const old = hooks[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) { if (old?.cleanup) old.cleanup(); hooks[i] = { deps }; effects.push(() => { hooks[i].cleanup = fn() }) } },
    useSyncExternalStore(_subscribe, snapshot) { return snapshot() },
  }
  const window = { localStorage: { getItem: () => null }, addEventListener: (n, f) => listeners.set(n, f), removeEventListener() {}, dispatchEvent() {}, innerWidth: 1400, innerHeight: 900, __ModuleLoader__: { load(entry) { plugin = entry.factory(n => n === 'react' ? React : {}) } } }
  const fetch = url => new Promise(resolve => { const sid = decodeURIComponent(String(url).split('ids=')[1]); pending.set(sid, state => resolve({ ok: true, json: async () => ({ states: { [sid]: state } }) })) })
  const source = (await readFile(new URL('../src/client.js', import.meta.url), 'utf8')).replace('      const register = (options, render) => {', '      window.__mentor = MentorFloat; window.__mentorWithSessions = MentorFloatWithSessions\n      const register = (options, render) => {')
  vm.runInNewContext(source, { window, fetch, console })
  plugin.apply({ effect: f => f(), slots: { inject: (_n, f) => f(), register: (o, f) => { slots.set(o.id, f) } }, get: () => undefined, interval: () => () => {} })
  let hookCount
  const render = () => { cursor = 0; const tree = window.__mentor({ sessionId: 'A', inline: true, useSessions: () => { throw new Error('conditional session hook in MentorFloat') } }); if (hookCount === undefined) hookCount = cursor; else assert.equal(cursor, hookCount, 'hook order must remain stable'); while (effects.length) effects.shift()(); return tree }
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
  const walk = (node, fn) => { if (Array.isArray(node)) { for (const child of node) { const found = walk(child, fn); if (found) return found } return null } if (!node || typeof node !== 'object') return null; if (fn(node)) return node; for (const child of node.children || []) { const found = walk(child, fn); if (found) return found } return null }
  assert.match(JSON.stringify(render()), /正在加载会话状态/)
  pending.get('A')({ mode: 'advice', suggestion: 'SECRET A' }); await flush()
  let tree = render()
  assert.match(JSON.stringify(tree), /SECRET A/)
  walk(tree, n => n.type === 'button' && n.children.includes('管理对话')).props.onClick()
  tree = render()
  walk(tree, n => n.type === 'button' && n.children.includes('收起')).props.onClick()
  tree = render()
  const select = walk(tree, n => n.type === 'select' && n.props.value === 'self')
  select.props.onChange({ target: { value: 'B' } })
  tree = render()
  assert.match(JSON.stringify(tree), /正在加载会话状态/)
  assert.doesNotMatch(JSON.stringify(tree), /SECRET A|采纳建议/)
  const back = walk(tree, n => n.type === 'button')
  back.props.onClick(); render()
  pending.get('B')({ mode: 'advice', suggestion: 'SECRET B' }); await flush()
  tree = render()
  assert.match(JSON.stringify(tree), /SECRET A/)
  assert.doesNotMatch(JSON.stringify(tree), /SECRET B/)
  walk(tree, n => n.type === 'select' && n.props.value === 'self').props.onChange({ target: { value: 'B' } })
  render(); pending.get('B')({ mode: 'advice', suggestion: 'B OLD' }); await flush()
  tree = render()
  assert.match(JSON.stringify(tree), /B OLD/)
  walk(tree, n => n.type === 'select' && n.props.value === 'B').props.onChange({ target: { value: 'C' } })
  tree = render(); const resolveC = pending.get('C')
  walk(tree, n => n.type === 'button').props.onClick()
  tree = render()
  walk(tree, n => n.type === 'select' && n.props.value === 'self').props.onChange({ target: { value: 'B' } })
  tree = render()
  assert.match(JSON.stringify(tree), /正在加载会话状态/)
  assert.doesNotMatch(JSON.stringify(tree), /B OLD|采纳建议/)
  resolveC({ mode: 'advice', suggestion: 'C LATE' }); await flush()
  assert.doesNotMatch(JSON.stringify(render()), /C LATE|B OLD/)
  pending.get('B')({ mode: 'advice', suggestion: 'B NEW' }); await flush()
  assert.match(JSON.stringify(render()), /B NEW/)
})

test('session hook wrapper calls its hook on every render regardless of sessionId', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const wrapper = source.match(/function MentorFloatWithSessions\(props\) \{([\s\S]*?)\n      \}/)?.[1]
  assert.ok(wrapper)
  assert.match(wrapper, /props\.useSessions\(\(s\) => s\)/)
  const mentor = source.split('function MentorFloat(props) {')[1].split('const register =')[0]
  assert.doesNotMatch(mentor, /sessionsState\s*\(|useSessions\s*\(/)
})
