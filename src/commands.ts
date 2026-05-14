import path from 'node:path'
import { h, type Context, type Session } from 'koishi'
import type { DebugCaptureConfig, DebugEntry } from './types'
import { DEBUG_LOG_TABLE, readDebugEntry, readMarkdownFile, removeDebugFiles, type DebugLogRow } from './storage'
import { renderDebugPreview } from './render-image'
import { logger } from './logger'

function clipPreview(markdown: string, maxChars: number) {
  if (markdown.length <= maxChars) return markdown
  return `${markdown.slice(0, maxChars)}\n\n...\n\n[preview truncated]`
}

async function sendPreview(session: Session, markdown: string, mode: DebugCaptureConfig['sendMode']) {
  if (mode === 'text') {
    return session.send(markdown)
  }
  return session.send(markdown)
}

function formatMetadataLine(label: string, value: unknown) {
  if (value == null || value === '') return undefined
  if (typeof value === 'object') {
    return `${label}: ${JSON.stringify(value)}`
  }
  return `${label}: ${value}`
}

function describeStoredFile(filePath?: string) {
  if (!filePath) return undefined
  const normalized = filePath.replace(/\\/g, '/')
  const match = normalized.match(/([^/]+)\/(md|json|files)\/([^/]+)$/)
  if (match) {
    return `${match[1]}/${match[2]}/${match[3]}`
  }
  return path.basename(filePath)
}

function extractDayAndFileName(filePath?: string) {
  if (!filePath) {
    return { day: '-', fileName: '-' }
  }

  const normalized = filePath.replace(/\\/g, '/')
  const match = normalized.match(/([^/]+)\/(?:md|json|files)\/([^/]+)$/)
  if (match) {
    return { day: match[1], fileName: match[2] }
  }

  return {
    day: '-',
    fileName: path.basename(filePath),
  }
}

async function findRow(ctx: Context, id: string) {
  const [row] = await (ctx.database as any).get(DEBUG_LOG_TABLE, { id } as any)
  return row as DebugLogRow | undefined
}

async function collectDeletePaths(row: DebugLogRow) {
  try {
    const entry = await loadEntry(row)
    return [
      row.filePath,
      row.jsonPath,
      ...(entry.assetFiles?.map((asset) => asset.filePath) ?? []),
    ]
  } catch (error) {
    logger.warn(`读取待删除调试日志失败: ${row.id}`, error)
    return [row.filePath, row.jsonPath]
  }
}

function formatEntryOverview(entry: DebugEntry, row: Pick<DebugLogRow, 'filePath' | 'jsonPath' | 'summary'>) {
  const markdownPath = describeStoredFile(row.filePath)
  const jsonPath = describeStoredFile(row.jsonPath)
  const lines = [
    formatMetadataLine('ID', entry.metadata.id),
    formatMetadataLine('来源', entry.metadata.source),
    formatMetadataLine('请求类型', entry.metadata.requestType),
    formatMetadataLine('模型', entry.metadata.resolvedModel || entry.metadata.model),
    formatMetadataLine('状态码', entry.metadata.status),
    formatMetadataLine('耗时(ms)', entry.metadata.durationMs),
    formatMetadataLine('请求地址', entry.metadata.url),
    formatMetadataLine('Request ID', entry.metadata.requestId),
    formatMetadataLine('Response ID', entry.metadata.responseId),
    `请求消息: ${entry.requestMessages.length}`,
    `响应消息: ${entry.responseMessages.length}`,
    `工具调用: ${entry.toolCalls.length}`,
    `工具结果: ${entry.toolResults.length}`,
    formatMetadataLine('资产文件', entry.assetFiles?.length ?? 0),
    markdownPath ? `Markdown: ${markdownPath}` : undefined,
    jsonPath ? `JSON: ${jsonPath}` : undefined,
    `摘要: ${row.summary}`,
  ].filter(Boolean)
  return lines.join('\n')
}

function buildFallbackEntry(row: any, markdown: string): DebugEntry {
  return {
    metadata: {
      id: row.id,
      createdAt: row.createdAt,
      endAt: row.endAt,
      durationMs: row.durationMs,
      source: row.source,
      requestType: row.requestType,
      model: row.model,
      resolvedModel: row.resolvedModel,
      method: row.method,
      url: row.url,
      status: row.status,
      requestId: row.requestId,
      serverRequestId: row.serverRequestId,
      responseId: row.responseId,
      truncated: row.truncated,
      requestBytes: row.requestBytes,
      responseBytes: row.responseBytes,
      maxTokens: row.maxTokens,
      maxOutputTokens: row.maxOutputTokens,
      reasoning: row.reasoning,
      otherOptions: row.otherOptions,
      usage: row.usage,
      error: row.error,
    },
    tools: [],
    requestMessages: [],
    responseMessages: [],
    toolCalls: [],
    toolResults: [],
    responseText: markdown,
    requestHeaders: {},
    responseHeaders: {},
    assetFiles: [],
  }
}

