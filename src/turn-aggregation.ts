import { createHash } from 'node:crypto'
import { sanitizeDebugEntry } from './debug-redaction'
import type { DebugEntry, DebugMessagePart, DebugToolCall, DebugToolDefinition, DebugToolResult } from './types'

type TraceMetadata = DebugEntry['metadata'] & {
  traceId?: string
  parentTraceId?: string
  callRunId?: string
  captureOutcome?: string
  responseStatus?: string
  errorCode?: string
}

export interface TurnUsage {
  inputTokens: number | null
  outputTokens: number | null
  cachedTokens: number | null
  totalTokens: number | null
}

export interface TurnUsageSummary extends TurnUsage {
  requestCount: number
  unknownRequestCount: number
  knownSubtotal: TurnUsage
}

export interface TurnAssociation {
  kind: 'initial' | 'trace' | 'tool-continuation' | 'exact-retry'
  previousRequestId?: string
  callIds?: string[]
  reason: string
}

export interface TurnFieldChange {
  path: string
  before: unknown
  after: unknown
}

export interface TurnTextDiagnostic {
  field: string
  invalidJson?: boolean
  utf16Length: number
  codePointCount: number
  controlCounts: Record<string, number>
  longestRun: { codePoint: string; length: number }
  escapedPreview: string
}

export interface TurnToolCall extends DebugToolCall {
  parameterChanges: TurnFieldChange[]
  stateChanges: TurnFieldChange[]
  parameters?: unknown
  state?: unknown
  diagnostics?: TurnTextDiagnostic
  characterReply?: {
    messages: unknown[]
    texts: string[]
    think?: string
    isFinal?: boolean
    delivery: 'not-observed'
  }
}

export interface TurnRequestView {
  id: string
  createdAt: number
  endAt?: number
  durationMs: number
  status?: number
  responseStatus?: string
  errorCode?: string
  captureOutcome?: string
  callRunId?: string
  error?: unknown
  association: TurnAssociation
  usage: TurnUsage
  rawLink?: string
  newMessages: DebugMessagePart[]
  responseMessages: DebugMessagePart[]
  responseText: string
  responseReasoningText?: string
  newToolCalls: TurnToolCall[]
  newToolResults: DebugToolResult[]
  parameterChanges: TurnFieldChange[]
  inputChanges: TurnFieldChange[]
}

export interface TurnMergeView {
  version: 1
  id: string
  traceId?: string
  parentTraceId?: string
  createdAt: number
  updatedAt: number
  status: 'open' | 'timeout' | 'capacity' | 'flushed' | 'disposed'
  correlation: 'explicit' | 'inferred' | 'single'
  shared: {
    endpoint: string
    model?: string
    requestType?: string
    prompt: DebugMessagePart[]
    tools: DebugToolDefinition[]
    headers: Record<string, string>
    parameters: Record<string, unknown>
  }
  requests: TurnRequestView[]
  usage: TurnUsageSummary
}

export interface TurnAggregatorOptions {
  maxTurns?: number
  maxRequestsPerTurn?: number
  idleTimeoutMs?: number
  pendingTimeoutMs?: number
  now?: () => number
  onFlush?: (view: TurnMergeView) => void
}

interface StoredRequest {
  entry: DebugEntry
  rawLink?: string
  association: TurnAssociation
}

interface TurnState {
  id: string
  traceId?: string
  requests: Map<string, StoredRequest>
  touchedAt: number
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as any)[key])).join(',') + '}'
  }
  return JSON.stringify(value) ?? 'undefined'
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function body(entry: DebugEntry): Record<string, any> {
  if (entry.requestBodyJson && typeof entry.requestBodyJson === 'object') return object(entry.requestBodyJson)
  try { return object(JSON.parse(entry.requestBodyText || '')) } catch { return {} }
}

function input(entry: DebugEntry): unknown[] | undefined {
  const request = body(entry)
  return Array.isArray(request.input) ? request.input : Array.isArray(request.messages) ? request.messages : undefined
}

function baseline(entry: DebugEntry): string {
  const request = body(entry)
  return fingerprint({
    endpoint: entry.metadata.url,
    method: entry.metadata.method,
    model: entry.metadata.model ?? request.model,
    requestType: entry.metadata.requestType,
    tools: request.tools ?? entry.tools,
    instructions: request.instructions,
  })
}

