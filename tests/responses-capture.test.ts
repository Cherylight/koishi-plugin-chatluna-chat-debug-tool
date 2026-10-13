const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const test = require('node:test')
const esbuild = module.require('esbuild')

const sourceDirectory = path.join(__dirname, '..', 'src')
function compileModule(source, filename, bundle = false) {
  const code = bundle
    ? esbuild.buildSync({ stdin: { contents: source, resolveDir: sourceDirectory, sourcefile: filename, loader: 'ts' }, bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external' }).outputFiles[0].text
    : esbuild.transformSync(source, { loader: 'ts', format: 'cjs', platform: 'node' }).code
  const module = new Module(filename)
  module.paths = Module._nodeModulePaths(path.dirname(filename))
  module._compile(code, filename)
  return module.exports
}

const capturePath = path.join(sourceDirectory, 'responses-capture.ts')
const capture = compileModule(fs.readFileSync(capturePath, 'utf8'), capturePath)
const hookPath = path.join(sourceDirectory, 'chatluna-hook.ts')
const hook = compileModule(fs.readFileSync(hookPath, 'utf8') + '\nexport { aggregateSsePayload, extractStructuredResponse, readResponseBody }\n', hookPath, true)
const { parseSseFrames, aggregateResponsesSsePayload, extractResponsesReasoningText } = capture

const reasoning = (id, text) => ({ type: 'reasoning', id, status: 'completed', summary: [{ type: 'summary_text', text }], encrypted_content: 'synthetic opaque state' })
const message = (id, text) => ({ type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] })
const tool = (id, callId, name, args) => ({ type: 'function_call', id, call_id: callId, name, arguments: args, status: 'completed' })
const frame = (type, data, multiline = false) => {
  const json = JSON.stringify({ type, ...data }, null, multiline ? 2 : 0)
  return `event: ${type}\n${json.split('\n').map(line => `data: ${line}`).join('\n')}\n\n`
}
const response = output => ({ id: 'response_test', object: 'response', model: 'grok-4.7', status: 'completed', input: [{ type: 'message', role: 'user', content: 'question' }], output, usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } })

test('SSE parser joins multiline data and handles CRLF, comments, BOM, and EOF', () => {
  const raw = '\uFEFF: heartbeat\r\nevent: response.output_text.delta\r\nid: event-1\r\ndata: {\r\ndata: "delta": "你好"\r\ndata: }\r\n\r\ndata: [DONE]'
  const frames = parseSseFrames(raw)
  assert.equal(frames.length, 2)
  assert.equal(frames[0].event, 'response.output_text.delta')
  assert.equal(frames[0].id, 'event-1')
  assert.equal(JSON.parse(frames[0].data).delta, '你好')
  assert.equal(frames[1].data, '[DONE]')
})

test('standard Responses stream has text, reasoning, tool calls, metadata, and raw byte counts', async () => {
  const output = [reasoning('r0', 'Think carefully'), tool('f0', 'call0', 'character_reply', '{"value":"ok"}'), message('m0', '你好')]
  const raw = frame('response.created', { response: { id: 'response_test', object: 'response', model: 'grok-4.7', status: 'in_progress', output: [] } })
    + frame('response.output_item.added', { output_index: 0, item: { type: 'reasoning', id: 'r0' } })
    + frame('response.reasoning_summary_text.delta', { output_index: 0, summary_index: 0, item_id: 'r0', delta: 'Think carefully' })
    + frame('response.output_item.done', { output_index: 0, item: output[0] })
    + frame('response.output_item.added', { output_index: 1, item: { ...output[1], arguments: '' } })
    + frame('response.function_call_arguments.delta', { output_index: 1, item_id: 'f0', delta: '{"value":' })
    + frame('response.function_call_arguments.delta', { output_index: 1, item_id: 'f0', delta: '"ok"}' })
    + frame('response.function_call_arguments.done', { output_index: 1, item_id: 'f0', arguments: output[1].arguments })
    + frame('response.output_text.delta', { output_index: 2, content_index: 0, item_id: 'm0', delta: '你好' })
    + frame('response.completed', { response: response(output) }, true) + 'data: [DONE]\n\n'
  const result = hook.aggregateSsePayload(raw, new Set(['character_reply']))
  assert.equal(result.parsed, true)
  assert.equal(result.text, '你好')
  assert.equal(result.reasoningText, 'Think carefully')
  assert.deepEqual(result.json.output.map(item => item.type), ['reasoning', 'function_call', 'message'])
  assert.deepEqual(result.json.usage, response(output).usage)
  assert.equal(result.json.status, 'completed')
  assert.equal(result.json.id, 'response_test')
  assert.equal(result.json.model, 'grok-4.7')
  assert.deepEqual(result.json.input, response(output).input)
  const transport = new Response(raw, { headers: { 'content-type': 'text/event-stream' } })
  const captured = await hook.readResponseBody(transport.clone())
  assert.equal(captured.bytes, Buffer.byteLength(raw, 'utf8'))
  assert.equal(captured.text, '你好')
  assert.equal(await transport.text(), raw)
  const structured = hook.extractStructuredResponse(result.json)
  assert.equal(structured.messages[0].content, '你好')
  assert.equal(structured.toolCalls[0].id, 'call0')
  assert.equal(structured.toolCalls[0].name, 'character_reply')
  assert.equal(structured.toolCalls[0].arguments, '{"value":"ok"}')
  assert.equal(structured.reasoningText, 'Think carefully')
})

