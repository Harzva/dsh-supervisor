import { App } from '@modelcontextprotocol/ext-apps'

const app = new App({ name: 'Harzva Supervisor', version: '0.3.0' }, {})
const element = id => document.getElementById(id)
let snapshot = null
let ready = false
let busy = false
let needsRefresh = false
let selectedId = null
const states = { proposed: '待授权', authorized: '待执行', dispatching: '正在派发', running: '执行中', verifying: '验收中', succeeded: '已通过', failed: '未通过', uncertain: '待核对', cancelling: '正在取消', cancelled: '已取消', 'needs-user-action': '需要处理' }

function notice(text, error = false) {
  element('notice').textContent = text
  element('notice').classList.toggle('error', error)
}

function render(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.bindings)) throw Error('INVALID_PANEL_RESPONSE')
  snapshot = value
  const binding = value.binding
  selectedId = binding?.id || null
  element('workspace-name').textContent = binding?.label || '尚未选择工程'
  element('workspace-path').textContent = binding?.workspace || '选择要管理的工程后，再使用开关。'
  element('enabled-label').textContent = binding ? (needsRefresh ? '待刷新' : binding.control.enabled ? '已开启' : '已关闭') : '未连接'
  element('enabled').setAttribute('aria-checked', String(Boolean(binding?.control.enabled)))
  element('enabled').dataset.stale = String(needsRefresh)
  element('enabled').disabled = busy || !ready || !binding || needsRefresh
  element('refresh').disabled = busy || !ready || !binding
  element('bind').disabled = busy || !ready
  element('choose').disabled = busy || !ready
  const select = element('workspaces')
  const oldSelection = select.value
  select.replaceChildren(new Option('选择已关联的工程', ''))
  for (const entry of value.bindings) select.append(new Option(entry.label, entry.id))
  select.value = selectedId || oldSelection
  element('existing-workspaces').hidden = value.bindings.length === 0
  element('faculty').textContent = binding?.initialized ? `${binding.mentorCount} 位导师` : '尚未初始化学院'
  const list = element('jobs')
  list.replaceChildren()
  for (const job of binding?.jobs || []) {
    const row = document.createElement('li')
    const name = document.createElement('span')
    const status = document.createElement('span')
    name.textContent = job.id
    status.textContent = states[job.status] || '待查看'
    row.append(name, status)
    list.append(row)
  }
  element('empty').hidden = Boolean(binding?.jobs.length)
  element('empty').textContent = binding ? '当前工程还没有执行任务。' : '选择工程后显示任务状态。'
}

function lock(value) {
  busy = value
  element('panel').setAttribute('aria-busy', String(value))
  if (snapshot) render(snapshot)
}

async function call(name, args) {
  if (!ready || busy) return
  lock(true)
  notice('正在保存…')
  try {
    const result = await app.callServerTool({ name, arguments: args })
    if (result.isError) throw Error(result.structuredContent?.error?.code || 'PANEL_OPERATION_FAILED')
    needsRefresh = false
    render(result.structuredContent)
    notice(name === 'supervisor_set_enabled' ? '开关状态已保存。' : '工程状态已更新。')
  } catch (error) {
    const messages = { STALE_CONTROL: '工程状态已发生变化，请刷新后再操作。', LOCKED: '另一项操作正在保存，请稍后刷新。', BINDING_BUSY: '另一项操作正在关联工程，请稍后重试。', INVALID_WORKSPACE: '请选择现有工程目录的完整路径。', UNSAFE_PATH: '工程路径不能包含符号链接。', UNKNOWN_BINDING: '工程关联已失效，请在当前对话重新选择工程。', THREAD_CONTEXT_REQUIRED: '当前入口没有提供对话信息，请从 Supervisor 对话页重新打开。' }
    if (name === 'supervisor_set_enabled') needsRefresh = true
    notice(messages[error.message] || '操作结果尚未确认，请刷新后查看工程状态。', true)
  } finally {
    lock(false)
  }
}

function bindWorkspace() {
  const workspace = element('workspace-input').value.trim()
  if (!workspace.startsWith('/')) { notice('请输入工程目录的完整路径。', true); return }
  call('supervisor_bind_workspace', { workspace })
}
element('bind').addEventListener('click', bindWorkspace)
element('workspace-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); bindWorkspace() }
})
element('choose').addEventListener('click', () => {
  if (!element('workspaces').value) { notice('请先选择一个工程。', true); return }
  call('supervisor_status', { bindingId: element('workspaces').value })
})
element('refresh').addEventListener('click', () => {
  if (selectedId) call('supervisor_status', { bindingId: selectedId })
})
element('enabled').addEventListener('click', () => {
  const binding = snapshot?.binding
  if (binding) call('supervisor_set_enabled', { bindingId: binding.id, enabled: !binding.control.enabled, expectedRevision: binding.control.revision })
})
app.ontoolresult = result => {
  if (!result.isError && result.structuredContent?.schemaVersion === 1) {
    try { render(result.structuredContent); if (ready && !busy) notice(result.structuredContent.binding ? '已连接 Supervisor。' : '请选择要管理的工程。') } catch { notice('工程状态无法读取，请重新打开面板。', true) }
  }
}
app.onhostcontextchanged = context => applyTheme(context)
function applyTheme(context) {
  document.documentElement.dataset.theme = context?.theme === 'dark' ? 'dark' : 'light'
  for (const [key, value] of Object.entries(context?.styles?.variables || {})) {
    if (/^--(?:color-|font-)[a-z0-9-]+$/.test(key) && typeof value === 'string' && value.length <= 256) document.documentElement.style.setProperty(key, value)
  }
}
try {
  await app.connect()
  ready = Boolean(app.getHostCapabilities()?.serverTools)
  applyTheme(app.getHostContext())
  if (!ready) { if (snapshot) render(snapshot); notice('此宿主暂未提供面板操作能力，当前为只读查看。', true) }
  else if (snapshot) { render(snapshot); notice(snapshot.binding ? '已连接 Supervisor。' : '请选择要管理的工程。') }
  else notice('已连接，正在等待工程状态…')
} catch {
  notice('请从 Codex 的 Supervisor 对话入口打开此面板。', true)
}
