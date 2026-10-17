#!/usr/bin/env node
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeMentors, resolveAssignment, publicMentor } from '../runtime/mentor-registry.mjs'
import { fail, SupervisorError, workspacePaths, readInput, readState, withStateLock, writeState, ensureHandoff } from './state.mjs'

const ROLES = ['architecture', 'research', 'execution', 'verification', 'handoff']
const PERMISSIONS = ['advise', 'takeover', 'relay', 'requestHandoff', 'createSession']
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const MAX_TASKS = 100
const MAX_CHECKPOINTS = 20
const HELP = `Codex Supervisor: bounded local records, without provider calls or background execution.

Usage: node scripts/supervisor.mjs <command> --workspace <directory> [--task <id>] [--input <JSON file>]
Commands:
  help        Show this help (workspace is optional).
  init        Initialize once; optional input {mentors?: [...], faculties?: [...]}.
  roster      Public mentor metadata; excludes domain prompts, routes and descriptions.
  assign      Requires task. Optional {primaryMentorId, collaboratorIds, tags, agentPreset}.
              Without a manual primary, reuse the assignment or resolve canonical responsibility rules.
  checkpoint  Requires task and input {summary, evidence, remaining, blockers, outcome, nativeGoalRef?}.
  status      Show one task or compact summaries of all tasks.
  handoff     Requires task and a checkpoint; writes deterministic local Markdown and returns its path.

Mentor input: id, name?, role?, responsibilities?, route?, color?, avatar?, permissions?,
              domainPrompt? (legacy prompt accepted instead), tags?, description?.
Faculty input: id, name?, prompt?, route?. Faculty prompts become private domainPrompt.
Permissions are retained DSH metadata; they do not authorize Codex actions.
Routes remain private, unmapped DSH metadata; the Codex host chooses its own model.
Checkpoint outcome: progress | stalled | unknown | complete.
Progress/complete require evidence; complete requires empty remaining and blockers.
nativeGoalRef is an opaque {id, revision} reference and never changes a native Goal.
Limits: 40 mentors/faculties per list, 8,000 characters per domain prompt, 100 tasks,
20 recent checkpoints per task; summary 1,200 characters; each evidence/remaining/blocker
list has at most 8 single-line strings of 800 characters; input 256 KiB; state 1 MiB.
Basic filters reject common credential patterns, private-key markers and transcript roles.
They are not a secret scanner: supply concise redacted evidence, never raw logs/transcripts.
State: <real workspace>/.codex/supervisor/state.v1.json; new private files mode 0600.
Writes use an exclusive .lock and atomic state replacement. A stale lock requires manual investigation.
init never replaces existing state or configuration. No threads or messages are created.
Success is JSON on stdout (except help); errors are JSON on stderr with exit code 1.
`

function object(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_DATA', `${label} must be an object.`)
  if (keys && Object.keys(value).some((key) => !keys.includes(key))) fail('INVALID_DATA', `${label} has an unknown field.`)
  return value
}

function textValue(value, label, max, required = false, multiline = false) {
  if (typeof value !== 'string' || value.length > max || value !== value.trim() || (required && !value)) {
    fail('INVALID_DATA', `${label} must be a trimmed string of at most ${max} characters${required ? ' and cannot be empty' : ''}.`)
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (!multiline && /[\r\n\t]/.test(value))) {
    fail('INVALID_DATA', `${label} contains unsupported control characters or line breaks.`)
  }
  return value
}

function optionalText(value, label, max, multiline = false) {
  return value === undefined ? '' : textValue(value, label, max, false, multiline)
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_DATA', `${label} must be 1–64 letters, digits, underscores or hyphens, starting with a letter or digit.`)
  return value
}

function list(value, label, max = 40, width = 120, nonempty = false) {
  if (!Array.isArray(value) || value.length > max) fail('INVALID_DATA', `${label} must be an array of at most ${max} items.`)
  const values = value.map((item) => textValue(item, label, width, nonempty))
  if (new Set(values).size !== values.length) fail('INVALID_DATA', `${label} contains duplicate items.`)
  return values
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail('INVALID_DATA', `${label} must be a safe integer >= ${minimum}.`)
}

function verifyPermissions(value, label, normalized = false) {
  object(value, label, PERMISSIONS)
  if (Object.values(value).some((permission) => typeof permission !== 'boolean') || (normalized && Object.keys(value).length !== PERMISSIONS.length)) {
    fail('INVALID_DATA', `${label} must contain boolean permissions.`)
  }
}

