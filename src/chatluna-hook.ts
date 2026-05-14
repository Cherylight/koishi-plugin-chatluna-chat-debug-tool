import type { Context } from 'koishi'
import { ChatLunaPlugin } from 'koishi-plugin-chatluna/services/chat'
import { logger } from './logger'
import type { DebugCaptureConfig, DebugEntry, DebugMessagePart, DebugToolCall, DebugToolDefinition, DebugToolResult } from './types'
import { rewriteDebugEntryAssets, saveDebugEntry } from './storage'
import { renderDebugMarkdown } from './markdown'

const originalFetchMap = new WeakMap<object, Function>()

export interface HookInstallResult {
  installed: boolean
  uninstall: () => void
}

function resolveFetchTarget(_plugin: any): { target?: object; fetch?: Function; mode: 'class-prototype' | 'instance' | 'prototype' | 'missing'; depth?: number } {
  // ChatLunaPlugin (not ChatLunaService) owns the fetch method used by all adapters
  const pluginPrototype = (ChatLunaPlugin as any)?.prototype as any
  if (typeof pluginPrototype?.fetch === 'function') {
    return {
      target: pluginPrototype,
      fetch: pluginPrototype.fetch,
      mode: 'class-prototype',
      depth: 0,
    }
  }

  return { mode: 'missing' }
}

function nowId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function headerEntries(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries())
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, String(value)]))
  }
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]))
}

function redactHeaders(headers: Record<string, string>, sensitive: string[]): Record<string, string> {
  const masked = { ...headers }
  const lowered = sensitive.map((item) => item.toLowerCase())
  for (const key of Object.keys(masked)) {
    if (lowered.includes(key.toLowerCase())) {
      masked[key] = '[REDACTED]'
    }
  }
  return masked
}

function extractRequestMessages(body: any): DebugMessagePart[] {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  return messages.map((message: any) => ({
    role: ['system', 'user', 'assistant', 'tool'].includes(message?.role) ? message.role : 'user',
    content: typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? ''),
    name: typeof message?.name === 'string' ? message.name : undefined,
    toolCallId: typeof message?.tool_call_id === 'string' ? message.tool_call_id : undefined,
  }))
}

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part
      if (typeof part?.text === 'string') return part.text
      if (typeof part?.output_text === 'string') return part.output_text
      return JSON.stringify(part)
    }).join('\n')
  }
  if (content == null) return ''
  return JSON.stringify(content)
}

function inferRequestType(url: string, body: any): string {
  if (url.includes('/responses') || Array.isArray(body?.input)) return 'responses'
  if (url.includes('/chat/completions') || Array.isArray(body?.messages)) return 'chat.completions'
  return 'unknown'
}

function pickHeader(headers: Record<string, string>, names: string[]): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (names.includes(key.toLowerCase())) return value
  }
  return undefined
}

function extractToolDefinitions(body: any): DebugToolDefinition[] {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  return tools.map((tool: any) => ({
    name: tool?.function?.name || tool?.name || tool?.type || 'unknown_tool',
    description: tool?.function?.description || tool?.description,
    type: tool?.type,
    parameters: tool?.function?.parameters || tool?.parameters,
  }))
}

