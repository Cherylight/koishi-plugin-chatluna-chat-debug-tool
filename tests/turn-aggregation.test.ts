import assert from 'node:assert/strict'
import test from 'node:test'
import { aggregateTurnEntries, diagnoseTurnText, normalizeTurnUsage, renderTurnMarkdown, TurnAggregator } from '../src/turn-aggregation'
import type { DebugEntry, DebugToolCall } from '../src/types'

const prompt = [{ type: 'message', role: 'system', content: 'COMMON_PROMPT_ONCE' },
  { type: 'message', role: 'user', content: 'synthetic user context' }]
const tools = [{ name: 'memory_search', type: 'function', parameters: { type: 'object' } },
  { name: 'character_reply', type: 'function', parameters: { type: 'object' } }]

test('an explicit turn retains top-level instructions and replacements of input context', () => {
  const first = entry('replace-first', 1000)
  const second = entry('replace-second', 1100, [{ type: 'message', role: 'user', content: 'replacement' }])
  first.metadata.traceId = second.metadata.traceId = 'turn-replace-trace'
  ;(first.requestBodyJson as any).instructions = 'instructions once'
  ;(second.requestBodyJson as any).instructions = 'changed instructions'
  const [turn] = aggregateTurnEntries([first, second])
  assert.equal(turn.shared.parameters.instructions, 'instructions once')
  assert.equal(turn.requests[1].inputChanges.length, 1)
  assert.equal(turn.requests[1].inputChanges[0].path, 'input')
  assert(turn.requests[1].parameterChanges.some(change => change.path === 'instructions'))
  assert(renderTurnMarkdown(turn).includes('replacement'))
})

function entry(id: string, createdAt: number, requestInput: unknown[] = prompt): DebugEntry {
  return {
    metadata: { id, createdAt, endAt: createdAt + 10, durationMs: 10, source: 'chatluna',
      method: 'POST', url: 'http://127.0.0.1:8317/v1/responses', model: 'fixture-model',
      requestType: 'responses', status: 200 },
    requestBodyJson: { model: 'fixture-model', input: structuredClone(requestInput), tools: structuredClone(tools), stream: true },
    tools: structuredClone(tools),
    requestMessages: requestInput.filter((item: any) => item.type === 'message').map((item: any) => ({ role: item.role, content: item.content })),
    responseMessages: [], toolCalls: [], toolResults: [], responseText: '', responseJson: { status: 'completed' },
    requestHeaders: { authorization: '[REDACTED]' }, responseHeaders: {},
  }
}

function call(id: string, name = 'memory_search', args = '{"layer":["guild","global"]}'): DebugToolCall {
  return { id, name, arguments: args, source: 'response', status: 'completed' }
}

function appendTool(previous: DebugEntry, outputCall: DebugToolCall, output = 'fixture result'): unknown[] {
  return [
    ...(previous.requestBodyJson as any).input,
    { type: 'function_call', call_id: outputCall.id, name: outputCall.name, arguments: outputCall.arguments, status: 'completed' },
    { type: 'function_call_output', call_id: outputCall.id, output },
  ]
}

test('tool call_id plus complete input prefix groups a chain and history is not emitted again', () => {
  const priorCall = { id: 'old-history', name: 'memory_search', arguments: '{}', source: 'request' as const }
  const first = entry('first', 1000, [...prompt,
    { type: 'function_call', call_id: priorCall.id, name: priorCall.name, arguments: '{}' },
    { type: 'function_call_output', call_id: priorCall.id, output: 'OLD_HISTORY_RESULT' }])
  const search = call('search-1')
  first.toolCalls = [priorCall, search]
  first.toolResults = [{ callId: priorCall.id, output: 'OLD_HISTORY_RESULT', source: 'request' }]
  const second = entry('second', 1100, appendTool(first, search))
  const nextCall = call('search-2', 'memory_search', '{"layer":["global"]}')
  second.toolCalls = [{ ...search, source: 'request' }, nextCall]
  second.toolResults = [...first.toolResults, { callId: search.id, output: 'fixture result', source: 'request' }]
  const third = entry('third', 1200, appendTool(second, nextCall))
  third.toolCalls = [{ ...search, source: 'request' }, { ...nextCall, source: 'request' }]
  third.toolResults = [...second.toolResults, { callId: nextCall.id, output: 'no results', source: 'request' }]
  const turns = aggregateTurnEntries([third, first, second], value => `../json/chat-debug-${value.metadata.id}.json`)
  assert.equal(turns.length, 1)
  const turn = turns[0]
  assert.equal(turn.correlation, 'inferred')
  assert.deepEqual(turn.requests.map(value => value.association.kind), ['initial', 'tool-continuation', 'tool-continuation'])
  assert.deepEqual(turn.requests.map(value => value.newToolCalls.map(item => item.id)), [['search-1'], ['search-2'], []])
  assert.deepEqual(turn.requests.map(value => value.newToolResults.map(item => item.callId)), [[], ['search-1'], ['search-2']])
  assert.deepEqual(turn.requests[1].newToolCalls[0].parameterChanges, [{ path: 'layer', before: ['guild', 'global'], after: ['global'] }])
  const markdown = renderTurnMarkdown(turn)
  assert.equal(markdown.split('COMMON_PROMPT_ONCE').length - 1, 1)
  assert(!markdown.includes('OLD_HISTORY_RESULT'))
  assert(markdown.includes('../json/chat-debug-first.json'))
})

