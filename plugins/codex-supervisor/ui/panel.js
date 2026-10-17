import { App } from '@modelcontextprotocol/ext-apps'

const app = new App({ name: 'Harzva Supervisor', version: '0.4.0' }, {})
const element = id => document.getElementById(id)
let snapshot = null
let ready = false
let busy = false
let switchNeedsRefresh = false
let settingsNeedsRefresh = false
let settingsDirty = false
let catalogError = false
let selectedId = null
const states = { proposed: '待授权', authorized: '待执行', dispatching: '正在派发', running: '执行中', verifying: '验收中', succeeded: '已通过', failed: '未通过', uncertain: '待核对', cancelling: '正在取消', cancelled: '已取消', 'needs-user-action': '需要处理' }
const effortLabels = { none: 'none · 无', minimal: 'minimal · 最低', low: 'low · 较低', medium: 'medium · 平衡', high: 'high · 深入', xhigh: 'xhigh · 更深', max: 'max · 最大', ultra: 'ultra · 极高' }

function notice(text, error = false) {
  element('notice').textContent = text
  element('notice').classList.toggle('error', error)
}

function modelValue(entry) {
  return entry?.model || entry?.id || ''
}

function findModel(catalog, value) {
  return catalog?.models?.find(entry => entry && (entry.model === value || entry.id === value)) || null
}

function modelLabel(catalog, value) {
  const entry = findModel(catalog, value)
  return entry?.displayName || entry?.model || entry?.id || value || '未指定'
}

function effortLabel(value) {
  return effortLabels[value] || value || '未指定'
}

function settingSummary(binding) {
  const settings = binding?.executionSettings
  if (!settings?.configured) return '尚未保存执行设置。'
  if (settings.mode === 'custom') {
    const model = modelLabel(binding.catalog, settings.model)
    return `已保存：${model}${settings.reasoningEffort ? ` · ${effortLabel(settings.reasoningEffort)}` : ''}`
  }
  return '已保存：Codex 默认执行模型'
}

function populateModels(catalog, selected) {
  const select = element('execution-model')
  const current = selected || select.value
  select.replaceChildren(new Option('选择模型', ''))
  for (const entry of catalog?.models || []) {
    const value = modelValue(entry)
    if (!value) continue
    select.append(new Option(entry.displayName || entry.model || entry.id || value, value))
  }
  const entry = findModel(catalog, current)
  select.value = entry ? modelValue(entry) : ''
  return entry
}

function populateReasoningEfforts(entry, selected = '') {
  const select = element('reasoning-effort')
  const current = selected || select.value
  select.replaceChildren(new Option('选择推理强度', ''))
  for (const effort of entry?.supportedReasoningEfforts || []) {
    if (!effort?.reasoningEffort) continue
    const option = new Option(effortLabel(effort.reasoningEffort), effort.reasoningEffort)
    if (effort.description) option.title = effort.description
    select.append(option)
  }
  const supported = (entry?.supportedReasoningEfforts || []).some(effort => effort?.reasoningEffort === current)
  const fallback = entry?.defaultReasoningEffort && (entry.supportedReasoningEfforts || []).some(effort => effort?.reasoningEffort === entry.defaultReasoningEffort)
  select.value = supported ? current : fallback ? entry.defaultReasoningEffort : ''
}

function draftIsValid(binding) {
  const catalog = binding?.catalog
  if (!catalog || !Array.isArray(catalog.models)) return false
  const mode = element('execution-mode').value
  if (mode === 'default') return true
  const model = findModel(catalog, element('execution-model').value)
  const effort = element('reasoning-effort').value
  return Boolean(model && effort && (model.supportedReasoningEfforts || []).some(item => item?.reasoningEffort === effort))
}

function updateSettingsState(binding) {
  const state = element('settings-state')
  state.classList.toggle('stale-note', settingsNeedsRefresh)
  if (settingsNeedsRefresh) state.textContent = '执行设置已过期，请刷新工程状态后重试。'
  else if (!binding?.catalog || !Array.isArray(binding.catalog.models)) state.textContent = '尚未读取模型目录。'
  else if (settingsDirty) state.textContent = '有未保存的执行设置。'
  else state.textContent = settingSummary(binding)
  const settings = binding?.executionSettings
  const needsInitialSave = Boolean(binding && settings?.configured !== true)
  element('save-execution').disabled = busy || !ready || !binding || settingsNeedsRefresh || !draftIsValid(binding) || (!settingsDirty && !needsInitialSave)
}

