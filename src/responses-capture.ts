export interface SseFrame {
  event?: string
  id?: string
  data: string
}

export interface ResponsesSseCapture {
  text: string
  reasoningText: string
  json?: Record<string, any>
  parsed: boolean
}

// SSE data fields belong to a frame and may contain a multiline JSON document.
export function parseSseFrames(rawText: string): SseFrame[] {
  const frames: SseFrame[] = []
  let event: string | undefined
  let id: string | undefined
  let data: string[] = []
  const flush = () => {
    if (data.length) frames.push({ event, id, data: data.join('\n') })
    event = undefined
    id = undefined
    data = []
  }

  for (const line of rawText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!line) {
      flush()
      continue
    }
    if (line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
    else if (field === 'id' && !value.includes('\0')) id = value
  }
  flush()
  return frames
}

export function extractResponsesReasoningText(value: unknown): string {
  if (Array.isArray(value)) return value.map(extractResponsesReasoningText).join('')
  if (!value || typeof value !== 'object') return ''
  const item = value as Record<string, any>
  if ((item.type === 'summary_text' || item.type === 'reasoning_text') && typeof item.text === 'string') return item.text
  if (item.type !== 'reasoning') return ''
  const original = extractResponsesReasoningText(item.content)
  return original || extractResponsesReasoningText(item.summary) || (typeof item.text === 'string' ? item.text : '')
}

function cloneItem<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

function visibleText(item: Record<string, any>): string {
  if (typeof item.content === 'string') return item.content
  if (!Array.isArray(item.content)) return ''
  return item.content.map((part: any) => {
    if (part?.type === 'refusal') return typeof part.refusal === 'string' ? part.refusal : ''
    if (part?.type === 'output_text') return typeof part.text === 'string' ? part.text : ''
    return ''
  }).join('')
}

