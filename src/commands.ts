import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { h, type Context, type Session } from 'koishi'
import type { DebugCaptureConfig, DebugEntry } from './types'
import { DEBUG_LOG_TABLE, pruneEmptyDebugDayDirs, readDebugEntry, readMarkdownFile, removeDebugFiles, writeHtmlFile, type DebugLogRow } from './storage'
import { renderDebugPreview, renderDebugPreviewHtml } from './render-image'
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

type ActiveSendMode = 'text' | 'image' | 'html'

function normalizeSendMode(config: DebugCaptureConfig): ActiveSendMode {
  const sendMode = (config as any).sendMode
  if (sendMode === 'html') return 'html'
  if (sendMode === 'text') return 'text'
  return 'image'
}

async function sendPreview(session: Session, markdown: string) {
  await session.send(markdown)
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
  const match = normalized.match(/([^/]+)\/(md|json|files|html)\/([^/]+)$/)
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
      inferHtmlPath(row),
      ...(entry.assetFiles?.map((asset) => asset.filePath) ?? []),
    ]
  } catch (error) {
    logger.warn(`读取待删除调试日志失败: ${row.id}`, error)
    return [row.filePath, row.jsonPath, inferHtmlPath(row)]
  }
}

function inferHtmlPath(row: Pick<DebugLogRow, 'filePath' | 'htmlPath'>) {
  if (row.htmlPath) return row.htmlPath
  if (!row.filePath) return undefined

  const mdDir = path.dirname(row.filePath)
  if (path.basename(mdDir) !== 'md') return undefined
  const dayDir = path.dirname(mdDir)
  const stem = path.basename(row.filePath, path.extname(row.filePath))
  return path.join(dayDir, 'html', `${stem}.html`)
}

function formatEntryOverview(entry: DebugEntry, row: Pick<DebugLogRow, 'filePath' | 'jsonPath' | 'htmlPath' | 'summary'>) {
  const markdownPath = describeStoredFile(row.filePath)
  const jsonPath = describeStoredFile(row.jsonPath)
  const htmlPath = describeStoredFile(row.htmlPath)
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
    htmlPath ? `HTML: ${htmlPath}` : undefined,
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

interface LocalAssetsLike {
  root?: string
  baseUrl?: string
  stats?: () => Promise<unknown>
  write?: (buffer: Buffer, filename: string) => Promise<void>
}

async function writeLocalImageAsset(ctx: Context, buffer: Buffer, index: number) {
  const assets = (ctx as any).assets as LocalAssetsLike | undefined
  if (!assets || typeof assets.write !== 'function') {
    logger.warn('assets-local 服务不可用，无法发送调试预览图片 URL')
    return null
  }

  if (!assets.root || !assets.baseUrl || assets.baseUrl === 'file:') {
    logger.warn('assets-local 未配置可访问的 selfUrl，无法生成调试预览图片 URL')
    return null
  }

  if (typeof assets.stats === 'function') {
    await assets.stats()
  }

  const hash = createHash('sha1').update(buffer).digest('hex')
  const filename = `${hash}-${index + 1}.png`
  const savePath = path.resolve(assets.root, filename)
  await assets.write(buffer, savePath)
  return `${String(assets.baseUrl).replace(/\/+$/, '')}/${filename}`
}

async function sendImageBuffers(ctx: Context, session: Session, buffers: Buffer[], batchSize: number) {
  if (!buffers.length) return false

  const urls: string[] = []
  for (const [index, buffer] of buffers.entries()) {
    const url = await writeLocalImageAsset(ctx, buffer, index)
    if (!url) return false
    urls.push(url)
  }

  if (buffers.length === 1) {
    for (const url of urls) {
      await session.send(h.image(url))
    }
    return true
  }

  for (let index = 0; index < urls.length; index += batchSize) {
    const batch = urls.slice(index, index + batchSize)
    const figure = h('figure', {}, batch.map((url) => h('message', {}, [h.image(url)])))
    await session.send(figure)
  }

  return true
}

function parseUsage(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function pickNumericField(value: unknown, keys: string[]): number | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const item = record[key]
    if (typeof item === 'number' && Number.isFinite(item)) return item
  }
  return undefined
}

function formatTotalTokens(usage: unknown) {
  const parsed = parseUsage(usage)
  const direct = pickNumericField(parsed, ['total_tokens', 'totalTokens', 'total_token_count', 'totalTokenCount', 'total'])
  if (direct != null) return String(direct)

  const prompt = pickNumericField(parsed, ['prompt_tokens', 'promptTokens', 'input_tokens', 'inputTokens'])
  const completion = pickNumericField(parsed, ['completion_tokens', 'completionTokens', 'output_tokens', 'outputTokens'])
  if (prompt != null || completion != null) {
    return String((prompt ?? 0) + (completion ?? 0))
  }

  return '-'
}

