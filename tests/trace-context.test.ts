import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { AIMessageChunk, HumanMessage } from '@langchain/core/messages'
import { ChatGenerationChunk } from '@langchain/core/outputs'
import { currentDebugTrace, installTraceContext } from '../src/trace-context'

test('Character trace follows all model steps and retries without mixing concurrent sessions', async () => {
  const prototype = ChatLunaChatModel.prototype as any
  const original = prototype._streamResponseChunks
  const events = new Map<string, Function>()
  const ctx = { on(name: string, callback: Function) { events.set(name, callback); return () => events.delete(name) } }
  prototype._streamResponseChunks = async function* () {
    await Promise.resolve()
    yield { ...currentDebugTrace() }
  }
  const fake = prototype._streamResponseChunks
  const uninstall = installTraceContext(ctx as any)
  const first = {}
  const second = {}
  try {
    events.get('chatluna_character/before-chat')!({ session: first })
    events.get('chatluna_character/before-chat')!({ session: second })
    const run = async (session: object, runId: string) => {
      const results = []
      for await (const result of prototype._streamResponseChunks.call({}, [], { configurable: { session } }, { runId, parentRunId: 'parent-' + runId })) results.push(result)
      return results[0]
    }
    const [a, b] = await Promise.all([run(first, 'a'), run(second, 'b')])
    const retry = await run(first, 'retry')
    assert.equal(a.traceId, retry.traceId)
    assert.notEqual(a.traceId, b.traceId)
    assert.equal(retry.callRunId, 'retry')
    assert.equal(currentDebugTrace(), undefined)
    assert.equal(uninstall.activeTraceIds().length, 2)
    events.get('chatluna_character/after-chat')!({ session: first })
    assert.equal(uninstall.activeTraceIds().length, 1)
  } finally {
    uninstall()
    assert.strictEqual(prototype._streamResponseChunks, fake)
    assert.equal(events.size, 0)
    prototype._streamResponseChunks = original
  }
})

test('public LangChain stream and invoke preserve the Character trace when configurable is stripped', async () => {
  const prototype = ChatLunaChatModel.prototype as any
  const original = prototype._streamResponseChunks
  const observed: any[] = []
  const events = new Map<string, Function>()
  const ctx = { on(name: string, callback: Function) { events.set(name, callback); return () => events.delete(name) } }
  prototype._streamResponseChunks = async function* (_messages: unknown, options: any) {
    // This is the actual LangChain boundary: configurable is absent here.
    assert.equal(options.configurable, undefined)
    observed.push({ ...currentDebugTrace() })
    yield new ChatGenerationChunk({ text: 'OK', message: new AIMessageChunk('OK') })
  }
  const uninstall = installTraceContext(ctx as any)
  const session = {}
  const other = {}
  try {
    const model = new ChatLunaChatModel({ modelInfo: { name: 'fixture' }, requester: {}, model: 'fixture', stream: true, callbacks: [{ handleLLMStart() {} }] } as any)
    model.cropMessages = async (messages: any) => [messages, 1]
    model.countMessageTokens = async () => 1
    events.get('chatluna_character/before-chat')!({ session })
    events.get('chatluna_character/before-chat')!({ session: other })
    for await (const chunk of await model.stream([new HumanMessage('probe')], { configurable: { session } } as any)) assert.equal(chunk.content, 'OK')
    assert.equal((await model.invoke([new HumanMessage('retry')], { stream: true, configurable: { session } } as any)).content, 'OK')
    for await (const _chunk of await model.stream([new HumanMessage('other')], { configurable: { session: other } } as any)) { /* consume */ }
    assert.equal(observed.length, 3)
    assert.equal(observed[0].traceSource, 'character')
    assert.equal(observed[0].traceId, observed[1].traceId)
    assert.notEqual(observed[0].traceId, observed[2].traceId)
    assert(observed.every(value => typeof value.callRunId === 'string' && value.callRunId))
    assert.equal(currentDebugTrace(), undefined)
  } finally {
    uninstall()
    prototype._streamResponseChunks = original
  }
})