function extractStructuredRequest(body: any): { messages: DebugMessagePart[]; toolCalls: DebugToolCall[]; toolResults: DebugToolResult[] } {
  const messages: DebugMessagePart[] = []
  const toolCalls: DebugToolCall[] = []
  const toolResults: DebugToolResult[] = []

  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) {
      const role = ['system', 'user', 'assistant', 'tool'].includes(message?.role) ? message.role : 'user'
      messages.push({
        role,
        content: normalizeContent(message?.content),
        name: typeof message?.name === 'string' ? message.name : undefined,
        toolCallId: typeof message?.tool_call_id === 'string' ? message.tool_call_id : undefined,
      })

      if (Array.isArray(message?.tool_calls)) {
        for (const toolCall of message.tool_calls) {
          toolCalls.push({
            id: toolCall?.id,
            name: toolCall?.function?.name || 'unknown_tool',
            arguments: toolCall?.function?.arguments,
            source: 'request',
          })
        }
      }

      if (role === 'tool') {
        toolResults.push({
          callId: message?.tool_call_id,
          name: message?.name,
          output: normalizeContent(message?.content),
          source: 'request',
        })
      }
    }
  }

  if (Array.isArray(body?.input)) {
    for (const item of body.input) {
      if (item?.type === 'message') {
        messages.push({
          role: ['system', 'user', 'assistant', 'tool'].includes(item?.role) ? item.role : 'user',
          content: normalizeContent(item?.content),
        })
      } else if (item?.type === 'function_call') {
        toolCalls.push({
          id: item?.call_id,
          name: item?.name || 'unknown_tool',
          arguments: item?.arguments,
          status: item?.status,
          source: 'request',
        })
      } else if (item?.type === 'function_call_output') {
        toolResults.push({
          callId: item?.call_id,
          output: normalizeContent(item?.output),
          source: 'request',
        })
      }
    }
  }

  return { messages, toolCalls, toolResults }
}

function extractStructuredResponse(json: any): { messages: DebugMessagePart[]; toolCalls: DebugToolCall[]; toolResults: DebugToolResult[]; responseId?: string; resolvedModel?: string; usage?: unknown } {
  const messages: DebugMessagePart[] = []
  const toolCalls: DebugToolCall[] = []
  const toolResults: DebugToolResult[] = []

  if (!json || typeof json !== 'object') {
    return { messages, toolCalls, toolResults }
  }

  if (Array.isArray(json.output)) {
    for (const item of json.output) {
      if (item?.type === 'message') {
        messages.push({
          role: ['system', 'user', 'assistant', 'tool'].includes(item?.role) ? item.role : 'assistant',
          content: normalizeContent(item?.content),
        })
      } else if (item?.type === 'function_call') {
        toolCalls.push({
          id: item?.call_id,
          name: item?.name || 'unknown_tool',
          arguments: item?.arguments,
          status: item?.status,
          source: 'response',
        })
      } else if (item?.type === 'function_call_output') {
        toolResults.push({
          callId: item?.call_id,
          name: item?.name,
          output: normalizeContent(item?.output),
          source: 'response',
        })
      }
    }
  }

  if (Array.isArray(json.choices)) {
    for (const choice of json.choices) {
      const message = choice?.message
      if (message) {
        messages.push({
          role: ['system', 'user', 'assistant', 'tool'].includes(message?.role) ? message.role : 'assistant',
          content: normalizeContent(message?.content),
          name: typeof message?.name === 'string' ? message.name : undefined,
          toolCallId: typeof message?.tool_call_id === 'string' ? message.tool_call_id : undefined,
        })
      }
      if (Array.isArray(message?.tool_calls)) {
        for (const toolCall of message.tool_calls) {
          toolCalls.push({
            id: toolCall?.id,
            name: toolCall?.function?.name || 'unknown_tool',
            arguments: toolCall?.function?.arguments,
            source: 'response',
          })
        }
      }
    }
  }

  return {
    messages,
    toolCalls,
    toolResults,
    responseId: typeof json?.id === 'string' ? json.id : typeof json?.response_id === 'string' ? json.response_id : undefined,
    resolvedModel: typeof json?.model === 'string' ? json.model : undefined,
    usage: json?.usage,
  }
}

function shouldCapture(url: string, bodyText: string | undefined, config: DebugCaptureConfig): boolean {
  if (!config.captureEnabled) return false
  if (!config.captureFilters.length) return true
  return config.captureFilters.some((filter) => url.includes(filter) || bodyText?.includes(filter))
}

