import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Context } from 'koishi'
import { logger } from './logger'
import type { DebugAssetFile, DebugEntry, DebugMetadata } from './types'

export const DEBUG_LOG_TABLE = 'chatluna_debug_logs'

export interface DebugLogRow extends Omit<DebugMetadata, 'reasoning' | 'otherOptions' | 'usage'> {
  reasoning?: string
  otherOptions?: string
  usage?: string
  filePath: string
  jsonPath: string
  htmlPath?: string
  summary: string
}

const DATA_URI_PATTERN = /data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\r\n]+)/g

function resolveDebugDay(createdAt: number): string {
  return new Date(createdAt).toISOString().slice(0, 10)
}

export function buildDebugFileStem(id: string): string {
  return id.startsWith('chat-debug-') ? id : `chat-debug-${id}`
}

function ensureDataPath(
  ctx: Context,
  storageDir: string,
  createdAt: number,
  category: 'md' | 'json' | 'files' | 'html',
  fileName: string,
): string {
  const base = path.join(ctx.baseDir, 'data', storageDir)
  const day = resolveDebugDay(createdAt)
  return path.join(base, day, category, fileName)
}

export function ensureMarkdownPath(ctx: Context, storageDir: string, id: string, createdAt: number): string {
  return ensureDataPath(ctx, storageDir, createdAt, 'md', `${buildDebugFileStem(id)}.md`)
}

export function ensureJsonPath(ctx: Context, storageDir: string, id: string, createdAt: number): string {
  return ensureDataPath(ctx, storageDir, createdAt, 'json', `${buildDebugFileStem(id)}.json`)
}

export function ensureHtmlPath(ctx: Context, storageDir: string, id: string, createdAt: number): string {
  return ensureDataPath(ctx, storageDir, createdAt, 'html', `${buildDebugFileStem(id)}.html`)
}

function ensureFilesPath(ctx: Context, storageDir: string, createdAt: number, fileName: string): string {
  return ensureDataPath(ctx, storageDir, createdAt, 'files', fileName)
}

export function buildSummary(entry: DebugEntry): string {
  const requestCount = entry.requestMessages.length
  const responseCount = entry.responseMessages.length
  const toolCallCount = entry.toolCalls.length
  const responseSnippet = entry.responseText.slice(0, 120).replace(/\s+/g, ' ')
  return `requestMessages=${requestCount}; responseMessages=${responseCount}; toolCalls=${toolCallCount}; response=${responseSnippet}${entry.responseText.length > 120 ? '…' : ''}`
}

export async function writeMarkdownFile(ctx: Context, storageDir: string, id: string, markdown: string) {
  const filePath = ensureMarkdownPath(ctx, storageDir, id, Date.now())
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, markdown, 'utf8')
  return filePath
}

export async function readMarkdownFile(filePath: string) {
  return fs.readFile(filePath, 'utf8')
}

export async function writeJsonFile(ctx: Context, storageDir: string, id: string, entry: DebugEntry) {
  const filePath = ensureJsonPath(ctx, storageDir, id, entry.metadata.createdAt)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(entry, null, 2), 'utf8')
  return filePath
}

export async function readDebugEntry(filePath: string) {
  const content = await fs.readFile(filePath, 'utf8')
  return JSON.parse(content) as DebugEntry
}

export async function writeHtmlFile(ctx: Context, storageDir: string, id: string, createdAt: number, html: string) {
  const filePath = ensureHtmlPath(ctx, storageDir, id, createdAt)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, html, 'utf8')
  return filePath
}

export async function removeDebugFiles(paths: Array<string | undefined>) {
  await Promise.all(paths.filter(Boolean).map(async (filePath) => {
    try {
      await fs.rm(filePath!, { force: true })
    } catch (error) {
      logger.warn(`删除调试文件失败: ${filePath}`, error)
    }
  }))
}

