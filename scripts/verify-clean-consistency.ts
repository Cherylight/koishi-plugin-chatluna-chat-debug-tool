import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { cleanDebugLogs } from '../src/clean'
import { DEBUG_LOG_TABLE, type DebugLogRow } from '../src/storage'
import type { DebugCaptureConfig } from '../src/types'

const day = '2026-06-30'

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class MemoryDatabase {
  rows: DebugLogRow[]
  activeGets = 0
  maxActiveGets = 0
  getDelayMs = 0

  constructor(rows: DebugLogRow[]) {
    this.rows = rows
  }

  async get(table: string, query: Record<string, unknown>) {
    assert.equal(table, DEBUG_LOG_TABLE)
    this.activeGets += 1
    this.maxActiveGets = Math.max(this.maxActiveGets, this.activeGets)
    if (this.getDelayMs) await delay(this.getDelayMs)
    this.activeGets -= 1

    if (query?.id) {
      return this.rows.filter((row) => row.id === query.id)
    }
    return [...this.rows]
  }

  async remove(table: string, query: Record<string, unknown>) {
    assert.equal(table, DEBUG_LOG_TABLE)
    this.rows = this.rows.filter((row) => row.id !== query.id)
  }
}

function makeCtx(baseDir: string, database: MemoryDatabase) {
  return {
    baseDir,
    database,
  } as any
}

function makeConfig(): DebugCaptureConfig {
  return {
    storageDir: 'chat-debug',
    managerPageSize: 2,
  } as DebugCaptureConfig
}

function debugPath(baseDir: string, category: 'md' | 'json' | 'html' | 'files', fileName: string) {
  return path.join(baseDir, 'data', 'chat-debug', day, category, fileName)
}

function row(baseDir: string, id: string, createdAt: number): DebugLogRow {
  const stem = `chat-debug-${id}`
  return {
    id,
    createdAt,
    filePath: debugPath(baseDir, 'md', `${stem}.md`),
    jsonPath: debugPath(baseDir, 'json', `${stem}.json`),
    htmlPath: debugPath(baseDir, 'html', `${stem}.html`),
    summary: id,
  } as DebugLogRow
}

async function writeFile(filePath: string, content: string | Buffer) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content)
}

async function writeEntry(baseDir: string, debugRow: DebugLogRow, options: {
  markdown?: boolean
  json?: boolean
  html?: boolean
  asset?: boolean
} = {}) {
  const stem = path.basename(debugRow.filePath, '.md')
  const assetPath = debugPath(baseDir, 'files', `${stem}-asset-01.png`)

  if (options.markdown !== false) {
    await writeFile(debugRow.filePath, `# ${debugRow.id}`)
  }
  if (options.asset) {
    await writeFile(assetPath, Buffer.from([1, 2, 3]))
  }
  if (options.json !== false) {
    await writeFile(debugRow.jsonPath, JSON.stringify({
      metadata: { id: debugRow.id, createdAt: debugRow.createdAt },
      assetFiles: options.asset ? [{ filePath: assetPath }] : [],
    }))
  }
  if (options.html !== false) {
    await writeFile(debugRow.htmlPath!, `<p>${debugRow.id}</p>`)
  }
}

async function exists(filePath: string) {
  try {
    await fs.stat(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function assertExists(filePath: string) {
  assert.equal(await exists(filePath), true, `${filePath} should exist`)
}

async function assertMissing(filePath: string) {
  assert.equal(await exists(filePath), false, `${filePath} should be removed`)
}

async function runConsistencyFixture() {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-debug-clean-'))
  try {
    const keepNew = row(baseDir, 'keep-new', 600)
    const keepOld = row(baseDir, 'keep-old', 500)
    const complete = row(baseDir, 'complete', 400)
    const missingMd = row(baseDir, 'missing-md', 300)
    const missingJson = row(baseDir, 'missing-json', 200)
    const failure = row(baseDir, 'failure', 100)
    const failureDir = failure.filePath
    failure.filePath = failureDir

    await writeEntry(baseDir, keepNew, { asset: true })
    await writeEntry(baseDir, keepOld, { asset: true })
    await writeEntry(baseDir, complete, { asset: true })
    await writeEntry(baseDir, missingMd, { markdown: false, asset: true })
    await writeEntry(baseDir, missingJson, { json: false, asset: true })
    await fs.mkdir(failure.filePath, { recursive: true })
    await writeFile(failure.jsonPath, JSON.stringify({ metadata: { id: failure.id }, assetFiles: [] }))

    const orphanMd = debugPath(baseDir, 'md', 'chat-debug-orphan.md')
    const orphanJson = debugPath(baseDir, 'json', 'chat-debug-orphan.json')
    const orphanHtml = debugPath(baseDir, 'html', 'chat-debug-orphan.html')
    const orphanAsset = debugPath(baseDir, 'files', 'chat-debug-orphan-asset-01.png')
    await writeFile(orphanMd, '# orphan')
    await writeFile(orphanJson, '{}')
    await writeFile(orphanHtml, '<p>orphan</p>')
    await writeFile(orphanAsset, Buffer.from([9]))

    const database = new MemoryDatabase([keepNew, keepOld, complete, missingMd, missingJson, failure])
    const result = await cleanDebugLogs(makeCtx(baseDir, database), makeConfig(), 2)

    assert.equal(result.indexedRowsCleaned, 3)
    assert.equal(result.orphanFilesCleaned, 5)
    assert.equal(result.failures.length, 1)
    assert.equal(database.rows.map((item) => item.id).sort().join(','), 'failure,keep-new,keep-old')

    await assertExists(keepNew.filePath)
    await assertExists(keepNew.jsonPath)
    await assertExists(debugPath(baseDir, 'files', 'chat-debug-keep-new-asset-01.png'))
    await assertExists(keepOld.filePath)
    await assertExists(debugPath(baseDir, 'files', 'chat-debug-keep-old-asset-01.png'))
    await assertMissing(complete.filePath)
    await assertMissing(complete.jsonPath)
    await assertMissing(debugPath(baseDir, 'files', 'chat-debug-complete-asset-01.png'))
    await assertMissing(missingJson.filePath)
    await assertMissing(debugPath(baseDir, 'files', 'chat-debug-missing-json-asset-01.png'))
    await assertMissing(orphanMd)
    await assertMissing(orphanJson)
    await assertMissing(orphanHtml)
    await assertMissing(orphanAsset)
    await assertExists(failure.filePath)
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true })
  }
}

async function runSerializationFixture() {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-debug-serial-'))
  try {
    const keep = row(baseDir, 'keep', 200)
    const obsolete = row(baseDir, 'obsolete', 100)
    await writeEntry(baseDir, keep)
    await writeEntry(baseDir, obsolete)

    const database = new MemoryDatabase([keep, obsolete])
    database.getDelayMs = 50
    const ctx = makeCtx(baseDir, database)
    const config = makeConfig()
    const [first, second] = await Promise.all([
      cleanDebugLogs(ctx, config, 1),
      cleanDebugLogs(ctx, config, 1),
    ])

    assert.equal(database.maxActiveGets, 1)
    assert.equal(first.indexedRowsCleaned + second.indexedRowsCleaned, 1)
    assert.equal(database.rows.map((item) => item.id).join(','), 'keep')
    await assertMissing(obsolete.filePath)
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true })
  }
}

await runConsistencyFixture()
await runSerializationFixture()
console.log('clean consistency fixture: PASS')
