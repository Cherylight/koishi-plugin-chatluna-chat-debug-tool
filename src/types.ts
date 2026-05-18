export interface DebugCaptureConfig {
  enabled: boolean
  captureEnabled: boolean
  writeMarkdown: boolean
  renderImageOnCommand: boolean
  collapseJsonOnRender: boolean
  collapseSystemPromptOnRender: boolean
  embedChatImagesOnRender: boolean
  storageDir: string
  maxPreviewChars: number
  redactHeaders: string[]
  captureFilters: string[]
  sendMode: 'image' | 'text' | 'figure'
  mergeForwardBatchSize: number
  renderTimeoutMs: number
  imageMaxBytes: number
  managerPageSize: number
}

export interface DebugMetadata {
  id: string
  createdAt: number
  endAt?: number
  durationMs: number
  source: string
  requestType?: string
  model?: string
  resolvedModel?: string
  method: string
  url: string
  status?: number
  requestId?: string
  serverRequestId?: string
  responseId?: string
  truncated?: boolean
  requestBytes?: number
  responseBytes?: number
  maxTokens?: number
  maxOutputTokens?: number
  reasoning?: unknown
  otherOptions?: unknown
  usage?: unknown
  error?: string
}

export interface DebugMessagePart {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  toolCallId?: string
}

export interface DebugToolDefinition {
  name: string
  description?: string
  type?: string
  parameters?: unknown
}

export interface DebugToolCall {
  id?: string
  name: string
  arguments?: string
  status?: string
  source: 'request' | 'response'
}

export interface DebugToolResult {
  callId?: string
  name?: string
  output: string
  source: 'request' | 'response'
}

export interface DebugAssetFile {
  name: string
  fileName: string
  filePath: string
  relativePath: string
  mimeType: string
}

export interface DebugEntry {
  metadata: DebugMetadata
  tools: DebugToolDefinition[]
  requestMessages: DebugMessagePart[]
  responseMessages: DebugMessagePart[]
  toolCalls: DebugToolCall[]
  toolResults: DebugToolResult[]
  responseText: string
  responseReasoningText?: string
  requestBodyText?: string
  requestBodyJson?: unknown
  responseJson?: unknown
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string>
  assetFiles?: DebugAssetFile[]
}