function exactRequest(entry: DebugEntry): string {
  const request = body(entry)
  return fingerprint({ baseline: baseline(entry), request,
    messages: entry.requestMessages, headers: entry.requestHeaders })
}

function endTime(entry: DebugEntry): number | undefined {
  if (entry.metadata.captureOutcome === 'pending') return undefined
  return entry.metadata.endAt ?? (entry.metadata.durationMs > 0 ? entry.metadata.createdAt + entry.metadata.durationMs : undefined)
}

function failed(entry: DebugEntry): boolean {
  const metadata = entry.metadata as TraceMetadata
  return Boolean(metadata.error || (metadata.status != null && metadata.status >= 400)
    || object(entry.responseJson).status === 'failed' || object(entry.responseJson).error
    || /fail|abort|cancel|error|truncat|incomplete/i.test(metadata.captureOutcome || ''))
}

function prefixOf(previous: unknown[], next: unknown[]): boolean {
  return next.length > previous.length && previous.every((item, index) => canonical(item) === canonical(next[index]))
}

function referencedCallIds(items: unknown[]): Set<string> {
  const ids = new Set<string>()
  for (const item of items) {
    const value = object(item)
    if (typeof value.call_id === 'string') ids.add(value.call_id)
    if (typeof value.tool_call_id === 'string') ids.add(value.tool_call_id)
    for (const call of Array.isArray(value.tool_calls) ? value.tool_calls : []) {
      if (typeof call?.id === 'string') ids.add(call.id)
    }
  }
  return ids
}

function inferAssociation(previous: DebugEntry, next: DebugEntry): TurnAssociation | undefined {
  const previousEnd = endTime(previous)
  if (previousEnd == null || next.metadata.createdAt < previousEnd || baseline(previous) !== baseline(next)) return
  const previousInput = input(previous)
  const nextInput = input(next)
  if (!previousInput?.length || !nextInput?.length) return
  if (failed(previous) && exactRequest(previous) === exactRequest(next)) {
    return { kind: 'exact-retry', previousRequestId: previous.metadata.id,
      reason: '前次已结束且失败；endpoint、model、完整请求、消息、tools 和 headers 精确相同，唯一候选的重试推断' }
  }
  if (!prefixOf(previousInput, nextInput)) return
  const additions = nextInput.slice(previousInput.length)
  // A newly appended user message starts another conversation turn, even when
  // the prior call/result has also been appended to the retained history.
  if (additions.some(item => object(item).role === 'user')) return
  const references = referencedCallIds(additions)
  const callIds = previous.toolCalls.filter(call => call.source === 'response' && call.id && references.has(call.id)).map(call => call.id!)
  if (callIds.length) {
    return { kind: 'tool-continuation', previousRequestId: previous.metadata.id, callIds,
      reason: '相同 endpoint、model、tools 和完整输入前缀；新增输入引用前次输出 call_id，唯一候选的工具续轮推断' }
  }
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function normalizeTurnUsage(entry: DebugEntry): TurnUsage {
  const usage = object(entry.metadata.usage ?? object(entry.responseJson).usage)
  const inputTokens = count(usage.input_tokens ?? usage.prompt_tokens)
  const outputTokens = count(usage.output_tokens ?? usage.completion_tokens)
  const cachedTokens = count(object(usage.input_tokens_details).cached_tokens
    ?? object(usage.prompt_tokens_details).cached_tokens ?? usage.cached_tokens ?? usage.cache_read_input_tokens)
  return { inputTokens, outputTokens, cachedTokens,
    totalTokens: count(usage.total_tokens) ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null) }
}

function summarizeUsage(requests: TurnRequestView[]): TurnUsageSummary {
  const fields = ['inputTokens', 'outputTokens', 'cachedTokens', 'totalTokens'] as const
  const total = {} as TurnUsage
  const knownSubtotal = {} as TurnUsage
  for (const field of fields) {
    const values = requests.map(request => request.usage[field])
    knownSubtotal[field] = values.some(value => value != null) ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null
    total[field] = values.every(value => value != null) ? knownSubtotal[field] : null
  }
  return { ...total, knownSubtotal, requestCount: requests.length,
    unknownRequestCount: requests.filter(request => request.usage.inputTokens == null || request.usage.outputTokens == null).length }
}

function escaped(text: string): string {
  return JSON.stringify(text).replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
    char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
}

