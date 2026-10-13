import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ChatLunaPlugin } from 'koishi-plugin-chatluna/services/chat'
import { Config } from '../src/config'
import { installChatlunaDebugHook } from '../src/chatluna-hook'
import { DEBUG_LOG_TABLE } from '../src/storage'
import type { DebugEntry } from '../src/types'

// Entirely synthetic fixtures: no credentials, remote services or bot messages.
const cipher = 'HOOK_FIXTURE_OPAQUE_VALUE_MUST_NOT_BE_STORED'
const authorization = 'Bearer HOOK_FIXTURE_AUTHORIZATION'
const tempPrefix = 'chat-debug-hook-e2e-'

interface Snapshot {
  row: any
  markdown: string
  jsonText: string
  entry: DebugEntry
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

async function waitFor(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert(Date.now() < deadline, description)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function assertSafeCopy(snapshot: Snapshot) {
  for (const [name, text] of Object.entries({
    markdown: snapshot.markdown,
    json: snapshot.jsonText,
    index: JSON.stringify(snapshot.row),
  })) {
    assert(!text.includes(cipher), `${name} must not contain the opaque fixture value`)
    assert(!/["']encrypted_content["']\s*:/.test(text.replace(/\\+"/g, '"')),
      `${name} must not contain an excluded JSON property`)
    assert(!text.includes(authorization), `${name} must not contain the authorization fixture`)
  }
}

function requestPayload(stream: boolean) {
  return {
    model: 'grok-4.7',
    stream,
    include: ['reasoning.encrypted_content'],
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply OK.' }] },
      { type: 'reasoning', id: 'request_reasoning', encrypted_content: cipher,
        summary: [{ type: 'summary_text', text: 'request visible thought' }] },
      { type: 'function_call_output', call_id: 'prior_call',
        output: JSON.stringify({ encrypted_content: cipher, result: 'previous OK' }) },
    ],
    tools: [{ type: 'function', name: 'echo_probe', description: 'Inert test tool',
      parameters: { type: 'object', properties: { value: { type: 'string' } } } }],
  }
}

function responsePayload() {
  return {
    id: 'response_hook_fixture',
    object: 'response',
    model: 'grok-4.7-build',
    status: 'completed',
    output: [
      { type: 'reasoning', id: 'response_reasoning', status: 'completed',
        encrypted_content: cipher,
        summary: [{ type: 'summary_text', text: 'visible response thought' }] },
      { type: 'function_call', id: 'function_item', call_id: 'call_echo',
        name: 'echo_probe', status: 'completed',
        arguments: JSON.stringify({ encrypted_content: cipher, value: 'OK' }) },
      { type: 'message', id: 'message_item', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'OK 测试' }] },
    ],
    usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
  }
}