test('delta-only tool arguments and reasoning are reconstructed without a completed event', () => {
  const raw = frame('response.output_item.added', { output_index: 0, item: { type: 'reasoning', id: 'r0' } })
    + frame('response.reasoning_text.delta', { output_index: 0, item_id: 'r0', content_index: 0, delta: 'First ' })
    + frame('response.reasoning_text.delta', { output_index: 0, item_id: 'r0', content_index: 0, delta: 'thought' })
    + frame('response.output_item.added', { output_index: 1, item: { type: 'function_call', id: 'f0', call_id: 'call0', name: 'probe', arguments: '' } })
    + frame('response.function_call_arguments.delta', { item_id: 'f0', delta: '{"n":' })
    + frame('response.function_call_arguments.delta', { item_id: 'f0', delta: '1}' })
  const result = aggregateResponsesSsePayload(raw)
  assert.equal(result.reasoningText, 'First thought')
  assert.equal(result.json.output[1].arguments, '{"n":1}')
  assert.equal(result.json.output[1].call_id, 'call0')
})

test('done and completed snapshots replace fragments and do not duplicate output items', () => {
  const output = [reasoning('r0', 'Only once'), tool('f0', 'call0', 'probe', '{}'), message('m0', 'Answer')]
  const raw = frame('response.output_item.added', { output_index: 0, item: { type: 'reasoning', id: 'r0' } })
    + frame('response.reasoning_summary_text.delta', { sequence_number: 1, output_index: 0, item_id: 'r0', delta: 'Only once' })
    + frame('response.reasoning_summary_text.delta', { sequence_number: 1, output_index: 0, item_id: 'r0', delta: 'Only once' })
    + frame('response.reasoning_summary_text.done', { output_index: 0, item_id: 'r0', text: 'Only once' })
    + frame('response.output_item.done', { output_index: 0, item: output[0] })
    + frame('response.output_item.done', { output_index: 1, item: output[1] })
    + frame('response.output_text.delta', { output_index: 2, delta: 'Answer' })
    + frame('response.output_text.done', { output_index: 2, text: 'Answer' })
    + frame('response.completed', { response: response(output) })
  const result = aggregateResponsesSsePayload(raw)
  assert.equal(result.text, 'Answer')
  assert.equal(result.reasoningText, 'Only once')
  assert.equal(result.json.output.length, 3)
})

test('summary and original reasoning channels display one copy while retaining both in JSON', () => {
  const raw = frame('response.output_item.added', { output_index: 0, item: { type: 'reasoning', id: 'r0' } })
    + frame('response.reasoning_summary_text.delta', { output_index: 0, item_id: 'r0', summary_index: 0, delta: 'Thought' })
    + frame('response.reasoning_text.delta', { output_index: 0, item_id: 'r0', content_index: 0, delta: 'Thought' })
  const result = aggregateResponsesSsePayload(raw)
  assert.equal(result.reasoningText, 'Thought')
  assert.equal(result.json.output[0].summary[0].text, 'Thought')
  assert.equal(result.json.output[0].content[0].text, 'Thought')
})

test('multiple reasoning, text, and tool items retain final output order', () => {
  const output = [message('m0', 'A'), reasoning('r0', 'R1'), tool('f0', 'call0', 'first', '{}'), reasoning('r1', 'R2'), message('m1', 'B'), tool('f1', 'call1', 'second', '{}')]
  const raw = output.map((item, index) => frame('response.output_item.done', { output_index: index, item })).reverse().join('')
    + frame('response.completed', { response: response(output) })
  const result = aggregateResponsesSsePayload(raw)
  assert.equal(result.text, 'A\n\nB')
  assert.equal(result.reasoningText, 'R1\n\nR2')
  assert.deepEqual(result.json.output.map(item => item.id), output.map(item => item.id))
})

test('refusal deltas and final content are captured as visible response text', () => {
  const raw = frame('response.refusal.delta', { output_index: 0, content_index: 0, item_id: 'm0', delta: 'Cannot ' })
    + frame('response.refusal.delta', { output_index: 0, content_index: 0, item_id: 'm0', delta: 'help' })
    + frame('response.refusal.done', { output_index: 0, content_index: 0, item_id: 'm0', refusal: 'Cannot help' })
  const result = aggregateResponsesSsePayload(raw)
  assert.equal(result.text, 'Cannot help')
  assert.equal(hook.extractStructuredResponse(result.json).messages[0].content, 'Cannot help')
})