export function diagnoseTurnText(text: string, field: string, invalidJson = false): TurnTextDiagnostic {
  const points = Array.from(text)
  const controlCounts: Record<string, number> = {}
  let last = '', run = 0, longestRun = { codePoint: '', length: 0 }
  for (const char of points) {
    const codePoint = 'U+' + char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')
    if (/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(char)) controlCounts[codePoint] = (controlCounts[codePoint] || 0) + 1
    run = char === last ? run + 1 : 1
    last = char
    if (run > longestRun.length) longestRun = { codePoint, length: run }
  }
  return { field, invalidJson: invalidJson || undefined, utf16Length: text.length,
    codePointCount: points.length, controlCounts, longestRun, escapedPreview: escaped(points.slice(0, 80).join('')) }
}

function preview(text: string, limit = 4000): string {
  return text.length > limit ? text.slice(0, limit) + `\n[已省略 ${text.length - limit} 字符；完整内容见单次 raw 记录]` : text
}

function changes(before: unknown, after: unknown, path = ''): TurnFieldChange[] {
  if (canonical(before) === canonical(after)) return []
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    return Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort().flatMap(key =>
      changes((before as any)[key], (after as any)[key], path ? `${path}.${key}` : key))
  }
  return [{ path: path || '$', before: before ?? null, after: after ?? null }]
}

function parameters(entry: DebugEntry): Record<string, unknown> {
  const request = body(entry)
  const { input: _input, messages: _messages, tools: _tools, model: _model, ...rest } = request
  return Object.keys(request).length ? rest : {
    reasoning: entry.metadata.reasoning, otherOptions: entry.metadata.otherOptions,
    maxTokens: entry.metadata.maxTokens, maxOutputTokens: entry.metadata.maxOutputTokens,
  }
}

function parseValue(text: unknown): unknown {
  if (typeof text !== 'string') return text
  try { return JSON.parse(text) } catch { return text }
}

function toolView(call: DebugToolCall, previous?: TurnToolCall): TurnToolCall {
  let parsed: unknown, invalid = false
  try { parsed = JSON.parse(call.arguments || '{}') } catch { invalid = true }
  const diagnostic = diagnoseTurnText(call.arguments || '', `${call.name}.arguments`, invalid)
  const abnormal = invalid || Object.keys(diagnostic.controlCounts).length > 0 || diagnostic.longestRun.length >= 128
  const args = object(parsed)
  const { status, messages, think, ...toolParameters } = args
  const view: TurnToolCall = { ...call, arguments: abnormal ? undefined : preview(call.arguments || ''),
    parameters: parsed == null ? undefined : toolParameters, state: parseValue(status),
    parameterChanges: previous ? changes(previous.parameters, toolParameters) : [],
    stateChanges: changes(previous?.state, parseValue(status)),
    diagnostics: abnormal ? diagnostic : undefined }
  if (call.name === 'character_reply' && !invalid) {
    const replyMessages = Array.isArray(messages) ? messages : []
    const texts = replyMessages.flatMap(message => {
      const content = object(message).content
      if (typeof content === 'string') return [content]
      return Array.isArray(content) ? content.flatMap(part => typeof object(part).text === 'string' ? [object(part).text] : []) : []
    })
    view.characterReply = { messages: replyMessages, texts,
      think: typeof think === 'string' ? think : undefined,
      isFinal: typeof args.is_final === 'boolean' ? args.is_final : undefined, delivery: 'not-observed' }
  }
  return view
}

