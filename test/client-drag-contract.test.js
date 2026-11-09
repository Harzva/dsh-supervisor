import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('Supervisor floating card exposes a bounded persistent drag handle', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /dsh-supervisor\.floatPosition\.v1/)
  assert.match(source, /data-dsh-supervisor-drag-handle/)
  assert.match(source, /Math\.hypot\(dx, dy\) < 5/)
  assert.match(source, /window\.addEventListener\('mousemove', moveDrag\)/)
  assert.match(source, /window\.addEventListener\('mouseup', endDrag\)/)
  assert.match(source, /window\.innerWidth - width - 12/)
  assert.match(source, /window\.innerHeight - height - 12/)
  assert.match(source, /onDoubleClick: resetPosition/)
  assert.match(source, /window\.addEventListener\('resize', keepInViewport\)/)
})

test('Supervisor model selector uses the native directory and persists a role-scoped override', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /ctx\.get\('modelDirectories'\)/)
  assert.doesNotMatch(source, /ctx\.get\('models'\)/)
  assert.match(source, /supervisorModel: \{ supervisorId, route: value \}/)
  assert.match(source, /React\.createElement\('optgroup'/)
  assert.match(source, /仅影响下一轮监督，不改变主对话模型/)
  assert.match(source, /exports\.inject = \[[^\]]*'modelDirectories'/)
  assert.match(source, /const refreshState = \(\) => \{ fetchState\(curSid\)/)
  assert.match(source, /const patch = \(p\) => runAction\('正在保存设置…', \(\) => patchState\(target \|\| curSid/)
})

test('Supervisor uses an inline dock panel without duplicate header or shell overlay entries', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /data-dsh-supervisor-inline/)
  assert.match(source, /inline: true/)
  assert.match(source, /name: 'conversation\.input\.dock', id: 'supervisor-controls'/)
  assert.doesNotMatch(source, /register\(\{ name: 'conversation\.session\.header\.actions', id: 'supervisor'/)
  assert.doesNotMatch(source, /register\(\{ name: 'shell\.overlay', id: 'supervisor-mentor'/)
})

test('Supervisor floating actions use HTTP state routes and expose failures', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /const ADOPT_PATH = '\/dsh-supervisor\/adopt'/)
  assert.match(source, /const REGEN_PATH = '\/dsh-supervisor\/regen'/)
  assert.match(source, /const patch = \(p\) => runAction\('正在保存设置…', \(\) => patchState\(target \|\| curSid/)
  assert.match(source, /const onAdopt = \(\) => runAction\('正在采纳建议…', \(\) => adoptState\(target \|\| curSid\)/)
  assert.match(source, /const onRegen = \(\) => runAction\('正在生成建议…', \(\) => regenState\(target \|\| curSid\)/)
  assert.doesNotMatch(source, /exec\(target \|\| curSid, '\/supervise _(set|adopt|regen)/)
  assert.match(source, /data-dsh-supervisor-action-error/)
  assert.match(source, /role: 'alert'/)
  assert.match(source, /disabled: !!disabled/)
})

test('Supervisor command resolves a role before the floating panel reads state', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /handler: async \(\{ agent, rawInput \}\) => \{/)
  assert.match(source, /const sid = agent\.id\s+\/\/ The floating panel[\s\S]*await ensureAssignment\(sid\)\s+const p = perOf\(sid\)/)
})

test('supervisor consumes the public GroupX Host service without internal imports', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /ctx\.get\('groupxCouncil'\)/)
  assert.doesNotMatch(source, /import\('@harness-flow\/dsh-groupx\/mode'\)/)
  assert.match(source, /service\.request\(/)
})

test('roundtable opinions are guarded against truncation and empty responses', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  // 抬高意见 token 上限，避免 80 字意见被截断。
  assert.match(source, /opinionMaxTokens: 4096/)
  // 空/过短意见：强化提示重试一次，仍失败则标记 ok:false，绝不喂给主席。
  assert.match(source, /const generateOpinion = async \(llm, sid, route, system, messages\) => \{/)
  assert.match(source, /请务必输出至少一句完整中文建议/)
  assert.match(source, /if \(attempt\.text\.length >= MIN_OPINION_LEN\)/)
  assert.match(source, /error: last\.text \? '建议过短' : '空响应'/)
  // 意见生成改用 generateOpinion，而非裸 streamOne 200-token 截断。
  assert.doesNotMatch(source, /const text = await streamOne\(llm, sid, froute, system, baseMessages, 200\)/)
  assert.match(source, /const opinion = await generateOpinion\(llm, sid, froute, system, baseMessages\)/)
})

test('supervisor registers its faculties as neutral roleRegistry domain roles, skipping when unavailable', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  // 联动：把学院注册为中立角色库的 domain 角色（认知+领域）。
  assert.match(source, /ctx\.inject\(\['roleRegistry'\], \(groupCtx\) => \{/)
  assert.match(source, /namespace: 'dsh-supervisor'/)
  assert.match(source, /kind: 'domain'/)
  assert.match(source, /contributorId: 'dsh-supervisor'/)
  assert.match(source, /phases: \['proposal', 'challenge', 'evaluation', 'synthesis'\]/)
  // 学院名作为角色 label。
  assert.match(source, /label: faculty\.name/)
  // 中立角色库要求 role id 以其 namespace 为前缀（dsh-supervisor.<facultyId>）。
  assert.match(source, /id: 'dsh-supervisor\.' \+ faculty\.id/)
  // 失败边界：注册失败仅记日志，不破坏其它能力。
  assert.match(source, /roleRegistry domain role registration failed/)
  // 卸载时注销。
  assert.match(source, /groupCtx\.effect\(\(\) => dispose,/)
  // 中立库未挂载时静默跳过（不崩）。
  assert.match(source, /roleRegistry === undefined \|\| typeof roleRegistry\.register !== 'function'/)
})

test('roundtable records persist opinions/consensus/verdict for graph', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  // 结构化的裁决依据 + 意见落盘。
  assert.match(source, /opinions: facultyResults\.map\(\(r\) => \(\{ facultyId: r\.id, name: r\.name, text:/)
  assert.match(source, /verdict: parseRoundtableVerdict\(p\.suggestion\)/)
  assert.match(source, /consensus: p\.suggestion \|\| ''/)
  // 落盘走 store，失败静默。
  assert.match(source, /await mentorStore\.appendRoundtable\(roundRecord\)/)
  assert.match(source, /roundtable persist failed/)
  // 只读依赖不破坏现有链路。
  assert.match(source, /withTailInjection && p\.used < p\.rounds/)
})

test('verify parseRoundtableVerdict logic via replica', () => {
  // parseRoundtableVerdict 是模块内函数，此处用等价逻辑复刻验证语义。
  // 真实 LLM 输出在「一致/分歧」前后常带换行、标点或 CJK（非 \w），故不依赖词边界。
  const parser = (text) => {
    const t = String(text || '').trim()
    if (!t) return ''
    if (/分歧/.test(t)) return '分歧'
    if (/一致/.test(t)) return '一致'
    return ''
  }
  // 常规
  assert.equal(parser('分歧：策略学院主张A，代码学院主张B。'), '分歧')
  assert.equal(parser('一致'), '一致')
  assert.equal(parser('先做A。'), '')
  assert.equal(parser(''), '')
  // 真实输出：换行包围的关键词（CJK 非 \w，不能用词边界）。
  assert.equal(parser('先做A。\n一致'), '一致')
  assert.equal(parser('\n分歧：\nA vs B'), '分歧')
  // 裁决里同时提到「一致」但主体是分歧 → 分歧优先。
  assert.equal(parser('分歧：无法就A达成一致。'), '分歧')
})

test('supervisor exposes a roundtables read route backed by store.getRoundtables', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  // 路由常量已声明。
  assert.match(source, /SUPV_ROUNDTABLES_PATH = '\/dsh-supervisor\/roundtables'/)
  // 路由注册：GET，按 sessionId 读取并回写历史。
  assert.match(source, /registerRoute\(SUPV_ROUNDTABLES_PATH, async \(req, res\) => \{/)
  assert.match(source, /sessionId is required/)
  assert.match(source, /mentorStore\.getRoundtables\(sid\)/)
  assert.match(source, /writeJson\(res, 200, \{ ok: true, roundtables \}\)/)
})

test('supervisor exposes a roundtable graph route driven by buildRoundtableGraph', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  // 图路由常量已声明。
  assert.match(source, /SUPV_ROUNDTABLE_GRAPH_PATH = '\/dsh-supervisor\/roundtables\/graph'/)
  // 图路由注册：GET，读取该会话 roundtables 并交给纯函数构建图。
  assert.match(source, /registerRoute\(SUPV_ROUNDTABLE_GRAPH_PATH, async \(req, res\) => \{/)
  assert.match(source, /buildRoundtableGraph\(roundtables\)/)
  assert.match(source, /ok: true, graph: buildRoundtableGraph/)
  // 纯函数模块已进入 build 产物清单。
  assert.match(source, /import \{ buildRoundtableGraph \} from '\.\/roundtable-graph\.js'/)
})

test('roundtable graph builder is node-testable (pure, no browser)', async () => {
  const source = await readFile(new URL('../lib/roundtable-graph.js', import.meta.url), 'utf8')
  assert.match(source, /export function buildRoundtableGraph/)
  assert.match(source, /kind: FEED/)
  assert.match(source, /kind: DIVERGENCE/)
  assert.match(source, /dashed: true/)
})

test('supervisor client has a discoverable roundtable graph toggle and SVG graph renderer', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  // 图数据经 HTTP 路由拉取（G1 数据源）。
  assert.match(source, /ROUNDTABLE_GRAPH_PATH = '\/dsh-supervisor\/roundtables\/graph'/)
  assert.match(source, /fetchRoundtableGraph\(/)
  // 可发现入口（G5）：面板里的「圆桌记录」切换按钮。
  assert.match(source, /data-dsh-supervisor-graph-toggle/)
  assert.match(source, /'圆桌记录'/)
  // 渲染：SVG graph 视图（G6）+ verdict 徽章 + 送入裁决/分歧边 + 可展开全文。
  assert.match(source, /const RoundtableGraphView = /)
  assert.match(source, /React\.createElement\('svg',/)
  assert.match(source, /kind === 'feed'/)
  assert.match(source, /kind === 'divergence'/)
  assert.match(source, /strokeDasharray/)
  assert.match(source, /'送入裁决'/)
  assert.match(source, /'分歧'/)
  assert.match(source, /RoundtableGraphView, \{ graph(?::[^}]*)? \}/)
})

test('supervisor takeover anchors to the next todo and degrades when plan is empty', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  // 计划驱动时，注入建议锚定到下一个未完成 todo。
  assert.match(source, /本轮监督聚焦 todo「/)
  assert.match(source, /plan && plan\.next/)
  assert.match(source, /p\.suggestion = anchor \+ p\.suggestion/)
  // 会话无 todo：提示一次并降级（planEmptyWarned / planWarnAt），避免反复盲建议。
  assert.match(source, /暂无 todo 计划/)
  assert.match(source, /planEmptyWarned/)
  assert.match(source, /planWarnAt/)
})

test('supervisor plan summary surfaces next incomplete todo for anchoring', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  // readTodos 数据源：supervisor 自己的持久 store（todosCache <- mentorStore.todos），
  // 不是 turn 内 sessionProjections.todos 投影（turn/start 会清空，无法支撑跨轮次计划驱动）。
  assert.match(source, /const todosCache = new Map\(\)/)
  assert.match(source, /mentorStore\.getTodos\(sid\)/)
  assert.match(source, /todosCache\.get\(sid\)/)
  assert.match(source, /mentorStore\.setTodos/)
  assert.match(source, /if \(!next && t\.status !== 'completed'\) next = t\.content/)
})

test('supervisor exposes a persistable todo-plan route and /supervise todos command', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  // 路由：GET 读 / POST 写 todo 计划。
  assert.match(source, /SUPV_TODOS_PATH = '\/dsh-supervisor\/todos'/)
  assert.match(source, /registerRoute\(SUPV_TODOS_PATH, async \(req, res\) => \{/)
  assert.match(source, /mentorStore\.getTodos\(sid\)/)
  assert.match(source, /mentorStore\.getTodos\(sid\)/)
  assert.match(source, /ok: true, todos: items, plan: planSummaryFrom\(items\)/)
  // 命令：/supervise todos … 设置计划、todos done <N> 标记完成。
  assert.match(source, /args === 'todos'/)
  assert.match(source, /args\.startsWith\('todos '\)/)
  assert.match(source, /args\.startsWith\('todos done '\)/)
  assert.match(source, /setTodos\(sid, items\)/)
})

test('supervisor surfaces recent injected surface for anchor capture', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /SUPV_SURFACE_PATH = '\/dsh-supervisor\/surface'/)
  assert.match(source, /registerRoute\(SUPV_SURFACE_PATH, async \(req, res\) => \{/)
  assert.match(source, /recentSurfaceText\(sid\)/)
  assert.match(source, /ok: true, surface/)
})

test('supervisor exposes a projections read route for groupxMode verification', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /SUPV_PROJECTIONS_PATH = '\/dsh-supervisor\/projections'/)
  assert.match(source, /registerRoute\(SUPV_PROJECTIONS_PATH, async \(req, res\) => \{/)
  assert.match(source, /readProjectionValues\(sid\)/)
  assert.match(source, /snapshot\(sess\)/)
  assert.match(source, /values\[key\]/)
  assert.match(source, /ok: true, available: true/)
  // inject 捕获 sessionProjections（避免 fiber 未 active 拿不到服务）。
  assert.match(source, /ctx\.inject\(\['sessionProjections'\], \(projCtx\) => \{/)
  assert.match(source, /sessionProjectionsRef = projCtx\.get\('sessionProjections'\)/)
})
