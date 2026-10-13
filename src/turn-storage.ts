import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Context } from 'koishi'
import type { DebugCaptureConfig } from './types'
import { renderTurnMarkdown, type TurnMergeView } from './turn-aggregation'

export function turnFilePath(ctx: Context, storageDir: string, id: string, createdAt: number, extension = 'md') {
  if (!/^turn-[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid turn id')
  return path.join(ctx.baseDir, 'data', storageDir, new Date(createdAt).toISOString().slice(0, 10), 'turns', `${id}.${extension}`)
}

export function createTurnWriter(ctx: Context, config: DebugCaptureConfig) {
  const queues = new Map<string, Promise<void>>()
  const invalidated = new Set<string>()
  let closed = false
  const hasPending = (id: string) => [...queues.keys()].some(file => path.basename(file) === `${id}.md`)
  const write = (view: TurnMergeView): Promise<void> => {
    if (closed || invalidated.has(view.id)) return Promise.resolve()
    const json = JSON.stringify(view, null, 2)
    const markdown = renderTurnMarkdown(view)
    const target = turnFilePath(ctx, config.storageDir, view.id, view.createdAt)
    const next = (queues.get(target) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (invalidated.has(view.id)) return
      await fs.mkdir(path.dirname(target), { recursive: true })
      for (const [extension, text] of [['json', json], ['md', markdown]]) {
        const file = target.replace(/\.md$/, `.${extension}`)
        const temporary = `${file}.tmp`
        await fs.writeFile(temporary, text, 'utf8')
        await fs.rename(temporary, file)
      }
    })
    queues.set(target, next)
    void next.finally(() => { if (queues.get(target) === next) queues.delete(target) }).catch(() => {})
    return next
  }
  return Object.assign(write, {
    hasPending,
    async invalidate(ids: string[]) {
      for (const id of ids) invalidated.add(id)
      await Promise.allSettled([...queues].filter(([file]) => ids.some(id => path.basename(file) === `${id}.md`)).map(([, queue]) => queue))
    },
    async drain() { await Promise.allSettled([...queues.values()]) },
    close() { closed = true },
  })
}