function verifyResponsibilities(value, label, normalized = false) {
  object(value, label, ['tags', 'workspacePatterns', 'presets', 'description'])
  for (const key of ['tags', 'workspacePatterns', 'presets']) {
    if (normalized || value[key] !== undefined) list(value[key], `${label}.${key}`, 40, 120, true)
  }
  if (normalized) {
    // Canonical faculty descriptions are a 300-character prefix of a potentially
    // multiline domain prompt. A cut may end at whitespace; retain it privately.
    if (typeof value.description !== 'string' || value.description.length > 300 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.description)) fail('INVALID_DATA', `${label}.description is invalid.`)
  } else if (value.description !== undefined) textValue(value.description, `${label}.description`, 300)
}

function normalizeConfig(input) {
  object(input, 'Configuration', ['mentors', 'faculties'])
  const rawMentors = input.mentors === undefined ? [] : input.mentors
  const rawFaculties = input.faculties === undefined ? [] : input.faculties
  for (const [label, values] of [['Mentors', rawMentors], ['Faculties', rawFaculties]]) {
    if (!Array.isArray(values) || values.length > 40) fail('INVALID_CONFIG', `${label} must be an array of at most 40 entries.`)
    const ids = new Set()
    for (const item of values) {
      object(item, label)
      identifier(item.id, `${label} id`)
      if (ids.has(item.id)) fail('INVALID_CONFIG', `${label} contains a duplicate id.`)
      ids.add(item.id)
    }
  }
  if ((Object.hasOwn(input, 'mentors') || Object.hasOwn(input, 'faculties')) && rawMentors.length === 0 && rawFaculties.length === 0) {
    fail('INVALID_CONFIG', 'Explicit configuration must contain at least one mentor or faculty.')
  }
  const faculties = rawFaculties.map((item) => {
    object(item, 'Faculty', ['id', 'name', 'prompt', 'route'])
    return { id: item.id, name: optionalText(item.name, 'Faculty name', 80) || item.id, prompt: optionalText(item.prompt, 'Faculty prompt', 8000, true), route: optionalText(item.route, 'Faculty route', 200) }
  })
  for (const item of rawMentors) {
    object(item, 'Mentor', ['id', 'name', 'role', 'responsibilities', 'route', 'color', 'avatar', 'permissions', 'domainPrompt', 'prompt', 'tags', 'description'])
    if (item.role !== undefined && !ROLES.includes(item.role)) fail('INVALID_CONFIG', 'Mentor role is unknown.')
    for (const [key, max] of [['name', 80], ['route', 200], ['avatar', 40], ['description', 300]]) optionalText(item[key], `Mentor ${key}`, max)
    if (item.color !== undefined && (typeof item.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(item.color))) fail('INVALID_CONFIG', 'Mentor color must be a six-digit hex color.')
    if (item.responsibilities !== undefined) verifyResponsibilities(item.responsibilities, 'Mentor responsibilities')
    if (item.tags !== undefined) list(item.tags, 'Mentor tags', 40, 120, true)
    if (item.tags !== undefined && item.responsibilities?.tags !== undefined) fail('INVALID_CONFIG', 'Use tags or responsibilities.tags, not both.')
    if (item.description !== undefined && item.responsibilities?.description !== undefined) fail('INVALID_CONFIG', 'Use description or responsibilities.description, not both.')
    if (item.permissions !== undefined) verifyPermissions(item.permissions, 'Mentor permissions')
    if (item.prompt !== undefined && item.domainPrompt !== undefined) fail('INVALID_CONFIG', 'Use domainPrompt or legacy prompt, not both.')
    optionalText(item.domainPrompt ?? item.prompt, 'Mentor domain prompt', 8000, true)
  }
  const source = rawMentors.length ? rawMentors : faculties
  const byId = new Map(source.map((item) => [item.id, item]))
  const mentors = normalizeMentors(rawMentors, faculties).map((mentor) => ({
    ...mentor,
    domainPrompt: byId.get(mentor.id)?.domainPrompt ?? byId.get(mentor.id)?.prompt ?? '',
  }))
  if (!mentors.length || (source.length && mentors.length !== source.length)) fail('INVALID_CONFIG', 'Configuration could not be normalized without losing entries.')
  return { mentors, faculties }
}

