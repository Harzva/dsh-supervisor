// Canonical role and assignment source recovered from the 0.2.4 runtime.
import { normalizeRoleRef, roleRefKey } from '@harzva/dsh-role-registry'

const DEFAULT_PALETTE = Object.freeze([
  '#2563eb', '#7c3aed', '#0f766e', '#b45309', '#be185d',
  '#0369a1', '#4d7c0f', '#9f1239', '#5b21b6', '#0e7490',
])

const ROLE_META = Object.freeze({
  architecture: { label: '架构 Supervisor', avatar: 'compass' },
  research: { label: '研究 Supervisor', avatar: 'scope' },
  execution: { label: '执行 Supervisor', avatar: 'bolt' },
  verification: { label: '评估验收 Supervisor', avatar: 'shield' },
  handoff: { label: '交接 Supervisor', avatar: 'bridge' },
  critic: { label: '批评家 Supervisor', avatar: 'cross' },
})

const DEFAULT_MENTORS = Object.freeze([
  { id: 'atlas', name: 'Atlas', role: 'architecture', color: '#2563eb', tags: ['架构', '设计', '重构', '迁移'], description: '模块边界、接口、架构与迁移决策' },
  { id: 'scout', name: 'Scout', role: 'research', color: '#0f766e', tags: ['研究', '调研', '资料', '论文'], description: '资料研究、假设验证与证据质量' },
  { id: 'forge', name: 'Forge', role: 'execution', color: '#b45309', tags: ['开发', '实现', '执行', '发布'], description: '计划推进、实现与任务闭环' },
  { id: 'verity', name: 'Verity', role: 'verification', color: '#be185d', tags: ['测试', '验证', '安全', '验收'], description: '测试、安全、质量与验收' },
  { id: 'relay', name: 'Relay', role: 'handoff', color: '#7c3aed', tags: ['handoff', '交接', '压缩'], description: '上下文健康、交接与连续性' },
])

const DEFAULT_PERMISSIONS = Object.freeze({
  advise: true,
  takeover: true,
  relay: true,
  requestHandoff: true,
  createSession: true,
})

const ROLE_TAGS = Object.freeze({
  architecture: ['架构', '设计', '重构', '迁移', '策略'],
  research: ['研究', '调研', '资料', '论文', '事实'],
  execution: ['开发', '实现', '执行', '代码', '调试', '发布'],
  verification: ['测试', '验证', '安全', '验收', '质量'],
  handoff: ['handoff', '交接', '压缩', '上下文'],
  critic: ['批评', '风险', '反方', '质疑', '漏洞'],
})

function cleanString(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function cleanList(value, maxItems = 40, maxLength = 120) {
  if (!Array.isArray(value)) return []
  const result = []
  const seen = new Set()
  for (const item of value) {
    const clean = cleanString(item, maxLength)
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    result.push(clean)
    if (result.length >= maxItems) break
  }
  return result
}

function validColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value)
}

function hashText(value) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function normalizePermissions(value) {
  const source = value && typeof value === 'object' ? value : {}
  const result = {}
  for (const key of Object.keys(DEFAULT_PERMISSIONS)) {
    result[key] = typeof source[key] === 'boolean' ? source[key] : DEFAULT_PERMISSIONS[key]
  }
  return result
}

function normalizeOne(item, index) {
  if (!item || typeof item !== 'object') return null
  const id = cleanString(item.id, 64)
  if (!id || !/^[a-z0-9][a-z0-9_-]*$/i.test(id)) return null
  const role = Object.hasOwn(ROLE_META, item.role) ? item.role : 'execution'
  const responsibilities = item.responsibilities && typeof item.responsibilities === 'object'
    ? item.responsibilities
    : {}
  const color = cleanString(item.color, 16)
  return {
    id,
    name: cleanString(item.name, 80) || id,
    role,
    roleLabel: ROLE_META[role].label,
    responsibilities: {
      tags: cleanList(responsibilities.tags || item.tags),
      workspacePatterns: cleanList(responsibilities.workspacePatterns),
      presets: cleanList(responsibilities.presets),
      description: cleanString(responsibilities.description || item.description, 300) || ROLE_META[role].label,
    },
    route: cleanString(item.route, 200),
    color: validColor(color) ? color.toLowerCase() : DEFAULT_PALETTE[index % DEFAULT_PALETTE.length],
    avatar: cleanString(item.avatar, 40) || ROLE_META[role].avatar,
    permissions: normalizePermissions(item.permissions),
  }
}