function renderModelSettings(binding) {
  const catalog = binding?.catalog
  const hasCatalog = Boolean(catalog && Array.isArray(catalog.models))
  const mode = element('execution-mode')
  const model = element('execution-model')
  const effort = element('reasoning-effort')
  const settings = binding?.executionSettings || { mode: 'default', model: null, reasoningEffort: null }
  element('model-limitation').hidden = !binding || binding.conversationModelAvailable !== false
  element('saved-settings').hidden = !binding || hasCatalog
  element('saved-settings').textContent = binding ? settingSummary(binding).replace(/^已保存：/, '当前设置：') : ''
  element('model-settings').hidden = !binding || !hasCatalog
  element('load-models').disabled = busy || !ready || !binding
  if (!hasCatalog) {
    element('catalog-state').textContent = catalogError ? '模型目录读取失败，请重试。' : '尚未读取模型目录，读取后才能保存设置。'
    mode.disabled = true
    model.disabled = true
    effort.disabled = true
    updateSettingsState(binding)
    return
  }
  element('catalog-state').textContent = catalog.models.length ? `已读取 ${catalog.models.length} 个可用模型。` : '模型目录已读取，但当前没有可用模型。'
  mode.disabled = busy || !ready
  const savedMode = settingsDirty ? mode.value : settings.mode === 'custom' ? 'custom' : 'default'
  mode.value = savedMode
  const selectedModel = settingsDirty ? model.value : settings.model
  const modelEntry = populateModels(catalog, selectedModel)
  const selectedEffort = settingsDirty ? effort.value : settings.reasoningEffort
  populateReasoningEfforts(modelEntry, selectedEffort)
  const custom = mode.value === 'custom'
  element('custom-model-settings').hidden = !custom
  model.disabled = busy || !ready || !custom
  effort.disabled = busy || !ready || !custom || !modelEntry
  updateSettingsState(binding)
}

function jobModelText(job, binding) {
  if (job.actualModel) return `实际模型：${modelLabel(binding?.catalog, job.actualModel)}${job.actualReasoningEffort ? ` · ${effortLabel(job.actualReasoningEffort)}` : ''}`
  if (job.requestedModel) return `请求模型：${modelLabel(binding?.catalog, job.requestedModel)}${job.requestedReasoningEffort ? ` · ${effortLabel(job.requestedReasoningEffort)}` : ''}`
  return '实际模型：尚未确定'
}

function render(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.bindings)) throw Error('INVALID_PANEL_RESPONSE')
  const binding = value.binding
  if ((binding?.id || null) !== selectedId) settingsDirty = false
  snapshot = value
  selectedId = binding?.id || null
  element('workspace-name').textContent = binding?.label || '尚未选择工程'
  element('workspace-path').textContent = binding?.workspace || '选择要管理的工程后，再使用开关。'
  const control = binding?.control
  element('enabled-label').textContent = binding ? (switchNeedsRefresh ? '待刷新' : control?.enabled ? '已开启' : '已关闭') : '未连接'
  element('enabled').setAttribute('aria-checked', String(Boolean(control?.enabled)))
  element('enabled').dataset.stale = String(switchNeedsRefresh)
  element('enabled').disabled = busy || !ready || !binding || switchNeedsRefresh
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
  renderModelSettings(binding)
  const list = element('jobs')
  list.replaceChildren()
  for (const job of binding?.jobs || []) {
    const row = document.createElement('li')
    const copy = document.createElement('div')
    copy.className = 'job-copy'
    const name = document.createElement('span')
    name.className = 'job-id'
    name.textContent = job.id
    const meta = document.createElement('span')
    meta.className = 'job-meta muted'
    meta.textContent = jobModelText(job, binding)
    copy.append(name, meta)
    const status = document.createElement('span')
    status.className = 'job-status'
    status.textContent = states[job.status] || '待查看'
    row.append(copy, status)
    list.append(row)
  }
  element('empty').hidden = Boolean(binding?.jobs.length)
  element('empty').textContent = binding ? '当前工程还没有执行任务。' : '选择工程后显示任务状态。'
  element('stop').disabled = busy || !ready || !binding
}

function lock(value) {
  busy = value
  element('panel').setAttribute('aria-busy', String(value))
  if (snapshot) render(snapshot)
}

function stopNotice(value) {
  const jobs = value?.binding?.jobs || []
  if (jobs.some(job => job.status === 'uncertain')) return '停止请求已发送；有任务待核对，请刷新确认。'
  if (jobs.some(job => job.status === 'cancelling')) return '停止请求已发送；仍有任务正在取消，请刷新确认。'
  return '停止请求已发送，请刷新确认结果。'
}

