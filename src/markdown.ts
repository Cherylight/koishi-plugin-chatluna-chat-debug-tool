import type { DebugEntry, DebugMessagePart } from './types'

function normalizeContent(input: string): string {
  return input.replace(/\r\n/g, '\n')
}

function maxFenceRun(input: string, fenceChar: '`' | '~') {
  const pattern = new RegExp(`\\${fenceChar}+`, 'g')
  const matches = input.match(pattern) || []
  return matches.reduce((max, item) => Math.max(max, item.length), 0)
}

function renderFencedBlock(content: string, language = 'text', fenceChar: '`' | '~' = '~') {
  const normalized = normalizeContent(content || '_empty_')
  const fence = fenceChar.repeat(Math.max(3, maxFenceRun(normalized, fenceChar) + 1))
  return [
    `${fence}${language}`,
    normalized,
    fence,
  ].join('\n')
}

function formatMetadataLine(label: string, value: unknown): string {
  const rendered = value == null || value === ''
    ? 'undefined'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value)
  return `${label.padEnd(18, ' ')}: ${rendered}`
}

function messageAnchorLabel(message: DebugMessagePart): string {
  return message.role.charAt(0).toUpperCase() + message.role.slice(1)
}

function formatSourceHeading(source: string): string {
  return source.charAt(0).toUpperCase() + source.slice(1)
}

function renderMessageBlock(message: DebugMessagePart): string {
  return [
    `### ${messageAnchorLabel(message)}`,
    message.name ? `- Name: ${message.name}` : '',
    message.toolCallId ? `- Tool Call ID: ${message.toolCallId}` : '',
    renderFencedBlock(message.content || '_empty_', 'text', '~'),
  ].filter(Boolean).join('\n')
}

function renderJsonBlock(value: unknown): string {
  return renderFencedBlock(JSON.stringify(value, null, 2), 'json', '`')
}

export function renderDebugMarkdown(entry: DebugEntry): string {
  const metadata = entry.metadata
  const metadataLines = [
    formatMetadataLine('requestType', metadata.requestType),
    formatMetadataLine('model', metadata.model),
    formatMetadataLine('resolvedModel', metadata.resolvedModel),
    formatMetadataLine('maxTokens', metadata.maxTokens),
    formatMetadataLine('maxOutputTokens', metadata.maxOutputTokens),
    formatMetadataLine('otherOptions', metadata.otherOptions),
    formatMetadataLine('reasoning', metadata.reasoning),
    formatMetadataLine('startTime', new Date(metadata.createdAt).toISOString()),
    formatMetadataLine('endTime', metadata.endAt ? new Date(metadata.endAt).toISOString() : undefined),
    formatMetadataLine('duration', metadata.durationMs),
    formatMetadataLine('ourRequestId', metadata.id),
    formatMetadataLine('requestId', metadata.requestId),
    formatMetadataLine('serverRequestId', metadata.serverRequestId),
    formatMetadataLine('responseId', metadata.responseId),
    formatMetadataLine('status', metadata.status),
    formatMetadataLine('method', metadata.method),
    formatMetadataLine('url', metadata.url),
    formatMetadataLine('usage', metadata.usage),
    formatMetadataLine('requestBytes', metadata.requestBytes),
    formatMetadataLine('responseBytes', metadata.responseBytes),
    formatMetadataLine('truncated', metadata.truncated),
    formatMetadataLine('error', metadata.error),
  ]

  const requestAnchors = entry.requestMessages
    .map((message) => `  - [${messageAnchorLabel(message)}](#${message.role})`)
    .join('\n')
  const requestMessages = entry.requestMessages.length
    ? entry.requestMessages.map(renderMessageBlock).join('\n\n')
    : '_No request messages captured._'
  const responseMessages = entry.responseMessages.length
    ? entry.responseMessages.map(renderMessageBlock).join('\n\n')
    : '_No response messages captured._'

  const toolSummary = entry.tools.length
    ? `<details>\n<summary>tools (${entry.tools.length})     : ${entry.tools.map((tool) => tool.name).join(', ')}</summary>${renderJsonBlock(entry.tools)}\n</details>`
    : ''

  const toolCalls = entry.toolCalls.length ? renderJsonBlock(entry.toolCalls) : '_No tool calls captured._'
  const toolResults = entry.toolResults.length ? renderJsonBlock(entry.toolResults) : '_No tool results captured._'
  const requestHeaders = Object.keys(entry.requestHeaders).length ? renderJsonBlock(entry.requestHeaders) : '_No request headers captured._'
  const responseHeaders = Object.keys(entry.responseHeaders).length ? renderJsonBlock(entry.responseHeaders) : '_No response headers captured._'
  const responseJson = entry.responseJson != null ? renderJsonBlock(entry.responseJson) : '_No structured response JSON captured._'

  return [
    `# ${formatSourceHeading(metadata.source)} / ${metadata.id}`,
    '',
    '- [Request Messages](#request-messages)',
    requestAnchors || '  - _No request messages captured._',
    '- [Response](#response)',
    '',
    '## Metadata',
    '<pre><code>',
    ...metadataLines,
    toolSummary,
    '</code></pre>',
    '',
    '## Request Messages',
    '',
    '### Headers',
    requestHeaders,
    '',
    '### Messages',
    requestMessages,
    '',
    '## Response',
    '',
    '### Headers',
    responseHeaders,
    '',
    '### Messages',
    responseMessages,
    '',
    '### Tool Calls',
    toolCalls,
    '',
    '### Tool Results',
    toolResults,
    '',
    '### Response JSON',
    responseJson,
    '',
    '### Response Text',
    renderFencedBlock(entry.responseText || '_empty_', 'text', '~'),
  ].filter((line) => line !== '').join('\n') + '\n'
}