export function normalizeMentors(value, faculties = []) {
  let source = Array.isArray(value) && value.length > 0 ? value : null
  if (source === null && Array.isArray(faculties) && faculties.length > 0) {
    source = faculties.map((faculty) => {
      const nameIdentity = [faculty.id, faculty.name].filter(Boolean).join(' ').toLocaleLowerCase()
      const promptIdentity = cleanString(faculty.prompt, 1000).toLocaleLowerCase()
      // 学院显式名称比长提示词中的交叉职责更权威。例如“代码学院”的
      // 提示词可以包含“质量/验证”，但其主角色仍应是执行导师。
      const identity = nameIdentity + ' ' + promptIdentity
      const role = /handoff|交接|压缩|上下文/.test(nameIdentity) ? 'handoff'
        : /code|工程|代码|开发|实现|调试/.test(nameIdentity) ? 'execution'
          : /research|研究|调研|事实|资料|论文/.test(nameIdentity) ? 'research'
            : /critic|批评|质疑|挑刺|反方|风险|漏洞/.test(nameIdentity) ? 'critic'
              : /verify|verify|评估|验收|安全|质量|达标/.test(nameIdentity) ? 'verification'
                : /test|verify|验证|测试|安全|质量|验收/.test(nameIdentity) ? 'verification'
                  : /handoff|交接|压缩|上下文/.test(identity) ? 'handoff'
                    : /code|工程|代码|开发|实现|调试/.test(identity) ? 'execution'
                      : /research|研究|调研|事实|资料|论文/.test(identity) ? 'research'
                        : /critic|批评|质疑|挑刺|反方|风险|漏洞/.test(identity) ? 'critic'
                          : /verify|评估|验收|安全|质量|达标/.test(identity) ? 'verification'
                            : /test|verify|验证|测试|安全|质量|验收/.test(identity) ? 'verification'
                              : 'architecture'
      return {
        ...faculty,
        role,
        responsibilities: { tags: ROLE_TAGS[role], description: faculty.prompt || '领域建议' },
      }
    })
  }
  if (source === null) source = DEFAULT_MENTORS
  const mentors = []
  const seen = new Set()
  for (let i = 0; i < source.length; i += 1) {
    const mentor = normalizeOne(source[i], i)
    if (!mentor || seen.has(mentor.id)) continue
    seen.add(mentor.id)
    mentors.push(mentor)
  }
  return mentors
}

function wildcardMatch(value, pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp('^' + escaped + '$', 'i').test(value)
}

// Safe RoleRef normalizer: returns a frozen { id, version } or undefined when
// the input is absent or does not satisfy the neutral role-protocol contract.
// This mirrors @harzva/dsh-role-registry#normalizeRoleRef but never throws,
// so a corrupt or stale persisted roleRef degrades to "no role" (fail-closed)
// instead of crashing the supervisor.
export function normalizeRoleRefLike(value) {
  if (value === undefined || value === null) return undefined
  try {
    return normalizeRoleRef(value)
  } catch {
    return undefined
  }
}

// Shared RoleRef key (id@version), or '' when the input is not a valid ref.
export function roleRefKeyOf(value) {
  const ref = normalizeRoleRefLike(value)
  return ref ? roleRefKey(ref) : ''
}

// Tri-state classification of an optional persisted RoleRef. This is the
// fail-closed source of truth for issue-6: we must NOT silently drop a present
// but invalid (corrupt) ref and fall back to a mentor. The three states:
//   { present:false }            -> user never selected / explicitly cleared  => default mentor path
//   { present:true, valid:true } -> a well-formed RoleRef                       => resolve via registry
//   { present:true, valid:false} -> a CORRUPT saved ref (bad shape)             => fail closed with error
export function classifyRoleRef(value) {
  if (value === undefined || value === null) return { present: false, valid: false, ref: undefined }
  try {
    return { present: true, valid: true, ref: normalizeRoleRef(value) }
  } catch {
    return { present: true, valid: false, ref: undefined }
  }
}

function scoreMentor(mentor, facts) {
  let score = 0
  const tags = Array.isArray(facts.tags) ? facts.tags.map((tag) => String(tag).toLocaleLowerCase()) : []
  for (const tag of mentor.responsibilities.tags) {
    const wanted = tag.toLocaleLowerCase()
    if (tags.some((candidate) => candidate === wanted || candidate.includes(wanted))) score += 10
  }
  const cwd = cleanString(facts.cwd, 1000)
  for (const pattern of mentor.responsibilities.workspacePatterns) {
    if (cwd && wildcardMatch(cwd, pattern)) score += 7
  }
  const preset = cleanString(facts.agentPreset, 200).toLocaleLowerCase()
  for (const candidate of mentor.responsibilities.presets) {
    if (preset && preset === candidate.toLocaleLowerCase()) score += 8
  }
  return score
}

