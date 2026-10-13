import assert from 'node:assert/strict'
import test from 'node:test'
import { tapResponseBody, type StreamCapture } from '../src/stream-tap'

function capturePromise() {
  let resolve!: (value: StreamCapture) => void
  const promise = new Promise<StreamCapture>(ok => { resolve = ok })
  return { promise, resolve }
}

test('tap preserves exact Unicode bytes, HTTP properties and UTF8 split boundaries', async () => {
  const raw = Buffer.from('data: 你好\u202c👩‍💻\n\n')
  let offset = 0
  const source = new Response(new ReadableStream({ pull(controller) {
    if (offset === raw.length) return controller.close()
    controller.enqueue(raw.subarray(offset, ++offset))
  } }, { highWaterMark: 0 }), { status: 201, statusText: 'Created', headers: { 'content-type': 'text/event-stream' } })
  Object.defineProperty(source, 'url', { value: 'https://offline.invalid/response' })
  const capture = capturePromise()
  const tapped = tapResponseBody(source, capture.resolve)
  assert.equal(tapped.url, source.url)
  assert.equal(tapped.status, 201)
  assert.deepEqual(Buffer.from(await tapped.arrayBuffer()), raw)
  const saved = await capture.promise
  assert.equal(saved.rawText, raw.toString('utf8'))
  assert.equal(saved.bytes, raw.length)
  assert.equal(saved.outcome, 'complete')
})

test('tap never drains ahead and cancellation reaches the original reader immediately', async () => {
  let pulls = 0
  let reason: unknown
  const source = new Response(new ReadableStream({ pull(controller) {
    pulls++
    controller.enqueue(Buffer.from('one'))
  }, cancel(value) { reason = value } }, { highWaterMark: 0 }))
  const capture = capturePromise()
  const tapped = tapResponseBody(source, capture.resolve)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(pulls, 0)
  const reader = tapped.body!.getReader()
  await reader.read()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(pulls, 1)
  const cancellation = new Error('caller rejected generation')
  await reader.cancel(cancellation)
  assert.strictEqual(reason, cancellation)
  const saved = await capture.promise
  assert.equal(saved.rawText, 'one')
  assert.equal(saved.outcome, 'cancelled')
  assert.equal(pulls, 1)
})

test('capture limit only truncates diagnostic bytes, never the caller body', async () => {
  const capture = capturePromise()
  const tapped = tapResponseBody(new Response('abcdefghijkl'), capture.resolve, 5)
  assert.equal(await tapped.text(), 'abcdefghijkl')
  const saved = await capture.promise
  assert.equal(saved.rawText, 'abcde')
  assert.equal(saved.bytes, 12)
  assert.equal(saved.capturedBytes, 5)
  assert.equal(saved.truncated, true)
})

test('transport errors propagate unchanged while partial diagnostic data survives', async () => {
  let pulls = 0
  const error = new Error('synthetic disconnect')
  const source = new Response(new ReadableStream({ pull(controller) {
    if (++pulls === 1) controller.enqueue(Buffer.from('partial'))
    else controller.error(error)
  } }, { highWaterMark: 0 }))
  const capture = capturePromise()
  const tapped = tapResponseBody(source, capture.resolve)
  await assert.rejects(tapped.text(), candidate => candidate === error)
  const saved = await capture.promise
  assert.strictEqual(saved.error, error)
  assert.equal(saved.rawText, 'partial')
  assert.equal(saved.outcome, 'transport_error')
})

test('slow or failed diagnostic persistence never blocks the actual consumer', async () => {
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  let started = false
  const source = tapResponseBody(new Response('OK'), async () => { started = true; await gate })
  assert.equal(await source.text(), 'OK')
  assert(started)
  finish()
})
