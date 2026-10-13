// Only operate on copies destined for debugging; never change transport/history.
const OMITTED_TEXT = '[调试已省略包含排除字段的非完整 JSON 文本]'
const ALWAYS_EXCLUDED = ['encrypted_content']

function excludedFields(extraFields: readonly string[] = []) {
  return Array.from(new Set([...ALWAYS_EXCLUDED, ...extraFields.filter((field) => field.trim()).map((field) => field.trim())]))
}

function propertyPattern(fields: readonly string[]) {
  const names = fields.map((field) => field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return new RegExp(`(?:["'](?:${names})["']|\\b(?:${names})\\b)\\s*:`)
}

function hasExcludedProperty(text: string, pattern: RegExp) {
  return pattern.test(text.replace(/\\+"/g, '"'))
}

function redactValue(value: unknown, fields: Set<string>, pattern: RegExp): unknown {
  if (typeof value === 'string') return redactText(value, fields, pattern)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, fields, pattern))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !fields.has(key))
      .map(([key, item]) => [key, redactValue(item, fields, pattern)]))
  }
  return value
}

function redactJsonText(text: string, fields: Set<string>, pattern: RegExp): string | undefined {
  try {
    return JSON.stringify(redactValue(JSON.parse(text), fields, pattern), null, text.includes('\n') ? 2 : undefined)
  } catch {
    return undefined
  }
}

function redactText(text: string, fields: Set<string>, pattern: RegExp): string {
  if (!hasExcludedProperty(text, pattern)) return text
  const json = redactJsonText(text, fields, pattern)
  if (json !== undefined) return json

  // Preserve SSE framing and ordinary data while removing nested payload fields.
  if (/(?:^|\r?\n)data:/.test(text)) {
    const safe = text.split(/(?:\r\n|\r|\n){2}/).map((frame) => {
      const lines = frame.split(/\r\n|\r|\n/)
      const indexes = lines.flatMap((line, index) => line.startsWith('data:') ? [index] : [])
      const data = indexes.map((index) => lines[index].slice(5).replace(/^ /, '')).join('\n')
      if (!indexes.length || !hasExcludedProperty(data, pattern)) return frame
      const safeData = redactJsonText(data, fields, pattern) ?? OMITTED_TEXT
      return lines.flatMap((line, index) => index === indexes[0]
        ? safeData.split('\n').map((part) => `data: ${part}`)
        : indexes.includes(index) ? [] : [line]).join('\n')
    }).join('\n\n')
    return hasExcludedProperty(safe, pattern) ? OMITTED_TEXT : safe
  }

  // Old Markdown logs may embed complete JSON in backtick/tilde fences.
  const lines = text.split(/\r\n|\r|\n/)
  let changed = false
  for (let index = 0; index < lines.length; index++) {
    const opening = lines[index].match(/^\s*(`{3,}|~{3,})[^\r\n]*$/)
    if (!opening) continue
    const fence = opening[1]
    let end = index + 1
    while (end < lines.length && !(lines[end].trim().startsWith(fence[0]) && new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(lines[end].trim()))) end++
    const body = lines.slice(index + 1, end).join('\n')
    if (hasExcludedProperty(body, pattern)) {
      const safeBody = redactText(body, fields, pattern)
      const replacement = safeBody.split('\n')
      lines.splice(index + 1, end - index - 1, ...replacement)
      end = index + 1 + replacement.length
      changed = true
    }
    index = end
  }
  if (changed) {
    const safe = lines.join('\n')
    return hasExcludedProperty(safe, pattern) ? OMITTED_TEXT : safe
  }
  // Do not retain opaque values in malformed/truncated JSON or error strings.
  return OMITTED_TEXT
}

export function sanitizeDebugText(text: string, extraFields: readonly string[] = []) {
  const names = excludedFields(extraFields)
  return redactText(text, new Set(names), propertyPattern(names))
}

export function sanitizeDebugEntry<T>(entry: T, extraFields: readonly string[] = []): T {
  const names = excludedFields(extraFields)
  return redactValue(entry, new Set(names), propertyPattern(names)) as T
}
