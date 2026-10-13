export interface StreamCapture {
  rawText: string
  bytes: number
  capturedBytes: number
  truncated: boolean
  outcome: 'complete' | 'cancelled' | 'transport_error'
  error?: unknown
}

// Observe only bytes the application consumes. A clone/tee would introduce an
// independent reader and could keep a rejected generation alive after cancel.
export function tapResponseBody(
  response: Response,
  onCapture: (capture: StreamCapture) => void | Promise<void>,
  maxBytes = 8 * 1024 * 1024,
  onError: (error: unknown) => void = () => {},
): Response {
  if (!response.body) {
    void Promise.resolve().then(() => onCapture({ rawText: '', bytes: 0, capturedBytes: 0, truncated: false, outcome: 'complete' })).catch(onError)
    return response
  }
  const limit = Math.max(0, Math.floor(maxBytes))
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let capturedBytes = 0
  let finalized = false
  const finish = (outcome: StreamCapture['outcome'], error?: unknown) => {
    if (finalized) return
    finalized = true
    const rawText = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), capturedBytes).toString('utf8')
    chunks.length = 0
    const snapshot = { rawText, bytes, capturedBytes, truncated: bytes > capturedBytes, outcome, error }
    // Parsing and disk/database work never block consumption or cancellation.
    void Promise.resolve().then(() => onCapture(snapshot)).catch(onError)
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          controller.close()
          reader.releaseLock()
          finish('complete')
          return
        }
        bytes += result.value.byteLength
        const remaining = limit - capturedBytes
        if (remaining > 0) {
          const copy = result.value.slice(0, remaining)
          chunks.push(copy)
          capturedBytes += copy.byteLength
        }
        controller.enqueue(result.value)
      } catch (error) {
        controller.error(error)
        try { reader.releaseLock() } catch {}
        finish('transport_error', error)
      }
    },
    async cancel(reason) {
      finish('cancelled', reason)
      try { await reader.cancel(reason) } finally {
        try { reader.releaseLock() } catch {}
      }
    },
  }, { highWaterMark: 0 })
  const observed = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  for (const key of ['url', 'redirected', 'type'] as const) {
    Object.defineProperty(observed, key, { value: response[key], configurable: true })
  }
  return observed
}
