import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { Context } from 'koishi'
import type { DebugCaptureConfig, DebugEntry } from './types'
import {
  DEBUG_LOG_TABLE,
  listDebugStorageFiles,
  normalizeDebugFilePath,
  pruneEmptyDebugDayDirs,
  readDebugEntry,
  removeDebugFiles,
  type DebugDeleteFailure,
  type DebugLogRow,
} from './storage'

type DebugMutation<T> = () => Promise<T>

let debugMutationQueue = Promise.resolve()

async function warnClean(message: string, error: unknown) {
  try {
    const { logger } = await import('./logger')
    logger.warn(message, error)
  } catch {
    console.warn(message, error)
  }
}

function enqueueDebugMutation<T>(mutation: DebugMutation<T>) {
  const queued = debugMutationQueue.then(mutation, mutation)
  debugMutationQueue = queued.then(() => undefined, () => undefined)
  return queued
}

export interface DeleteDebugLogResult {
  indexedRowCleaned: boolean
  removedFiles: number
  missingFiles: number
  failures: DebugDeleteFailure[]
  invalidatedTurnIds: string[]
}

export interface CleanDebugLogsResult {
  requestedKeep: number
  retainedRows: number
  indexedRowsCleaned: number
  orphanFilesCleaned: number
  removedIndexedFiles: number
  missingIndexedFiles: number
  prunedDirectories: number
  failures: DebugDeleteFailure[]
  invalidatedTurnIds: string[]
}

interface DerivedTurnFiles {
  id: string
  paths: string[]
  jsonPath: string
  memberIds?: string[]
}

