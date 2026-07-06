import path from 'node:path'
import type { Context } from 'koishi'
import type { DebugCaptureConfig } from './types'
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

async function collectDeletePaths(row: DebugLogRow) {
  const paths = [
    row.filePath,
    row.jsonPath,
    inferHtmlPath(row),
  ]

  if (!row.jsonPath) return paths

  try {
    const entry = await readDebugEntry(row.jsonPath)
    paths.push(...(entry.assetFiles?.map((asset) => asset.filePath) ?? []))
  } catch (error) {
    if (!isMissingFileError(error)) {
      await warnClean(`读取待删除调试日志失败: ${row.id}`, error)
    }
  }

  return paths
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

async function collectRetainedPathSet(rows: DebugLogRow[], scannedFiles: string[]) {
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

  return retainedPaths
}

async function deleteDebugLogNow(ctx: Context, row: DebugLogRow): Promise<DeleteDebugLogResult> {
  const removeResult = await removeDebugFiles(await collectDeletePaths(row))

  if (!removeResult.failures.length) {
    await (ctx.database as any).remove(DEBUG_LOG_TABLE, { id: row.id } as any)
  }

  return {
    indexedRowCleaned: removeResult.failures.length === 0,
    removedFiles: removeResult.removed,
    missingFiles: removeResult.missing,
    failures: removeResult.failures,
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
  const retainedPathSet = await collectRetainedPathSet(retainedRows, scannedFiles)
  const indexedDeletePathSet = new Set<string>()

  let indexedRowsCleaned = 0
  let removedIndexedFiles = 0
  let missingIndexedFiles = 0

  for (const row of obsoleteRows) {
    const deletePaths = await collectDeletePaths(row)
    for (const filePath of deletePaths) addPath(indexedDeletePathSet, filePath)

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
  }
}

export function cleanDebugLogs(ctx: Context, config: DebugCaptureConfig, keep: number) {
  return enqueueDebugMutation(() => cleanDebugLogsNow(ctx, config, keep))
}
