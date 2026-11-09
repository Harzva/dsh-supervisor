// dsh-supervisor — 圆桌记录 → 图结构（纯函数，0 运行时依赖，node 可单测）。
//
// 从 store.getRoundtables(sid) 的原始记录构建可渲染的图：
//   节点：round（每轮）/ faculty（实际参与学院）/ consensus（共识）
//   边：faculty→consensus（送入裁决，实线）；verdict==='分歧' 时参与学院间（虚线分歧）
//
// 语义对齐 01-需求 FR-D6 / 02-架构 §7：每条记录能还原 学院→共识 边与分歧边。
// G2/G3 采用"实际参与集"（主责+协作，非固定 5）：每轮 faculty 节点=参与学院数。

const ROUND = 'round'
const FACULTY = 'faculty'
const CONSENSUS = 'consensus'
const FEED = 'feed'
const DIVERGENCE = 'divergence'

/**
 * 单条圆桌记录 → 一组节点与边。
 * @param {object} record - { roundId, sessionId, at, opinions[], verdict, consensus }
 * @param {number} index - 轮次序号（用于"第 N 轮"标签）。
 * @returns {{round: object, nodes: object[], edges: object[]}}
 */
function buildRound(record, index) {
  const roundId = String(record && record.roundId || 'round-' + String(index + 1))
  const roundNodeId = 'round:' + roundId
  const consensusNodeId = 'consensus:' + roundId
  const opinions = Array.isArray(record && record.opinions) ? record.opinions : []
  // 实际参与学院 = 成功产出意见的学院（ok:true）。未成功的不构成"送入裁决"边。
  const participating = opinions.filter((o) => o && (o.ok === true || (typeof o.text === 'string' && o.text.trim().length > 0)))
  const verdict = String((record && record.verdict) || '').trim()
  const consensusText = String((record && record.consensus) || '').trim() || '（无共识）'

  const nodes = [
    { id: roundNodeId, kind: ROUND, label: '第 ' + String(index + 1) + ' 轮', roundId },
    ...participating.map((o) => ({
      id: 'faculty:' + (o.facultyId || o.name || String(Math.random())),
      kind: FACULTY,
      label: o.name || o.facultyId || '学院',
      facultyId: o.facultyId || '',
      text: typeof o.text === 'string' ? o.text : '',
      ok: true,
    })),
    { id: consensusNodeId, kind: CONSENSUS, label: '共识', text: consensusText, verdict },
  ]

  const edges = participating.map((o) => ({
    from: 'faculty:' + (o.facultyId || o.name || String(Math.random())),
    to: consensusNodeId,
    kind: FEED,
  }))

  // verdict 明确为「分歧」时，在参与学院间画虚线分歧边（至少 1 条）。
  if (verdict === '分歧') {
    const ids = participating.map((o) => 'faculty:' + (o.facultyId || o.name || String(Math.random())))
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        edges.push({ from: ids[i], to: ids[j], kind: DIVERGENCE, dashed: true })
      }
    }
  }

  return {
    round: { roundId, at: Number(record && record.at) || 0, verdict, consensus: consensusText, nodeCount: nodes.length, edgeCount: edges.length },
    nodes,
    edges,
  }
}

/**
 * 从多条圆桌记录构建完整图结构。
 * @param {Array<object>} records - getRoundtables(sid) 返回的记录（任意顺序）。
 * @returns {{ rounds: object[], nodes: object[], edges: object[], summary: object }}
 */
export function buildRoundtableGraph(records) {
  const list = Array.isArray(records) ? records.filter((r) => r && r.roundId) : []
  // 时间线：按 at 升序（G6）。
  const ordered = [...list].sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
  const rounds = ordered.map((record, index) => buildRound(record, index))
  const nodes = []
  const edges = []
  const facultySet = new Set()
  const verdictCounts = { 分歧: 0, 一致: 0, 未标注: 0 }
  for (const r of rounds) {
    nodes.push(...r.nodes)
    edges.push(...r.edges)
    for (const n of r.nodes) if (n.kind === FACULTY) facultySet.add(n.label)
    const v = r.round.verdict
    if (v === '分歧') verdictCounts.分歧 += 1
    else if (v === '一致') verdictCounts.一致 += 1
    else verdictCounts.未标注 += 1
  }
  return {
    rounds,
    nodes,
    edges,
    summary: {
      roundCount: rounds.length,
      facultyCount: facultySet.size,
      facultyNames: [...facultySet],
      edgeCount: edges.length,
      divergenceEdges: edges.filter((e) => e.kind === DIVERGENCE).length,
      verdictCounts,
    },
  }
}