function isMissingFileError(error: unknown) {
  return typeof error === 'object' && error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
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

function derivedTurnPaths(dayDir: string, id: string) {
  return [
    path.join(dayDir, 'turns', `${id}.md`),
    path.join(dayDir, 'turns', `${id}.json`),
    path.join(dayDir, 'html', `chat-debug-${id}.html`),
  ]
}

async function collectDerivedTurns(scannedFiles: string[]) {
  const groups = new Map<string, DerivedTurnFiles>()
  for (const filePath of scannedFiles) {
    const category = path.basename(path.dirname(filePath))
    const name = path.basename(filePath)
    const match = category === 'turns'
      ? name.match(/^(turn-[a-zA-Z0-9_-]+)\.(?:md|json)(?:\.tmp)?$/)
      : category === 'html' ? name.match(/^chat-debug-(turn-[a-zA-Z0-9_-]+)\.html$/) : null
    if (!match) continue
    const id = match[1]
    const dayDir = path.dirname(path.dirname(filePath))
    const key = `${normalizeDebugFilePath(dayDir)}:${id}`
    const group = groups.get(key) ?? {
      id, paths: derivedTurnPaths(dayDir, id), jsonPath: path.join(dayDir, 'turns', `${id}.json`),
    }
    if (!group.paths.includes(filePath)) group.paths.push(filePath)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    try {
      const view = JSON.parse(await fs.readFile(group.jsonPath, 'utf8'))
      if (view.id === group.id && Array.isArray(view.requests) && view.requests.length
        && view.requests.every((request: any) => typeof request?.id === 'string' && request.id)) {
        group.memberIds = Array.from(new Set(view.requests.map((request: any) => request.id))) as string[]
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        await warnClean(`读取合并调试日志成员失败: ${group.id}`,
          error instanceof SyntaxError ? new Error('Invalid merged debug member index') : error)
      }
    }
  }
  return Array.from(groups.values())
}

function rowStorageDir(ctx: Context, row: DebugLogRow) {
  const primaryPath = row.filePath || row.jsonPath || row.htmlPath
  if (!primaryPath) return undefined
  const categoryDir = path.dirname(primaryPath)
  if (!['md', 'json', 'html'].includes(path.basename(categoryDir))) return undefined
  const storageBase = path.dirname(path.dirname(categoryDir))
  const relative = path.relative(path.join(ctx.baseDir, 'data'), storageBase)
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return undefined
  return relative
}

async function invalidateTurns(ctx: Context, ids: string[]) {
  // Runtime listeners invalidate in-memory turns and drain pending writers
  // before their derived files are removed, preventing later resurrection.
  if (ids.length && typeof (ctx as any).parallel === 'function') {
    await (ctx as any).parallel('chat-debug/turn-invalidated', ids)
  }
}

async function collectDeletePaths(row: DebugLogRow, groups: DerivedTurnFiles[]) {
  const paths = [
    row.filePath,
    row.jsonPath,
    inferHtmlPath(row),
  ]
  let entry: DebugEntry | undefined
  if (row.jsonPath) {
    try {
      entry = await readDebugEntry(row.jsonPath)
      paths.push(...(entry.assetFiles?.map((asset) => asset.filePath) ?? []))
    } catch (error) {
      if (!isMissingFileError(error)) {
        await warnClean(`读取待删除调试日志失败: ${row.id}`, error)
      }
    }
  }
  const turnId = row.turnId || entry?.metadata.turnId
  const turnCreatedAt = row.turnCreatedAt ?? entry?.metadata.turnCreatedAt
  const turnIds = new Set<string>()
  if (turnId && /^turn-[a-zA-Z0-9_-]+$/.test(turnId)) {
    turnIds.add(turnId)
    const primaryPath = row.filePath || row.jsonPath || row.htmlPath
    if (primaryPath && turnCreatedAt != null && Number.isFinite(new Date(turnCreatedAt).getTime())) {
      const storageBase = path.dirname(path.dirname(path.dirname(primaryPath)))
      const dayDir = path.join(storageBase, new Date(turnCreatedAt).toISOString().slice(0, 10))
      paths.push(...derivedTurnPaths(dayDir, turnId))
    }
  }
  for (const group of groups) {
    if (group.id === turnId || group.id === `turn-${row.id}` || group.memberIds?.includes(row.id)) {
      paths.push(...group.paths)
      turnIds.add(group.id)
    }
  }
  return { paths, turnIds: Array.from(turnIds) }
}

function addPath(pathSet: Set<string>, filePath?: string) {
  if (filePath) pathSet.add(normalizeDebugFilePath(filePath))
}

function sortDebugRows(rows: DebugLogRow[], order: 'asc' | 'desc') {
  const factor = order === 'asc' ? 1 : -1
  return [...rows].sort((left, right) => {
    const createdAtDiff = ((left.createdAt ?? 0) - (right.createdAt ?? 0)) * factor
    if (createdAtDiff !== 0) return createdAtDiff
    return left.id.localeCompare(right.id) * factor
  })
}

function collectInferredAssetPaths(row: DebugLogRow, scannedFiles: string[]) {
  const primaryPath = row.filePath || row.jsonPath || row.htmlPath
  if (!primaryPath) return []

  const categoryDir = path.dirname(primaryPath)
  const dayDir = path.basename(categoryDir) === 'md'
    || path.basename(categoryDir) === 'json'
    || path.basename(categoryDir) === 'html'
    ? path.dirname(categoryDir)
    : path.dirname(path.dirname(primaryPath))
  const filesDir = normalizeDebugFilePath(path.join(dayDir, 'files'))
  const stem = path.basename(primaryPath, path.extname(primaryPath))
  const assetPrefix = `${stem}-asset-`

  return scannedFiles.filter((filePath) => {
    const normalizedDir = normalizeDebugFilePath(path.dirname(filePath))
    return normalizedDir === filesDir && path.basename(filePath).startsWith(assetPrefix)
  })
}

async function collectRetainedPathSet(rows: DebugLogRow[], scannedFiles: string[], groups: DerivedTurnFiles[]) {
  const retainedPaths = new Set<string>()

  for (const row of rows) {
    addPath(retainedPaths, row.filePath)
    addPath(retainedPaths, row.jsonPath)
    addPath(retainedPaths, inferHtmlPath(row))

    if (row.jsonPath) {
      try {
        const entry = await readDebugEntry(row.jsonPath)
        for (const asset of entry.assetFiles ?? []) {
          addPath(retainedPaths, asset.filePath)
        }
      } catch (error) {
        if (!isMissingFileError(error)) {
          await warnClean(`读取保留调试日志资产失败: ${row.id}`, error)
        }
      }
    }

    for (const inferredAssetPath of collectInferredAssetPaths(row, scannedFiles)) {
      addPath(retainedPaths, inferredAssetPath)
    }
  }

  const retainedIds = new Set(rows.map(row => row.id))
  for (const group of groups) {
    if (group.memberIds?.length && group.memberIds.every(id => retainedIds.has(id))) {
      for (const filePath of group.paths) addPath(retainedPaths, filePath)
    }
  }

  return retainedPaths
}

async function deleteDebugLogNow(ctx: Context, row: DebugLogRow): Promise<DeleteDebugLogResult> {
  const storageDir = rowStorageDir(ctx, row)
  const scannedFiles = storageDir == null ? [] : await listDebugStorageFiles(ctx, storageDir)
  const groups = await collectDerivedTurns(scannedFiles)
  const deletion = await collectDeletePaths(row, groups)
  await invalidateTurns(ctx, deletion.turnIds)
  const removeResult = await removeDebugFiles(deletion.paths)

  if (!removeResult.failures.length) {
    await (ctx.database as any).remove(DEBUG_LOG_TABLE, { id: row.id } as any)
  }

  return {
    indexedRowCleaned: removeResult.failures.length === 0,
    removedFiles: removeResult.removed,
    missingFiles: removeResult.missing,
    failures: removeResult.failures,
    invalidatedTurnIds: deletion.turnIds,
  }
}

export function deleteDebugLog(ctx: Context, row: DebugLogRow) {
  return enqueueDebugMutation(() => deleteDebugLogNow(ctx, row))
}

async function cleanDebugLogsNow(ctx: Context, config: DebugCaptureConfig, keep: number): Promise<CleanDebugLogsResult> {
  const safeKeep = Math.max(0, Math.floor(keep))
  const failures: DebugDeleteFailure[] = []
  let prunedDirectories = 0

  const initialPrune = await pruneEmptyDebugDayDirs(ctx, config.storageDir)
  prunedDirectories += initialPrune.removed
  failures.push(...initialPrune.failures)

  const rows = sortDebugRows(await (ctx.database as any).get(DEBUG_LOG_TABLE, {}) as DebugLogRow[], 'desc')
  const retainedRows = rows.slice(0, safeKeep) as DebugLogRow[]
  const obsoleteRows = rows.slice(safeKeep) as DebugLogRow[]
  const scannedFiles = await listDebugStorageFiles(ctx, config.storageDir)
  const groups = await collectDerivedTurns(scannedFiles)
  const retainedPathSet = await collectRetainedPathSet(retainedRows, scannedFiles, groups)
  const indexedDeletePathSet = new Set<string>()
  const deletions = []
  const invalidatedTurnIds = new Set<string>()
  for (const row of obsoleteRows) {
    const deletion = await collectDeletePaths(row, groups)
    deletions.push({ row, ...deletion })
    for (const filePath of deletion.paths) addPath(indexedDeletePathSet, filePath)
    for (const id of deletion.turnIds) invalidatedTurnIds.add(id)
  }
  for (const group of groups) {
    if (group.paths.some(filePath => !retainedPathSet.has(normalizeDebugFilePath(filePath)))) {
      invalidatedTurnIds.add(group.id)
    }
  }
  await invalidateTurns(ctx, Array.from(invalidatedTurnIds))

  let indexedRowsCleaned = 0
  let removedIndexedFiles = 0
  let missingIndexedFiles = 0

  for (const { row, paths: deletePaths } of deletions) {
    const removeResult = await removeDebugFiles(deletePaths)
    removedIndexedFiles += removeResult.removed
    missingIndexedFiles += removeResult.missing
    failures.push(...removeResult.failures)

    if (!removeResult.failures.length) {
      await (ctx.database as any).remove(DEBUG_LOG_TABLE, { id: row.id } as any)
      indexedRowsCleaned += 1
    }
  }

  const orphanPaths = scannedFiles.filter((filePath) => {
    const normalizedPath = normalizeDebugFilePath(filePath)
    return !retainedPathSet.has(normalizedPath) && !indexedDeletePathSet.has(normalizedPath)
  })
  const orphanRemoveResult = await removeDebugFiles(orphanPaths)
  failures.push(...orphanRemoveResult.failures)

  const finalPrune = await pruneEmptyDebugDayDirs(ctx, config.storageDir)
  prunedDirectories += finalPrune.removed
  failures.push(...finalPrune.failures)

  return {
    requestedKeep: safeKeep,
    retainedRows: retainedRows.length,
    indexedRowsCleaned,
    orphanFilesCleaned: orphanRemoveResult.removed,
    removedIndexedFiles,
    missingIndexedFiles,
    prunedDirectories,
    failures,
    invalidatedTurnIds: Array.from(invalidatedTurnIds),
  }
}

export function cleanDebugLogs(ctx: Context, config: DebugCaptureConfig, keep: number) {
  return enqueueDebugMutation(() => cleanDebugLogsNow(ctx, config, keep))
}