function buildView(state: TurnState, status: TurnMergeView['status'] = 'open'): TurnMergeView {
  const records = Array.from(state.requests.values()).sort((a, b) => a.entry.metadata.createdAt - b.entry.metadata.createdAt)
  const first = records[0].entry
  const seenCalls = new Set<string>(), seenResults = new Set<string>()
  const lastTool = new Map<string, TurnToolCall>()
  const requests: TurnRequestView[] = []
  let previous: DebugEntry | undefined
  for (const record of records) {
    const { entry } = record
    const metadata = entry.metadata as TraceMetadata
    const newToolCalls = entry.toolCalls.filter(call => {
      if (call.source !== 'response') return false
      const key = call.id || fingerprint({ name: call.name, arguments: call.arguments })
      if (seenCalls.has(key)) return false
      seenCalls.add(key)
      return true
    }).map(call => {
      const value = toolView(call, lastTool.get(call.name))
      lastTool.set(call.name, value)
      return value
    })
    const newToolResults = entry.toolResults.filter(result => {
      // Request-side results are new only if their call was produced in this turn.
      if (result.source === 'request' && (!result.callId || !seenCalls.has(result.callId))) return false
      const key = fingerprint(result)
      if (seenResults.has(key)) return false
      seenResults.add(key)
      return true
    }).map(result => ({ ...result, output: preview(result.output) }))
    const messagePrefix = previous?.requestMessages || first.requestMessages
    const newMessages = previous && entry.requestMessages.length > messagePrefix.length
      && messagePrefix.every((message, index) => canonical(message) === canonical(entry.requestMessages[index]))
      ? entry.requestMessages.slice(messagePrefix.length).filter(message => message.role !== 'tool') : []
    requests.push({ id: metadata.id, createdAt: metadata.createdAt, endAt: metadata.endAt, durationMs: metadata.durationMs,
      status: metadata.status, responseStatus: metadata.responseStatus ?? object(entry.responseJson).status,
      errorCode: metadata.responseErrorCode ?? metadata.errorCode ?? object(object(entry.responseJson).error).code, captureOutcome: metadata.captureOutcome,
      callRunId: metadata.callRunId, error: metadata.error ?? object(entry.responseJson).error,
      association: record.association, usage: normalizeTurnUsage(entry), rawLink: record.rawLink,
      newMessages, responseMessages: entry.responseMessages.map(message => ({ ...message, content: preview(message.content) })),
      responseText: /^\s*(?:event:|data:)/.test(entry.responseText) ? '' : preview(entry.responseText),
      responseReasoningText: entry.responseReasoningText ? preview(entry.responseReasoningText) : undefined,
      newToolCalls, newToolResults,
      inputChanges: previous && canonical(input(previous)) !== canonical(input(entry))
        && !(input(previous) && input(entry) && prefixOf(input(previous)!, input(entry)!))
        ? changes(input(previous) ?? previous.requestMessages, input(entry) ?? entry.requestMessages, 'input') : [],
      parameterChanges: previous ? [
        ...changes(parameters(previous), parameters(entry)),
        ...changes(previous.requestHeaders, entry.requestHeaders, 'headers'),
        ...changes(previous.tools, entry.tools, 'tools'),
      ] : [],
    })
    previous = entry
  }
  return { version: 1, id: state.id, traceId: state.traceId,
    parentTraceId: (first.metadata as TraceMetadata).parentTraceId, createdAt: first.metadata.createdAt,
    updatedAt: Math.max(...records.map(record => endTime(record.entry) ?? record.entry.metadata.createdAt)),
    status, correlation: state.traceId ? 'explicit' : records.length > 1 ? 'inferred' : 'single',
    shared: { endpoint: first.metadata.url, model: first.metadata.model, requestType: first.metadata.requestType,
      prompt: first.requestMessages, tools: first.tools, headers: first.requestHeaders, parameters: parameters(first) },
    requests, usage: summarizeUsage(requests) }
}

/** No timers or hooks: the owner drives expiry with a Koishi-managed interval. */
export class TurnAggregator {
  private readonly turns = new Map<string, TurnState>()
  private disposed = false
  private readonly options: Required<Omit<TurnAggregatorOptions, 'onFlush'>> & Pick<TurnAggregatorOptions, 'onFlush'>

  constructor(options: TurnAggregatorOptions = {}) {
    this.options = { maxTurns: 64, maxRequestsPerTurn: 64, idleTimeoutMs: 30_000, pendingTimeoutMs: 30 * 60_000, now: Date.now, ...options }
    for (const key of ['maxTurns', 'maxRequestsPerTurn', 'idleTimeoutMs', 'pendingTimeoutMs'] as const) {
      if (!Number.isFinite(this.options[key]) || this.options[key] <= 0) throw new RangeError(`${key} must be positive and finite`)
    }
  }