async function directoryContainsFiles(directoryPath: string): Promise<boolean> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true }).catch(() => null)
  try {
    if (!entries) return false
  } catch {
    return false
  }

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name)
    if (entry.isFile()) {
      return true
    }
    if (entry.isDirectory() && await directoryContainsFiles(fullPath)) {
      return true
    }
  }

  return false
}

export async function pruneEmptyDebugDayDirs(ctx: Context, storageDir: string) {
  const baseDir = path.join(ctx.baseDir, 'data', storageDir)
  const entries = await fs.readdir(baseDir, { withFileTypes: true }).catch(() => null)
  if (!entries) {
    return 0
  }

  let removedCount = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dayDir = path.join(baseDir, entry.name)
    if (await directoryContainsFiles(dayDir)) continue
    try {
      await fs.rm(dayDir, { recursive: true, force: true })
      removedCount += 1
    } catch (error) {
      logger.warn(`移除空调试目录失败: ${dayDir}`, error)
    }
  }

  return removedCount
}

function serializeUnknown(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return undefined }
}

function mimeToExtension(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    case 'image/svg+xml':
      return 'svg'
    default:
      return mimeType.split('/')[1]?.replace(/[^a-z0-9]+/gi, '-') || 'bin'
  }
}

async function writeAssetFile(
  ctx: Context,
  storageDir: string,
  entry: DebugEntry,
  assetIndex: number,
  mimeType: string,
  data: string,
): Promise<DebugAssetFile> {
  const hash = createHash('sha1').update(data).digest('hex').slice(0, 16)
  const extension = mimeToExtension(mimeType)
  const fileName = `${buildDebugFileStem(entry.metadata.id)}-asset-${String(assetIndex).padStart(2, '0')}.${extension}`
  const filePath = ensureFilesPath(ctx, storageDir, entry.metadata.createdAt, fileName)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, Buffer.from(data.replace(/\s+/g, ''), 'base64'))
  return {
    name: `image:${hash}`,
    fileName,
    filePath,
    relativePath: path.posix.join('..', 'files', fileName),
    mimeType,
  }
}

async function rewriteStringAssets(
  ctx: Context,
  storageDir: string,
  entry: DebugEntry,
  value: string,
  assetMap: Map<string, DebugAssetFile>,
  assetCounter: { value: number },
  appendMarkdownLinks: boolean,
): Promise<string> {
  if (!value || !DATA_URI_PATTERN.test(value)) return value
  DATA_URI_PATTERN.lastIndex = 0

  let cursor = 0
  let changed = false
  let rewritten = ''
  const linkedAssets: DebugAssetFile[] = []

  for (const match of value.matchAll(DATA_URI_PATTERN)) {
    const [fullMatch, mimeType, data] = match
    const start = match.index ?? 0
    rewritten += value.slice(cursor, start)

    let asset = assetMap.get(fullMatch)
    if (!asset) {
      assetCounter.value += 1
      asset = await writeAssetFile(ctx, storageDir, entry, assetCounter.value, mimeType, data)
      assetMap.set(fullMatch, asset)
    }

    rewritten += `[${asset.name}]`
    linkedAssets.push(asset)
    cursor = start + fullMatch.length
    changed = true
  }

  if (!changed) return value

  rewritten += value.slice(cursor)
  if (!appendMarkdownLinks || !linkedAssets.length) return rewritten

  const uniqueLinks = Array.from(new Map(linkedAssets.map((asset) => [asset.relativePath, asset])).values())
  const renderedLinks = uniqueLinks.map((asset) => `![${asset.name}](${asset.relativePath})`).join('\n')
  return `${rewritten}\n\n${renderedLinks}`
}