test('part events and event-name-only SSE payloads work without a JSON type field', () => {
  const raw = 'event: response.output_text.delta\ndata: {"output_index":0,"item_id":"m0","delta":"Text"}\n\n'
    + frame('response.reasoning_summary_part.done', { output_index: 1, item_id: 'r0', summary_index: 0, part: { type: 'summary_text', text: 'Summary' } })
  const result = aggregateResponsesSsePayload(raw)
  assert.equal(result.text, 'Text')
  assert.equal(result.reasoningText, 'Summary')
})

test('failed, incomplete, and error events preserve status, error, usage, and partial output', () => {
  for (const status of ['failed', 'incomplete']) {
    const raw = frame('response.created', { response: { id: 'r0', status: 'in_progress' } })
      + frame('response.output_text.delta', { output_index: 0, delta: 'Partial' })
      + frame(`response.${status}`, { response: { id: 'r0', status, error: { code: 'test_error', message: 'failure' }, incomplete_details: { reason: 'max_output_tokens' }, usage: { output_tokens: 1 }, output: [] } })
    const result = aggregateResponsesSsePayload(raw)
    assert.equal(result.json.status, status)
    assert.equal(result.json.error.code, 'test_error')
    assert.equal(result.json.usage.output_tokens, 1)
    assert.equal(result.text, 'Partial')
  }
  const result = aggregateResponsesSsePayload(frame('error', { code: 'invalid_request', message: 'failure' }))
  assert.equal(result.json.status, 'failed')
  assert.equal(result.json.error.code, 'invalid_request')
})

test('unknown or malformed SSE retains the original response and its raw UTF8 byte count', async () => {
  for (const raw of ['data: {"type":"vendor.custom","delta":"未知"}\n\n', 'data: {bad json}\n\n']) {
    const result = await hook.readResponseBody(new Response(raw, { headers: { 'content-type': 'text/event-stream' } }))
    assert.equal(result.text, raw)
    assert.equal(result.bytes, Buffer.byteLength(raw, 'utf8'))
    assert.equal(result.json, undefined)
  }
  const mixed = frame('response.created', { response: { id: 'r0', status: 'in_progress' } }) + 'data: {"type":"vendor.custom","delta":"未知"}\n\n'
  const captured = await hook.readResponseBody(new Response(mixed, { headers: { 'content-type': 'text/event-stream' } }))
  assert.equal(captured.text, mixed)
  assert.equal(captured.json.id, 'r0')
  assert.deepEqual(captured.json.debug_sse.unknown_event_types, ['vendor.custom'])
})

test('legacy Chat Completions reasoning and incremental tool arguments remain compatible', async () => {
  const values = [
    { id: 'chat0', object: 'chat.completion.chunk', model: 'legacy', choices: [{ delta: { reasoning_content: 'Thought' } }] },
    { id: 'chat0', object: 'chat.completion.chunk', choices: [{ delta: { content: 'Hello', tool_calls: [{ index: 0, id: 'call0', type: 'function', function: { name: 'character_', arguments: '{"a":' } }] } }] },
    { id: 'chat0', object: 'chat.completion.chunk', choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'reply', arguments: '1}' } }] } }] },
    { id: 'chat0', object: 'chat.completion.chunk', choices: [], usage: { total_tokens: 7 } },
  ]
  const raw = values.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n'
  const result = hook.aggregateSsePayload(raw, new Set(['character_reply']))
  assert.equal(result.text, 'Hello')
  assert.equal(result.reasoningText, 'Thought')
  assert.equal(result.json.choices[0].message.tool_calls[0].function.name, 'character_reply')
  assert.equal(result.json.choices[0].message.tool_calls[0].function.arguments, '{"a":1}')
  assert.equal(result.json.usage.total_tokens, 7)
  const captured = await hook.readResponseBody(new Response(raw, { headers: { 'content-type': 'text/event-stream' } }), new Set(['character_reply']))
  assert.equal(captured.bytes, Buffer.byteLength(raw))
})

test('nonstream Responses reasoning is extracted and capture does not alter opaque transport fields', () => {
  const output = [reasoning('r0', 'Summary'), message('m0', 'Answer')]
  const body = response(output)
  const original = JSON.stringify(body)
  assert.equal(extractResponsesReasoningText(body.output), 'Summary')
  assert.equal(hook.extractStructuredResponse(body).reasoningText, 'Summary')
  const result = aggregateResponsesSsePayload(frame('response.completed', { response: body }))
  assert.equal(result.json.output[0].encrypted_content, body.output[0].encrypted_content)
  assert.equal(JSON.stringify(body), original)
})