function sseResponseText() {
  const response = responsePayload()
  const frame = (data: any) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`
  return [
    frame({ type: 'response.created', response: { id: response.id, model: response.model, status: 'in_progress' } }),
    frame({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'visible response thought' }),
    frame({ type: 'response.output_item.done', output_index: 0, item: response.output[0] }),
    frame({ type: 'response.output_item.added', output_index: 1,
      item: { ...response.output[1], arguments: '', status: 'in_progress' } }),
    frame({ type: 'response.function_call_arguments.delta', output_index: 1,
      delta: response.output[1].arguments }),
    frame({ type: 'response.function_call_arguments.done', output_index: 1,
      arguments: response.output[1].arguments }),
    frame({ type: 'response.output_item.done', output_index: 1, item: response.output[1] }),
    frame({ type: 'response.output_text.delta', output_index: 2, delta: 'OK 测试' }),
    frame({ type: 'response.output_item.done', output_index: 2, item: response.output[2] }),
    frame({ type: 'response.completed', response }),
    'data: [DONE]\n\n',
  ].join('')
}

function chunkedResponse(rawText: string, contentType: string) {
  const bytes = new TextEncoder().encode(rawText)
  // Split JSON/SSE frames and UTF-8 characters across transport chunks.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 17) {
        controller.enqueue(bytes.slice(offset, offset + 17))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}

async function makeHarness() {
  const tempParent = await fs.realpath(os.tmpdir())
  const baseDir = await fs.mkdtemp(path.join(tempParent, tempPrefix))
  const snapshots: Snapshot[] = []
  const rows = new Map<string, any>()
  const ctx = {
    baseDir,
    chatluna: {},
    database: {
      async upsert(table: string, values: any[]) {
        assert.equal(table, DEBUG_LOG_TABLE)
        for (const row of values) {
          const root = path.resolve(baseDir) + path.sep
          assert(path.resolve(row.filePath).startsWith(root), 'Markdown must stay in this test root')
          assert(path.resolve(row.jsonPath).startsWith(root), 'JSON must stay in this test root')
          const [markdown, jsonText] = await Promise.all([
            fs.readFile(row.filePath, 'utf8'), fs.readFile(row.jsonPath, 'utf8'),
          ])
          const snapshot = { row: structuredClone(row), markdown, jsonText, entry: JSON.parse(jsonText) }
          snapshots.push(snapshot)
          rows.set(row.id, structuredClone(row))
        }
      },
      async remove(table: string, query: { id: string }) {
        assert.equal(table, DEBUG_LOG_TABLE)
        rows.delete(query.id)
      },
    },
  }
  const config = Config({ enabled: true, captureEnabled: true, capturePendingRequests: true })
  assert.deepEqual(config.excludeJsonFields, ['encrypted_content'])
  return {
    ctx, config, snapshots, rows,
    async cleanup() {
      // Only remove the unique directory created by this test, after validating
      // its absolute canonical parent and prefix. Never inspect/delete old data.
      const resolved = await fs.realpath(baseDir)
      assert.equal(path.dirname(resolved), tempParent)
      assert(path.basename(resolved).startsWith(tempPrefix))
      assert.equal(path.resolve(resolved), path.resolve(baseDir))
      await fs.rm(resolved, { recursive: true, force: true })
    },
  }
}

for (const mode of ['sse', 'json'] as const) {
  test(`actual debug hook filters pending and completed ${mode} files without changing transport`, async () => {
    const harness = await makeHarness()
    const prototype = (ChatLunaPlugin as any).prototype
    const previousFetch = prototype.fetch
    const gate = deferred<Response>()
    const originalPayload = requestPayload(mode === 'sse')
    const rawRequest = JSON.stringify(originalPayload)
    const payloadBefore = JSON.stringify(originalPayload)
    const rawResponse = mode === 'sse' ? sseResponseText() : JSON.stringify(responsePayload())
    const originalResponse = chunkedResponse(rawResponse, mode === 'sse' ? 'text/event-stream' : 'application/json')
    const init = Object.freeze({ method: 'POST', body: rawRequest, headers: Object.freeze({ Authorization: authorization }) })
    const info = mode === 'json' ? new Request('https://offline.invalid/v1/responses', init) : 'https://offline.invalid/v1/responses'
    const plugin = Object.create(prototype)
    let observedBytes: Buffer | undefined
    let observedThis: unknown
    let observedInfo: unknown
    let observedInit: unknown
    let responsePromise: Promise<Response> | undefined
    let installed: ReturnType<typeof installChatlunaDebugHook> | undefined
    try {
      prototype.fetch = async function mockFetch(passedInfo: any, passedInit: any) {
        observedThis = this
        observedInfo = passedInfo
        observedInit = passedInit
        observedBytes = passedInfo instanceof Request
          ? Buffer.from(await passedInfo.clone().arrayBuffer())
          : Buffer.from(passedInit.body)
        return gate.promise
      }
      const mockFetch = prototype.fetch
      installed = installChatlunaDebugHook(harness.ctx as any, harness.config)
      assert(installed.installed)
      responsePromise = plugin.fetch(info, mode === 'json' ? undefined : init)
      await waitFor(() => harness.snapshots.length === 1 && observedBytes !== undefined, 'pending log must be saved before mock response release')
      const pending = harness.snapshots[0]
      assertSafeCopy(pending)
      assert.equal(pending.row.status, undefined)
      assert.equal(pending.entry.responseMessages.length, 0)
      assert.equal(Object.entries(pending.entry.requestHeaders)
        .find(([name]) => name.toLowerCase() === 'authorization')?.[1], '[REDACTED]')
      assert.deepEqual(pending.entry.requestBodyJson && (pending.entry.requestBodyJson as any).include, ['reasoning.encrypted_content'])
      assert.equal(observedBytes!.equals(Buffer.from(rawRequest)), true, 'original fetch must receive unchanged request bytes')
      assert.strictEqual(observedThis, plugin)
      assert.strictEqual(observedInfo, info)
      assert.strictEqual(observedInit, mode === 'json' ? undefined : init)

      gate.resolve(originalResponse)
      const returned = await responsePromise
      assert(returned instanceof Response)
      assert.equal(returned.status, originalResponse.status)
      assert.equal(returned.url, originalResponse.url)
      assert.deepEqual([...returned.headers], [...originalResponse.headers])
      const callerText = await returned.text()
      assert.equal(callerText, rawResponse, 'caller stream must remain byte-for-byte readable')
      assert(callerText.includes(cipher), 'opaque state must remain available to the actual caller')
      await waitFor(() => harness.snapshots.some(snapshot => snapshot.row.status === 200), 'completed log must be saved')
      assert.equal(harness.snapshots.length, 2)
      harness.snapshots.forEach(assertSafeCopy)
      const completed = harness.snapshots[1]
      assert.equal(completed.row.id, pending.row.id)
      assert.equal(harness.rows.size, 1, 'completed entry must replace its pending index')
      assert.equal(completed.entry.responseMessages.length, 1)
      assert.equal(completed.entry.responseText, 'OK 测试')
      assert.equal(completed.entry.responseReasoningText, 'visible response thought')
      assert.equal(completed.entry.toolCalls.filter(call => call.source === 'response').length, 1)
      const call = completed.entry.toolCalls.find(call => call.source === 'response')!
      assert.equal(call.name, 'echo_probe')
      assert.deepEqual(JSON.parse(call.arguments!), { value: 'OK' })
      assert.equal(completed.entry.toolResults.length, 1)
      assert.deepEqual(JSON.parse(completed.entry.toolResults[0].output), { result: 'previous OK' })
      assert(completed.row.summary.includes('OK 测试'))
      assert.equal(completed.row.requestBytes, Buffer.byteLength(rawRequest))
      assert.equal(completed.row.responseBytes, Buffer.byteLength(rawResponse))
      assert.equal(JSON.stringify(originalPayload), payloadBefore)
      assert.equal(originalPayload.input[1].encrypted_content, cipher)
      await installed.uninstall()
      installed = undefined
      assert.strictEqual(prototype.fetch, mockFetch, 'uninstall must restore the original fetch implementation')
    } finally {
      gate.resolve(originalResponse)
      if (responsePromise) {
        const returned = await responsePromise.catch(() => undefined)
        if (returned && !returned.bodyUsed) await returned.text().catch(() => undefined)
        // Persistence intentionally runs in the background. Even a failed
        // assertion must let that operation settle before deleting its files.
        await waitFor(() => harness.snapshots.some(snapshot => snapshot.row.status === 200 || snapshot.row.error),
          'background capture must settle before test cleanup').catch(() => undefined)
      }
      await installed?.uninstall()
      prototype.fetch = previousFetch
      await harness.cleanup()
    }
  })
}

test('actual debug hook sanitizes rejected request files while preserving the caller error and body', async () => {
  const harness = await makeHarness()
  const prototype = (ChatLunaPlugin as any).prototype
  const previousFetch = prototype.fetch
  const gate = deferred<Response>()
  const rawRequest = JSON.stringify(requestPayload(true))
  const requestBytes = new TextEncoder().encode(rawRequest)
  const init = Object.freeze({ method: 'POST', body: requestBytes, headers: { Authorization: authorization } })
  const error = new Error(`Synthetic request failure: ${JSON.stringify({ encrypted_content: cipher, code: 'FIXTURE_FAILURE' })}`)
  const errorBefore = error.message
  const plugin = Object.create(prototype)
  let observedBytes: Buffer | undefined
  let installed: ReturnType<typeof installChatlunaDebugHook> | undefined
  try {
    prototype.fetch = async function mockFetch(_info: any, passedInit: any) {
      assert.strictEqual(passedInit, init)
      observedBytes = Buffer.from(passedInit.body)
      return gate.promise
    }
    installed = installChatlunaDebugHook(harness.ctx as any, harness.config)
    assert(installed.installed)
    const requestPromise = plugin.fetch('https://offline.invalid/v1/responses', init)
    const callerResult = requestPromise.then(() => undefined, (caught: unknown) => caught)
    await waitFor(() => harness.snapshots.length === 1 && observedBytes !== undefined, 'pending failure request log must be saved')
    assertSafeCopy(harness.snapshots[0])
    assert.equal(observedBytes!.equals(Buffer.from(rawRequest)), true)
    gate.reject(error)
    assert.strictEqual(await callerResult, error, 'caller must receive its original rejection object')
    assert.equal(error.message, errorBefore, 'debug filtering must not edit the original error')
    assert.equal(Buffer.from(requestBytes).equals(Buffer.from(rawRequest)), true)
    await waitFor(() => harness.snapshots.some(snapshot => Boolean(snapshot.row.error)), 'rejected request log must be saved')
    assert.equal(harness.snapshots.length, 2)
    harness.snapshots.forEach(assertSafeCopy)
    const failed = harness.snapshots[1]
    assert.equal(failed.row.id, harness.snapshots[0].row.id)
    assert.equal(harness.rows.size, 1)
    assert(failed.entry.metadata.error)
    assert.equal(failed.entry.responseMessages.length, 0)
    assert.equal(failed.row.requestBytes, Buffer.byteLength(rawRequest))
  } finally {
    gate.resolve(new Response('unused'))
    await installed?.uninstall()
    prototype.fetch = previousFetch
    await harness.cleanup()
  }
})

for (const outcome of ['failed', 'incomplete', 'cancelled', 'truncated'] as const) {
  test(`actual debug hook preserves partial Responses data and classifies ${outcome}`, async () => {
    const harness = await makeHarness()
    const prototype = (ChatLunaPlugin as any).prototype
    const previousFetch = prototype.fetch
    const frame = (value: any) => `data: ${JSON.stringify(value)}\n\n`
    const prefix = frame({ type: 'response.created', response: { id: 'partial-fixture', status: 'in_progress' } })
      + frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item', call_id: 'partial-call', name: 'echo_probe', status: 'in_progress', arguments: '' } })
      + frame({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"value":"partial' })
    const raw = outcome === 'failed' ? prefix + frame({ type: 'error', error: { code: 'request_timeout', message: 'fixture upstream disconnect', type: 'server_error' } })
      : outcome === 'truncated' ? sseResponseText() : prefix
    let cancelled: unknown
    let installed: ReturnType<typeof installChatlunaDebugHook> | undefined
    try {
      if (outcome === 'truncated') harness.config.captureMaxBytes = 64
      prototype.fetch = async () => outcome === 'cancelled'
        ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(raw)) }, cancel(reason) { cancelled = reason } }), { headers: { 'content-type': 'text/event-stream' } })
        : chunkedResponse(raw, 'text/event-stream')
      installed = installChatlunaDebugHook(harness.ctx as any, harness.config)
      const returned: Response = await Object.create(prototype).fetch('https://offline.invalid/v1/responses', { method: 'POST', body: JSON.stringify(requestPayload(true)) })
      if (outcome === 'cancelled') {
        const reader = returned.body!.getReader()
        assert.equal(new TextDecoder().decode((await reader.read()).value), raw)
        await reader.cancel('fixture-consumer-cancel')
        assert.equal(cancelled, 'fixture-consumer-cancel')
      } else assert.equal(await returned.text(), raw)
      await waitFor(() => harness.snapshots.some(value => value.entry.metadata.captureOutcome === outcome), 'partial capture must settle')
      const saved = harness.snapshots.at(-1)!
      assertSafeCopy(saved)
      assert.equal(saved.entry.metadata.status, 200, 'HTTP success must not hide stream failure')
      assert.equal(saved.entry.metadata.captureOutcome, outcome)
      assert.equal(saved.entry.metadata.responseBytes, Buffer.byteLength(raw))
      assert.equal(harness.rows.size, 1)
      if (outcome === 'failed') {
        assert.equal(saved.entry.metadata.responseStatus, 'failed')
        assert.equal(saved.entry.metadata.responseErrorCode, 'request_timeout')
        assert(saved.entry.metadata.error?.includes('fixture upstream disconnect'))
        assert.equal(saved.entry.toolCalls.find(call => call.source === 'response')?.arguments, '{"value":"partial')
        assert.equal(saved.entry.metadata.usage, undefined)
      }
      if (outcome === 'truncated') {
        assert.equal(saved.entry.metadata.truncated, true)
        assert.equal(saved.entry.metadata.capturedBytes, 64)
        assert.equal(saved.entry.metadata.responseErrorCode, undefined, 'diagnostic truncation cannot be attributed to upstream')
      }
    } finally {
      await installed?.uninstall()
      prototype.fetch = previousFetch
      await harness.cleanup()
    }
  })
}