  ingest(source: DebugEntry, rawLink?: string): TurnMergeView {
    if (this.disposed) throw new Error('TurnAggregator has been disposed')
    const entry = sanitizeDebugEntry(source)
    // Keep semantic data and matching context; large SSE transcripts stay in the raw log.
    entry.responseText = /^\s*(?:event:|data:)/.test(entry.responseText) ? '' : preview(entry.responseText)
    const response = object(entry.responseJson)
    entry.responseJson = { id: response.id, status: response.status, error: response.error, usage: response.usage }
    const metadata = entry.metadata as TraceMetadata
    let selected = Array.from(this.turns.values()).find(turn => turn.requests.has(metadata.id))
    if (selected) {
      const old = selected.requests.get(metadata.id)!
      // A late pending snapshot must not overwrite a final HTTP capture.
      if (endTime(old.entry) != null && endTime(entry) == null) return buildView(selected)
      selected.requests.set(metadata.id, { entry, rawLink: rawLink ?? old.rawLink, association: old.association })
      selected.traceId ||= metadata.traceId
      selected.touchedAt = this.options.now()
      return buildView(selected)
    }
    let association: TurnAssociation = { kind: 'initial', reason: '独立请求；未找到可确定的关联证据' }
    if (metadata.traceId) {
      selected = Array.from(this.turns.values()).find(turn => turn.traceId === metadata.traceId)
      if (selected) association = { kind: 'trace', reason: '显式 traceId 相同' }
    } else {
      const candidates: { state: TurnState; association: TurnAssociation }[] = []
      for (const state of this.turns.values()) {
        const previous = Array.from(state.requests.values()).sort((a, b) => b.entry.metadata.createdAt - a.entry.metadata.createdAt)[0].entry
        const relation = inferAssociation(previous, entry)
        if (relation) candidates.push({ state, association: relation })
      }
      if (candidates.length === 1) {
        selected = candidates[0].state
        association = candidates[0].association
      } else if (candidates.length > 1) association.reason = '多个请求满足强关联条件；保持独立以避免混合并发轮次'
    }
    if (selected && selected.requests.size >= this.options.maxRequestsPerTurn) {
      this.close(selected, 'capacity')
      selected = undefined
      association = { kind: 'initial', reason: '达到每轮请求上限；新建独立分段' }
    }
    if (!selected) {
      if (this.turns.size >= this.options.maxTurns) {
        const oldest = Array.from(this.turns.values()).sort((a, b) => a.touchedAt - b.touchedAt)[0]
        this.close(oldest, 'capacity')
      }
      selected = { id: `turn-${metadata.id}`, traceId: metadata.traceId, requests: new Map(), touchedAt: this.options.now() }
      this.turns.set(selected.id, selected)
    }
    selected.requests.set(metadata.id, { entry, rawLink, association })
    selected.touchedAt = this.options.now()
    return buildView(selected)
  }

  forget(turnId: string): boolean {
    return this.turns.delete(turnId)
  }

  private close(state: TurnState, status: TurnMergeView['status']): TurnMergeView {
    const view = buildView(state, status)
    this.turns.delete(state.id)
    this.options.onFlush?.(view)
    return view
  }

  /** Keep an existing live trace during tool execution; never creates a turn. */
  touch(traceId: string, now = this.options.now()): void {
    if (this.disposed) return
    for (const state of this.turns.values()) {
      if (state.traceId === traceId) state.touchedAt = now
    }
  }

  flushExpired(now = this.options.now()): TurnMergeView[] {
    const views: TurnMergeView[] = []
    for (const state of Array.from(this.turns.values())) {
      const hasPending = Array.from(state.requests.values()).some(record =>
        (record.entry.metadata as TraceMetadata).captureOutcome === 'pending' || endTime(record.entry) == null)
      const timeout = hasPending ? this.options.pendingTimeoutMs : this.options.idleTimeoutMs
      if (now - state.touchedAt >= timeout) views.push(this.close(state, hasPending ? 'timeout' : 'flushed'))
    }
    return views
  }

  flushAll(reason: TurnMergeView['status'] = 'flushed'): TurnMergeView[] {
    return Array.from(this.turns.values()).map(state => this.close(state, reason))
  }

  dispose(): TurnMergeView[] {
    const views = this.flushAll('disposed')
    this.disposed = true
    this.options.onFlush = undefined
    return views
  }

  get size(): number { return this.turns.size }
}

export function aggregateTurnEntries(entries: readonly DebugEntry[], rawLink?: (entry: DebugEntry) => string | undefined): TurnMergeView[] {
  const completed: TurnMergeView[] = []
  const aggregator = new TurnAggregator({ onFlush: view => completed.push(view) })
  for (const entry of [...entries].sort((a, b) => a.metadata.createdAt - b.metadata.createdAt)) aggregator.ingest(entry, rawLink?.(entry))
  aggregator.flushAll()
  return completed
}

