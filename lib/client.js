// dsh-supervisor — browser half（package 0.2.4：模式三档矩阵 + 策略/上限/间隔矩阵框）。
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

    const noneState = { mode: 'off', strategy: 'plan', rounds: 10, used: 0, intervalMs: 5000, mentorModel: '', supervisorModels: {}, mentor: null, assignment: null, suggestion: '', suggestError: '', suggesting: false, status: 'off', plan: null, planTodos: [] }
    const STATUS = {
      off: { label: '未开启', color: '#999999' },
      silent: { label: '监听中', color: '#8a8f98' },
      thinking: { label: '思考中·分析对话', color: '#3b82f6' },
      suggested: { label: '建议就绪', color: '#2f9e44' },
      working: { label: '执行中', color: '#f59e0b' },
    }
    const statusBadge = (status) => {
      const s = STATUS[status] || STATUS.silent
      return React.createElement('span', { key: 'status', style: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: s.color, fontWeight: 600 } },
        React.createElement('span', { style: { width: 8, height: 8, borderRadius: 999, background: s.color, display: 'inline-block' } }),
        s.label,
      )
    }
    const chip = (label, value, selected, color, onPick, disabled) => React.createElement('button', {
      type: 'button',
      key: value,
      disabled: !!disabled,
      onClick: () => onPick(value),
      style: {
        height: 24, padding: '0 10px', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: disabled ? 'wait' : 'pointer', border: 'none', flex: 'none', whiteSpace: 'nowrap', opacity: disabled ? .62 : 1,
        background: selected ? color : 'var(--dsw-alias-interactive-bg-hover-solid, #e5e5e5)',
        color: selected ? '#fff' : 'var(--dsw-alias-label-primary, #333)',
        boxShadow: selected ? 'inset 0 0 0 1px rgba(255,255,255,0.25)' : 'none',
      },
    }, label)
    const chipRow = (label, chips, opts) => React.createElement('div', { key: opts.key, style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
      React.createElement('span', { style: { flex: 'none', color: 'var(--dsw-alias-label-tertiary)', fontWeight: 600 } }, label),
      ...chips,
    )

    const MODE = { off: { label: '关闭', color: '#6b7280' }, advice: { label: '提意见', color: '#2563eb' }, takeover: { label: '接管', color: '#2f9e44' } }
    const STRATEGY = { plan: { label: '计划驱动', color: '#2563eb' }, insight: { label: '理解驱动', color: '#7c3aed' }, fixed: { label: '固定随机', color: '#d97706' } }

    function apply(ctx) {
      const warn = (...args) => { if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('[supervisor]', ...args) }
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

      function Controls(props) {
        const { cur, patch, busy } = props
        const mode = cur.mode || 'off'
        const strategy = cur.strategy || 'plan'
        const rounds = cur.rounds || 10
        const intervalSec = Math.round((cur.intervalMs || 5000) / 1000)
        return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, width: '100%' } },
          chipRow('模式', Object.keys(MODE).map((k) => chip(MODE[k].label, k, mode === k, MODE[k].color, (v) => patch({ mode: v }), busy)), { key: 'mode' }),
          chipRow('策略', Object.keys(STRATEGY).map((k) => chip(STRATEGY[k].label, k, strategy === k, STRATEGY[k].color, (v) => patch({ strategy: v }), busy)), { key: 'strategy' }),
          chipRow('上限', [5, 10, 20, 30, 50].map((n) => chip(String(n), n, rounds === n, '#0e7490', (v) => patch({ rounds: v }), busy)), { key: 'rounds' }),
          chipRow('间隔', [2, 5, 15, 30, 60].map((s) => chip(s + 's', s, intervalSec === s, '#9333ea', (v) => patch({ intervalMs: v * 1000 }), busy)), { key: 'interval' }),
        )
      }

      function SupervisorHeaderAction(props) {
        const sid = props && props.sessionId
        const [st, setSt] = React.useState(null)
        const open = usePanelOpen(sid)
        usePoll(sid, setSt, 3000)
        const cur = st || noneState
        const mode = cur.mode || 'off'
        const status = cur.status || (mode !== 'off' ? 'silent' : 'off')
        const statusText = status === 'off' ? '关闭' : mode === 'takeover' ? '接管 ' + (cur.used || 0) + '/' + (cur.rounds || 10) : mode === 'advice' ? '建议' : (STATUS[status] ? STATUS[status].label : status)
        const dockId = 'dsh-supervisor-dock-' + String(sid || 'current').replace(/[^a-zA-Z0-9_-]/g, '').slice(-24)
        return React.createElement('button', {
          type: 'button', onClick: () => setPanelOpen(sid, !open),
          title: open ? '收起智能接管面板' : '展开智能接管面板',
          'aria-label': open ? '收起智能接管面板' : '展开智能接管面板',
          'aria-expanded': open, 'aria-controls': dockId,
          style: { display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 28, padding: '2px 9px', border: '1px solid var(--dsw-alias-border-l1)', background: mode === 'off' ? 'transparent' : 'var(--dsw-specific-tip)', color: 'var(--dsw-alias-label-primary)', borderRadius: 999, cursor: 'pointer', fontSize: 12, fontWeight: 600, lineHeight: '20px', fontFamily: 'inherit' },
        },
          React.createElement('span', { 'aria-hidden': true, style: { width: 7, height: 7, borderRadius: 999, background: (STATUS[status] || STATUS.silent).color, flex: 'none' } }),
          React.createElement('span', null, '智能接管'),
          React.createElement('span', { style: { color: 'var(--dsw-alias-label-caption, #888)', fontWeight: 500 } }, statusText),
          React.createElement('span', { 'aria-hidden': true, style: { fontSize: 10, opacity: .65 } }, open ? '⌃' : '⌄'),
        )
      }

      function SupervisorDock(props) {
        const sid = props && props.sessionId
        const open = usePanelOpen(sid)
        React.useEffect(() => {
          if (!open || typeof document === 'undefined') return
          const onKeyDown = (event) => { if (event.key === 'Escape') setPanelOpen(sid, false) }
          document.addEventListener('keydown', onKeyDown)
          return () => document.removeEventListener('keydown', onKeyDown)
        }, [open, sid])
        if (!open || !sid) return null
        return React.createElement(MentorFloat, Object.assign({}, props, {
          inline: true,
          sessionId: sid,
          onHide: () => setPanelOpen(sid, false),
        }))
      }

      function MentorFloat(props) {
        const inline = props && props.inline === true
        const sessionsState = props && props.useSessions
        const curSid = (props && props.sessionId) || (typeof sessionsState === 'function' ? sessionsState((s) => s && s.current) : undefined) || null
        const [st, setSt] = React.useState(null)
        const [tst, setTst] = React.useState(null)
        const [group, setGroup] = React.useState(null)
        const [sel, setSel] = React.useState(null)
        const [actionPending, setActionPending] = React.useState('')
        const [actionError, setActionError] = React.useState('')
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
        const [dir, setDir] = React.useState(null)
        React.useEffect(() => {
          const ts = group && group.targets ? group.targets.map((t) => t.sid) : []
          setPendingTargets(ts)
        }, [group])
        React.useEffect(() => {
          if (!curSid) return
          setActionPending('')
          setActionError('')
          let alive = true
          const refreshState = () => { fetchState(curSid).then((v) => { if (alive && v) setSt(v) }).catch(() => {}) }
          const refreshGroup = () => { exec(curSid, '/supervise _group list').then((v) => { if (alive && v) setGroup(v) }).catch(() => {}) }
          refreshState(); refreshGroup()
          let stop = () => {}
          try { stop = ctx.interval(() => { refreshState(); refreshGroup() }, 3000) } catch { /* no polling */ }
          return () => { alive = false; if (typeof stop === 'function') stop() }
        }, [curSid])
        React.useEffect(() => {
          if (!curSid) return
          const models = ctx.get('modelDirectories')
          if (!models || typeof models.directoryFor !== 'function') return
          const directory = models.directoryFor(curSid)
          if (!directory) return
          let alive = true
          try { directory.load().catch(() => {}) } catch { /* ignore */ }
          const apply = () => { if (alive && directory.store) setDir(directory.store.getSnapshot()) }
          apply()
          let unsub = () => {}
          try { unsub = directory.store ? directory.store.subscribe(apply) : (() => {}) } catch { /* ignore */ }
          return () => { alive = false; unsub() }
        }, [curSid])
        const target = sel && sel !== 'self' ? sel : null
        const refreshTarget = () => { if (target) fetchState(target).then((v) => { if (v) setTst(v) }).catch(() => {}) }
        React.useEffect(() => {
          if (!target) { setTst(null); return }
          let alive = true
          const fetchT = () => { fetchState(target).then((v) => { if (alive && v) setTst(v) }).catch(() => {}) }
          fetchT()
          let stop = () => {}
          try { stop = ctx.interval(fetchT, 3000) } catch { /* no polling */ }
          return () => { alive = false; if (typeof stop === 'function') stop() }
        }, [target])
        const cur = st || noneState
        const tv = target ? (tst || cur) : cur
        const mode = tv.mode || 'off'
        const strategy = tv.strategy || 'plan'
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
        const applyResult = (value) => { if (target) setTst(value); else setSt(value) }
        const runAction = async (pendingText, action, onSuccess) => {
          if (actionPending) return null
          setActionPending(pendingText)
          setActionError('')
          try {
            const value = await action()
            if (!value) throw new Error('操作没有返回有效结果')
            if (typeof onSuccess === 'function') onSuccess(value)
            return value
          } catch (cause) {
            const message = String((cause && cause.message) || cause || '未知错误')
            setActionError(message)
            warn('floating action failed:', pendingText, message)
            return null
          } finally {
            setActionPending('')
          }
        }
        const patch = (p) => runAction('正在保存设置…', () => patchState(target || curSid, { mode: tv.mode, strategy: tv.strategy, rounds: tv.rounds, intervalMs: tv.intervalMs, ...p }), applyResult)
        const onAdopt = () => runAction('正在采纳建议…', () => adoptState(target || curSid), applyResult)
        const onRegen = () => runAction('正在生成建议…', () => regenState(target || curSid), applyResult)
        const onBatchRegen = () => {
          if (!curSid) return
          runAction('正在批量刷新…', () => exec(curSid, '/supervise _group regen'), (v) => { setGroup(v); try { ctx.timeout(() => { refreshTarget(); fetchState(curSid).then((r) => { if (r) setSt(r) }).catch(() => {}) }, 2500) } catch { /* ignore */ } })
        }
        // 会话矩阵的 overlay root 使用 z-index:120；Supervisor 必须高于它，
        // 否则矩阵打开时浮窗仍在 DOM 中，但视觉上会像“消失”一样。
        const wrapStyle = inline
          ? { position: 'static', width: '100%', maxWidth: 'var(--dsh-composer-card-max-width, 780px)', margin: '0 auto', pointerEvents: 'auto', boxSizing: 'border-box' }
          : { position: 'fixed', right: position ? 'auto' : 'var(--zhitro-session-board-inset-right, 12px)', left: position ? position.left : 'auto', top: position ? position.top : 60, zIndex: 160, pointerEvents: 'auto', boxSizing: 'border-box', transition: dragging ? 'none' : 'box-shadow 120ms ease' }
        const cardStyle = { width: inline ? '100%' : 300, maxWidth: inline ? '100%' : 'calc(100vw - 24px)', maxHeight: inline ? 'min(520px, 52vh)' : 'calc(100vh - 24px)', display: 'flex', flexDirection: 'column', gap: 10, border: dragging && !inline ? '1px solid var(--dsw-alias-brand-primary, #2563eb)' : '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)', borderRadius: 12, padding: '10px 12px', boxShadow: inline ? '0 8px 24px color-mix(in srgb,#111 10%,transparent)' : dragging ? 'var(--dsw-shadow-lv3, 0 10px 30px rgba(0,0,0,0.24))' : 'var(--dsw-shadow-lv2, 0 4px 16px rgba(0,0,0,0.18))', overflow: 'auto', fontSize: 13 }
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
        if (showMembers && typeof sessionsState === 'function') {
          const listState = sessionsState((s) => s) || {}
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
            React.createElement('button', { type: 'button', key: 'save', style: { height: 24, padding: '0 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer', border: 'none', color: '#fff', background: '#2f9e44', flex: 'none' }, onClick: saveGroup }, '保存托管清单'),
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
            React.createElement('span', { style: { fontWeight: 600, fontSize: 14, color: 'var(--dsw-alias-label-primary)' } }, 'Supervisor · ' + (curSid ? String(curSid).slice(0, 12) : '…')),
            React.createElement('span', { style: { color: 'var(--dsw-alias-label-caption, #888)', fontSize: 11, flex: 'none' } }, '已用 ' + used + '/' + rounds),
            inline ? null : React.createElement('button', { type: 'button', key: 'fold', style: { marginLeft: 'auto', minWidth: 54, height: 28, padding: '0 8px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 7, background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: 11, fontWeight: 600, fontFamily: 'inherit' }, onClick: () => changeCollapsed(true), title: '收起 Supervisor 浮窗', 'aria-label': '收起 Supervisor 浮窗', 'aria-expanded': true }, '收起 ⌃'),
            React.createElement('button', { type: 'button', key: 'hide', style: { marginLeft: inline ? 'auto' : 0, width: 28, height: 28, padding: 0, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 7, background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: 15, fontWeight: 600, fontFamily: 'inherit' }, onClick: props.onHide, title: inline ? '收起 Supervisor 面板' : '隐藏浮窗（右上角保留恢复入口）', 'aria-label': inline ? '收起 Supervisor 面板' : '隐藏 Supervisor 浮窗' }, '×'),
          ),
          React.createElement('div', { key: 'status-row', style: { display: 'flex', alignItems: 'center', gap: 8 } }, statusBadge(status)),
          React.createElement(Controls, { key: 'controls', cur: tv, patch, busy: !!actionPending }),
          actionPending ? React.createElement('div', { key: 'action-pending', role: 'status', 'aria-live': 'polite', style: { fontSize: 11, lineHeight: '17px', color: 'var(--dsw-alias-label-secondary)' } }, actionPending) : null,
          actionError ? React.createElement('div', { key: 'action-error', role: 'alert', 'data-dsh-supervisor-action-error': '', style: { fontSize: 11, lineHeight: '17px', color: '#b42318', border: '1px solid rgba(180,35,24,.28)', borderRadius: 7, padding: '6px 8px', background: 'rgba(180,35,24,.06)' } }, '操作失败：' + actionError + '。请稍后重试。') : null,
          planBlock,
          React.createElement('div', { key: 'sel', style: { display: 'flex', gap: 8, alignItems: 'center' } },
            React.createElement('select', { style: { flex: 1, height: 24, fontSize: 12, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', padding: '0 6px' }, value: sel || 'self', onChange: (e) => setSel(e.target.value) }, targetOptions),
            React.createElement('button', { type: 'button', style: { height: 24, padding: '0 8px', borderRadius: 999, fontSize: 11, cursor: 'pointer', border: 'none', background: 'var(--dsw-alias-interactive-bg-hover-solid, #e0e0e0)', color: 'var(--dsw-alias-label-primary, #333)', flex: 'none' }, onClick: () => setShowMembers(!showMembers) }, showMembers ? '收起' : '管理对话'),
            React.createElement('button', { type: 'button', style: { height: 24, padding: '0 8px', borderRadius: 999, fontSize: 11, cursor: 'pointer', border: 'none', background: 'var(--dsw-alias-interactive-bg-hover-solid, #e0e0e0)', color: 'var(--dsw-alias-label-primary, #333)', flex: 'none' }, onClick: onBatchRegen }, '批量刷新'),
          ),
          ...memberRows,
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
        ]
        if (mode === 'off') {
          panel.push(React.createElement('div', { key: 'off-hint', style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, '关闭：Supervisor 静默。选择「提意见」：只展示建议人工采纳；「接管」：自动生成并输入，主对话执行。'))
        } else if (mode === 'advice') {
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
            React.createElement('div', { key: 'acts', style: { display: 'flex', gap: 8 } },
              React.createElement('button', { type: 'button', style: { height: 24, padding: '0 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer', border: 'none', color: '#fff', background: '#2563eb', flex: 'none' }, onClick: onAdopt }, '采纳并输入'),
              React.createElement('button', { type: 'button', style: { height: 24, padding: '0 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer', border: 'none', background: 'var(--dsw-alias-interactive-bg-hover-solid, #e0e0e0)', color: 'var(--dsw-alias-label-primary, #333)', flex: 'none' }, onClick: onRegen }, '重新建议'),
            ),
          )
          else panel.push(
            React.createElement('div', { key: 'empty', style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, suggestError ? ('建议生成失败：' + suggestError) : '提意见模式：Supervisor 自动生成建议，你确认后采纳。'),
            React.createElement('div', { key: 'acts2', style: { display: 'flex', gap: 8 } },
              React.createElement('button', { type: 'button', style: { height: 24, padding: '0 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer', border: 'none', background: 'var(--dsw-alias-interactive-bg-hover-solid, #e0e0e0)', color: 'var(--dsw-alias-label-primary, #333)', flex: 'none' }, onClick: onRegen }, '生成建议'),
            ),
          )
        } else {
          panel.push(React.createElement('div', { key: 'take-hint', style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, '接管：自动生成建议并输入，注入内容要求主对话先陈述下一步再执行（上限 ' + rounds + ' 次；计划完成或上限用完即停）。'))
        }
        return React.createElement('div', { ref: wrapRef, style: wrapStyle, [inline ? 'data-dsh-supervisor-inline' : 'data-dsh-supervisor-floating']: '' },
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
