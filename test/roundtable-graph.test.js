import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRoundtableGraph } from '../lib/roundtable-graph.js'

function record(overrides = {}) {
  return {
    roundId: overrides.roundId || 'rt-' + String(Math.random()).slice(2),
    sessionId: overrides.sessionId || 's1',
    at: overrides.at || 1000,
    opinions: overrides.opinions || [
      { facultyId: 'strategy', name: '策略学院', text: '先验证', ok: true },
      { facultyId: 'code', name: '代码学院', text: '先上线', ok: true },
      { facultyId: 'verify', name: '评估验收', text: '先核验', ok: true },
    ],
    verdict: overrides.verdict !== undefined ? overrides.verdict : '一致',
    consensus: overrides.consensus !== undefined ? overrides.consensus : '先验证再上线',
  }
}

// G1：≥1 轮记录能渲染成图（nodes/edges 非空，rounds 非空）。
test('G1: a single record renders a non-empty graph', () => {
  const graph = buildRoundtableGraph([record()])
  assert.equal(graph.rounds.length, 1)
  assert.ok(graph.nodes.length > 0)
  assert.ok(graph.edges.length > 0)
  assert.equal(graph.summary.roundCount, 1)
})

// G2/G3（实际参与集）：每轮 faculty 节点=参与学院数，共识/轮次各 1；每条 faculty→consensus 送入裁决边。
test('G2/G3: faculty nodes and feed edges use actual participant set', () => {
  const graph = buildRoundtableGraph([record()])
  const r = graph.rounds[0]
  const facultyNodes = r.nodes.filter((n) => n.kind === 'faculty')
  const consensusNodes = r.nodes.filter((n) => n.kind === 'consensus')
  const roundNodes = r.nodes.filter((n) => n.kind === 'round')
  const feedEdges = r.edges.filter((e) => e.kind === 'feed')
  assert.equal(facultyNodes.length, 3)
  assert.equal(consensusNodes.length, 1)
  assert.equal(roundNodes.length, 1)
  assert.equal(feedEdges.length, 3) // = 参与学院数
  // 每条 feed 边指向该轮的 consensus 节点。
  for (const e of feedEdges) assert.equal(e.to, 'consensus:' + r.round.roundId)
})

// G4：verdict==='分歧' 时存在 ≥1 条 dashed 分歧边；verdict==='一致' 时无。
test('G4: divergence edges exist only when verdict is 分歧', () => {
  const divergent = buildRoundtableGraph([record({ verdict: '分歧', roundId: 'rt-d' })])
  const consensus = buildRoundtableGraph([record({ verdict: '一致', roundId: 'rt-c' })])

  const dRound = divergent.rounds[0]
  const dDivergence = dRound.edges.filter((e) => e.kind === 'divergence')
  assert.ok(dDivergence.length >= 1, '分歧 时应有 ≥1 条虚线分歧边')
  assert.ok(dDivergence.every((e) => e.dashed === true))

  const cRound = consensus.rounds[0]
  assert.equal(cRound.edges.filter((e) => e.kind === 'divergence').length, 0, '一致 时不应有分歧边')

  // 分歧边连接的是参与学院（faculty⟂faculty）。
  for (const e of dDivergence) {
    assert.match(e.from, /^faculty:/)
    assert.match(e.to, /^faculty:/)
    assert.notEqual(e.from, e.to)
  }
})

// 时间线（G6）：多轮按 at 升序排列。
test('G6: multiple rounds are ordered by at ascending', () => {
  const graph = buildRoundtableGraph([
    record({ roundId: 'rt-2', at: 2000 }),
    record({ roundId: 'rt-1', at: 1000 }),
    record({ roundId: 'rt-3', at: 3000 }),
  ])
  assert.deepEqual(graph.rounds.map((r) => r.round.roundId), ['rt-1', 'rt-2', 'rt-3'])
})

// 边缘：无记录 → 空图；失败学院（ok:false）不构成送入裁决边。
test('empty records and failed faculties are handled', () => {
  const empty = buildRoundtableGraph([])
  assert.equal(empty.rounds.length, 0)
  assert.equal(empty.nodes.length, 0)
  assert.equal(empty.edges.length, 0)

  const withFail = buildRoundtableGraph([record({
    roundId: 'rt-f',
    opinions: [
      { facultyId: 'strategy', name: '策略学院', text: '', ok: false },
      { facultyId: 'code', name: '代码学院', text: '先上线', ok: true },
    ],
  })])
  const facultyNodes = withFail.rounds[0].nodes.filter((n) => n.kind === 'faculty')
  assert.equal(facultyNodes.length, 1)
  assert.equal(withFail.rounds[0].edges.filter((e) => e.kind === 'feed').length, 1)
})