function block(value: unknown): string {
  const text = (typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'null')
    .replace(/[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
  const fence = '~'.repeat(Math.max(3, ...(text.match(/~+/g) || []).map(run => run.length + 1)))
  return `${fence}${typeof value === 'string' ? 'text' : 'json'}\n${text}\n${fence}`
}

function details(label: string, value: unknown): string {
  return `<details>\n<summary>${label}</summary>\n\n${block(value)}\n\n</details>`
}

function displayCount(value: number | null): string { return value == null ? 'unknown' : String(value) }

export function renderTurnMarkdown(source: TurnMergeView): string {
  const view = sanitizeDebugEntry(source)
  const sections = [
    `# Turn / ${view.id}`, '',
    `关联：${view.correlation}${view.traceId ? `；traceId=${view.traceId}` : ''}；状态：${view.status}`,
    `HTTP 请求：${view.requests.length}；input=${displayCount(view.usage.inputTokens)}；output=${displayCount(view.usage.outputTokens)}；cached=${displayCount(view.usage.cachedTokens)}（input 内含）；total=${displayCount(view.usage.totalTokens)}`,
    view.usage.unknownRequestCount ? `有 ${view.usage.unknownRequestCount} 次请求 usage 未完整返回；已知小计：${JSON.stringify(view.usage.knownSubtotal)}` : '',
    '', '## 公共请求上下文', '',
    `endpoint=${view.shared.endpoint}；model=${view.shared.model || 'unknown'}`,
    details('Prompt（首次完整消息）', view.shared.prompt),
    details(`Tools（${view.shared.tools.length}）`, view.shared.tools),
    details('Headers（已脱敏）', view.shared.headers),
    details('首次请求参数', view.shared.parameters),
  ]
  for (const [index, request] of view.requests.entries()) {
    sections.push('', `## HTTP ${index + 1} / ${request.id}`, '',
      `耗时 ${request.durationMs}ms；HTTP ${request.status ?? 'unknown'}；response=${request.responseStatus || 'unknown'}；capture=${request.captureOutcome || 'unknown'}`,
      `关联依据：${request.association.reason}`,
      `usage：input=${displayCount(request.usage.inputTokens)}；output=${displayCount(request.usage.outputTokens)}；cached=${displayCount(request.usage.cachedTokens)}；total=${displayCount(request.usage.totalTokens)}`)
    if (request.rawLink) sections.push(`[单次 raw 记录](<${request.rawLink.replace(/[<>\r\n]/g, '')}>)`)
    if (request.error) sections.push('### 捕获或服务错误', block(request.error))
    if (request.parameterChanges.length) sections.push('### 请求参数 / Headers / Tools 变化', block(request.parameterChanges))
    if (request.inputChanges.length) sections.push('### 输入上下文替换或删除', block(request.inputChanges))
    if (request.newMessages.length) sections.push('### 新增输入消息', block(request.newMessages))
    for (const result of request.newToolResults) sections.push(`### 新增工具结果 / ${result.name || result.callId || 'unknown'}`, block(result.output))
    for (const call of request.newToolCalls) {
      sections.push(`### 新增模型工具调用 / ${call.name}`, `call_id=${call.id || 'unknown'}；status=${call.status || 'unknown'}`)
      if (call.diagnostics) sections.push('参数异常诊断（完整值见单次 raw 记录）', block(call.diagnostics))
      else if (call.parameterChanges.length) sections.push('工具参数变化', block(call.parameterChanges))
      else if (index === 0 || !view.requests.slice(0, index).some(prior => prior.newToolCalls.some(value => value.name === call.name))) {
        sections.push('工具参数', block(call.parameters ?? {}))
      }
      if (call.stateChanges.length) sections.push('角色 state / status 变化', block(call.stateChanges))
      if (call.characterReply) {
        sections.push('#### character_reply.messages 正文', '来源：模型生成的工具参数；发送结果未由此 HTTP 记录证实。',
          ...call.characterReply.texts.map(text => block(text)))
        if (call.characterReply.messages.some(message => !Array.isArray(object(message).content)
          || object(message).content.some((part: unknown) => object(part).type !== 'text'))) {
          sections.push(details('messages 的非文本内容', call.characterReply.messages))
        }
        if (call.characterReply.think) sections.push('#### 工具参数 think', block(call.characterReply.think))
      }
    }
    if (request.responseMessages.length) sections.push('### 模型响应消息', block(request.responseMessages))
    else if (request.responseText) sections.push('### 模型响应文本', block(request.responseText))
    if (request.responseReasoningText) sections.push('### 服务返回的 reasoning', block(request.responseReasoningText))
  }
  return sections.filter(section => section !== '').join('\n\n') + '\n'
}
