import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { cleanDebugLogs, deleteDebugLog } from '../src/clean'
import { createTurnWriter, turnFilePath } from '../src/turn-storage'
import { TurnAggregator } from '../src/turn-aggregation'
import { Config } from '../src/config'
import { saveDebugEntry } from '../src/storage'
import type { DebugEntry } from '../src/types'

async function fixture() {
  const parent = await fs.realpath(os.tmpdir())
  const baseDir = await fs.mkdtemp(path.join(parent, 'chat-debug-clean-turns-'))
  const rows = new Map<string, any>()
  const invalidations: string[][] = []
  let listener: ((ids: string[]) => Promise<void>) | undefined
  const ctx = { baseDir, database: {
    async upsert(_table: string, values: any[]) { for (const value of values) rows.set(value.id, structuredClone(value)) },
    async get() { return [...rows.values()] },
    async remove(_table: string, query: any) { rows.delete(query.id) },
  }, async parallel(_event: string, ids: string[]) { invalidations.push(ids); await listener?.(ids) } }
  const config = Config({ enabled: true, captureEnabled: true })
  const aggregator = new TurnAggregator()
  const writer = createTurnWriter(ctx as any, config)
  const createdAt = Date.parse('2026-10-13T01:00:00Z')
  for (const [index, id] of ['clean-a', 'clean-b'].entries()) {
    const entry: DebugEntry = { metadata: { id, traceId: 'turn-clean-a', createdAt: createdAt + index * 100, durationMs: 10, endAt: createdAt + index * 100 + 10, source: 'fixture', method: 'POST', url: 'https://offline.invalid/responses' }, requestMessages: [], responseMessages: [], toolCalls: [], toolResults: [], tools: [], responseText: 'fixture', requestHeaders: {}, responseHeaders: {}, responseJson: { status: 'completed' } }
    const view = aggregator.ingest(entry)
    entry.metadata.turnId = view.id
    entry.metadata.turnCreatedAt = view.createdAt
    await saveDebugEntry(ctx as any, entry, 'fixture raw', config.storageDir)
    await writer(view)
  }
  const turn = turnFilePath(ctx as any, config.storageDir, 'turn-clean-a', createdAt)
  const html = path.join(path.dirname(path.dirname(turn)), 'html', 'chat-debug-turn-clean-a.html')
  await fs.mkdir(path.dirname(html), { recursive: true })
  await fs.writeFile(html, 'derived fixture')
  listener = async ids => { ids.forEach(id => aggregator.forget(id)); await writer.invalidate(ids) }
  return { ctx, config, rows, turn, html, writer, aggregator, invalidations,
    async cleanup() { writer.close(); const resolved = await fs.realpath(baseDir); assert.equal(path.dirname(resolved), parent); assert(path.basename(resolved).startsWith('chat-debug-clean-turns-')); await fs.rm(resolved, { recursive: true, force: true }) } }
}

test('deleting one raw member invalidates the derived turn and preserves the other raw member', async () => {
  const value = await fixture()
  try {
    const remaining = value.rows.get('clean-b')
    const result = await deleteDebugLog(value.ctx as any, value.rows.get('clean-a'))
    assert.equal(result.failures.length, 0)
    assert.deepEqual(result.invalidatedTurnIds, ['turn-clean-a'])
    assert.equal(value.rows.size, 1)
    await fs.access(remaining.filePath)
    for (const file of [value.turn, value.turn.replace(/\.md$/, '.json'), value.html]) await assert.rejects(fs.access(file), { code: 'ENOENT' })
    assert.deepEqual(value.invalidations, [['turn-clean-a']])
  } finally { await value.cleanup() }
})

for (const keep of [1, 2]) {
  test(`clean keep=${keep} retains a derived turn only when all raw members remain`, async () => {
    const value = await fixture()
    try {
      const result = await cleanDebugLogs(value.ctx as any, value.config, keep)
      assert.equal(result.failures.length, 0)
      assert.equal(value.rows.size, keep)
      if (keep === 2) { await fs.access(value.turn); await fs.access(value.html); assert.equal(result.invalidatedTurnIds.length, 0) }
      else { await assert.rejects(fs.access(value.turn), { code: 'ENOENT' }); await fs.access(value.rows.get('clean-b').filePath) }
    } finally { await value.cleanup() }
  })
}

test('invalidating a queued turn writer drains pending writes and prevents file resurrection', async () => {
  const value = await fixture()
  try {
    const view = JSON.parse(await fs.readFile(value.turn.replace(/\.md$/, '.json'), 'utf8'))
    const writes = [value.writer(view), value.writer(view), value.writer(view)]
    await value.writer.invalidate([view.id])
    await Promise.all(writes)
    await fs.unlink(value.turn)
    await fs.unlink(value.turn.replace(/\.md$/, '.json'))
    await value.writer(view)
    assert.equal(value.writer.hasPending(view.id), false)
    await assert.rejects(fs.access(value.turn), { code: 'ENOENT' })
  } finally { await value.cleanup() }
})

test('clean removes orphan or corrupt derived files and their temporary writes', async () => {
  const value = await fixture()
  try {
    const stem = path.join(path.dirname(value.turn), 'turn-orphan')
    await fs.writeFile(stem + '.json', '{malformed')
    await fs.writeFile(stem + '.md.tmp', 'unfinished')
    const result = await cleanDebugLogs(value.ctx as any, value.config, 2)
    assert.equal(result.failures.length, 0)
    assert(result.invalidatedTurnIds.includes('turn-orphan'))
    await assert.rejects(fs.access(stem + '.json'), { code: 'ENOENT' })
    await assert.rejects(fs.access(stem + '.md.tmp'), { code: 'ENOENT' })
    await fs.access(value.turn)
  } finally { await value.cleanup() }
})

test('closing a turn writer preserves already queued final snapshots', async () => {
  const value = await fixture()
  try {
    const view = JSON.parse(await fs.readFile(value.turn.replace(/\.md$/, '.json'), 'utf8'))
    view.status = 'disposed'
    const write = value.writer(view)
    value.writer.close()
    await write
    assert.equal(JSON.parse(await fs.readFile(value.turn.replace(/\.md$/, '.json'), 'utf8')).status, 'disposed')
  } finally { await value.cleanup() }
})