async function rewriteUnknownAssets(
  ctx: Context,
  storageDir: string,
  entry: DebugEntry,
  value: unknown,
  assetMap: Map<string, DebugAssetFile>,
  assetCounter: { value: number },
  appendMarkdownLinks: boolean,
): Promise<unknown> {
  if (typeof value === 'string') {
    return rewriteStringAssets(ctx, storageDir, entry, value, assetMap, assetCounter, appendMarkdownLinks)
  }

  if (Array.isArray(value)) {
    const result = []
    for (const item of value) {
      result.push(await rewriteUnknownAssets(ctx, storageDir, entry, item, assetMap, assetCounter, appendMarkdownLinks))
    }
    return result
  }

  if (!value || typeof value !== 'object') return value

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] = await rewriteUnknownAssets(ctx, storageDir, entry, item, assetMap, assetCounter, appendMarkdownLinks)
  }
  return result
}

export async function rewriteDebugEntryAssets(ctx: Context, storageDir: string, entry: DebugEntry): Promise<DebugEntry> {
  const assetMap = new Map<string, DebugAssetFile>()
  const assetCounter = { value: 0 }

  const requestMessages = []
  for (const message of entry.requestMessages) {
    requestMessages.push({
      ...message,
      content: await rewriteStringAssets(ctx, storageDir, entry, message.content, assetMap, assetCounter, true),
    })
  }

  const responseMessages = []
  for (const message of entry.responseMessages) {
    responseMessages.push({
      ...message,
      content: await rewriteStringAssets(ctx, storageDir, entry, message.content, assetMap, assetCounter, true),
    })
  }

  const toolCalls = []
  for (const toolCall of entry.toolCalls) {
    toolCalls.push({
      ...toolCall,
      arguments: typeof toolCall.arguments === 'string'
        ? await rewriteStringAssets(ctx, storageDir, entry, toolCall.arguments, assetMap, assetCounter, true)
        : toolCall.arguments,
    })
  }

  const toolResults = []
  for (const toolResult of entry.toolResults) {
    toolResults.push({
      ...toolResult,
      output: await rewriteStringAssets(ctx, storageDir, entry, toolResult.output, assetMap, assetCounter, true),
    })
  }

  const rewrittenEntry: DebugEntry = {
    ...entry,
    requestMessages,
    responseMessages,
    toolCalls,
    toolResults,
    requestBodyText: entry.requestBodyText
      ? await rewriteStringAssets(ctx, storageDir, entry, entry.requestBodyText, assetMap, assetCounter, true)
      : entry.requestBodyText,
    requestBodyJson: await rewriteUnknownAssets(ctx, storageDir, entry, entry.requestBodyJson, assetMap, assetCounter, false),
    responseReasoningText: entry.responseReasoningText
      ? await rewriteStringAssets(ctx, storageDir, entry, entry.responseReasoningText, assetMap, assetCounter, true)
      : entry.responseReasoningText,
    responseText: await rewriteStringAssets(ctx, storageDir, entry, entry.responseText, assetMap, assetCounter, true),
    responseJson: await rewriteUnknownAssets(ctx, storageDir, entry, entry.responseJson, assetMap, assetCounter, false),
    assetFiles: Array.from(assetMap.values()),
  }

  return rewrittenEntry
}

export async function saveDebugEntry(ctx: Context, entry: DebugEntry, markdown: string, storageDir: string) {
  const filePath = ensureMarkdownPath(ctx, storageDir, entry.metadata.id, entry.metadata.createdAt)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, markdown, 'utf8')
  const jsonPath = await writeJsonFile(ctx, storageDir, entry.metadata.id, entry)
  const { reasoning, otherOptions, usage, ...restMeta } = entry.metadata
  const row: DebugLogRow = {
    ...restMeta,
    reasoning: serializeUnknown(reasoning),
    otherOptions: serializeUnknown(otherOptions),
    usage: serializeUnknown(usage),
    filePath,
    jsonPath,
    summary: buildSummary(entry),
  }
  try {
    await (ctx.database as any).upsert(DEBUG_LOG_TABLE, [row])
  } catch (error) {
    logger.warn('写入调试索引失败:', error)
  }
  return row
}