test('901 second failed response and exact retry retain separate attempts and unknown usage', () => {
  const first = entry('failed', 1000)
  first.metadata.endAt = 902000
  first.metadata.durationMs = 901000
  first.metadata.usage = null
  first.responseJson = { status: 'failed', error: { code: 'request_timeout' } }
  first.toolCalls = [call('partial', 'character_reply', '{' + '\u202c'.repeat(19850))]
  first.toolCalls[0].status = 'in_progress'
  const retry = entry('retry', 904000)
  retry.metadata.usage = { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 80 }, total_tokens: 110 }
  retry.toolCalls = [call('completed', 'character_reply', '{"messages":[{"content":[{"type":"text","text":"RETRY_BODY"}]}],"is_final":true}')]
  const [turn] = aggregateTurnEntries([first, retry])
  assert.equal(turn.requests.length, 2)
  assert.equal(turn.requests[1].association.kind, 'exact-retry')
  assert.equal(turn.requests[0].usage.inputTokens, null)
  assert.equal(turn.usage.totalTokens, null)
  assert.equal(turn.usage.knownSubtotal.totalTokens, 110)
  assert.equal(turn.usage.unknownRequestCount, 1)
  assert.equal(turn.requests[0].newToolCalls[0].diagnostics?.controlCounts['U+202C'], 19850)
  assert.equal(turn.requests[0].newToolCalls[0].diagnostics?.longestRun.length, 19850)
  const markdown = renderTurnMarkdown(turn)
  assert(markdown.includes('request_timeout'))
  assert(markdown.includes('RETRY_BODY'))
  assert(markdown.includes('U+202C'))
  assert(!markdown.includes('\u202c'))
  assert(markdown.length < 12_000)
})

test('unknown usage remains unknown and cached tokens are already included in input', () => {
  assert.deepEqual(normalizeTurnUsage(entry('missing', 1000)), {
    inputTokens: null, outputTokens: null, cachedTokens: null, totalTokens: null,
  })
  const sample = entry('usage', 1000)
  sample.metadata.usage = { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 70 } }
  assert.deepEqual(normalizeTurnUsage(sample), { inputTokens: 100, outputTokens: 20, cachedTokens: 70, totalTokens: 120 })
  const [turn] = aggregateTurnEntries([sample])
  assert.equal(turn.usage.totalTokens, 120)
})

test('pending to final replaces usage for the same HTTP id exactly once', () => {
  const aggregator = new TurnAggregator()
  const pending = entry('same-id', 1000)
  delete pending.metadata.endAt
  pending.metadata.durationMs = 17
  pending.metadata.captureOutcome = 'pending'
  delete pending.responseJson
  aggregator.ingest(pending, '../json/original.json')
  const final = entry('same-id', 1000)
  final.metadata.usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 } }
  const updated = aggregator.ingest(final)
  assert.equal(updated.requests.length, 1)
  assert.equal(updated.usage.totalTokens, 15)
  assert.equal(updated.requests[0].rawLink, '../json/original.json')
  assert.equal(aggregator.ingest(pending).usage.totalTokens, 15)
  aggregator.dispose()
})

