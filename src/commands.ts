import path from 'node:path'
import { h, type Context, type Session } from 'koishi'
import type { DebugCaptureConfig, DebugEntry } from './types'
import { DEBUG_LOG_TABLE, pruneEmptyDebugDayDirs, readDebugEntry, readMarkdownFile, removeDebugFiles, type DebugLogRow } from './storage'
import { renderDebugPreview } from './render-image'
import { logger } from './logger'
import zhCN from './locales/zh-CN'

export interface DebugRuntimeController {
  isHookInstalled(): boolean
  ensureHookInstalled(reason: string): boolean
  ensureHookUninstalled(reason: string): void
}

function formatLocale(template: string, params: Record<string, unknown> = {}) {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`))
}

function text(session: Session | undefined, key: string, params: Record<string, unknown> = {}) {
  if (session) {
    try {
      const localized = session.text(key, params)
      if (localized && localized !== key) return localized
    } catch {
      // fall back to bundled zh-CN strings when no session locale resolver is available
    }
  }

  const fallback = (zhCN as Record<string, string>)[key] || key
  return formatLocale(fallback, params)
}

function clipPreview(markdown: string, maxChars: number) {
  if (markdown.length <= maxChars) return markdown
  return `${markdown.slice(0, maxChars)}\n\n...\n\n[preview truncated]`
}

async function sendPreview(session: Session, markdown: string, mode: DebugCaptureConfig['sendMode']) {
  if (mode === 'text') {
    await session.send(markdown)
    return
  }
  await session.send(markdown)
  return
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

function sortDebugRows(rows: DebugLogRow[], order: 'asc' | 'desc') {
  const factor = order === 'asc' ? 1 : -1
  return [...rows].sort((left, right) => {
    const createdAtDiff = ((left.createdAt ?? 0) - (right.createdAt ?? 0)) * factor
    if (createdAtDiff !== 0) return createdAtDiff
    return left.id.localeCompare(right.id) * factor
  })
}

function formatRelativeAge(createdAt?: number, now = Date.now()) {
  if (!createdAt) return '刚刚'
  const elapsedSeconds = Math.max(0, Math.floor((now - createdAt) / 1000))
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}秒前`
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}分钟前`
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) {
    return `${elapsedHours}小时前`
  }

  const elapsedDays = Math.floor(elapsedHours / 24)
  if (elapsedDays < 7) {
    return `${elapsedDays}天前`
  }

  return '更久以前'
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

function dispatchOnce(session: Session, content: string | ReturnType<typeof h>) {
  void session.send(content).catch((error) => {
    logger.warn('调试预览发送结果已忽略（已按单次发送处理）:', error)
  })
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
    dispatchOnce(session, figure)
  }
}

export function registerCommands(ctx: Context, config: DebugCaptureConfig, runtime: DebugRuntimeController) {
  const command = ctx.command('chat-debug', text(undefined, 'commands.chat-debug.description'))

  command.subcommand('.status', text(undefined, 'commands.chat-debug.status.description'))
    .action(async ({ session }) => {
      if (!config.enabled || !config.captureEnabled) {
        return text(session, 'commands.chat-debug.messages.status.off')
      }

      return text(
        session,
        runtime.isHookInstalled()
          ? 'commands.chat-debug.messages.status.on'
          : 'commands.chat-debug.messages.status.partial',
      )
    })

  command.subcommand('.on', text(undefined, 'commands.chat-debug.on.description'))
    .action(async ({ session }) => {
      config.enabled = true
      config.captureEnabled = true
      const installed = runtime.ensureHookInstalled('command.on')
      return text(
        session,
        installed
          ? 'commands.chat-debug.messages.on.success'
          : 'commands.chat-debug.messages.on.pending',
      )
    })

  command.subcommand('.off', text(undefined, 'commands.chat-debug.off.description'))
    .action(async ({ session }) => {
      config.captureEnabled = false
      runtime.ensureHookUninstalled('command.off')
      return text(session, 'commands.chat-debug.messages.off.success')
    })

  command.subcommand('.list [page:number]', text(undefined, 'commands.chat-debug.list.description'))
    .action(async ({ session }, page = 1) => {
      const limit = config.managerPageSize
      const safePage = Math.max(1, Math.floor(page))
      const offset = (safePage - 1) * limit
      const rows = await (ctx.database as any).get(DEBUG_LOG_TABLE, {}, {
        limit,
        offset,
        sort: { createdAt: 'desc' },
      } as any) as DebugLogRow[]
      const pagedRows = sortDebugRows(rows, 'asc')
      if (!pagedRows.length) {
        return safePage === 1
          ? text(session, 'commands.chat-debug.messages.list.empty')
          : text(session, 'commands.chat-debug.messages.list.empty-page', { page: safePage })
      }
      const lines = pagedRows.map((row) => {
        const { day, fileName } = extractDayAndFileName(row.filePath)
        return `- ${row.id} | ${formatRelativeAge(row.createdAt)} | ${row.source || '-'} | ${row.resolvedModel || row.model || '-'} | ${row.status || '-'} | ${day} | ${fileName}`
      })
      return lines.join('\n')
    })

  command.subcommand('.show <id:text>', text(undefined, 'commands.chat-debug.show.description'))
    .action(async ({ session }, id) => {
      const row = await findRow(ctx, id)
      if (!row) return text(session, 'commands.chat-debug.messages.not-found')
      const entry = await loadEntry(row)
      return formatEntryOverview(entry, row)
    })

  command.subcommand('.preview <id:text>', text(undefined, 'commands.chat-debug.preview.description'))
    .action(async ({ session }, id) => {
      if (!session) return
      const row = await findRow(ctx, id)
      if (!row) return text(session, 'commands.chat-debug.messages.not-found')
      const filePath = row.filePath as string
      const markdown = await readMarkdownFile(filePath)
      const previewText = clipPreview(markdown, config.maxPreviewChars)
      if (!config.renderImageOnCommand) return previewText
      return sendPreview(session, previewText, config.sendMode)
    })

  command.subcommand('.send <id:text>', text(undefined, 'commands.chat-debug.send.description'))
    .action(async ({ session }, id) => {
      if (!session) return
      const row = await findRow(ctx, id)
      if (!row) return text(session, 'commands.chat-debug.messages.not-found')
      const entry = await loadEntry(row)
      const preview = await renderDebugPreview(ctx, entry, config, {
        sourcePath: row.filePath as string | undefined,
      })
      if (preview.tooLarge || !preview.buffers?.length) {
        return clipPreview(preview.markdown, config.maxPreviewChars)
      }
      await sendImageBuffers(session, preview.buffers, config.sendMode, config.mergeForwardBatchSize)
      return
    })

  command.subcommand('.delete <id:text>', text(undefined, 'commands.chat-debug.delete.description'))
    .action(async ({ session }, id) => {
      const row = await findRow(ctx, id)
      if (!row) return text(session, 'commands.chat-debug.messages.not-found')
      await removeDebugFiles(await collectDeletePaths(row))
      await (ctx.database as any).remove(DEBUG_LOG_TABLE, { id: row.id } as any)
      return text(session, 'commands.chat-debug.messages.delete.success', { id: row.id })
    })

  command.subcommand('.clean [keep:number]', text(undefined, 'commands.chat-debug.clean.description'))
    .action(async ({ session }, keep = config.managerPageSize) => {
      await pruneEmptyDebugDayDirs(ctx, config.storageDir)

      const safeKeep = Math.max(0, Math.floor(keep))
      const rows = sortDebugRows(await (ctx.database as any).get(DEBUG_LOG_TABLE, {}) as DebugLogRow[], 'desc')
      const obsoleteRows = rows.slice(safeKeep) as DebugLogRow[]
      if (!obsoleteRows.length) {
        return text(session, 'commands.chat-debug.messages.clean.empty', { count: rows.length })
      }

      for (const row of obsoleteRows) {
        await removeDebugFiles(await collectDeletePaths(row))
        await (ctx.database as any).remove(DEBUG_LOG_TABLE, { id: row.id } as any)
      }
      await pruneEmptyDebugDayDirs(ctx, config.storageDir)
      return text(session, 'commands.chat-debug.messages.clean.success', {
        count: obsoleteRows.length,
        keep: safeKeep,
      })
    })

  logger.info('chat-debug 命令已注册')
}
