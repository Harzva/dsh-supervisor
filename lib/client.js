// dsh-supervisor — browser half: session controls and optional council advice.
//
// 单会话状态读写走 /dsh-supervisor/* HTTP 接口；仅圆桌成员管理等尚无
// HTTP 路由的 group 动作保留 /supervise 命令通道。表面：输入区智能接管条、
// 右侧 Supervisor 浮窗、设置→Supervisor（浮窗显隐）。

window.__ModuleLoader__.load({
  id: 'dsh-supervisor',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const PANEL_CSS = `
      .dshSupervisorPanel { min-width: 0; color: var(--dsw-alias-label-primary, #303030); }
      .dshSupervisorPanel *, .dshSupervisorPanel *::before { box-sizing: border-box; }
      .dshSupervisorPanel button, .dshSupervisorPanel select, .dshSupervisorPanel summary { font-family: inherit; }
      .dshSupervisorPanel button:focus-visible, .dshSupervisorPanel select:focus-visible,
      .dshSupervisorPanel input:focus-visible, .dshSupervisorPanel summary:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #2563eb); outline-offset: 2px;
      }
      .dshSupervisorPanel button:disabled { opacity: .5; cursor: not-allowed; }
      .dshSupervisorPanel select { min-width: 0; max-width: 100%; }
      .dshSupervisorPanel details > summary { min-height: 30px; padding-block: 4px; }
      .dshSupervisorPanel details[open] > summary > span[aria-hidden] { rotate: 90deg; }
      .dshSupervisorPanel p { overflow-wrap: anywhere; }
      .dshSupervisorPanel .dshSupervisorSettings { border-top: 1px solid var(--dsw-alias-border-l1, #dedede); padding-top: 8px; }
      .dshSupervisorPanel .dshSupervisorSettings > summary { font-size: 12px; font-weight: 600; cursor: pointer; }
      .dshSupervisorPanel .dshSupervisorSettingsBody { display: flex; flex-direction: column; gap: 12px; padding-top: 8px; min-width: 0; }
      @media (max-width: 480px) {
        .dshSupervisorPanel { width: 100%; }
        .dshSupervisorPanel [data-dsh-supervisor-council] label { align-items: flex-start; line-height: 20px; }
        .dshSupervisorPanel [data-dsh-supervisor-council] input { flex: none; margin-top: 3px; }
      }
    `

    const FLOAT_KEY = 'dsh-supervisor.floatVisible'
    const FLOAT_EVENT = 'dsh-supervisor:float-change'
    const PANEL_TOGGLE_EVENT = 'dsh-supervisor:panel-toggle'
    const PANEL_STATE_EVENT = 'dsh-supervisor:panel-state'
    const FLOAT_COLLAPSED_KEY = 'dsh-supervisor.floatCollapsed'
    const FLOAT_POSITION_KEY = 'dsh-supervisor.floatPosition.v1'
    const floatVisible = () => { try { return window.localStorage.getItem(FLOAT_KEY) !== '0' } catch { return true } }
    const floatCollapsed = () => { try { return window.localStorage.getItem(FLOAT_COLLAPSED_KEY) === '1' } catch { return false } }
    const floatPosition = () => {
      try {
        const value = JSON.parse(window.localStorage.getItem(FLOAT_POSITION_KEY) || 'null')
        return value && Number.isFinite(value.left) && Number.isFinite(value.top)
          ? { left: value.left, top: value.top }
          : null
      } catch { return null }
    }
    const setFloatPosition = (value) => {
      try {
        if (value) window.localStorage.setItem(FLOAT_POSITION_KEY, JSON.stringify(value))
        else window.localStorage.removeItem(FLOAT_POSITION_KEY)
      } catch { /* ignore */ }
    }
    const setFloatCollapsed = (value) => { try { window.localStorage.setItem(FLOAT_COLLAPSED_KEY, value ? '1' : '0') } catch { /* ignore */ } }
    const setFloatVisible = (value) => {
      try { window.localStorage.setItem(FLOAT_KEY, value ? '1' : '0') } catch { /* ignore */ }
      try { window.dispatchEvent(new Event(FLOAT_EVENT)) } catch { /* ignore */ }
    }
    const STATES_PATH = '/dsh-supervisor/states'
    const STATE_PATH = '/dsh-supervisor/state'
    const ADOPT_PATH = '/dsh-supervisor/adopt'
    const REGEN_PATH = '/dsh-supervisor/regen'
    const ROUNDTABLE_GRAPH_PATH = '/dsh-supervisor/roundtables/graph'

    const noneState = { mode: 'off', strategy: 'plan', rounds: 10, used: 0, intervalMs: 5000, mentorModel: '', supervisorModels: {}, mentor: null, assignment: null, suggestion: '', suggestError: '', suggesting: false, status: 'off', plan: null, planTodos: [] }
    const STATUS = {
      recovery: { label: '恢复待核对', color: '#b45309' },
      off: { label: '未开启', color: '#999999' },
      silent: { label: '监听中', color: '#8a8f98' },
      thinking: { label: '思考中·分析对话', color: '#3b82f6' },
      suggested: { label: '建议就绪', color: '#2f9e44' },
      working: { label: '执行中', color: '#f59e0b' },
    }
    const statusBadge = (status) => {
      const s = STATUS[status] || STATUS.silent
      return React.createElement('span', { key: 'status', style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: s.color, fontWeight: 600 } },
        s.label,
      )
    }
    const chip = (label, value, selected, color, onPick, disabled) => React.createElement('button', {
      type: 'button',
      key: value,
      disabled: !!disabled,
      onClick: () => onPick(value),
      'aria-pressed': selected,
      style: {
        minHeight: 32, padding: '4px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: disabled ? 'wait' : 'pointer', border: selected ? '1px solid transparent' : '1px solid var(--dsw-alias-border-l1, #d0d0d0)', flex: 'none', whiteSpace: 'nowrap', opacity: disabled ? .55 : 1, fontFamily: 'inherit', lineHeight: '20px',
        background: selected ? color : 'var(--dsw-alias-interactive-bg-hover-solid, #e5e5e5)',
        color: selected ? '#fff' : 'var(--dsw-alias-label-primary, #333)',
        boxShadow: selected ? 'inset 0 0 0 1px rgba(255,255,255,0.25)' : 'none',
        transition: 'background 100ms ease, border-color 100ms ease',
      },
    }, label)
    const chipRow = (label, chips, opts) => React.createElement('div', { key: opts.key, role: 'group', 'aria-label': label, style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
      React.createElement('span', { style: { flex: 'none', minWidth: 36, color: 'var(--dsw-alias-label-primary, #555)', fontWeight: 700, fontSize: 11 } }, label),
      ...chips,
    )

    const MODE = { off: { label: '关闭', color: '#6b7280' }, advice: { label: '提意见', color: '#2563eb' }, takeover: { label: '接管', color: '#2f9e44' } }
    const STRATEGY = { plan: { label: '计划驱动', color: '#2563eb' }, insight: { label: '理解驱动', color: '#7c3aed' }, fixed: { label: '固定随机', color: '#d97706' } }

    function apply(ctx) {
      const warn = (...args) => { if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('[supervisor]', ...args) }
      // 共享选角实现：require **裸包名** '@harzva/dsh-role-registry'（DSH ModuleLoader 客户端模块）。
      // 与 GroupX MemberSelector 从同一模块解析（FR-9）。注意：ModuleLoader 只解析尾部 /client，
      // 无法解析 /picker 子路径，因此这里必须用裸包名并从导出里取 picker API。加载失败不阻塞
      // Supervisor 其余能力，仅禁用选角并提示。
      let rolePickerApi = null
      let rolePickerFailed = false
      const getRolePickerApi = () => {
        if (rolePickerFailed) return null
        if (rolePickerApi) return rolePickerApi
        try { rolePickerApi = require('@harzva/dsh-role-registry') } catch (cause) {
          rolePickerFailed = true
          warn('role picker module unavailable: ' + String((cause && cause.message) || cause))
        }
        return rolePickerApi
      }
      const exec = async (sessionId, line) => {
        try {
          const r = await ctx.remote.commands.execute(sessionId, line, [])
          if (r && r.ok) {
            const v = r.value
            const text = v && ((v.result && v.result.text) || v.text)
            if (typeof text === 'string' && text.length > 0) { try { return JSON.parse(text) } catch { return null } }
          }
          return null
        } catch { return null }
      }
      const fetchState = async (sessionId) => {
        if (!sessionId) return null
        try {
          const res = await fetch(STATES_PATH + '?ids=' + encodeURIComponent(sessionId), { method: 'GET', cache: 'no-store' })
          if (!res.ok) return null
          const payload = await res.json()
          return payload && payload.states ? (payload.states[sessionId] || null) : null
        } catch { return null }
      }
      const fetchRoundtableGraph = async (sessionId) => {
        if (!sessionId) return null
        try {
          const res = await fetch(ROUNDTABLE_GRAPH_PATH + '?sessionId=' + encodeURIComponent(sessionId), { method: 'GET', cache: 'no-store' })
          if (!res.ok) return null
          const payload = await res.json()
          return payload && payload.ok && payload.graph ? payload.graph : null
        } catch { return null }
      }

      // 圆桌 graph 视图：对标 Trajectory 清晰度。
      // 每轮一个时间线区块：顶部轮次/verdict 徽章/学院数/时间；中间 SVG 画节点+边
      // （学院→共识 实线箭头=送入裁决；学院⟂学院 虚线=分歧）；节点可展开看完整意见/共识。
      const RoundtableGraphView = ({ graph, onOpenSummary }) => {
        if (!graph || graph.roundCount === 0) {
          return React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, graph ? '暂无圆桌记录。' : '正在载入圆桌记录…')
        }
        const summary = graph.summary || {}
        const verdictMeta = { '分歧': { color: '#b45309', label: '分歧' }, '一致': { color: '#15803d', label: '一致' } }
        const fmtTime = (at) => {
          if (!at) return ''
          try {
            const d = new Date(Number(at))
            return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
          } catch { return '' }
        }
        // 单轮 SVG：左=学院节点，右=共识节点；feed 实线，divergence 虚线。
        const renderLinks = (edges, positions) => {
          return edges.map((e, idx) => {
            const a = positions[e.from]
            const b = positions[e.to]
            if (!a || !b) return null
            const stroke = e.kind === 'feed' ? '#0d766f' : '#b45309'
            const dash = e.kind === 'divergence' ? '4 3' : ''
            const marker = e.kind === 'feed' ? 'url(#rtArrow)' : ''
            return React.createElement('line', {
              key: 'edge-' + idx,
              x1: a.x, y1: a.y, x2: b.x, y2: b.y,
              stroke: stroke, strokeWidth: e.kind === 'feed' ? 1.6 : 1.3,
              strokeDasharray: dash || undefined, markerEnd: marker,
              opacity: 0.85,
            })
          })
        }
        return React.createElement('div', { 'data-dsh-supervisor-graph': '', style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 9px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base))' } },
          React.createElement('div', { key: 'g-summary', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
            '共 ' + graph.roundCount + ' 轮 · ' + summary.facultyCount + ' 学院 · 达成 ' + (summary.verdictCounts['一致'] || 0) + ' 一致 / ' + (summary.verdictCounts['分歧'] || 0) + ' 分歧'),
          ...graph.rounds.map((r, roundIndex) => {
            const facultyNodes = r.nodes.filter((n) => n.kind === 'faculty')
            const consensusNode = r.nodes.find((n) => n.kind === 'consensus')
            const feedEdges = r.edges.filter((e) => e.kind === 'feed')
            const divEdges = r.edges.filter((e) => e.kind === 'divergence')
            const hasDivergence = divEdges.length > 0
            const vMeta = verdictMeta[r.round.verdict] || { color: '#6b7280', label: r.round.verdict || '未标注' }
            const vLabel = r.round.verdict || '未标注'
            // SVG 布局：学院节点纵向排左侧，共识节点右侧中部；边从学院→共识。
            const consensusPos = { x: 252, y: Math.max(22, (facultyNodes.length - 1) * 26 + 22) }
            const positions = {}
            const nodeDefs = []
            facultyNodes.forEach((n, i) => {
              const y = 22 + i * 26
              positions[n.id] = { x: 88, y }
              nodeDefs.push({ id: n.id, x: 88, y, label: n.label, color: '#0d766f', text: n.text })
            })
            positions['consensus:' + r.round.roundId] = consensusPos
            return React.createElement('details', {
              key: 'round-' + r.round.roundId,
              open: roundIndex === graph.rounds.length - 1, // 最新一轮默认展开
              style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 7, padding: '6px 8px', background: 'var(--dsw-alias-bg-base)' },
            },
              React.createElement('summary', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', listStyle: 'none' } },
                React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontWeight: 600 } }, r.round.label),
                React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 3, borderRadius: 999, padding: '1px 7px', fontSize: 10, fontWeight: 700, color: '#fff', background: vMeta.color } }, vLabel),
                React.createElement('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' } }, String(facultyNodes.length) + ' 学院'),
                hasDivergence ? React.createElement('span', { style: { fontSize: 10, color: '#b45309', fontWeight: 700 } }, '分歧 ' + String(divEdges.length) + ' 边') : null,
                React.createElement('span', { style: { marginLeft: 'auto', fontSize: 10, color: 'var(--dsw-alias-label-caption, #888)' } }, fmtTime(r.round.at)),
              ),
              React.createElement('div', { style: { marginTop: 6 } },
                React.createElement('svg', { width: 300, height: Math.max(48, facultyNodes.length * 26 + 18), viewBox: '0 0 300 ' + String(Math.max(48, facultyNodes.length * 26 + 18)), 'aria-hidden': true },
                  React.createElement('defs', null,
                    React.createElement('marker', { id: 'rtArrow', markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto' },
                      React.createElement('path', { d: 'M0,0 L8,4 L0,8 z', fill: '#0d766f' }),
                    ),
                  ),
                  renderLinks(r.edges, positions),
                  ...nodeDefs.map((n) =>
                    React.createElement('g', { key: n.id },
                      React.createElement('rect', { x: n.x - 38, y: n.y - 10, width: 76, height: 20, rx: 6, fill: 'rgba(13,118,111,0.12)', stroke: '#0d766f', strokeWidth: 1 }),
                      React.createElement('text', { x: n.x, y: 3, textAnchor: 'middle', dominantBaseline: 'middle', y: n.y + 4, fontSize: 10, fontWeight: 700, fill: '#0d3b2d', style: { userSelect: 'none' } }, n.label),
                    ),
                  ),
                  React.createElement('text', { x: consensusPos.x, y: consensusPos.y - 8, textAnchor: 'middle', fontSize: 10, fontWeight: 700, fill: '#0d3b2d' }, consensusNode ? '共识' : '共识'),
                  React.createElement('rect', { x: consensusPos.x - 26, y: consensusPos.y - 9, width: 52, height: 18, rx: 6, fill: 'rgba(210,155,34,0.16)', stroke: '#d29b22', strokeWidth: 1 }),
                  React.createElement('text', { x: consensusPos.x, y: consensusPos.y + 4, textAnchor: 'middle', fontSize: 9, fill: '#7a5410' }, '裁决'),
                ),
                // 图例
                React.createElement('div', { style: { display: 'flex', gap: 10, fontSize: 9, color: 'var(--dsw-alias-label-tertiary)', marginTop: 2, flexWrap: 'wrap' } },
                  (React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, React.createElement('span', { style: { width: 14, height: 0, borderTop: '2px solid #0d766f', display: 'inline-block' } }), '送入裁决')),
                  (hasDivergence ? React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, React.createElement('span', { style: { width: 14, height: 0, borderTop: '2px dashed #b45309', display: 'inline-block' } }), '分歧') : null),
                ),
                // 学院意见全文 + 共识
                React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, marginTop: 5 } },
                  ...facultyNodes.map((n) =>
                    React.createElement('div', { key: n.id, style: { fontSize: 10.5, lineHeight: '15px', color: 'var(--dsw-alias-label-secondary)' } },
                      React.createElement('span', { style: { fontWeight: 700, color: '#0d766f', whiteSpace: 'nowrap' } }, '◆ ' + n.label + ' '),
                      n.text ? String(n.text) : '（无意见）'),
                  ),
                  React.createElement('div', { style: { fontSize: 10.5, lineHeight: '15px', color: 'var(--dsw-alias-label-tertiary)', borderTop: '1px dashed var(--dsw-alias-border-l1)', paddingTop: 4, marginTop: 2 } },
                    '→ 共识（' + String(feedEdges.length) + ' 学院送入裁决）：' + String(r.round.consensus || '').slice(0, 140)),
                ),
              ),
            )
          }),
        )
      }
      function ProjectMemoryPanel({ sessionId, judgement }) {
        const [data, setData] = React.useState(null)
        const [folder, setFolder] = React.useState('')
        const [error, setError] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const generation = React.useRef(0)
        const request = async (action, folderPath) => {
          const current = ++generation.current
          setBusy(true); setError('')
          try {
            const response = await fetch('/dsh-supervisor/memory' + (action ? '' : '?sessionId=' + encodeURIComponent(sessionId)), action ? {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, action, folderPath }),
            } : {})
            const value = await response.json()
            if (!response.ok) throw new Error(value.error || '读取失败')
            if (current === generation.current) { setData(value); if (action === 'create') setFolder('') }
          } catch (cause) { if (current === generation.current) setError(cause.message) }
          finally { if (current === generation.current) setBusy(false) }
        }
        React.useEffect(() => {
          setData(null); setFolder('')
          if (sessionId) request()
          const timer = sessionId ? setInterval(() => request(), 3000) : null
          return () => { generation.current++; if (timer) clearInterval(timer) }
        }, [sessionId, judgement?.loadedAt])
        const info = data?.memory
        const status = { ready: '已读取', empty: '暂无已审核记忆', unavailable: '服务未加载', degraded: '读取失败，已降级', stale: '作用域已改变' }[info?.status] || '尚未读取'
        const inputStyle = { minHeight: 30, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 7, padding: '4px 8px', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', minWidth: 0 }
        const buttonStyle = { ...inputStyle, cursor: 'pointer', flex: 'none' }
        return React.createElement('section', { 'aria-label': 'Supervisor 项目记忆', style: { display: 'flex', flexDirection: 'column', gap: 7, padding: 10, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base))' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            React.createElement('strong', { style: { flex: 1 } }, '项目记忆'),
            React.createElement('span', { role: 'status', style: { fontSize: 11, color: info?.status === 'ready' ? '#16814b' : 'var(--dsw-alias-label-secondary)' } }, busy ? '读取中…' : status)),
          React.createElement('div', { style: { fontSize: 12 } }, '当前作用域：' + (data?.scope?.label || '加载中…') + (data?.scope?.kind === 'folder' ? ' · 项目文件夹' : ' · 工作目录')),
          React.createElement('select', { 'aria-label': '项目记忆文件夹', disabled: busy || !data?.foldersAvailable, value: data?.scope?.folderPath || '', style: inputStyle, onChange: e => request('assign', e.target.value) },
            React.createElement('option', { value: '' }, '未分组 · 沿用工作目录'),
            ...(data?.folders || []).map(f => React.createElement('option', { key: f.path, value: f.path }, f.title + ' · ' + f.path))),
          React.createElement('div', { style: { display: 'flex', gap: 6 } },
            React.createElement('input', { 'aria-label': '新项目文件夹', value: folder, placeholder: '新项目文件夹，例如 产品/桌面端', disabled: busy || !data?.foldersAvailable, maxLength: 240, onChange: e => setFolder(e.target.value), style: { ...inputStyle, flex: 1 } }),
            React.createElement('button', { type: 'button', disabled: busy || !folder.trim() || !data?.foldersAvailable, onClick: () => request('create', folder.trim()), style: buttonStyle }, '创建并移入')),
          React.createElement('div', { style: { fontSize: 11, lineHeight: '17px', color: 'var(--dsw-alias-label-secondary)' } },
            data?.nativeFolders ? '与侧边栏的项目文件夹同步；执行目录保持原位置。' : '同项目文件夹共享记忆；在此切换归属，执行目录保持原位置。'),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            React.createElement('span', { style: { flex: 1, fontSize: 11 } }, info ? (data.usedInJudgement ? '本轮监督已使用' : '读取预览') + ' · ' + info.hitCount + ' 条 · ' + (info.tokenUsed || 0) + ' tokens' : '每轮监督自动读取已审核记忆'),
            React.createElement('button', { type: 'button', disabled: busy || !data?.available, onClick: () => request('refresh'), style: buttonStyle }, '刷新记忆')),
          data?.scope?.migrationRequired ? React.createElement('div', { role: 'status', style: { fontSize: 11, color: '#b45309' } }, data.scope.migrationRequired.message || '宿主项目归属已变化，继续使用原项目记忆；可预览迁移后再切换。') : null,
          info?.warnings?.length ? React.createElement('div', { style: { fontSize: 11, color: '#b45309' } }, info.warnings.join('；')) : null,
          error ? React.createElement('div', { role: 'alert', style: { color: '#b42318', fontSize: 12 } }, error) : null)
      }

      const patchState = async (sessionId, patch) => {
        return postState(STATE_PATH, sessionId, { patch })
      }
      const postState = async (path, sessionId, body) => {
        if (!sessionId) throw new Error('当前会话尚未就绪')
        let res
        try {
          res = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, ...body }),
          })
        } catch (cause) {
          throw new Error('无法连接 Supervisor 服务：' + String((cause && cause.message) || cause || '网络错误'))
        }
        let payload = null
        try { payload = await res.json() } catch { /* handled below */ }
        if (!res.ok) throw new Error((payload && payload.error) || ('Supervisor 服务返回 HTTP ' + res.status))
        if (!payload || !payload.state) throw new Error('Supervisor 服务未返回有效状态')
        return payload.state
      }
      const adoptState = (sessionId) => postState(ADOPT_PATH, sessionId, {})
      const regenState = (sessionId) => postState(REGEN_PATH, sessionId, {})
      const usePoll = (sid, setState, ms) => {
        React.useEffect(() => {
          if (!sid) return
          let alive = true
          const refresh = () => { fetchState(sid).then((v) => { if (alive && v) setState(v) }).catch(() => {}) }
          refresh()
          let stop = () => {}
          try { stop = ctx.interval(refresh, ms) || (() => {}) } catch { /* no polling */ }
          return () => { alive = false; if (typeof stop === 'function') stop() }
        }, [sid])
      }

      const panelOpenBySession = new Map()
      const panelListeners = new Map()
      const readPanelOpen = (sid) => panelOpenBySession.get(sid) === true
      const setPanelOpen = (sid, open) => {
        if (!sid || readPanelOpen(sid) === open) return
        panelOpenBySession.set(sid, open)
        for (const listener of panelListeners.get(sid) || []) listener()
        try { window.dispatchEvent(new CustomEvent(PANEL_STATE_EVENT, { detail: { sessionId: sid, open } })) } catch { /* ignore */ }
      }
      const usePanelOpen = (sid) => React.useSyncExternalStore(
        (listener) => {
          const listeners = panelListeners.get(sid) || new Set()
          listeners.add(listener)
          panelListeners.set(sid, listeners)
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0) panelListeners.delete(sid)
          }
        },
        () => readPanelOpen(sid),
        () => false,
      )
      try {
        ctx.effect(() => {
          const onToggle = (event) => {
            const sid = event && event.detail && event.detail.sessionId
            if (typeof sid === 'string' && sid.length > 0) setPanelOpen(sid, !readPanelOpen(sid))
          }
          window.addEventListener(PANEL_TOGGLE_EVENT, onToggle)
          return () => window.removeEventListener(PANEL_TOGGLE_EVENT, onToggle)
        }, 'dsh-supervisor: external panel toggle')
      } catch (error) { warn('external panel toggle registration failed', error) }

      // 共享选角组件：挂载 @harzva/dsh-role-registry 客户端模块（与 GroupX 同一实现）。
      // 选角 → 经 /supervise _role 写会话 roleRef；角色来源卸载/版本缺失 → fail-closed 提示。
      function SupervisorRolePicker(props) {
        const sid = props && props.sessionId
        const [open, setOpen] = React.useState(false)
        const [err, setErr] = React.useState('')
        const [roles, setRoles] = React.useState(null)
        const hostRef = React.useRef(null)
        const controlRef = React.useRef(null)
        const savingRef = React.useRef(false)
        const latest = React.useRef(props)
        latest.current = props
        const currentRef = React.useRef(props && props.roleRef)
        currentRef.current = props && props.roleRef
        const api = getRolePickerApi()
        const applyResult = props && props.onApplied
        const refresh = props && props.onRefresh
        React.useEffect(() => {
          if (!api) return
          let alive = true
          const request = new AbortController()
          try { api.fetchRoles('', { signal: request.signal }).then((r) => { if (alive) setRoles(r && r.ok ? r.roles : null) }).catch(() => { if (alive) setRoles(null) }) } catch { /* ignore */ }
          return () => { alive = false; request.abort() }
        }, [api, open])
        React.useEffect(() => {
          if (!open || !api || !hostRef.current) return
          let ctl = null
          let alive = true
          try {
            ctl = api.mountRolePicker(hostRef.current, {
              title: '选择监督角色（定义与模型路由分离）',
              baseUrl: '',
              initialRef: currentRef.current,
              onSelect: (refObj) => {
                const prior = currentRef.current
                if (savingRef.current || latest.current.disabled) { ctl.setSelection(prior); return }
                savingRef.current = true
                ctl.setEnabled(false)
                const want = refObj ? { id: refObj.id, version: refObj.version } : null
                const line = '/supervise _role ' + JSON.stringify(want)
                Promise.resolve(exec(sid, line)).then(async (value) => {
                  if (!alive) return
                  const assignment = value && value.assignment
                  const saved = assignment && assignment.roleRef ? assignment.roleRef : null
                  const confirmed = assignment && typeof assignment === 'object' && !Array.isArray(assignment)
                    && (want === null ? saved === null : saved && saved.id === want.id && saved.version === want.version)
                  if (!confirmed) throw new Error('保存未确认，请刷新后重试')
                  if (typeof applyResult === 'function') await applyResult(value)
                  if (alive) setErr('')
                }).catch((cause) => {
                  if (!alive) return
                  ctl.setSelection(prior)
                  setErr(String((cause && cause.message) || cause))
                }).finally(() => {
                  savingRef.current = false
                  if (alive) ctl.setEnabled(!latest.current.disabled)
                })
              },
            })
            controlRef.current = ctl
            ctl.setEnabled(!latest.current.disabled)
          } catch (cause) { setErr(String((cause && cause.message) || cause)) }
          return () => { alive = false; if (ctl) ctl.destroy(); if (controlRef.current === ctl) controlRef.current = null }
        }, [open, sid, api])
        React.useEffect(() => {
          if (!savingRef.current) controlRef.current?.setSelection(currentRef.current || null)
        }, [props.roleRef?.id, props.roleRef?.version])
        React.useEffect(() => {
          controlRef.current?.setEnabled(!props.disabled && !savingRef.current)
        }, [props.disabled])
        const sel = currentRef.current
        const selKey = sel ? sel.id + '@' + sel.version : ''
        const present = Array.isArray(roles) && selKey !== ''
          ? roles.some((r) => r && r.id === sel.id && r.version === sel.version)
          : true
        const unavailable = Array.isArray(roles) && selKey !== '' && !present
        const btnStyle = { height: 24, padding: '0 8px', borderRadius: 999, fontSize: 11, cursor: 'pointer', border: 'none', background: open ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'var(--dsw-alias-interactive-bg-hover-solid, #e0e0e0)', color: open ? '#fff' : 'var(--dsw-alias-label-primary, #333)', flex: 'none' }
        return React.createElement('div', { 'data-dsh-supervisor-role-picker': '', style: { display: 'flex', flexDirection: 'column', gap: 5, padding: '8px 9px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base))' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            React.createElement('span', { style: { fontWeight: 700, fontSize: 12, color: 'var(--dsw-alias-label-primary)', flex: 'none' } }, '监督角色'),
            sel ? React.createElement('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-caption, #888)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: selKey }, sel.id + ' v' + sel.version) : null,
            React.createElement('button', { type: 'button', style: btnStyle, onClick: () => { setOpen(!open); setErr('') }, 'aria-expanded': open }, open ? '收起' : '选择角色'),
          ),
          open && api ? React.createElement('div', { ref: hostRef }) : null,
          !api ? React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, '共享选角组件不可用（@harzva/dsh-role-registry 客户端模块未加载）。') : null,
          err ? React.createElement('div', { role: 'alert', style: { fontSize: 11, lineHeight: '16px', color: '#b42318' } }, '查看/写入角色失败：' + err + '。') : null,
          unavailable ? React.createElement('div', { 'data-dsh-supervisor-role-unavailable': '', role: 'alert', style: { fontSize: 11, lineHeight: '16px', color: '#b45309', border: '1px solid rgba(180,83,9,.3)', borderRadius: 7, padding: '5px 7px', background: 'rgba(180,83,9,.06)' } }, '所选角色来源已卸载或版本不存在：监督将失败关闭，不再静默回退本地导师。') : null,
        )
      }

      function Controls(props) {
        const { cur, patch, busy } = props
        const mode = cur.mode || 'off'
        const strategy = cur.strategy || 'plan'
        const rounds = cur.rounds || 10
        const intervalSec = Math.round((cur.intervalMs || 5000) / 1000)
        const autoStatusKnown = cur.automaticContinuation && typeof cur.automaticContinuation.allowed === 'boolean'
        return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, width: '100%' } },
          chipRow('模式', Object.keys(MODE).map((k) => chip(MODE[k].label, k, mode === k, MODE[k].color, (v) => patch({ mode: v }), busy || (k === 'takeover' && !autoStatusKnown))), { key: 'mode' }),
          !autoStatusKnown ? React.createElement('div', { role: 'status', style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' } }, '当前服务未提供自动续行状态，暂不能从此处开启接管。') : null,
          React.createElement('details', { key: 'advanced-controls', style: { borderTop: '1px solid var(--dsw-alias-border-l1, #e5e5e5)', paddingTop: 6 } },
            React.createElement('summary', { style: { cursor: 'pointer', fontSize: 11, fontWeight: 700, color: 'var(--dsw-alias-label-secondary)', userSelect: 'none', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 4 } },
              React.createElement('span', { 'aria-hidden': true, style: { fontSize: 10 } }, '▸'),
              '策略与上限',
            ),
            React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 8 } },
              chipRow('策略', Object.keys(STRATEGY).map((k) => chip(STRATEGY[k].label, k, strategy === k, STRATEGY[k].color, (v) => patch({ strategy: v }), busy)), { key: 'strategy' }),
              chipRow('上限', [5, 10, 20, 30, 50].map((n) => chip(String(n), n, rounds === n, '#0e7490', (v) => patch({ rounds: v }), busy)), { key: 'rounds' }),
              chipRow('间隔', [2, 5, 15, 30, 60].map((s) => chip(s + 's', s, intervalSec === s, '#9333ea', (v) => patch({ intervalMs: v * 1000 }), busy)), { key: 'interval' }),
            ),
          ),
        )
      }

      // DSH's dock owner passes InputZone.session.sessionId; older
      // integrations may still pass a flat sessionId or session.id.
      const sessionIdFrom = (props) => {
        const candidates = [props?.session?.sessionId, props?.sessionId, props?.session?.id]
        return candidates.find(value => typeof value === 'string' && value.trim()) || null
      }
      function SupervisorHeaderAction(props) {
        const sid = props && props.sessionId
        const open = !!(props && props.open)
        const dockId = 'dsh-supervisor-dock-' + String(sid || 'current').replace(/[^a-zA-Z0-9_-]/g, '').slice(-24)
        return React.createElement('button', {
          type: 'button', onClick: () => setPanelOpen(sid, !open),
          title: open ? '收起智能接管面板' : '展开智能接管面板',
          'aria-label': open ? '收起智能接管面板' : '展开智能接管面板',
          'aria-expanded': open, 'aria-controls': dockId,
          style: { display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 28, padding: '2px 9px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-specific-tip)', color: 'var(--dsw-alias-label-primary)', borderRadius: 999, cursor: 'pointer', fontSize: 12, fontWeight: 600, lineHeight: '20px', fontFamily: 'inherit' },
        }, '智能接管', React.createElement('span', { 'aria-hidden': true, style: { fontSize: 10, opacity: .65 } }, open ? '⌃' : '⌄'))
      }

      function SupervisorDock(props) {
        const sid = sessionIdFrom(props)
        const open = usePanelOpen(sid)
        React.useEffect(() => {
          if (!sid) return
          try { window.dispatchEvent(new CustomEvent(PANEL_STATE_EVENT, { detail: { sessionId: sid, open } })) } catch { /* optional toolbar */ }
        }, [sid, open])
        React.useEffect(() => {
          if (!open || typeof document === 'undefined') return
          const onKeyDown = (event) => { if (event.key === 'Escape') setPanelOpen(sid, false) }
          document.addEventListener('keydown', onKeyDown)
          return () => document.removeEventListener('keydown', onKeyDown)
        }, [open, sid])
        if (!sid) return null
        const dockId = 'dsh-supervisor-dock-' + String(sid).replace(/[^a-zA-Z0-9_-]/g, '').slice(-24)
        return React.createElement('div', { 'data-dsh-supervisor-dock': '', style: { width: '100%', maxWidth: 'var(--dsh-composer-card-max-width, 780px)', margin: '0 auto' } },
          React.createElement(SupervisorHeaderAction, { sessionId: sid, open }),
          open ? React.createElement('div', { id: dockId }, React.createElement(typeof props.useSessions === 'function' ? MentorFloatWithSessions : MentorFloat, Object.assign({}, props, {
            inline: true,
            key: sid,
            sessionId: sid,
            onHide: () => setPanelOpen(sid, false),
          }))) : null,
        )
      }

      function MentorFloatWithSessions(props) {
        const sessionsSnapshot = props.useSessions((s) => s) || {}
        return React.createElement(MentorFloat, Object.assign({}, props, { sessionsSnapshot }))
      }

      function MentorFloat(props) {
        const inline = props && props.inline === true
        const sessionsSnapshot = (props && props.sessionsSnapshot) || {}
        const curSid = (props && props.sessionId) || sessionsSnapshot.current || null
        const [st, setSt] = React.useState(null)
        const [tst, setTst] = React.useState(null)
        const [group, setGroup] = React.useState(null)
        const [sel, setSel] = React.useState(null)
        const target = sel && sel !== 'self' ? sel : null
        const viewSid = target || curSid
        const viewRef = React.useRef({ sid: viewSid, epoch: 0 })
        if (viewRef.current.sid !== viewSid) viewRef.current = { sid: viewSid, epoch: viewRef.current.epoch + 1 }
        const viewEpoch = viewRef.current.epoch
        const [actionPending, setActionPending] = React.useState('')
        const [actionError, setActionError] = React.useState('')
        React.useEffect(() => { setActionPending(''); setActionError('') }, [viewSid])
        // Slot owner may re-project list occupants while surrounding shell state changes.
        // Persist this UI-only state so a projection cannot immediately undo the click.
        const [collapsed, setCollapsed] = React.useState(floatCollapsed)
        const changeCollapsed = (value) => { setFloatCollapsed(value); setCollapsed(value) }
        const [position, setPosition] = React.useState(floatPosition)
        const [dragging, setDragging] = React.useState(false)
        const wrapRef = React.useRef(null)
        const dragRef = React.useRef(null)
        const clampPosition = (left, top, width, height) => ({
          left: Math.min(Math.max(12, left), Math.max(12, window.innerWidth - width - 12)),
          top: Math.min(Math.max(12, top), Math.max(12, window.innerHeight - height - 12)),
        })
        const resetPosition = () => { dragRef.current = null; setDragging(false); setFloatPosition(null); setPosition(null) }
        const startDrag = (event) => {
          if (event.button !== 0 || !wrapRef.current) return
          const rect = wrapRef.current.getBoundingClientRect()
          dragRef.current = {
            startX: event.clientX,
            startY: event.clientY,
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            active: false,
          }
          event.preventDefault()
        }
        const moveDrag = (event) => {
          const drag = dragRef.current
          if (!drag) return
          const dx = event.clientX - drag.startX
          const dy = event.clientY - drag.startY
          if (!drag.active && Math.hypot(dx, dy) < 5) return
          if (!drag.active) { drag.active = true; setDragging(true) }
          setPosition(clampPosition(drag.left + dx, drag.top + dy, drag.width, drag.height))
          event.preventDefault()
        }
        const endDrag = () => {
          const drag = dragRef.current
          if (!drag) return
          dragRef.current = null
          setDragging(false)
          setPosition((current) => { if (current) setFloatPosition(current); return current })
        }
        React.useEffect(() => {
          window.addEventListener('mousemove', moveDrag)
          window.addEventListener('mouseup', endDrag)
          return () => {
            window.removeEventListener('mousemove', moveDrag)
            window.removeEventListener('mouseup', endDrag)
          }
        }, [])
        React.useEffect(() => {
          const keepInViewport = () => setPosition((current) => {
            if (!current || !wrapRef.current) return current
            const rect = wrapRef.current.getBoundingClientRect()
            const next = clampPosition(current.left, current.top, rect.width, rect.height)
            if (next.left === current.left && next.top === current.top) return current
            setFloatPosition(next)
            return next
          })
          keepInViewport()
          window.addEventListener('resize', keepInViewport)
          return () => window.removeEventListener('resize', keepInViewport)
        }, [])
        const [showMembers, setShowMembers] = React.useState(false)
        const [pendingTargets, setPendingTargets] = React.useState([])
        const [dirRecord, setDir] = React.useState(null)
        const dir = dirRecord && dirRecord.sid === viewSid ? dirRecord.value : null
        const [showGraph, setShowGraph] = React.useState(false)
        const [graph, setGraph] = React.useState(null)
        const [graphFailed, setGraphFailed] = React.useState(false)
        React.useEffect(() => {
          if (!curSid || !showGraph) return
          let alive = true
          const refreshGraph = () => { fetchRoundtableGraph(viewSid).then((v) => { if (alive && viewRef.current.sid === viewSid && viewRef.current.epoch === viewEpoch) { setGraph({ sid: viewSid, value: v }); setGraphFailed(!v) } }).catch(() => { if (alive) setGraphFailed(true) }) }
          refreshGraph()
          let stop = () => {}
          try { stop = ctx.interval(refreshGraph, 4000) } catch { /* no polling */ }
          return () => { alive = false; if (typeof stop === 'function') stop() }
        }, [curSid, target, showGraph])
        const toggleGraph = () => { setShowGraph((v) => !v); setGraphFailed(false) }
        React.useEffect(() => {
          const ts = group && group.targets ? group.targets.map((t) => t.sid) : []
          setPendingTargets(ts)
        }, [group])
        React.useEffect(() => {
          if (!curSid) return
          setActionPending('')
          setActionError('')
          let alive = true
          const refreshState = () => { fetchState(curSid).then((v) => { if (alive && v) setSt({ sid: curSid, value: v }) }).catch(() => {}) }
          // Group commands create transcript events. Query only when the user
          // opens group management, not on every ordinary role-panel poll.
          const refreshGroup = () => { if (showMembers) exec(curSid, '/supervise _group list').then((v) => { if (alive && v) setGroup(v) }).catch(() => {}) }
          refreshState(); refreshGroup()
          let stop = () => {}
          try { stop = ctx.interval(() => { refreshState(); refreshGroup() }, 3000) } catch { /* no polling */ }
          return () => { alive = false; if (typeof stop === 'function') stop() }
        }, [curSid, showMembers])
        React.useEffect(() => {
          if (!curSid) return
          const models = ctx.get('modelDirectories')
          if (!models || typeof models.directoryFor !== 'function') return
          const directory = models.directoryFor(viewSid)
          if (!directory) return
          let alive = true
          try { directory.load().catch(() => {}) } catch { /* ignore */ }
          const apply = () => { if (alive && directory.store) setDir({ sid: viewSid, value: directory.store.getSnapshot() }) }
          apply()
          let unsub = () => {}
          try { unsub = directory.store ? directory.store.subscribe(apply) : (() => {}) } catch { /* ignore */ }
          return () => { alive = false; unsub() }
        }, [curSid, target])
        const refreshTarget = () => { if (target) fetchState(target).then((v) => { if (v && viewRef.current.sid === target && viewRef.current.epoch === viewEpoch) setTst({ sid: target, epoch: viewEpoch, value: v }) }).catch(() => {}) }
        React.useEffect(() => {
          if (!target) { setTst(null); return }
          let alive = true
          const fetchT = () => { fetchState(target).then((v) => { if (alive && v && viewRef.current.sid === target && viewRef.current.epoch === viewEpoch) setTst({ sid: target, epoch: viewEpoch, value: v }) }).catch(() => {}) }
          fetchT()
          let stop = () => {}
          try { stop = ctx.interval(fetchT, 3000) } catch { /* no polling */ }
          return () => { alive = false; if (typeof stop === 'function') stop() }
        }, [target])
        const cur = st && st.sid === curSid ? st.value : null
        const tv = target ? (tst && tst.sid === target && tst.epoch === viewEpoch ? tst.value : null) : cur
        if (!tv) return React.createElement('div', { role: 'status', 'data-dsh-supervisor-loading': '' }, '正在加载会话状态…', target ? React.createElement('button', { type: 'button', onClick: () => setSel('self') }, '返回本会话') : null)
        const mode = tv.mode || 'off'
        const strategy = tv.strategy || 'plan'
        const autoStatusKnown = tv.automaticContinuation && typeof tv.automaticContinuation.allowed === 'boolean'
        const autoAllowed = !!autoStatusKnown && tv.automaticContinuation.allowed === true
        const autoReason = autoStatusKnown
          ? (typeof tv.automaticContinuation.reason === 'string' && tv.automaticContinuation.reason.trim() ? tv.automaticContinuation.reason : '当前条件不满足，等待用户操作。')
          : '当前服务未提供自动续行状态，无法确认是否会自动发送；请切换到「提意见」或升级服务。'
        const suggestion = tv.suggestion || ''
        const suggestError = tv.suggestError || ''
        const suggesting = !!tv.suggesting
        const faculties = Array.isArray(tv.faculties) ? tv.faculties : []
        const facultySuggestions = (tv.facultySuggestions && typeof tv.facultySuggestions === 'object') ? tv.facultySuggestions : {}
        const roundtableAt = tv.roundtableAt || 0
        const status = tv.status || (mode !== 'off' ? 'silent' : 'off')
        const intervalSec = Math.round((tv.intervalMs || 5000) / 1000)
        const used = tv.used || 0
        const rounds = tv.rounds || 10
        const plan = tv.plan || null
        const applyResult = (value) => { if ((viewRef.current.sid !== viewSid || viewRef.current.epoch !== viewEpoch)) return; if (target) setTst({ sid: viewSid, epoch: viewEpoch, value }); else setSt({ sid: viewSid, value }) }
        const runAction = async (pendingText, action, onSuccess) => {
          if (actionPending) return null
          setActionPending(pendingText)
          setActionError('')
          try {
            const value = await action()
            if (!value) throw new Error('操作没有返回有效结果')
            if (viewRef.current.sid === viewSid && viewRef.current.epoch === viewEpoch && typeof onSuccess === 'function') onSuccess(value)
            return value
          } catch (cause) {
            const message = String((cause && cause.message) || cause || '未知错误')
            if (viewRef.current.sid === viewSid && viewRef.current.epoch === viewEpoch) setActionError(message)
            warn('floating action failed:', pendingText, message)
            return null
          } finally {
            if (viewRef.current.sid === viewSid && viewRef.current.epoch === viewEpoch) setActionPending('')
          }
        }
        // Send only the control the user actually changed. Including the existing
        // mode in unrelated settings would silently re-authorize takeover.
        const patch = (p) => runAction('正在保存设置…', () => patchState(target || curSid, p), applyResult)
        const onAdopt = () => runAction('正在采纳建议…', () => adoptState(target || curSid), applyResult)
        const onRegen = () => runAction('正在生成建议…', () => regenState(target || curSid), applyResult)
        const onBatchRegen = () => {
          if (!curSid) return
          runAction('正在批量刷新…', () => exec(curSid, '/supervise _group regen'), (v) => { setGroup(v); try { ctx.timeout(() => { refreshTarget(); fetchState(curSid).then((r) => { if (r) setSt({ sid: curSid, value: r }) }).catch(() => {}) }, 2500) } catch { /* ignore */ } })
        }
        // 会话矩阵的 overlay root 使用 z-index:120；Supervisor 必须高于它，
        // 否则矩阵打开时浮窗仍在 DOM 中，但视觉上会像“消失”一样。
        const wrapStyle = inline
          ? { position: 'static', width: '100%', maxWidth: 'var(--dsh-composer-card-max-width, 780px)', margin: '0 auto', pointerEvents: 'auto', boxSizing: 'border-box' }
          : { position: 'fixed', right: position ? 'auto' : 'var(--zhitro-session-board-inset-right, 12px)', left: position ? position.left : 'auto', top: position ? position.top : 60, zIndex: 160, pointerEvents: 'auto', boxSizing: 'border-box', transition: dragging ? 'none' : 'box-shadow 120ms ease' }
        const cardStyle = { width: inline ? '100%' : 320, maxWidth: inline ? '100%' : 'calc(100vw - 24px)', maxHeight: inline ? 'min(560px, 60vh)' : 'calc(100vh - 24px)', display: 'flex', flexDirection: 'column', gap: 12, border: dragging && !inline ? '1px solid var(--dsw-alias-brand-primary, #2563eb)' : '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)', borderRadius: 8, padding: 12, boxShadow: inline ? 'none' : '0 2px 8px rgba(0,0,0,.12)', overflow: 'auto', fontSize: 13 }
        const lineStyle = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', display: 'flex', flexDirection: 'column', gap: 2 }
        const planDone = plan && plan.completed >= plan.total
        const planBlock = plan ? React.createElement('div', { style: lineStyle },
          React.createElement('span', null, planDone ? '✅ 计划完成（' + plan.total + ' 项）' : '计划 ' + plan.total + ' 项 · ✅' + plan.completed + ' · ⏳' + plan.inProgress + ' · ○' + plan.pending),
          !planDone && plan.next ? React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, '下一项：' + plan.next) : null,
        ) : null
        const supervisorId = (tv.mentor && tv.mentor.id) || (tv.assignment && tv.assignment.primaryMentorId) || ''
        const supervisorName = (tv.mentor && tv.mentor.name) || 'Supervisor'
        const supervisorModels = tv.supervisorModels && typeof tv.supervisorModels === 'object' ? tv.supervisorModels : {}
        const selectedSupervisorModel = supervisorId && typeof supervisorModels[supervisorId] === 'string' ? supervisorModels[supervisorId] : ''
        const knownModelRoutes = new Set()
        const modelOptions = [React.createElement('option', { key: 'default', value: '' }, '自动（Supervisor 默认 / 主对话）')]
        if (dir && Array.isArray(dir.groups)) {
          for (const g of dir.groups) {
            const options = []
            for (const m of g.models || []) {
              const route = g.id + '/' + m.id
              knownModelRoutes.add(route)
              options.push(React.createElement('option', { key: route, value: route }, m.name))
            }
            if (options.length > 0) modelOptions.push(React.createElement('optgroup', { key: 'provider-' + g.id, label: g.name }, options))
          }
        }
        if (selectedSupervisorModel && !knownModelRoutes.has(selectedSupervisorModel)) {
          modelOptions.push(React.createElement('option', { key: 'saved-route', value: selectedSupervisorModel }, selectedSupervisorModel + '（已保存，当前目录未列出）'))
        }
        const onModel = (value) => {
          if (!supervisorId) return
          const sid = target || curSid
          runAction('正在保存监督模型…', () => patchState(sid, { supervisorModel: { supervisorId, route: value } }), applyResult)
        }
        if (!inline && collapsed) {
          return React.createElement('div', { ref: wrapRef, style: wrapStyle },
            React.createElement('button', { type: 'button', style: { minHeight: 36, display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', borderRadius: 999, padding: '6px 12px', boxShadow: 'var(--dsw-shadow-lv2, 0 4px 16px rgba(0,0,0,0.18))', cursor: 'pointer', fontFamily: 'inherit' }, onClick: () => changeCollapsed(false), title: '展开 Supervisor 浮窗', 'aria-label': '展开 Supervisor 浮窗', 'aria-expanded': false },
              React.createElement('span', { style: { fontWeight: 600 } }, 'Supervisor'),
              React.createElement('span', { style: { color: 'var(--dsw-alias-label-caption, #888)', fontSize: 12 } }, mode === 'takeover' ? '· 接管 ' + used + '/' + rounds : mode === 'advice' ? '· 建议' : '· 关闭'),
              React.createElement('span', { 'aria-hidden': true, style: { fontSize: 11, fontWeight: 700 } }, '展开 ⌄'),
            ),
          )
        }
        const memberRows = []
        if (showMembers) {
          const listState = sessionsSnapshot
          const ids = listState.ids || []
          const byId = listState.byId || {}
          const toggleMember = (id, checked) => { setPendingTargets(checked ? pendingTargets.filter((x) => x !== id) : pendingTargets.concat(id)) }
          const saveGroup = () => { runAction('正在保存托管清单…', () => exec(curSid, '/supervise _group set ' + JSON.stringify(pendingTargets)), (v) => { setGroup(v); setShowMembers(false) }) }
          memberRows.push(React.createElement('div', { key: 'members', style: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflow: 'auto' } },
            ...ids.filter((id) => id !== curSid).map((id) => {
              const info = byId[id] || {}
              const label = info.displayTitle || info.title || String(id).slice(0, 12)
              const checked = pendingTargets.indexOf(id) >= 0
              return React.createElement('label', { key: id, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' } },
                React.createElement('input', { type: 'checkbox', checked: checked, onChange: (ev) => toggleMember(id, checked) }),
                React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
              )
            }),
            React.createElement('button', { type: 'button', key: 'save', style: { minHeight: 32, padding: '4px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid transparent', color: '#fff', background: '#2f9e44', flex: 'none', fontFamily: 'inherit' }, onClick: saveGroup }, '保存托管清单'),
          ))
        }
        const targetOptions = [React.createElement('option', { key: 'self', value: 'self' }, '本会话')]
        if (group && group.targets) for (const t of group.targets) targetOptions.push(React.createElement('option', { key: t.sid, value: t.sid }, '↳ ' + String(t.sid).slice(0, 12)))
        const panel = [
          React.createElement('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8 } },
            inline
              ? React.createElement('span', { 'aria-hidden': true, style: { width: 28, height: 28, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: 15 } }, '◇')
              : React.createElement('span', {
                role: 'button', tabIndex: 0,
                title: '拖动调整位置；双击恢复右上角',
                'aria-label': '拖动 Supervisor 浮窗；双击恢复默认位置',
                'data-dsh-supervisor-drag-handle': '',
                onMouseDown: startDrag,
                onDoubleClick: resetPosition,
                onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); resetPosition() } },
                style: { width: 28, height: 28, flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, color: 'var(--dsw-alias-label-tertiary)', cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none', userSelect: 'none', fontSize: 15, letterSpacing: -2 },
              }, '⠿'),
            React.createElement('span', { style: { fontWeight: 600, fontSize: 14, color: 'var(--dsw-alias-label-primary)' } }, 'Supervisor'),
            React.createElement('span', { title: '当前任务已使用的自动续行次数', style: { color: 'var(--dsw-alias-label-secondary, #777)', fontSize: 12, flex: 'none' } }, '续行 ' + used + '/' + rounds),
            inline ? null : React.createElement('button', { type: 'button', key: 'fold', style: { marginLeft: 'auto', minWidth: 54, height: 28, padding: '0 8px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 7, background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: 11, fontWeight: 600, fontFamily: 'inherit' }, onClick: () => changeCollapsed(true), title: '收起 Supervisor 浮窗', 'aria-label': '收起 Supervisor 浮窗', 'aria-expanded': true }, '收起 ⌃'),
            React.createElement('button', { type: 'button', key: 'hide', style: { marginLeft: inline ? 'auto' : 0, width: 28, height: 28, padding: 0, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 7, background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: 15, fontWeight: 600, fontFamily: 'inherit' }, onClick: props.onHide, title: inline ? '收起 Supervisor 面板' : '隐藏浮窗（右上角保留恢复入口）', 'aria-label': inline ? '收起 Supervisor 面板' : '隐藏 Supervisor 浮窗' }, '×'),
          ),
          React.createElement('div', { key: 'status-row', style: { display: 'flex', alignItems: 'center', gap: 8 } }, statusBadge(status)),
          React.createElement('div', { key: 'progress', 'data-dsh-supervisor-progress': '', style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' } },
            '任务进展：' + ({ advanced: '有推进', unchanged: '未变化', regressed: '出现退步', unknown: '证据不足' }[tv.progress?.state] || '证据不足') + (tv.progress?.streak ? ' · 连续 ' + tv.progress.streak + ' 轮' : ''),
            tv.nativeGoal?.owned ? React.createElement('div', null, '原生 Goal：' + tv.nativeGoal.phase + '，续行由 Goal 管理。') : null,
          ),
          React.createElement(Controls, { key: 'controls', cur: tv, patch, busy: !!actionPending }),
          actionPending ? React.createElement('div', { key: 'action-pending', role: 'status', 'aria-live': 'polite', style: { fontSize: 11, lineHeight: '17px', color: 'var(--dsw-alias-label-secondary)' } }, actionPending) : null,
          actionError ? React.createElement('div', { key: 'action-error', role: 'alert', 'data-dsh-supervisor-action-error': '', style: { fontSize: 11, lineHeight: '17px', color: '#b42318', border: '1px solid rgba(180,35,24,.28)', borderRadius: 7, padding: '6px 8px', background: 'rgba(180,35,24,.06)' } }, '操作失败：' + actionError + '。请稍后重试。') : null,
          planBlock,
          React.createElement('section', { key: 'council', 'data-dsh-supervisor-council': '', 'aria-label': 'GroupX 会诊', style: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1)', fontSize: 12, lineHeight: '18px' } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
              React.createElement('b', { style: { fontSize: 13, fontWeight: 700, color: 'var(--dsw-alias-label-primary)' } }, '会诊'),
              React.createElement('span', { role: 'status', style: { fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: ['running', 'queued'].includes(tv.council?.status) ? 'color-mix(in srgb, #2563eb 14%, transparent)' : tv.council?.status === 'completed' ? 'color-mix(in srgb, #2f9e44 14%, transparent)' : ['failed', 'cancelled', 'timed_out', 'interrupted'].includes(tv.council?.status) ? 'color-mix(in srgb, #b42318 10%, transparent)' : 'var(--dsw-alias-interactive-bg-hover-solid, #e5e5e5)', color: ['running', 'queued'].includes(tv.council?.status) ? '#2563eb' : tv.council?.status === 'completed' ? '#2f9e44' : ['failed', 'cancelled', 'timed_out', 'interrupted'].includes(tv.council?.status) ? '#b42318' : 'var(--dsw-alias-label-secondary)' } }, { queued: '等待启动', running: '讨论中', completed: '建议就绪', unresolved: '未决', failed: '调用失败', cancelled: '已取消', timed_out: '已超时', interrupted: '已中断', unavailable: '服务未加载', 'no-context': '暂无上下文', 'budget-exhausted': '预算已用完' }[tv.council?.status] || (tv.council?.available ? '可用' : '服务未加载')),
            ),
            React.createElement('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 } }, '本任务已预留 ' + (tv.council?.callsReserved || 0) + '/12 次模型调用 · 会诊 ' + (tv.council?.discussionsUsed || 0) + '/2 次'),
            React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              React.createElement('button', { type: 'button', style: { minHeight: 32, padding: '4px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: (!!actionPending || ['queued', 'running'].includes(tv.council?.status) || !tv.council?.available || tv.council?.discussionsUsed >= 2) ? 'not-allowed' : 'pointer', border: '1px solid color-mix(in srgb, #2563eb 48%, transparent)', background: 'color-mix(in srgb, #2563eb 12%, transparent)', color: 'var(--dsw-alias-label-primary, #333)', fontFamily: 'inherit' }, disabled: !!actionPending || ['queued', 'running'].includes(tv.council?.status) || !tv.council?.available || tv.council?.discussionsUsed >= 2, onClick: () => runAction('正在启动会诊…', () => postState('/dsh-supervisor/council', target || curSid, { action: 'start' }), () => refreshTarget()) }, '发起会诊'),
              React.createElement('button', { type: 'button', style: { minHeight: 32, padding: '4px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: (!!actionPending || !['queued', 'running'].includes(tv.council?.status)) ? 'not-allowed' : 'pointer', border: '1px solid var(--dsw-alias-border-l1, #d0d0d0)', background: 'transparent', color: 'var(--dsw-alias-label-primary, #333)', fontFamily: 'inherit' }, disabled: !!actionPending || !['queued', 'running'].includes(tv.council?.status), onClick: () => runAction('正在取消会诊…', () => postState('/dsh-supervisor/council', target || curSid, { action: 'cancel' }), () => refreshTarget()) }, '取消会诊'),
            ),
            React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 } },
              React.createElement('input', { type: 'checkbox', checked: !!tv.council?.autoEnabled, disabled: !!actionPending || !tv.council?.available, onChange: e => runAction('正在更新会诊设置…', () => postState('/dsh-supervisor/council', target || curSid, { action: 'auto', enabled: e.target.checked }), () => refreshTarget()), style: { width: 14, height: 14 } }),
              '本任务停滞 3 轮后自动会诊',
            ),
            React.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: '16px' } }, '会诊仅生成建议。新用户任务、关闭监督或重启后，需要重新开启自动会诊。'),
            tv.council?.receipt?.result ? React.createElement('details', { style: { border: '1px solid var(--dsw-alias-border-l1, #e5e5e5)', borderRadius: 8, overflow: 'hidden' } },
              React.createElement('summary', { style: { padding: '8px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base))', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 4 } }, React.createElement('span', { 'aria-hidden': true, style: { fontSize: 10 } }, '▸'), '会诊结论与成员意见'),
              React.createElement('div', { style: { padding: '8px 10px', fontSize: 12, lineHeight: '18px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-primary)' } }, tv.council.receipt.result.summary),
              ...(tv.council.receipt.result.evidence || []).map((text, i) => React.createElement('p', { key: 'opinion-' + i, style: { margin: '0', padding: '6px 10px', fontSize: 11, lineHeight: '17px', borderTop: '1px solid var(--dsw-alias-border-l1, #e5e5e5)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-secondary)' } }, text)),
              ...(tv.council.receipt.result.dissent || []).map((text, i) => React.createElement('p', { key: 'dissent-' + i, style: { margin: '0', padding: '6px 10px', fontSize: 11, lineHeight: '17px', borderTop: '1px solid var(--dsw-alias-border-l1, #e5e5e5)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: '#b45309', background: 'rgba(180,83,9,.04)' } }, '异议：' + text)),
            ) : null,
          ),
          tv.execution?.recoveryRequired ? React.createElement('div', { key: 'execution-recovery', role: 'alert', style: { padding: 9, border: '1px solid #b45309', borderRadius: 8, fontSize: 12 } }, tv.execution.recoveryRequired, React.createElement('p', null, '确认上次执行结果后再发送新指令；系统不会自动重发旧建议。'), React.createElement('button', { type: 'button', onClick: () => runAction('正在核对接收记录…', () => exec(target || curSid, '/supervise _recover'), () => refreshTarget()) }, '核对恢复状态')) : null,
          React.createElement(ProjectMemoryPanel, { key: 'memory-' + String(target || curSid), sessionId: target || curSid, judgement: tv.memoryContext }),
          React.createElement('div', { key: 'sel', style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
            React.createElement('select', { style: { flex: 1, minHeight: 30, fontSize: 12, borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', padding: '0 6px', fontFamily: 'inherit' }, value: sel || 'self', onChange: (e) => setSel(e.target.value) }, targetOptions),
            React.createElement('button', { type: 'button', style: { minHeight: 30, padding: '4px 10px', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l1, #d0d0d0)', background: 'var(--dsw-alias-interactive-bg-hover-solid, #e0e0e0)', color: 'var(--dsw-alias-label-primary, #333)', flex: 'none', fontFamily: 'inherit' }, onClick: () => setShowMembers(!showMembers) }, showMembers ? '收起' : '管理对话'),
            React.createElement('button', { type: 'button', style: { minHeight: 30, padding: '4px 10px', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l1, #d0d0d0)', background: 'var(--dsw-alias-interactive-bg-hover-solid, #e0e0e0)', color: 'var(--dsw-alias-label-primary, #333)', flex: 'none', fontFamily: 'inherit' }, onClick: onBatchRegen }, '批量刷新'),
            React.createElement('button', { type: 'button', style: { minHeight: 30, padding: '4px 10px', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: showGraph ? '1px solid transparent' : '1px solid var(--dsw-alias-border-l1, #d0d0d0)', background: showGraph ? 'var(--dsw-alias-brand-primary, #2563eb)' : 'var(--dsw-alias-interactive-bg-hover-solid, #e0e0e0)', color: showGraph ? '#fff' : 'var(--dsw-alias-label-primary, #333)', flex: 'none', fontFamily: 'inherit' }, onClick: toggleGraph, 'aria-expanded': showGraph, 'data-dsh-supervisor-graph-toggle': '' }, '圆桌记录'),
          ),
          ...memberRows,
          showGraph ? (graphFailed
            ? React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, '暂无圆桌记录（本会话尚未产生接管圆桌）。')
            : React.createElement(RoundtableGraphView, { graph: graph && graph.sid === viewSid ? graph.value : null })) : null,
          React.createElement('div', { key: 'model', style: { display: 'flex', flexDirection: 'column', gap: 5, padding: '8px 9px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base))' } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              React.createElement('label', { htmlFor: 'dsh-supervisor-model-' + String(target || curSid), style: { fontSize: 12, fontWeight: 700, color: 'var(--dsw-alias-label-primary)', flex: 'none' } }, '监督模型'),
              React.createElement('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, color: 'var(--dsw-alias-label-caption, #888)' }, title: supervisorName }, supervisorName),
            ),
            React.createElement('select', {
              id: 'dsh-supervisor-model-' + String(target || curSid),
              'aria-label': '选择 ' + supervisorName + ' 的监督模型',
              title: '选择独立的监督模型',
              disabled: !supervisorId || !dir || dir.status === 'loading',
              style: { width: '100%', height: 30, fontSize: 12, borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', padding: '0 8px' },
              value: selectedSupervisorModel,
              onChange: (e) => onModel(e.target.value),
            }, modelOptions),
            React.createElement('span', { style: { fontSize: 10, lineHeight: '15px', color: dir && dir.error ? '#dc2626' : 'var(--dsw-alias-label-caption, #888)' } },
              !supervisorId ? '正在分配 Supervisor…'
                : dir && dir.status === 'loading' ? '正在载入可用 Provider 与模型…'
                  : dir && dir.error ? '模型目录载入失败：' + dir.error
                    : selectedSupervisorModel ? '独立模型已启用；仅影响下一轮监督，不改变主对话模型。' : '自动模式优先使用 Supervisor 配置，否则跟随主对话；可改选更强模型。',
            ),
          ),
          React.createElement(SupervisorRolePicker, {
            key: 'role-picker',
            sessionId: target || curSid,
            roleRef: (tv.assignment && tv.assignment.roleRef) || null,
            disabled: !!tv.suggesting || !!actionPending,
            onApplied: () => fetchState(target || curSid).then((v) => { if (v) applyResult(v) }).catch(() => {}),
            onRefresh: () => fetchState(target || curSid).then((v) => { if (v) applyResult(v) }).catch(() => {}),
          }),
        ]
        const settingsStart = panel.findIndex((entry) => (entry?.key ?? entry?.props?.key) === 'memory-' + String(target || curSid))
        if (settingsStart >= 0) {
          const settings = panel.splice(settingsStart)
          panel.push(React.createElement('details', { key: 'session-settings', className: 'dshSupervisorSettings' },
            React.createElement('summary', null, '模型、角色与托管会话'),
            React.createElement('div', { className: 'dshSupervisorSettingsBody' }, settings),
          ))
        }
        if (mode === 'off') {
          panel.push(React.createElement('div', { key: 'off-hint', style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, '关闭：Supervisor 静默。「提意见」显示建议供人工采纳；「接管」需为当前任务授权，且有同任务未完成的原生待办时才可能自动续行。'))
        } else if (mode === 'advice' || (mode === 'takeover' && !autoAllowed)) {
          if (mode === 'takeover') panel.push(React.createElement('div', { key: 'auto-blocked', role: 'status', 'data-dsh-supervisor-auto-blocked': '', style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' } }, autoReason))
          if (suggestError && suggestion) panel.push(React.createElement('div', { key: 'suggest-error', role: 'alert', style: { fontSize: 12, lineHeight: '18px', color: '#b42318' } }, suggestError))
          if (suggesting) panel.push(React.createElement('div', { key: 'busy', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '正在生成建议…'))
          else if (suggestion) panel.push(
            React.createElement('div', { key: 'sugg', style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: '8px 10px', background: 'var(--dsw-specific-tip)' } }, suggestion),
            (faculties.length > 0 && Object.keys(facultySuggestions).length > 0) ? React.createElement('div', { key: 'fac', style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 } },
              React.createElement('div', { style: { fontSize: 10, fontWeight: 700, color: 'var(--dsw-alias-label-secondary)', marginTop: 4 } }, 'Supervisor 圆桌 · 各角色意见'),
              ...faculties.map((f) => {
                const fs = facultySuggestions[f.id]
                if (!fs) return null
                return React.createElement('div', { key: f.id, style: { fontSize: 11, lineHeight: '16px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, padding: '5px 8px', background: 'var(--dsw-alias-bg-layer-1, #fff)' } },
                  React.createElement('span', { style: { fontWeight: 700, color: 'var(--dsw-alias-brand-primary, #155c45)' } }, '◆ ' + (fs.name || f.name) + ' '),
                  fs.ok ? fs.text : React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, '（生成失败：' + (fs.error || '未知') + '）'),
                )
              }),
            ) : null,
            React.createElement('div', { key: 'acts', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              React.createElement('button', { type: 'button', style: { minHeight: 32, padding: '4px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid transparent', color: '#fff', background: '#2563eb', flex: 'none', fontFamily: 'inherit' }, onClick: onAdopt }, '采纳并输入'),
              React.createElement('button', { type: 'button', style: { minHeight: 32, padding: '4px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l1, #d0d0d0)', background: 'var(--dsw-alias-interactive-bg-hover-solid, #e0e0e0)', color: 'var(--dsw-alias-label-primary, #333)', flex: 'none', fontFamily: 'inherit' }, onClick: onRegen }, '重新建议'),
            ),
          )
          else panel.push(
            React.createElement('div', { key: 'empty', style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, suggestError ? ('建议生成失败：' + suggestError) : mode === 'takeover' ? '自动续行暂不可用；可手动生成建议。' : '提意见模式：Supervisor 自动生成建议，你确认后采纳。'),
            React.createElement('div', { key: 'acts2', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              React.createElement('button', { type: 'button', style: { minHeight: 32, padding: '4px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l1, #d0d0d0)', background: 'var(--dsw-alias-interactive-bg-hover-solid, #e0e0e0)', color: 'var(--dsw-alias-label-primary, #333)', flex: 'none', fontFamily: 'inherit' }, onClick: onRegen }, '生成建议'),
            ),
          )
        } else {
          panel.push(React.createElement('div', { key: 'take-hint', style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, '接管：当前任务已授权且存在同任务未完成的原生待办时，可能自动续行（上限 ' + rounds + ' 次）。新任务、关闭接管或重启后需要重新授权；工具和文件权限仍由主对话执行器控制。'))
        }
        return React.createElement('div', { ref: wrapRef, className: 'dshSupervisorPanel', style: wrapStyle, [inline ? 'data-dsh-supervisor-inline' : 'data-dsh-supervisor-floating']: '' },
          React.createElement('style', { key: 'panel-styles' }, PANEL_CSS),
          React.createElement('div', { style: cardStyle }, panel),
        )
      }

      const register = (options, render) => {
        try {
          const disposer = ctx.slots.inject(options.name, () => ctx.slots.register(options, render))
          if (typeof disposer === 'function') ctx.effect(() => () => disposer(), 'dsh-supervisor: slot ' + options.id)
        } catch (cause) { warn('slot registration failed (' + options.id + ')', cause) }
      }
      register({ name: 'conversation.input.dock', id: 'supervisor-controls', order: 15 }, (props) => React.createElement(SupervisorDock, props))
      const SettingsSection = () => {
        return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 20px', maxWidth: 640 } },
          React.createElement('strong', { style: { fontSize: 14, color: 'var(--dsw-alias-label-primary)' } }, 'Supervisor 已并入会话模式栏'),
          React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, '点击输入框下方的 Supervisor 按钮，完整控制面板会在模式栏下方展开，不再遮挡对话。'),
        )
      }
      register({ name: 'settings.section', id: 'supervisor', order: 45, label: 'Supervisor' }, () => React.createElement(SettingsSection))
    }

    exports.apply = apply
    exports.inject = ['slots', 'remote', 'remote.commands', 'timer', 'modelDirectories']
    return module.exports
  },
})