test('changed context, endpoint, tools, overlapping requests and successful duplicate requests stay independent', () => {
  const first = entry('first', 1000)
  first.toolCalls = [call('shared-id')]
  for (const variation of ['context', 'endpoint', 'tools', 'overlap', 'changed-prefix', 'new-user-message', 'same-successful-request']) {
    const next = entry('next', 1200, appendTool(first, first.toolCalls[0]))
    if (variation === 'context') (next.requestBodyJson as any).input[1].content = 'different user context'
    if (variation === 'endpoint') next.metadata.url = 'http://other-endpoint/v1/responses'
    if (variation === 'tools') (next.requestBodyJson as any).tools.push({ name: 'other-tool' })
    if (variation === 'overlap') next.metadata.createdAt = 1005
    if (variation === 'changed-prefix') (next.requestBodyJson as any).input.shift()
    if (variation === 'new-user-message') (next.requestBodyJson as any).input.push({ type: 'message', role: 'user', content: 'a new turn' })
    if (variation === 'same-successful-request') next.requestBodyJson = structuredClone(first.requestBodyJson)
    assert.equal(aggregateTurnEntries([first, next]).length, 2, variation)
  }
})

test('two equally strong failure candidates do not claim an ambiguous retry', () => {
  const a = entry('a', 1000), b = entry('b', 1005), retry = entry('retry', 1200)
  a.responseJson = { status: 'failed' }
  b.responseJson = { status: 'failed' }
  const turns = aggregateTurnEntries([a, b, retry])
  assert.equal(turns.length, 3)
  assert.match(turns[2].requests[0].association.reason, /多个/)
})

test('explicit trace overrides inference, separates sibling traces, and reports parameter changes', () => {
  const a = entry('a', 1000), b = entry('b', 1010), c = entry('c', 1200)
  Object.assign(a.metadata, { traceId: 'trace-a', parentTraceId: 'root-trace' })
  Object.assign(b.metadata, { traceId: 'trace-b', parentTraceId: 'root-trace' })
  Object.assign(c.metadata, { traceId: 'trace-a', callRunId: 'model-run-c' })
  ;(c.requestBodyJson as any).temperature = 0.5
  const turns = aggregateTurnEntries([a, b, c])
  assert.equal(turns.length, 2)
  const merged = turns.find(turn => turn.traceId === 'trace-a')!
  assert.equal(merged.requests.length, 2)
  assert.equal(merged.requests[1].association.kind, 'trace')
  assert.equal(merged.requests[1].callRunId, 'model-run-c')
  assert.deepEqual(merged.requests[1].parameterChanges, [{ path: 'temperature', before: null, after: 0.5 }])
})

test('character_reply displays body, field think and state delta without claiming delivery', () => {
  const first = entry('first', 1000)
  const firstCall = call('reply-1', 'character_reply', JSON.stringify({ messages: [{ content: [{ type: 'text', text: 'First reply body' }] }],
    status: JSON.stringify({ mood: 'calm', score: 1 }), think: 'TOOL_FIELD_THINK', is_final: false }))
  first.toolCalls = [firstCall]
  const second = entry('second', 1100, appendTool(first, firstCall))
  second.toolCalls = [call('reply-2', 'character_reply', JSON.stringify({ messages: [{ content: [{ type: 'text', text: 'Second reply body' }] }],
    status: JSON.stringify({ mood: 'calm', score: 2 }), think: 'TOOL_FIELD_THINK', is_final: true }))]
  const [turn] = aggregateTurnEntries([first, second])
  assert.deepEqual(turn.requests[1].newToolCalls[0].stateChanges, [{ path: 'score', before: 1, after: 2 }])
  assert.equal(turn.requests[1].newToolCalls[0].characterReply?.delivery, 'not-observed')
  const markdown = renderTurnMarkdown(turn)
  assert(markdown.includes('First reply body'))
  assert(markdown.includes('Second reply body'))
  assert(markdown.includes('工具参数 think'))
  assert(markdown.includes('发送结果未由此 HTTP 记录证实'))
  assert(!markdown.includes('发送成功'))
})