function clipText(text: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
  const bytes = Buffer.byteLength(text)
  if (bytes <= maxBytes) {
    return { text, truncated: false, bytes }
  }

  let end = text.length
  let clipped = text
  while (end > 0 && Buffer.byteLength(clipped) > maxBytes) {
    end = Math.max(0, end - Math.ceil(end / 8))
    clipped = text.slice(0, end)
  }
  return { text: clipped, truncated: true, bytes }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function mergeToolCallFragment(target: Record<number, any>, index: number, fragment: any) {
  const current = target[index] ?? {
    id: fragment?.id,
    type: fragment?.type,
    function: {
      name: fragment?.function?.name ?? '',
      arguments: fragment?.function?.arguments ?? '',
    },
  }

  if (fragment?.id) current.id = fragment.id
  if (fragment?.type) current.type = fragment.type
  if (fragment?.function?.name) {
    current.function.name = `${current.function.name || ''}${fragment.function.name}`
  }
  if (fragment?.function?.arguments) {
    current.function.arguments = `${current.function.arguments || ''}${fragment.function.arguments}`
  }

  target[index] = current
}

function aggregateSsePayload(rawText: string): { text: string; json?: unknown } {
  const fragments: string[] = []
  const choiceToolCalls = new Map<number, Record<number, any>>()
  let responseId: string | undefined
  let model: string | undefined
  let usage: unknown
  const lines = rawText.split(/\r?\n/)

  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    const parsed = tryParseJson(payload) as any
    if (!parsed || typeof parsed !== 'object') continue

    if (typeof parsed.id === 'string') responseId = parsed.id
    if (typeof parsed.response_id === 'string') responseId = parsed.response_id
    if (typeof parsed.model === 'string') model = parsed.model
    if (parsed.usage != null) usage = parsed.usage

    const outputText = parsed.output_text
    if (typeof outputText === 'string' && outputText) {
      fragments.push(outputText)
    }

    const choices = Array.isArray(parsed.choices) ? parsed.choices : []
    for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex++) {
      const choice = choices[choiceIndex]
      const delta = choice?.delta
      if (typeof delta?.content === 'string' && delta.content) {
        fragments.push(delta.content)
      }
      if (Array.isArray(delta?.content)) {
        for (const part of delta.content) {
          if (typeof part?.text === 'string' && part.text) {
            fragments.push(part.text)
          }
        }
      }
      if (Array.isArray(delta?.tool_calls)) {
        const toolCallMap = choiceToolCalls.get(choiceIndex) ?? {}
        delta.tool_calls.forEach((toolCall: any, toolIndex: number) => {
          const index = typeof toolCall?.index === 'number' ? toolCall.index : toolIndex
          mergeToolCallFragment(toolCallMap, index, toolCall)
        })
        choiceToolCalls.set(choiceIndex, toolCallMap)
      }

      const message = choice?.message
      if (typeof message?.content === 'string' && message.content) {
        fragments.push(message.content)
      }
      if (Array.isArray(message?.content)) {
        for (const part of message.content) {
          if (typeof part?.text === 'string' && part.text) {
            fragments.push(part.text)
          }
        }
      }
      if (Array.isArray(message?.tool_calls)) {
        const toolCallMap = choiceToolCalls.get(choiceIndex) ?? {}
        message.tool_calls.forEach((toolCall: any, toolIndex: number) => {
          const index = typeof toolCall?.index === 'number' ? toolCall.index : toolIndex
          toolCallMap[index] = toolCall
        })
        choiceToolCalls.set(choiceIndex, toolCallMap)
      }
    }
  }

  const choices = Array.from(choiceToolCalls.entries()).map(([index, toolCallMap]) => ({
    index,
    message: {
      role: 'assistant',
      content: '',
      tool_calls: Object.keys(toolCallMap)
        .map((key) => Number(key))
        .sort((a, b) => a - b)
        .map((key) => toolCallMap[key]),
    },
  }))

  return {
    text: fragments.join(''),
    json: responseId || model || usage || choices.length
      ? {
          id: responseId,
          model,
          usage,
          choices,
        }
      : undefined,
  }
}

async function readResponseBody(response: Response, maxBytes: number): Promise<{ text: string; json?: unknown; bytes: number; truncated: boolean }> {
  const clone = response.clone()
  const contentType = clone.headers.get('content-type') || ''
  const rawText = await clone.text()

  if (contentType.includes('text/event-stream')) {
    const aggregated = aggregateSsePayload(rawText)
    const clipped = clipText(aggregated.text || rawText, maxBytes)
    return { text: clipped.text, json: aggregated.json, bytes: clipped.bytes, truncated: clipped.truncated }
  }

  const clipped = clipText(rawText, maxBytes)
  if (contentType.includes('application/json')) {
    const json = tryParseJson(clipped.text)
    return { text: clipped.text, json, bytes: clipped.bytes, truncated: clipped.truncated }
  }
  return { text: clipped.text, bytes: clipped.bytes, truncated: clipped.truncated }
}

