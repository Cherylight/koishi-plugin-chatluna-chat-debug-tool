import { Logger } from 'koishi'

export const logger = new Logger('chatluna-chat-debug-tool')

export function formatErrorForLog(error: unknown): string {
  const seen = new Set<unknown>()
  const parts: string[] = []
  let current: unknown = error

  while (current != null && !seen.has(current)) {
    seen.add(current)
    if (current instanceof Error) {
      parts.push(current.stack || `${current.name}: ${current.message}`)
      current = current.cause
      continue
    }
    if (typeof current === 'object') {
      try {
        parts.push(JSON.stringify(current))
      } catch {
        parts.push(String(current))
      }
    } else {
      parts.push(String(current))
    }
    break
  }

  return parts.length ? parts.join('\nCaused by: ') : 'Unknown error'
}