export function aggregateResponsesSsePayload(rawText: string): ResponsesSseCapture {
  const items = new Map<number, Record<string, any>>()
  const itemIndices = new Map<string, number>()
  const seenSequences = new Set<number>()
  const unknownEventTypes = new Set<string>()
  let malformedFrames = 0
  let response: Record<string, any> = {}
  let parsed = false
  let terminalObserved = false

  const indexFor = (data: Record<string, any>) => {
    if (typeof data.output_index === 'number') return data.output_index
    const id = data.item_id ?? data.item?.id
    if (typeof id === 'string' && itemIndices.has(id)) return itemIndices.get(id)!
    return typeof id === 'string' || data.item ? items.size : 0
  }

  const updateItem = (index: number, incoming: Record<string, any>) => {
    const existing = items.get(index) ?? {}
    const item = { ...existing, ...cloneItem(incoming) }
    if (typeof item.id === 'string') itemIndices.set(item.id, index)
    items.set(index, item)
    return item
  }

  const ensureItem = (index: number, type: string, data: Record<string, any>) => {
    const item = items.get(index) ?? { type }
    if (typeof data.item_id === 'string') {
      item.id = data.item_id
      itemIndices.set(data.item_id, index)
    }
    if (typeof data.name === 'string') item.name = data.name
    if (typeof data.call_id === 'string') item.call_id = data.call_id
    items.set(index, item)
    return item
  }

  const updatePart = (item: Record<string, any>, field: 'content' | 'summary', index: number, part: Record<string, any>, delta: boolean) => {
    if (!Array.isArray(item[field])) item[field] = []
    const previous = item[field][index] ?? {}
    item[field][index] = { ...previous, ...cloneItem(part) }
    const textField = part.type === 'refusal' ? 'refusal' : 'text'
    if (delta) item[field][index][textField] = `${previous[textField] ?? ''}${part[textField] ?? ''}`
  }

  const updateResponse = (incoming: Record<string, any>) => {
    response = { ...response, ...cloneItem(incoming) }
    if (Array.isArray(incoming.output) && incoming.output.length > 0) {
      // A final output array is authoritative and replaces provisional indices.
      const snapshots = incoming.output.map((item: any, index: number) => [index, cloneItem(item)] as const)
      items.clear()
      itemIndices.clear()
      for (const [index, item] of snapshots) updateItem(index, item)
    }
  }

  for (const frame of parseSseFrames(rawText)) {
    if (!frame.data || frame.data.trim() === '[DONE]') continue
    let data: Record<string, any>
    try {
      data = JSON.parse(frame.data)
    } catch {
      malformedFrames++
      continue
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    const type = typeof data.type === 'string' ? data.type : frame.event
    if (typeof data.sequence_number === 'number') {
      if (seenSequences.has(data.sequence_number)) continue
      seenSequences.add(data.sequence_number)
    }

    if (data.object === 'response' && Array.isArray(data.output)) {
      parsed = true
      updateResponse(data)
      if (['completed', 'failed', 'incomplete'].includes(data.status)) terminalObserved = true
      continue
    }
    if (type === 'response.created' || type === 'response.in_progress' || type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete' || type === 'response.queued') {
      parsed = true
      if (['response.completed', 'response.failed', 'response.incomplete'].includes(type)) terminalObserved = true
      if (data.response && typeof data.response === 'object') updateResponse(data.response)
      response.status = data.response?.status ?? (type === 'response.created' ? 'in_progress' : type.slice('response.'.length))
      continue
    }
    if (type === 'error' || type === 'response.error') {
      parsed = true
      terminalObserved = true
      if (data.response && typeof data.response === 'object') updateResponse(data.response)
      response.error = cloneItem(data.error ?? { code: data.code, message: data.message, param: data.param })
      response.status = response.status === 'incomplete' ? response.status : 'failed'
      continue
    }
    if ((type === 'response.output_item.added' || type === 'response.output_item.done') && data.item && typeof data.item === 'object') {
      parsed = true
      updateItem(indexFor(data), data.item)
      continue
    }
    if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
      parsed = true
      const item = ensureItem(indexFor(data), 'function_call', data)
      if (type.endsWith('.delta')) item.arguments = `${item.arguments ?? ''}${typeof data.delta === 'string' ? data.delta : ''}`
      else if (typeof data.arguments === 'string') item.arguments = data.arguments
      continue
    }
    if (type === 'response.output_text.delta' || type === 'response.output_text.done' || type === 'response.refusal.delta' || type === 'response.refusal.done') {
      parsed = true
      const item = ensureItem(indexFor(data), 'message', data)
      item.role ??= 'assistant'
      const refusal = type.startsWith('response.refusal')
      const text = type.endsWith('.delta') ? data.delta : refusal ? data.refusal ?? data.text : data.text
      updatePart(item, 'content', data.content_index ?? 0, refusal ? { type: 'refusal', refusal: typeof text === 'string' ? text : '' } : { type: 'output_text', text: typeof text === 'string' ? text : '' }, type.endsWith('.delta'))
      continue
    }
    if (type && /^response\.reasoning(_summary)?_text\.(delta|done)$/.test(type)) {
      parsed = true
      const item = ensureItem(indexFor(data), 'reasoning', data)
      const summary = type.startsWith('response.reasoning_summary')
      const text = type.endsWith('.delta') ? data.delta : data.text
      updatePart(item, summary ? 'summary' : 'content', summary ? data.summary_index ?? 0 : data.content_index ?? 0, { type: summary ? 'summary_text' : 'reasoning_text', text: typeof text === 'string' ? text : '' }, type.endsWith('.delta'))
      continue
    }
    if (type === 'response.content_part.added' || type === 'response.content_part.done' || type === 'response.reasoning_summary_part.added' || type === 'response.reasoning_summary_part.done') {
      if (!data.part || typeof data.part !== 'object') continue
      parsed = true
      const summary = type.startsWith('response.reasoning_summary')
      const reasoning = summary || data.part.type === 'reasoning_text'
      const item = ensureItem(indexFor(data), reasoning ? 'reasoning' : 'message', data)
      if (!reasoning) item.role ??= 'assistant'
      updatePart(item, summary ? 'summary' : 'content', summary ? data.summary_index ?? 0 : data.content_index ?? 0, data.part, false)
      continue
    }
    unknownEventTypes.add(type ?? frame.event ?? 'message')
  }

  if (!parsed) return { text: '', reasoningText: '', parsed: false }
  const output = Array.from(items).sort(([left], [right]) => left - right).map(([, item]) => item)
  const json: Record<string, any> = { ...response, output }
  if (!terminalObserved) {
    json.status = 'incomplete'
    json.error ??= { code: 'debug_stream_incomplete', message: 'Captured stream ended without a Responses terminal event.' }
  }
  const text = output.filter(item => item.type === 'message').map(visibleText).filter(Boolean).join('\n\n') || (typeof response.output_text === 'string' ? response.output_text : '')
  const reasoningText = output.filter(item => item.type === 'reasoning').map(extractResponsesReasoningText).filter(Boolean).join('\n\n')
  if (unknownEventTypes.size || malformedFrames) {
    json.debug_sse = { unknown_event_types: Array.from(unknownEventTypes), malformed_frames: malformedFrames }
  }
  const usefulOutput = text || reasoningText || output.some(item => item.type === 'function_call' && (item.name || item.arguments)) || response.error
  // Keep unfamiliar payloads visible when known lifecycle events alone cannot
  // explain a response; do not turn a vendor stream into a fake empty result.
  return { text: !usefulOutput && (unknownEventTypes.size || malformedFrames) ? rawText : text, reasoningText, json, parsed: true }
}
