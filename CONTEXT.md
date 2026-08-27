# 导师建议的上下文窗口 Schema（v1）

> 设计目标：**防止导师只依据残缺尾部（旧版"最近 12 个 surface 事件"）就下结论**。
> 本设计保证：锚点（原始需求）、计划、目标、工具进展、历史建议、最近对话
> 六类信息都有结构化入口，且每段带**省略标记**，并显式告诉导师
> **"上下文不足时必须明说、不得补全缺失信息"**。

## 1. 上下文四段结构（每次建议节选组织）

```
【任务头·原始需求】  <首条用户消息，默认截 400 字，过长带省略标记>
【当前计划】          <todo 条目（最多 30 条），仅 plan 策略注入>
【当前目标】          <会话 goal：phase + objective（若有）>
【工具进展】          <最近 N 条 tool/result 摘要：名称 + 输出前 120 字>
【历史建议】          <最近 N 条建议：是否被采纳 + 前 160 字，防重复/自相矛盾>
【最近对话】          <尾部 M 条 user/assistant 消息（按消息数取窗），按字符软预算截断>
```

关键改进 vs 旧版：
- **按消息数取窗**（旧版按 surface 事件数取窗，工具事件会挤掉消息）；
- **任务头锚点**：任何时刻导师都知道"原始任务是什么"；
- **工具进展摘要**：尾部全是工具调用时导师不被"空白对话"误导；
- **历史建议**：避免重复给同一建议、或与已采纳建议自相矛盾；
- **每段省略显式标注**：导师知道信息被截断，配合护栏不会脑补。

## 2. Schema（每会话独立，可经 `/supervise _set {"context": {...}}` 覆盖）

| 字段 | 默认 | 范围（钳制） | 含义 |
|---|---|---|---|
| `maxMessages` | 12 | 2–60 | 最近对话保留的 user/assistant 消息条数 |
| `maxChars` | 8000 | 800–40000 | 全上下文软预算（字符），超出优先截「最近对话」 |
| `taskHeaderChars` | 400 | 100–2000 | 任务头截断长度 |
| `includeTaskHeader` | true | bool | 是否注入任务头 |
| `includeTodos` | true | bool | 是否注入计划清单（plan 策略下） |
| `includeGoals` | true | bool | 是否注入当前 goal |
| `includeToolHints` | true | bool | 是否注入工具结果摘要 |
| `maxToolHints` | 4 | 0–12 | 工具结果条数 |
| `toolHintChars` | 120 | 40–1000 | 单条工具结果截断 |
| `includePrevSuggestions` | true | bool | 是否注入历史建议 |
| `maxPrevSuggestions` | 3 | 0–6 | 历史建议条数 |

- 定义位置：`lib/index.js` 的 `CONTEXT_DEFAULTS` / `sanitizeContext()`。
- **校验策略**：字段级校验 + 数值钳制（非法字段回退默认值），整份坏配置 → 保持默认，不会抛异常。
- 历史建议记录：`p.suggestLog`（每会话保留最近 6 条，生成时记 `adopted:false`，采纳时置 `adopted:true`）。

## 3. Prompt 护栏（防片面建议的判定规则）

system 提示词末尾统一追加：

> 只依据提供的上下文判断；若上下文不足以支撑建议（例如任务头缺失、计划为空或对话过短），
> 直接回复：**上下文不足，请补充信息后再建议**。不得编造或补全上下文之外的内容。

即：**信息不全时"不知道"是合法答案**，而不是猜一个建议。

## 4. 可观测

- `_state` 返回 `contextSummary`：`{ messages(全消息数), tail(尾部条数), chars(注入字符数), header, tools, prev, at }`。
- 导师面板 meta 行实时显示：`上下文：尾 12 条 / 全 34 条 · 6.2k 字 · 任务头 · 历史建议`。

## 5. 覆盖示例

```bash
# 更长的对话窗（长任务）：
/supervise context {"maxMessages":24,"maxChars":12000,"includePrevSuggestions":false}

# 聚焦计划、不要工具噪音：
/supervise context {"includeToolHints":false,"includePrevSuggestions":true}
```