export function resolveAssignment(facts, mentors, existing, loadByMentor = {}) {
  const byId = new Map(mentors.map((mentor) => [mentor.id, mentor]))
  if (existing && byId.has(existing.primaryMentorId)) {
    const { roleRef: existingRoleRef, ...defaults } = existing
    const classified = classifyRoleRef(existingRoleRef)
    return {
      ...defaults,
      collaboratorIds: cleanList(existing.collaboratorIds, 2, 64).filter((id) => id !== existing.primaryMentorId && byId.has(id)),
      ...(classified.valid ? { roleRef: classified.ref } : {}),
      // Present-but-invalid saved ref: preserve the corruption marker so the
      // consumer FAILS CLOSED instead of silently re-roling to a mentor.
      ...(classified.present && !classified.valid ? { roleRefCorrupt: true } : {}),
    }
  }
  if (mentors.length === 0) return null
  const ranked = mentors.map((mentor) => ({
    mentor,
    score: scoreMentor(mentor, facts || {}),
    load: Number.isFinite(loadByMentor[mentor.id]) ? loadByMentor[mentor.id] : 0,
  })).sort((left, right) => {
    return right.score - left.score
      || left.load - right.load
      || hashText(String(facts?.sessionId || '') + ':' + left.mentor.id) - hashText(String(facts?.sessionId || '') + ':' + right.mentor.id)
  })
  const selected = ranked[0]
  // Reassigning an unavailable mentor changes the execution route, not the
  // user's expert selection. Preserve exact refs and corruption markers so
  // their normal resolution path can fail closed if the role disappeared.
  const roleSelection = {}
  if (existing && typeof existing === 'object') {
    const classified = classifyRoleRef(existing.roleRef)
    if (classified.valid) roleSelection.roleRef = classified.ref
    if ((classified.present && !classified.valid) || existing.roleRefCorrupt) roleSelection.roleRefCorrupt = true
    for (const key of ['roleRefSource', 'defaultRoleRef', 'defaultRoleSource']) {
      if (Object.hasOwn(existing, key)) roleSelection[key] = existing[key]
    }
  }
  return {
    sessionId: cleanString(facts?.sessionId, 128),
    primaryMentorId: selected.mentor.id,
    collaboratorIds: [],
    assignmentSource: selected.score > 0 ? 'rule' : 'fallback',
    reason: selected.score > 0 ? '责任范围匹配' : '稳定负载分配',
    assignedAt: Date.now(),
    version: Number.isSafeInteger(existing?.version) && existing.version > 0 && existing.version < Number.MAX_SAFE_INTEGER
      ? existing.version + 1 : 1,
    ...roleSelection,
  }
}

export function publicMentor(mentor) {
  if (!mentor) return null
  return {
    id: mentor.id,
    name: mentor.name,
    role: mentor.role,
    roleLabel: mentor.roleLabel,
    responsibilities: mentor.responsibilities,
    color: mentor.color,
    avatar: mentor.avatar,
    permissions: mentor.permissions,
  }
}

export function mentorById(mentors, id) {
  return mentors.find((mentor) => mentor.id === id) || null
}

export function normalizeModelRoute(value) {
  const route = cleanString(value, 200)
  const separator = route.indexOf('/')
  if (separator <= 0 || separator === route.length - 1) return ''
  const provider = route.slice(0, separator).trim()
  const model = route.slice(separator + 1).trim()
  if (!provider || !model || /\s/.test(provider) || /[\r\n]/.test(model)) return ''
  return provider + '/' + model
}

export function normalizeSupervisorModels(value, mentors) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const allowed = new Set((Array.isArray(mentors) ? mentors : []).map((mentor) => mentor.id))
  const result = {}
  for (const [supervisorId, candidate] of Object.entries(source)) {
    if (!allowed.has(supervisorId)) continue
    const route = normalizeModelRoute(candidate)
    if (route) result[supervisorId] = route
  }
  return result
}

export const MENTOR_ROLES = ROLE_META

// 挑选实际参与接管/建议的监督者 id 集合：主责 + 协作（观众）。
// 协作为空时回退到只有主责；从不回退到「全部学院」——那会让卡片上的
// 协作数与真正被咨询的监督者不一致（协作成为摆设）。
// 返回去重且有效的 id 数组；分配不存在时返回空数组。
export function participantMentorIds(assignment) {
  const primary = assignment && typeof assignment.primaryMentorId === 'string'
    ? assignment.primaryMentorId.trim()
    : ''
  const seen = new Set(primary ? [primary] : [])
  const ids = primary ? [primary] : []
  const collaborators = assignment && Array.isArray(assignment.collaboratorIds) ? assignment.collaboratorIds : []
  for (const raw of collaborators) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= 3) break // 主责 + 最多 2 协作
  }
  return ids
}