async function call(name, args) {
  if (!ready || busy) return false
  lock(true)
  notice(name === 'supervisor_models' ? '正在读取模型目录…' : name === 'supervisor_stop' ? '正在请求停止…' : name === 'supervisor_set_execution' ? '正在保存执行设置…' : '正在保存…')
  try {
    const result = await app.callServerTool({ name, arguments: args })
    if (result.isError) throw Error(result.structuredContent?.error?.code || 'PANEL_OPERATION_FAILED')
    if (!result.structuredContent || result.structuredContent.schemaVersion !== 1) throw Error('INVALID_PANEL_RESPONSE')
    if (name === 'supervisor_set_enabled' || name === 'supervisor_status' || name === 'supervisor_bind_workspace') switchNeedsRefresh = false
    if (name === 'supervisor_set_execution' || name === 'supervisor_status' || name === 'supervisor_bind_workspace') settingsNeedsRefresh = false
    if (name === 'supervisor_models' || name === 'supervisor_status' || name === 'supervisor_bind_workspace') catalogError = false
    if (name === 'supervisor_status' || name === 'supervisor_bind_workspace') settingsDirty = false
    if (name === 'supervisor_set_execution') settingsDirty = false
    render(result.structuredContent)
    if (name === 'supervisor_set_enabled') notice('开关状态已保存。')
    else if (name === 'supervisor_models') notice('模型目录已更新。')
    else if (name === 'supervisor_set_execution') notice('执行设置已保存。')
    else if (name === 'supervisor_stop') notice(stopNotice(result.structuredContent))
    else notice(result.structuredContent.binding ? '工程状态已更新。' : '请选择要管理的工程。')
    return true
  } catch (error) {
    const messages = {
      STALE_CONTROL: '工程开关状态已发生变化，请刷新后再操作。',
      STALE_SETTINGS: '执行设置已发生变化，请刷新工程状态后重试。',
      MODEL_UNAVAILABLE: '所选模型已不可用，请重新读取模型目录。',
      REASONING_UNAVAILABLE: '所选模型不支持此推理强度，请重新选择。',
      MODEL_CATALOG_UNAVAILABLE: '模型目录暂时不可用，请重试。',
      LOCKED: '另一项操作正在保存，请稍后刷新。',
      BINDING_BUSY: '另一项操作正在关联工程，请稍后重试。',
      INVALID_WORKSPACE: '请选择现有工程目录的完整路径。',
      UNSAFE_PATH: '工程路径不能包含符号链接。',
      UNKNOWN_BINDING: '工程关联已失效，请在当前对话重新选择工程。',
      THREAD_CONTEXT_REQUIRED: '当前入口没有提供对话信息，请从 Supervisor 对话页重新打开。',
    }
    if (name === 'supervisor_set_enabled' || error.message === 'STALE_CONTROL') switchNeedsRefresh = true
    if (name === 'supervisor_set_execution' && error.message === 'STALE_SETTINGS') settingsNeedsRefresh = true
    if (name === 'supervisor_models' && error.message === 'MODEL_CATALOG_UNAVAILABLE') catalogError = true
    if (snapshot) render(snapshot)
    notice(messages[error.message] || '操作结果尚未确认，请刷新后查看工程状态。', true)
    return false
  } finally {
    lock(false)
  }
}

function bindWorkspace() {
  const workspace = element('workspace-input').value.trim()
  if (!workspace.startsWith('/')) { notice('请输入工程目录的完整路径。', true); return }
  call('supervisor_bind_workspace', { workspace })
}

function readModels() {
  if (selectedId) call('supervisor_models', { bindingId: selectedId })
}

function saveExecution() {
  const binding = snapshot?.binding
  if (!binding?.catalog || settingsNeedsRefresh || !draftIsValid(binding)) return
  const mode = element('execution-mode').value === 'custom' ? 'custom' : 'default'
  call('supervisor_set_execution', {
    bindingId: binding.id,
    mode,
    model: mode === 'custom' ? element('execution-model').value || null : null,
    reasoningEffort: mode === 'custom' ? element('reasoning-effort').value || null : null,
    expectedRevision: Number.isSafeInteger(binding.executionSettings?.revision) ? binding.executionSettings.revision : 0,
  })
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
element('load-models').addEventListener('click', readModels)
element('execution-mode').addEventListener('change', () => {
  settingsDirty = true
  renderModelSettings(snapshot?.binding)
})
element('execution-model').addEventListener('change', () => {
  settingsDirty = true
  const entry = findModel(snapshot?.binding?.catalog, element('execution-model').value)
  populateReasoningEfforts(entry, '')
  renderModelSettings(snapshot?.binding)
})
element('reasoning-effort').addEventListener('change', () => {
  settingsDirty = true
  updateSettingsState(snapshot?.binding)
})
element('save-execution').addEventListener('click', saveExecution)
element('stop').addEventListener('click', () => {
  const binding = snapshot?.binding
  if (binding) call('supervisor_stop', { bindingId: binding.id })
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
