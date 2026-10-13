import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { Context } from 'koishi'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'

export interface DebugTraceContext {
  traceId: string
  callRunId?: string
  parentTraceId?: string
  traceSource: 'character' | 'model-run'
}

const activeTrace = new AsyncLocalStorage<DebugTraceContext>()
export function currentDebugTrace() { return activeTrace.getStore() }

export function installTraceContext(ctx: Context) {
  const sessions = new WeakMap<object, DebugTraceContext>()
  const active = new Map<string, number>()
  const subscriptions: (() => void)[] = []
  const prototype = ChatLunaChatModel.prototype as any
  const descriptors = new Map(['_streamResponseChunks', '_streamIterator', 'invoke']
    .map(key => [key, Object.getOwnPropertyDescriptor(prototype, key)]))
  const original = prototype._streamResponseChunks
  if (typeof original !== 'function') return Object.assign(() => {}, { activeTraceIds: () => [] as string[] })
  if (typeof ctx.on === 'function') {
    subscriptions.push((ctx as any).on('chatluna_character/before-chat', (payload: any) => {
      if (payload?.session && typeof payload.session === 'object') {
        const previous = sessions.get(payload.session)
        if (previous) active.delete(previous.traceId)
        const trace = { traceId: `turn-${randomUUID()}`, traceSource: 'character' as const }
        sessions.set(payload.session, trace)
        active.set(trace.traceId, Date.now())
        if (active.size > 64) active.delete(active.keys().next().value!)
      }
    }))
    subscriptions.push((ctx as any).on('chatluna_character/after-chat', (payload: any) => {
      if (payload?.session && typeof payload.session === 'object') {
        const trace = sessions.get(payload.session)
        if (trace) active.delete(trace.traceId)
        sessions.delete(payload.session)
      }
    }))
  }
  const traceFor = (options: any): DebugTraceContext => {
    const session = options?.configurable?.session
    return (session && typeof session === 'object' ? sessions.get(session) : undefined)
      ?? activeTrace.getStore()
      ?? { traceId: `model-${options?.runId ?? randomUUID()}`, traceSource: 'model-run' }
  }
  const originalIterator = prototype._streamIterator
  // LangChain removes configurable from callOptions before invoking
  // _streamResponseChunks. Bind the trace at its public iterator boundary.
  const wrappedIterator = async function* (this: any, input: unknown, options: any) {
    const trace = traceFor(options)
    const iterator = originalIterator.call(this, input, options)[Symbol.asyncIterator]()
    let done = false
    try {
      while (true) {
        const result = await activeTrace.run(trace, () => iterator.next())
        if (result.done) { done = true; return result.value }
        yield result.value
      }
    } finally {
      if (!done && iterator.return) await activeTrace.run(trace, () => iterator.return())
    }
  }
  const originalInvoke = prototype.invoke
  const wrappedInvoke = function (this: any, input: unknown, options: any) {
    return activeTrace.run(traceFor(options), () => originalInvoke.call(this, input, options))
  }
  const wrapped = async function* (this: any, messages: unknown, options: any, runManager: any, ...rest: any[]) {
    const session = options?.configurable?.session
    const characterTrace = session && typeof session === 'object' ? sessions.get(session) : undefined
    const inherited = activeTrace.getStore()
    const trace: DebugTraceContext = {
      ...(characterTrace ?? inherited ?? {
        traceId: `model-${runManager?.parentRunId ?? runManager?.runId ?? randomUUID()}`,
        traceSource: 'model-run' as const,
      }),
      callRunId: runManager?.runId,
      parentTraceId: runManager?.parentRunId,
    }
    const iterator = original.call(this, messages, options, runManager, ...rest)[Symbol.asyncIterator]()
    let done = false
    try {
      while (true) {
        const result = await activeTrace.run(trace, () => iterator.next())
        if (result.done) { done = true; return result.value }
        yield result.value
      }
    } finally {
      if (!done && iterator.return) await activeTrace.run(trace, () => iterator.return())
    }
  }
  prototype._streamResponseChunks = wrapped
  prototype._streamIterator = wrappedIterator
  prototype.invoke = wrappedInvoke
  const uninstall = () => {
    for (const [key, wrapper] of [['_streamResponseChunks', wrapped], ['_streamIterator', wrappedIterator], ['invoke', wrappedInvoke]]) {
      if (prototype[key as string] !== wrapper) continue
      const descriptor = descriptors.get(key as string)
      if (descriptor) Object.defineProperty(prototype, key as string, descriptor)
      else delete prototype[key as string]
    }
    for (const unsubscribe of subscriptions) if (typeof unsubscribe === 'function') unsubscribe()
    active.clear()
  }
  return Object.assign(uninstall, { activeTraceIds: () => {
    for (const [id, started] of active) if (Date.now() - started > 30 * 60_000) active.delete(id)
    return [...active.keys()]
  } })
}