test('sanitized merge view and markdown retain raw links but omit encrypted values', () => {
  const source = entry('cipher', 1000)
  const cipher = 'OPAQUE_FIXTURE_MUST_NEVER_LEAK'
  ;(source.requestBodyJson as any).input.push({ type: 'reasoning', encrypted_content: cipher })
  source.responseJson = { status: 'completed', output: [{ type: 'reasoning', encrypted_content: cipher }] }
  source.toolCalls = [call('safe-call', 'echo', JSON.stringify({ encrypted_content: cipher, text: 'SAFE_TEXT' }))]
  const [turn] = aggregateTurnEntries([source], value => `../json/chat-debug-${value.metadata.id}.json`)
  for (const text of [JSON.stringify(turn), renderTurnMarkdown(turn)]) {
    assert(!text.includes(cipher))
    assert(!text.includes('encrypted_content'))
    assert(text.includes('../json/chat-debug-cipher.json'))
    assert(text.includes('SAFE_TEXT'))
  }
  assert((source.responseJson as any).output[0].encrypted_content === cipher, 'debug view must not mutate source')
})

test('diagnostics count code points, bidi controls and repeated runs with bounded escaped excerpts', () => {
  const value = diagnoseTurnText('😺' + '\u202c'.repeat(2000), 'args')
  assert.equal(value.utf16Length, 2002)
  assert.equal(value.codePointCount, 2001)
  assert.equal(value.controlCounts['U+202C'], 2000)
  assert.equal(value.longestRun.length, 2000)
  assert(value.escapedPreview.length < 500)
  assert(!value.escapedPreview.includes('\u202c'))
})

test('capacity, expiry and dispose bound state and report final views without timers', () => {
  let now = 0
  const flushed: any[] = []
  const aggregator = new TurnAggregator({ maxTurns: 1, maxRequestsPerTurn: 2, idleTimeoutMs: 20,
    now: () => now, onFlush: view => flushed.push(view) })
  aggregator.ingest(entry('a', 1000))
  now = 10
  aggregator.ingest(entry('b', 1100))
  assert.equal(aggregator.size, 1)
  assert.equal(flushed[0].status, 'capacity')
  now = 40
  assert.equal(aggregator.flushExpired()[0].status, 'flushed')
  assert.equal(aggregator.size, 0)
  aggregator.ingest(entry('c', 1200))
  assert.equal(aggregator.dispose()[0].status, 'disposed')
  assert.equal(aggregator.size, 0)
  assert.throws(() => aggregator.ingest(entry('d', 1300)), /disposed/)
})

test('pending HTTP survives idle expiry until its separate TTL and can finish after 901 seconds', () => {
  let now = 0
  const aggregator = new TurnAggregator({ idleTimeoutMs: 30_000, pendingTimeoutMs: 30 * 60_000, now: () => now })
  const pending = entry('long-request', 1000)
  delete pending.metadata.endAt
  pending.metadata.durationMs = 0
  Object.assign(pending.metadata, { captureOutcome: 'pending' })
  aggregator.ingest(pending)
  now = 901000
  assert.deepEqual(aggregator.flushExpired(), [])
  const final = entry('long-request', 1000)
  final.metadata.endAt = 902000
  final.metadata.durationMs = 901000
  Object.assign(final.metadata, { captureOutcome: 'failed', responseStatus: 'failed', errorCode: 'request_timeout' })
  aggregator.ingest(final)
  assert.equal(aggregator.size, 1)
  now += 30001
  const archived = aggregator.flushExpired()[0]
  assert.equal(archived.requests[0].errorCode, 'request_timeout')
  assert.equal(archived.status, 'flushed')
  aggregator.ingest(pending)
  now += 30 * 60_000 + 1
  assert.equal(aggregator.flushExpired()[0].status, 'timeout')
})

test('touch keeps an existing trace alive during tool work and never creates new state', () => {
  let now = 0
  const aggregator = new TurnAggregator({ idleTimeoutMs: 30_000, now: () => now })
  aggregator.touch('unknown-trace')
  assert.equal(aggregator.size, 0)
  const request = entry('tool-start', 1000)
  Object.assign(request.metadata, { traceId: 'active-tool-trace' })
  aggregator.ingest(request)
  now = 20_000
  aggregator.touch('active-tool-trace')
  now = 40_000
  assert.deepEqual(aggregator.flushExpired(), [])
  aggregator.touch('active-tool-trace', 100_000)
  assert.deepEqual(aggregator.flushExpired(120_000), [])
  assert.equal(aggregator.flushExpired(130_001)[0].status, 'flushed')
  assert.equal(aggregator.size, 0)
  aggregator.touch('active-tool-trace')
  assert.equal(aggregator.size, 0)
  aggregator.dispose()
  aggregator.touch('unknown-trace')
  assert.equal(aggregator.size, 0)
})
