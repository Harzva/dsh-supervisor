import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../lib/index.js'

const writes = ['/dsh-supervisor/council', '/dsh-supervisor/memory', '/dsh-supervisor/todos',
  '/dsh-supervisor/assignment', '/dsh-supervisor/handoff', '/dsh-supervisor/state',
  '/dsh-supervisor/adopt', '/dsh-supervisor/regen']
const reads = ['/dsh-supervisor/memory', '/dsh-supervisor/todos', '/dsh-supervisor/handoff',
  '/dsh-supervisor/states', '/dsh-supervisor/mentors', '/dsh-supervisor/roundtables',
  '/dsh-supervisor/roundtables/graph', '/dsh-supervisor/surface', '/dsh-supervisor/projections']

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'supervisor-http-origin-'))
  const routes = new Map(), disposers = []
  const agent = { id: 's1', session: { id: 's1' }, status: 'idle', options: {}, inbox: { nextTurn: [], nextStep: [] } }
  const services = {
    agents: { get: id => id === 's1' ? agent : undefined, list: () => [agent], roots: () => [agent] },
    webServer: { register: route => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
    sessions: { get: () => agent.session },
  }
  const ctx = {
    get: name => services[name], inject: (names, cb) => { if (names.every(n => services[n])) cb(ctx) },
    effect: cb => { const dispose = cb(); if (typeof dispose === 'function') disposers.push(dispose) },
    on() {}, timeout() {}, interval() {}, logger: { info() {}, warn() {}, error() {} },
  }
  apply(ctx, { storePath: join(dir, 'state.json') })
  t.after(async () => { await Promise.allSettled(disposers.map(dispose => dispose())); await rm(dir, { recursive: true, force: true }) })
  return async (path, { method = 'POST', headers = { host: 'localhost' + ':3080' }, remote = '127.0.0.1', encrypted = false, body = '{}', query = '?sessionId=s1' } = {}) => {
    const req = Readable.from(method === 'POST' ? [Buffer.from(body)] : [])
    Object.assign(req, { method, url: path + query, headers, socket: { remoteAddress: remote, encrypted } })
    let status, data
    await routes.get(path)(req, { writeHead(value) { status = value }, end(value) { data = JSON.parse(value) } })
    return { status, data }
  }
}

test('all write routes reject cross-site requests and local DNS rebinding before processing', async t => {
  const request = await fixture(t)
  for (const path of writes) {
    for (const headers of [
      { host: 'localhost' + ':3080', origin: 'https://attacker.example', 'content-type': 'text/plain' },
      { host: 'attacker.example:3080', origin: 'http://attacker.example:3080', 'content-type': 'application/json' },
      { host: 'localhost' + ':3080', origin: 'null', 'content-type': 'application/json' },
      { host: 'localhost' + ':3080', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      { host: 'localhost' + ':3080', forwarded: 'for=192.0.2.1', 'content-type': 'application/json' },
      { host: 'localhost' + ':3080', 'x-forwarded-for': '192.0.2.1', 'content-type': 'application/json' },
      { host: 'localhost' + ':3080', 'X-Forwarded-Host': 'attacker.example', 'content-type': 'application/json' },
    ]) {
      const result = await request(path, { headers })
      assert.equal(result.status, 403, path + ' ' + JSON.stringify(headers))
    }
    assert.equal((await request(path, { remote: '192.0.2.1', headers: { host: 'localhost' + ':3080', 'content-type': 'application/json' } })).status, 403, path)
    assert.equal((await request(path, { headers: { host: 'localhost' + ':3080', origin: 'http://localhost' + ':3080', 'content-type': 'text/plain' } })).status, 415, path)
    assert.equal((await request(path, { headers: { host: 'localhost' + ':3080', origin: 'http://localhost' + ':3080' } })).status, 415, path)
    assert.equal((await request(path, { headers: { host: 'localhost' + ':3080', 'content-type': 'text/plain' } })).status, 415, path)
  }
})

test('all routes accept same-origin JSON and origin-less local CLI without weakening read guards', async t => {
  const request = await fixture(t)
  for (const path of writes) {
    for (const headers of [
      { host: 'localhost' + ':3080', origin: 'http://localhost' + ':3080', 'content-type': 'application/json; charset=utf-8' },
      { host: '127.0.0.1' + ':3080', 'content-type': 'application/json' },
      { host: '[::1]:3080' }, // legacy origin-less loopback CLI
    ]) {
      const result = await request(path, { headers })
      assert.notEqual(result.status, 403, path)
      assert.notEqual(result.status, 415, path)
    }
  }
  for (const path of reads) {
    assert.equal((await request(path, { method: 'GET', headers: { host: 'evil.example:3080', origin: 'http://evil.example:3080' } })).status, 403, path)
    assert.equal((await request(path, { method: 'GET', remote: '192.0.2.1', headers: { host: 'localhost' + ':3080' } })).status, 403, path)
    assert.equal((await request(path, { method: 'GET', headers: { host: 'localhost' + ':3080', 'sec-fetch-site': 'cross-site' } })).status, 403, path)
    assert.equal((await request(path, { method: 'GET', headers: { host: 'localhost' + ':3080', 'x-forwarded-proto': 'https' } })).status, 403, path)
    const local = await request(path, { method: 'GET', headers: { host: 'localhost' + ':3080', 'sec-fetch-site': 'same-origin' } })
    assert.notEqual(local.status, 403, path)
  }
})

test('origin scheme, port, forwarded headers, and loopback transport cannot be spoofed', async t => {
  const request = await fixture(t)
  const path = '/dsh-supervisor/adopt'
  for (const headers of [
    { host: 'localhost' + ':3080', origin: 'https://localhost' + ':3080', 'content-type': 'application/json' },
    { host: 'localhost' + ':3080', origin: 'http://localhost' + ':3081', 'content-type': 'application/json' },
    { host: 'attacker.example:3080', origin: 'http://attacker.example:3080', 'x-forwarded-host': 'localhost' + ':3080', 'content-type': 'application/json' },
  ]) assert.equal((await request(path, { headers })).status, 403)
  const secure = await request(path, { encrypted: true, headers: { host: 'localhost' + ':3443', origin: 'https://localhost' + ':3443', 'content-type': 'application/json' } })
  assert.notEqual(secure.status, 403)
  assert.notEqual(secure.status, 415)
})

test('cross-site mode mutation has no effect, while the same-origin JSON action still works', async t => {
  const request = await fixture(t)
  const path = '/dsh-supervisor/state'
  const body = JSON.stringify({ sessionId: 's1', patch: { mode: 'takeover' } })
  const attack = await request(path, { body, headers: { host: 'localhost' + ':3080', origin: 'https://attacker.example', 'content-type': 'text/plain' } })
  assert.equal(attack.status, 403)
  const before = await request('/dsh-supervisor/states', { method: 'GET', query: '?ids=s1', headers: { host: 'localhost' + ':3080' } })
  assert.equal(before.data.states.s1.mode, 'off')
  const valid = await request(path, { body, headers: { host: 'localhost' + ':3080', origin: 'http://localhost' + ':3080', 'content-type': 'application/json' } })
  assert.equal(valid.status, 200)
  assert.equal(valid.data.state.mode, 'takeover')
})