async function loadEntry(row: any) {
  const typedRow = row as DebugLogRow
  if (typedRow.jsonPath) {
    try {
      return await readDebugEntry(typedRow.jsonPath)
    } catch (error) {
      logger.warn(`读取结构化调试日志失败: ${typedRow.jsonPath}`, error)
    }
  }

  const markdown = await readMarkdownFile(typedRow.filePath)
  return buildFallbackEntry(typedRow, markdown)
}

async function sendImageBuffers(session: Session, buffers: Buffer[], mode: DebugCaptureConfig['sendMode'], batchSize: number) {
  if (!buffers.length) return
  if (mode === 'text') {
    return
  }

  if (buffers.length === 1 || mode === 'image') {
    for (const buffer of buffers) {
      await session.send(h.image(buffer, 'image/png'))
    }
    return
  }

  for (let index = 0; index < buffers.length; index += batchSize) {
    const batch = buffers.slice(index, index + batchSize)
    const figure = h('figure', {}, batch.map((buffer) => h('message', {}, [h.image(buffer, 'image/png')])))
    await session.send(figure)
  }
}

export function registerCommands(ctx: Context, config: DebugCaptureConfig) {
  const command = ctx.command('chat-debug', 'ChatLuna 调试日志管理')

  command.subcommand('.status', '查看聊天调试状态')
    .action(async () => {
      return `ChatLuna 聊天调试：${config.enabled && config.captureEnabled ? 'on' : 'off'}`
    })

  command.subcommand('.on', '开启聊天调试')
    .action(async () => {
      config.enabled = true
      config.captureEnabled = true
      return 'ChatLuna 聊天调试已开启'
    })

  command.subcommand('.off', '关闭聊天调试')
    .action(async () => {
      config.captureEnabled = false
      return 'ChatLuna 聊天调试已关闭'
    })

  command.subcommand('.list [page:number]', '列出调试日志')
    .action(async ({ session }, page = 1) => {
      const limit = config.managerPageSize
      const offset = Math.max(0, page - 1) * limit
      const rows = await (ctx.database as any).get(DEBUG_LOG_TABLE, {}, {
        limit,
        offset,
        sort: { createdAt: 'desc' },
      } as any)
      if (!rows.length) return '没有可用的调试日志。'
      const lines = rows.map((row: any) => {
        const { day, fileName } = extractDayAndFileName(row.filePath)
        return `- ${row.id} | ${row.source || '-'} | ${row.resolvedModel || row.model || '-'} | ${row.status || '-'} | ${day} | ${fileName}`
      })
      return lines.join('\n')
    })

  command.subcommand('.show <id:text>', '查看指定日志摘要')
    .action(async (_argv, id) => {
      const row = await findRow(ctx, id)
      if (!row) return '未找到指定日志。'
      const entry = await loadEntry(row)
      return formatEntryOverview(entry, row)
    })

  command.subcommand('.preview <id:text>', '预览指定日志')
    .action(async ({ session }, id) => {
      if (!session) return
      const row = await findRow(ctx, id)
      if (!row) return '未找到指定日志。'
      const filePath = row.filePath as string
      const markdown = await readMarkdownFile(filePath)
      const previewText = clipPreview(markdown, config.maxPreviewChars)
      if (!config.renderImageOnCommand) return previewText
      return sendPreview(session, previewText, config.sendMode)
    })

  command.subcommand('.send <id:text>', '发送日志预览')
    .action(async ({ session }, id) => {
      if (!session) return
      const row = await findRow(ctx, id)
      if (!row) return '未找到指定日志。'
      const entry = await loadEntry(row)
      const preview = await renderDebugPreview(ctx, entry, config)
      if (preview.tooLarge || !preview.buffers?.length) {
        return clipPreview(preview.markdown, config.maxPreviewChars)
      }
      await sendImageBuffers(session, preview.buffers, config.sendMode, config.mergeForwardBatchSize)
      return
    })

  command.subcommand('.delete <id:text>', '删除指定日志')
    .action(async (_argv, id) => {
      const row = await findRow(ctx, id)
      if (!row) return '未找到指定日志。'
      await removeDebugFiles(await collectDeletePaths(row))
      await (ctx.database as any).remove(DEBUG_LOG_TABLE, { id: row.id } as any)
      return `已删除调试日志：${row.id}`
    })

  command.subcommand('.clean [keep:number]', '清理旧日志，保留最新若干条')
    .action(async (_argv, keep = config.managerPageSize) => {
      const safeKeep = Math.max(0, Math.floor(keep))
      const rows = await (ctx.database as any).get(DEBUG_LOG_TABLE, {}, {
        sort: { createdAt: 'desc' },
      } as any)
      const obsoleteRows = rows.slice(safeKeep) as DebugLogRow[]
      if (!obsoleteRows.length) {
        return `没有需要清理的日志，当前保留数：${rows.length}`
      }

      for (const row of obsoleteRows) {
        await removeDebugFiles(await collectDeletePaths(row))
        await (ctx.database as any).remove(DEBUG_LOG_TABLE, { id: row.id } as any)
      }
      return `已清理 ${obsoleteRows.length} 条旧日志，保留最新 ${safeKeep} 条。`
    })

  logger.info('chat-debug 命令已注册')
}