function parseBodyValue(body: BodyInit | null | undefined): { text?: string; json?: unknown } {
  if (typeof body === 'string') {
    try {
      return { text: body, json: JSON.parse(body) }
    } catch {
      return { text: body }
    }
  }
  if (body instanceof Uint8Array) {
    const text = Buffer.from(body).toString('utf8')
    return { text, json: tryParseJson(text) }
  }
  return {}
}

async function normalizeRequest(info: RequestInfo, init?: RequestInit) {
  const request = info instanceof Request ? info : undefined
  const requestUrl = typeof info === 'string'
    ? info
    : info instanceof URL
      ? info.toString()
      : info.url
  const method = init?.method || request?.method || 'GET'
  const requestHeaders = redactHeaders({
    ...headerEntries(request?.headers),
    ...headerEntries(init?.headers),
  }, [])

  let requestBody = parseBodyValue(init?.body)
  if (!requestBody.text && request) {
    try {
      const cloned = request.clone()
      const text = await cloned.text()
      if (text) {
        requestBody = { text, json: tryParseJson(text) }
      }
    } catch {
      // ignore unreadable request body
    }
  }

  return {
    requestUrl,
    method,
    requestHeaders,
    requestBody,
  }
}

export function installChatlunaDebugHook(ctx: Context, config: DebugCaptureConfig): HookInstallResult {
  const resolved = resolveFetchTarget((ctx as any).chatluna)
  if (!resolved.target || !resolved.fetch) {
    logger.warn(`ChatLuna fetch 不可用，跳过调试 hook 安装: ChatLunaPlugin.prototype.fetch 未找到`)
    return {
      installed: false,
      uninstall: () => {},
    }
  }

  if (originalFetchMap.has(resolved.target)) {
    logger.info(`ChatLuna 调试 hook 已存在，跳过重复安装: mode=${resolved.mode}`)
    return {
      installed: false,
      uninstall: () => {},
    }
  }

  const originalFetch = resolved.fetch
  originalFetchMap.set(resolved.target, originalFetch)

  ;(resolved.target as any).fetch = async function fetchWithDebug(info: RequestInfo, init?: RequestInit, proxy?: string) {
    const startedAt = Date.now()
    const normalizedRequest = await normalizeRequest(info, init)
    const requestHeaders = redactHeaders(normalizedRequest.requestHeaders, config.redactHeaders)
    const requestBody = normalizedRequest.requestBody
    const structuredRequest = extractStructuredRequest(requestBody.json)
    const requestMessages = structuredRequest.messages.length ? structuredRequest.messages : extractRequestMessages(requestBody.json)
    const requestType = inferRequestType(normalizedRequest.requestUrl, requestBody.json)
    const tools = extractToolDefinitions(requestBody.json)
    const model = typeof (requestBody.json as any)?.model === 'string' ? (requestBody.json as any).model : undefined
    const otherOptions = requestBody.json && typeof requestBody.json === 'object'
      ? {
          stream: (requestBody.json as any).stream,
          store: (requestBody.json as any).store,
          temperature: (requestBody.json as any).temperature,
          top_p: (requestBody.json as any).top_p,
          parallel_tool_calls: (requestBody.json as any).parallel_tool_calls,
        }
      : undefined

    const matched = shouldCapture(normalizedRequest.requestUrl, requestBody.text, config)
    logger.info(`ChatLuna 调试请求经过 hook: matched=${matched}, method=${normalizedRequest.method}, url=${normalizedRequest.requestUrl}`)

    if (!matched) {
      return originalFetch.call(this, info, init, proxy)
    }

    const id = nowId()

    try {
      const response: Response = await originalFetch.call(this, info, init, proxy)
      const responseHeaders = redactHeaders(Object.fromEntries(response.headers.entries()), config.redactHeaders)

      if (config.writeMarkdown) {
        void readResponseBody(response, config.maxBodyBytes)
          .then((responseBody) => {
            const structuredResponse = extractStructuredResponse(responseBody.json)
            const requestId = pickHeader(responseHeaders, ['x-request-id', 'request-id'])
            const serverRequestId = pickHeader(responseHeaders, ['x-ms-request-id', 'trace-id', 'x-trace-id']) || requestId
            const completedAt = Date.now()
            const entry: DebugEntry = {
              metadata: {
                id,
                createdAt: startedAt,
                endAt: completedAt,
                durationMs: completedAt - startedAt,
                source: 'chatluna',
                requestType,
                model,
                resolvedModel: structuredResponse.resolvedModel,
                method: normalizedRequest.method,
                url: normalizedRequest.requestUrl,
                status: response.status,
                requestId,
                serverRequestId,
                responseId: structuredResponse.responseId,
                truncated: responseBody.truncated,
                requestBytes: requestBody.text ? Buffer.byteLength(requestBody.text) : undefined,
                responseBytes: responseBody.bytes,
                maxTokens: (requestBody.json as any)?.max_tokens,
                maxOutputTokens: (requestBody.json as any)?.max_output_tokens,
                reasoning: (requestBody.json as any)?.reasoning,
                otherOptions,
                usage: structuredResponse.usage,
              },
              tools,
              requestMessages,
              responseMessages: structuredResponse.messages,
              toolCalls: [...structuredRequest.toolCalls, ...structuredResponse.toolCalls],
              toolResults: [...structuredRequest.toolResults, ...structuredResponse.toolResults],
              responseText: structuredResponse.messages.map((message) => message.content).filter(Boolean).join('\n\n') || responseBody.text,
              requestBodyText: requestBody.text,
              requestBodyJson: requestBody.json,
              responseJson: responseBody.json,
              requestHeaders,
              responseHeaders,
            }

            return rewriteDebugEntryAssets(ctx, config.storageDir, entry)
              .then((rewrittenEntry) => {
                const markdown = renderDebugMarkdown(rewrittenEntry)
                return saveDebugEntry(ctx, rewrittenEntry, markdown, config.storageDir)
              })
          })
          .catch((error) => {
            logger.warn('保存调试日志失败:', error)
          })
      }

      return response
    } catch (error: any) {
      const entry: DebugEntry = {
        metadata: {
          id,
          createdAt: startedAt,
          endAt: Date.now(),
          durationMs: Date.now() - startedAt,
          source: 'chatluna',
          requestType,
          model,
          method: normalizedRequest.method,
          url: normalizedRequest.requestUrl,
          maxTokens: (requestBody.json as any)?.max_tokens,
          maxOutputTokens: (requestBody.json as any)?.max_output_tokens,
          reasoning: (requestBody.json as any)?.reasoning,
          otherOptions,
          error: error?.message || String(error),
        },
        tools,
        requestMessages,
        responseMessages: [],
        toolCalls: structuredRequest.toolCalls,
        toolResults: structuredRequest.toolResults,
        responseText: '',
        requestBodyText: requestBody.text,
        requestBodyJson: requestBody.json,
        requestHeaders,
        responseHeaders: {},
      }
      if (config.writeMarkdown) {
        void rewriteDebugEntryAssets(ctx, config.storageDir, entry)
          .then((rewrittenEntry) => {
            const markdown = renderDebugMarkdown(rewrittenEntry)
            return saveDebugEntry(ctx, rewrittenEntry, markdown, config.storageDir)
          })
          .catch((saveError) => {
            logger.warn('保存失败请求日志失败:', saveError)
          })
      }
      throw error
    }
  }

  logger.info(`ChatLuna 调试 hook 已安装: mode=${resolved.mode}, depth=${resolved.depth ?? 0}, target=ChatLunaPlugin.prototype`)
  return {
    installed: true,
    uninstall: () => {
      ;(resolved.target as any).fetch = originalFetch
      if (resolved.target) originalFetchMap.delete(resolved.target)
      logger.info('ChatLuna 调试 hook 已卸载')
    },
  }
}