function validateConfig(config) {
  object(config, 'State configuration', ['mentors', 'faculties'])
  if (!Array.isArray(config.mentors) || !config.mentors.length || config.mentors.length > 40 || !Array.isArray(config.faculties) || config.faculties.length > 40) {
    fail('INVALID_STATE', 'State configuration has invalid roster sizes.')
  }
  const ids = new Set()
  for (const mentor of config.mentors) {
    object(mentor, 'Stored mentor', ['id', 'name', 'role', 'roleLabel', 'responsibilities', 'route', 'color', 'avatar', 'permissions', 'domainPrompt'])
    identifier(mentor.id, 'Stored mentor id')
    if (ids.has(mentor.id)) fail('INVALID_STATE', 'State contains duplicate mentor ids.')
    ids.add(mentor.id)
    if (!ROLES.includes(mentor.role)) fail('INVALID_STATE', 'State contains an unknown mentor role.')
    textValue(mentor.name, 'Stored mentor name', 80, true)
    textValue(mentor.roleLabel, 'Stored role label', 80, true)
    textValue(mentor.route, 'Stored route', 200)
    textValue(mentor.avatar, 'Stored avatar', 40, true)
    textValue(mentor.domainPrompt, 'Stored domain prompt', 8000, false, true)
    if (typeof mentor.color !== 'string' || !/^#[0-9a-f]{6}$/.test(mentor.color)) fail('INVALID_STATE', 'State has an invalid color.')
    verifyResponsibilities(mentor.responsibilities, 'Stored responsibilities', true)
    verifyPermissions(mentor.permissions, 'Stored permissions', true)
  }
  const facultyIds = new Set()
  for (const faculty of config.faculties) {
    object(faculty, 'Stored faculty', ['id', 'name', 'prompt', 'route'])
    identifier(faculty.id, 'Stored faculty id')
    if (facultyIds.has(faculty.id)) fail('INVALID_STATE', 'State contains duplicate faculty ids.')
    facultyIds.add(faculty.id)
    textValue(faculty.name, 'Stored faculty name', 80, true)
    textValue(faculty.prompt, 'Stored faculty prompt', 8000, false, true)
    textValue(faculty.route, 'Stored faculty route', 200)
  }
}

function safeCheckpointText(value, label, width) {
  const clean = textValue(value, label, width, true)
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b|\bBearer\s+\S+|\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret)\s*[:=]\s*\S+/i.test(clean)) {
    fail('SENSITIVE_INPUT', `${label} resembles a credential. Supply redacted evidence.`)
  }
  if (/^(?:user|assistant|system|developer|tool)\s*:|^\[?(?:20\d\d-\d\d-\d\d[T ]|TRACE\b|DEBUG\b)|^at\s+\S+\s*\(/i.test(clean)) {
    fail('RAW_LOG_INPUT', `${label} resembles a transcript or raw log. Supply a concise summary.`)
  }
  return clean
}

function validateCheckpoint(input) {
  object(input, 'Checkpoint', ['summary', 'evidence', 'remaining', 'blockers', 'outcome', 'nativeGoalRef'])
  const checkpoint = { summary: safeCheckpointText(input.summary, 'Checkpoint summary', 1200) }
  for (const field of ['evidence', 'remaining', 'blockers']) {
    checkpoint[field] = list(input[field], `Checkpoint ${field}`, 8, 800, true).map((item) => safeCheckpointText(item, `Checkpoint ${field}`, 800))
  }
  if (!['progress', 'stalled', 'unknown', 'complete'].includes(input.outcome)) fail('INVALID_CHECKPOINT', 'Checkpoint outcome is unknown.')
  checkpoint.outcome = input.outcome
  if (['progress', 'complete'].includes(input.outcome) && !checkpoint.evidence.length) fail('INVALID_CHECKPOINT', 'Progress and complete outcomes require evidence.')
  if (input.outcome === 'complete' && (checkpoint.remaining.length || checkpoint.blockers.length)) fail('INVALID_CHECKPOINT', 'Complete requires empty remaining and blockers.')
  if (input.nativeGoalRef !== undefined) {
    object(input.nativeGoalRef, 'Native Goal reference', ['id', 'revision'])
    identifier(input.nativeGoalRef.id, 'Native Goal id')
    safeCheckpointText(input.nativeGoalRef.id, 'Native Goal id', 64)
    integer(input.nativeGoalRef.revision, 'Native Goal revision')
    checkpoint.nativeGoalRef = { id: input.nativeGoalRef.id, revision: input.nativeGoalRef.revision }
  }
  return checkpoint
}

function validateAssignment(assignment, taskId, mentors) {
  object(assignment, 'Assignment', ['sessionId', 'primaryMentorId', 'collaboratorIds', 'assignmentSource', 'reason', 'assignedAt', 'version'])
  if (assignment.sessionId !== taskId) fail('INVALID_STATE', 'Assignment is bound to another task.')
  const allowed = new Set(mentors.map((mentor) => mentor.id))
  if (!allowed.has(assignment.primaryMentorId)) fail('INVALID_ASSIGNMENT', 'Primary mentor is not in the roster.')
  list(assignment.collaboratorIds, 'Collaborators', 2, 64, true)
  if (assignment.collaboratorIds.some((id) => !allowed.has(id) || id === assignment.primaryMentorId)) fail('INVALID_ASSIGNMENT', 'Collaborators must be distinct roster mentors other than the primary.')
  if (!['manual', 'rule', 'fallback'].includes(assignment.assignmentSource)) fail('INVALID_STATE', 'Assignment source is unknown.')
  textValue(assignment.reason, 'Assignment reason', 300, true)
  integer(assignment.assignedAt, 'Assignment timestamp')
  if (assignment.version !== 1) fail('INVALID_STATE', 'Assignment version is unsupported.')
}

function validateState(state, workspace) {
  object(state, 'State', ['schemaVersion', 'revision', 'workspace', 'config', 'tasks'])
  if (state.schemaVersion !== 1) fail('UNKNOWN_SCHEMA', 'Supervisor state schema is unsupported; preserve the file for migration.')
  integer(state.revision, 'State revision', 1)
  if (state.workspace !== workspace) fail('WORKSPACE_BINDING', 'State is bound to a different real workspace path.')
  validateConfig(state.config)
  object(state.tasks, 'Tasks')
  if (Object.keys(state.tasks).length > MAX_TASKS) fail('INVALID_STATE', 'State contains too many tasks.')
  for (const [taskId, task] of Object.entries(state.tasks)) {
    identifier(taskId, 'Task id')
    object(task, 'Task', ['assignment', 'checkpointSequence', 'checkpoints', 'handoff'])
    validateAssignment(task.assignment, taskId, state.config.mentors)
    integer(task.checkpointSequence, 'Checkpoint sequence')
    if (!Array.isArray(task.checkpoints) || task.checkpoints.length > MAX_CHECKPOINTS) fail('INVALID_STATE', 'Task checkpoint history is invalid.')
    let previous = 0
    for (const entry of task.checkpoints) {
      object(entry, 'Checkpoint entry', ['sequence', 'recordedAt', 'data'])
      integer(entry.sequence, 'Checkpoint entry sequence', 1)
      integer(entry.recordedAt, 'Checkpoint timestamp')
      if (entry.sequence <= previous || entry.sequence > task.checkpointSequence) fail('INVALID_STATE', 'Checkpoint sequences are inconsistent.')
      previous = entry.sequence
      validateCheckpoint(entry.data)
    }
    if (previous !== task.checkpointSequence) fail('INVALID_STATE', 'Current checkpoint sequence is inconsistent.')
    if (task.handoff !== null) {
      object(task.handoff, 'Handoff pointer', ['digest', 'relativePath', 'checkpointSequence'])
      if (typeof task.handoff.digest !== 'string' || !/^[a-f0-9]{64}$/.test(task.handoff.digest) || task.handoff.relativePath !== `handoffs/${taskId}-${task.handoff.digest}.md` || task.handoff.checkpointSequence !== previous || !previous) {
        fail('INVALID_STATE', 'Handoff pointer is invalid.')
      }
      const expected = handoffData(taskId, task)
      if (task.handoff.digest !== expected.digest) fail('INVALID_STATE', 'Handoff pointer does not match the current assignment and checkpoint.')
    }
  }
}

function roster(config) {
  return config.mentors.map((mentor) => {
    const result = publicMentor(mentor)
    const { description: _privateDescription, ...responsibilities } = result.responsibilities
    const { permissions: _legacyPermissions, ...metadata } = result
    return { ...metadata, responsibilities }
  })
}

function requiredTask(state, taskId) {
  const task = Object.hasOwn(state.tasks, taskId) ? state.tasks[taskId] : null
  if (!task) fail('MISSING_TASK', 'Assign this task before recording or generating a handoff.')
  return task
}

function compactTask(taskId, task) {
  return { taskId, assignment: task.assignment, checkpointSequence: task.checkpointSequence, latestCheckpoint: task.checkpoints.at(-1) ?? null, handoff: task.handoff }
}

function md(value) {
  return value.replace(/([\\`*_{}\[\]()<>#!|])/g, '\\$1')
}

function handoffData(taskId, task) {
  const checkpoint = task.checkpoints.at(-1)
  if (!checkpoint) fail('NO_CHECKPOINT', 'Record a checkpoint before generating a handoff.')
  const data = checkpoint.data
  const items = (values) => values.length ? values.map((value) => `- ${md(value)}`).join('\n') : '- None recorded.'
  const goal = data.nativeGoalRef ? `\nNative Goal reference: ${md(data.nativeGoalRef.id)} (revision ${data.nativeGoalRef.revision}); reference only.\n` : ''
  const markdown = `# Supervisor handoff: ${md(taskId)}\n\nPrimary mentor: ${md(task.assignment.primaryMentorId)}\n\nCollaborators: ${task.assignment.collaboratorIds.map(md).join(', ') || 'None'}\n\nAssignment: ${md(task.assignment.assignmentSource)} — ${md(task.assignment.reason)}\n\nCheckpoint: ${checkpoint.sequence}\n\nOutcome: ${data.outcome}\n${goal}\n## Summary\n\n${md(data.summary)}\n\n## Evidence\n\n${items(data.evidence)}\n\n## Remaining work\n\n${items(data.remaining)}\n\n## Blockers\n\n${items(data.blockers)}\n\nThis local record does not change native Goals, select a provider model, create a thread, or send a message.\n`
  return { markdown, digest: createHash('sha256').update(markdown).digest('hex') }
}

function assign(state, taskId, input) {
  object(input, 'Assignment input', ['primaryMentorId', 'collaboratorIds', 'tags', 'agentPreset'])
  const tags = input.tags === undefined ? [] : list(input.tags, 'Assignment tags', 40, 120, true)
  const agentPreset = optionalText(input.agentPreset, 'Agent preset', 200)
  if (input.primaryMentorId !== undefined) identifier(input.primaryMentorId, 'Primary mentor id')
  if (input.collaboratorIds !== undefined) list(input.collaboratorIds, 'Collaborators', 2, 64, true).forEach((id) => identifier(id, 'Collaborator id'))
  const existing = Object.hasOwn(state.tasks, taskId) ? state.tasks[taskId] : null
  if (!existing && Object.keys(state.tasks).length >= MAX_TASKS) fail('TASK_LIMIT', 'Workspace already contains the maximum number of tasks.')
  let assignment
  if (input.primaryMentorId !== undefined) {
    assignment = { sessionId: taskId, primaryMentorId: input.primaryMentorId, collaboratorIds: input.collaboratorIds ?? [], assignmentSource: 'manual', reason: 'Explicit local mentor assignment', assignedAt: Date.now(), version: 1 }
  } else {
    assignment = resolveAssignment({ sessionId: taskId, cwd: state.workspace, tags, agentPreset }, state.config.mentors, existing?.assignment)
    if (input.collaboratorIds !== undefined) assignment = { ...assignment, collaboratorIds: input.collaboratorIds }
  }
  validateAssignment(assignment, taskId, state.config.mentors)
  if (existing) {
    const previous = existing.assignment
    // Assignment time is an audit value, not a reason to reassign. Collaborator
    // order is immaterial; preserve the prior order and handoff on a retry.
    if (previous.primaryMentorId === assignment.primaryMentorId
      && previous.assignmentSource === assignment.assignmentSource
      && previous.reason === assignment.reason
      && JSON.stringify([...previous.collaboratorIds].sort()) === JSON.stringify([...assignment.collaboratorIds].sort())) {
      return { changed: false, task: existing }
    }
  }
  const task = { assignment, checkpointSequence: existing?.checkpointSequence ?? 0, checkpoints: existing?.checkpoints ?? [], handoff: null }
  Object.defineProperty(state.tasks, taskId, { value: task, enumerable: true, configurable: true, writable: true })
  return { changed: true, task }
}

function parseArgs(argv) {
  const command = argv[0] ?? 'help'
  if (!['help', 'init', 'roster', 'assign', 'checkpoint', 'status', 'handoff'].includes(command)) fail('USAGE', 'Unknown command; run help.')
  const options = {}
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index]
    if (!['--workspace', '--task', '--input'].includes(key) || options[key] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) fail('USAGE', 'Flags require a single value and cannot be duplicated; run help.')
    options[key] = argv[index + 1]
  }
  if (command !== 'help' && !options['--workspace']) fail('USAGE', '--workspace is required.')
  if (['assign', 'checkpoint', 'handoff'].includes(command) && !options['--task']) fail('USAGE', '--task is required for this command.')
  if (options['--task']) identifier(options['--task'], 'Task id')
  if (options['--task'] && !['assign', 'checkpoint', 'status', 'handoff'].includes(command)) fail('USAGE', '--task is unsupported for this command.')
  if (options['--input'] && !['init', 'assign', 'checkpoint'].includes(command)) fail('USAGE', '--input is unsupported for this command.')
  if (command === 'checkpoint' && !options['--input']) fail('USAGE', 'checkpoint requires --input.')
  return { command, options }
}

export function run(argv) {
  const { command, options } = parseArgs(argv)
  if (command === 'help') return HELP
  const paths = workspacePaths(options['--workspace'], command === 'init')
  const taskId = options['--task']
  const input = options['--input'] ? readInput(options['--input']) : {}
  if (['roster', 'status'].includes(command)) {
    const state = readState(paths, validateState)
    if (command === 'roster') return { schemaVersion: 1, revision: state.revision, mentors: roster(state.config), routing: { mode: 'host-default', legacyRouteMapped: false } }
    return taskId ? { revision: state.revision, ...compactTask(taskId, requiredTask(state, taskId)) } : { schemaVersion: 1, revision: state.revision, workspace: state.workspace, tasks: Object.entries(state.tasks).map(([id, task]) => ({ taskId: id, primaryMentorId: task.assignment.primaryMentorId, collaboratorIds: task.assignment.collaboratorIds, checkpointSequence: task.checkpointSequence, outcome: task.checkpoints.at(-1)?.data.outcome ?? 'unknown', handoff: task.handoff })) }
  }
  return withStateLock(paths, () => {
    let state = readState(paths, validateState, command === 'init')
    if (command === 'init') {
      if (state) return { initialized: false, revision: state.revision, workspace: state.workspace, mentorCount: state.config.mentors.length }
      state = { schemaVersion: 1, revision: 1, workspace: paths.workspace, config: normalizeConfig(input), tasks: {} }
      writeState(paths, state, validateState)
      return { initialized: true, revision: state.revision, workspace: state.workspace, mentorCount: state.config.mentors.length }
    }
    if (command === 'assign') {
      const result = assign(state, taskId, input)
      if (result.changed) {
        state.revision += 1
        writeState(paths, state, validateState)
      }
      return { revision: state.revision, ...compactTask(taskId, result.task) }
    }
    const task = requiredTask(state, taskId)
    if (command === 'checkpoint') {
      const data = validateCheckpoint(input)
      task.checkpointSequence += 1
      task.checkpoints.push({ sequence: task.checkpointSequence, recordedAt: Date.now(), data })
      task.checkpoints = task.checkpoints.slice(-MAX_CHECKPOINTS)
      task.handoff = null
      state.revision += 1
      writeState(paths, state, validateState)
      return { revision: state.revision, ...compactTask(taskId, task) }
    }
    const { markdown, digest } = handoffData(taskId, task)
    const filename = `${taskId}-${digest}.md`
    const target = ensureHandoff(paths, filename, markdown)
    if (!task.handoff) {
      task.handoff = { digest, relativePath: `handoffs/${filename}`, checkpointSequence: task.checkpointSequence }
      state.revision += 1
      writeState(paths, state, validateState)
    }
    return { taskId, revision: state.revision, digest, path: target, checkpointSequence: task.checkpointSequence }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (Number(process.versions.node.split('.')[0]) < 22) fail('NODE_VERSION', 'Codex Supervisor requires Node.js >= 22.')
    const result = run(process.argv.slice(2))
    process.stdout.write(typeof result === 'string' ? result : `${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    const known = error instanceof SupervisorError
    process.stderr.write(`${JSON.stringify({ error: { code: known ? error.code : 'INTERNAL', message: known ? error.message : 'Supervisor failed without changing a native Goal or sending a message.' } })}\n`)
    process.exitCode = 1
  }
}