function formatUtc8Time(timestamp: number) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(timestamp))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second} UTC+8`
}

function buildHtmlFileMetadataText(entry: DebugEntry, htmlPath: string, generatedAt: number) {
  return [
    'ChatLuna 调试 HTML 报告',
    `- 报告生成时间: ${formatUtc8Time(generatedAt)}`,
    `- 响应模型: ${entry.metadata.resolvedModel || entry.metadata.model || '-'}`,
    `- 总使用 token: ${formatTotalTokens(entry.metadata.usage)}`,
    `- 日志 ID: ${entry.metadata.id}`,
    `- 文件名: ${path.basename(htmlPath)}`,
  ].join('\n')
}

interface OneBotForwardSender {
  sendGroupForwardMsg?: (groupId: string, messages: unknown[]) => Promise<unknown>
  sendPrivateForwardMsg?: (userId: string, messages: unknown[]) => Promise<unknown>
}

function getOneBotForwardSender(session: Session): OneBotForwardSender | undefined {
  const onebot = (session as any).onebot
  if (!onebot) return undefined
  return onebot as OneBotForwardSender
}

function getForwardTarget(session: Session) {
  const channelId = String(session.channelId || '')
  const userId = String(session.userId || '')
  const isDirect = Boolean(session.isDirect || channelId.startsWith('private:'))
  if (isDirect) {
    return {
      isDirect,
      id: channelId.startsWith('private:') ? channelId.slice('private:'.length) : userId,
    }
  }
  return { isDirect, id: channelId || String(session.guildId || '') }
}

async function sendHtmlFileForward(session: Session, metadataText: string, htmlPath: string, generatedAt: number) {
  const sender = getOneBotForwardSender(session)
  if (!sender) throw new Error('OneBot internal sender is unavailable')

  const target = getForwardTarget(session)
  if (!target.id) throw new Error('OneBot forward target is unavailable')

  const fileName = path.basename(htmlPath)
  const bot = (session as any).bot
  const authorName = bot?.user?.name || 'ChatLuna Debug'
  const authorUin = String(session.selfId || bot?.selfId || bot?.userId || 0)
  const baseNodeData = {
    name: authorName,
    uin: authorUin,
    time: `${Math.floor(generatedAt / 1000)}`,
  }
  const messages = [
    {
      type: 'node',
      data: {
        ...baseNodeData,
        content: [{ type: 'text', data: { text: metadataText } }],
      },
    },
    {
      type: 'node',
      data: {
        ...baseNodeData,
        content: [{
          type: 'file',
          data: {
            file: pathToFileURL(htmlPath).href,
            name: fileName,
          },
        }],
      },
    },
  ]

  if (target.isDirect) {
    if (typeof sender.sendPrivateForwardMsg !== 'function') throw new Error('sendPrivateForwardMsg is unavailable')
    await sender.sendPrivateForwardMsg(target.id, messages)
    return true
  }

  if (typeof sender.sendGroupForwardMsg !== 'function') throw new Error('sendGroupForwardMsg is unavailable')
  await sender.sendGroupForwardMsg(target.id, messages)
  return true
}

async function markHtmlPath(ctx: Context, row: DebugLogRow, htmlPath: string) {
  await (ctx.database as any).upsert(DEBUG_LOG_TABLE, [{
    ...row,
    htmlPath,
  }] as any)
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
      if (normalizeSendMode(config) === 'text') return previewText
      return sendPreview(session, previewText)
    })

  command.subcommand('.send <id:text>', text(undefined, 'commands.chat-debug.send.description'))
    .action(async ({ session }, id) => {
      if (!session) return
      const row = await findRow(ctx, id)
      if (!row) return text(session, 'commands.chat-debug.messages.not-found')
      const entry = await loadEntry(row)
      const mode = normalizeSendMode(config)
      if (mode === 'text') {
        const { markdown } = renderDebugPreviewHtml(entry, config, {
          sourcePath: row.filePath as string | undefined,
        })
        return clipPreview(markdown, config.maxPreviewChars)
      }

      if (mode === 'html') {
        const generatedAt = Date.now()
        const { markdown, html } = renderDebugPreviewHtml(entry, config, {
          sourcePath: row.filePath as string | undefined,
          stripCollapsedSystemPrompt: config.collapseSystemPromptOnRender ?? false,
        })
        try {
          const htmlPath = await writeHtmlFile(ctx, config.storageDir, entry.metadata.id, entry.metadata.createdAt, html)
          await markHtmlPath(ctx, row, htmlPath)
          const metadataText = buildHtmlFileMetadataText(entry, htmlPath, generatedAt)
          await sendHtmlFileForward(session, metadataText, htmlPath, generatedAt)
          return
        } catch (error) {
          logger.warn('发送 HTML 调试文件失败，回退到 Markdown 文本预览:', error)
          return clipPreview(markdown, config.maxPreviewChars)
        }
      }

      const preview = await renderDebugPreview(ctx, entry, config, {
        sourcePath: row.filePath as string | undefined,
      })
      if (preview.tooLarge || !preview.buffers?.length) {
        return clipPreview(preview.markdown, config.maxPreviewChars)
      }
      const sent = await sendImageBuffers(ctx, session, preview.buffers, config.mergeForwardBatchSize)
      if (!sent) return clipPreview(preview.markdown, config.maxPreviewChars)
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
