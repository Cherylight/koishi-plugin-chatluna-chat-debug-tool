import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { debugPreviewStyles } from './render-preview-style'

interface HeadingBlock {
  type: 'h1' | 'h2' | 'h3'
  text: string
  id?: string
}

interface ListItem {
  level: number
  label: string
  href: string
  resolvedHref?: string
}

interface ListBlock {
  type: 'list'
  items: ListItem[]
}

interface FenceBlock {
  type: 'fence'
  language: string
  content: string
}

interface ParagraphBlock {
  type: 'paragraph'
  text: string
}

interface MetadataBlock {
  type: 'metadata'
  content: string
}

type MarkdownBlock = HeadingBlock | ListBlock | FenceBlock | ParagraphBlock | MetadataBlock

export interface BuildDebugPreviewHtmlOptions {
  sourcePath?: string
  collapseJsonByDefault?: boolean
  collapseSystemPromptByDefault?: boolean
  embedChatImages?: boolean
  titleSuffix?: string
  metaLabel?: string
}

const EMBEDDED_CHAT_IMAGE_PATTERN = /<image>([\s\S]*?)<\/image>|&lt;image&gt;([\s\S]*?)&lt;\/image&gt;|!\[([^\]]*)\]\(([^)]+)\)/g

function toDisplaySourcePath(sourcePath?: string) {
  if (!sourcePath) return undefined
  const normalized = sourcePath.replace(/\\/g, '/')
  const match = normalized.match(/(?:^|\/)(chat-debug\/.*)$/)
  if (match) return match[1]
  return normalized.split('/').slice(-3).join('/')
}

function escapeHtml(input: string) {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderInlineText(input: string) {
  const escaped = escapeHtml(input)
  return escaped.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
}

function resolveChatImageSrc(src: string, options: BuildDebugPreviewHtmlOptions) {
  const normalized = src.trim()
  if (!normalized) return ''
  if (/^(https?:|data:|file:)/i.test(normalized)) return normalized
  if (!options.sourcePath) return normalized
  const absolutePath = path.resolve(path.dirname(options.sourcePath), normalized)
  return pathToFileURL(absolutePath).href
}

function hasEmbeddedChatImages(input: string) {
  EMBEDDED_CHAT_IMAGE_PATTERN.lastIndex = 0
  return EMBEDDED_CHAT_IMAGE_PATTERN.test(input)
}

function renderEmbeddedChatImage(src: string, alt: string, options: BuildDebugPreviewHtmlOptions) {
  const resolvedSrc = resolveChatImageSrc(src, options)
  const safeAlt = escapeHtml(alt || 'chat image')
  return `<span class="chat-image-box"><img class="chat-image" src="${escapeHtml(resolvedSrc)}" alt="${safeAlt}" /></span>`
}

function renderTextWithEmbeddedImages(input: string, options: BuildDebugPreviewHtmlOptions) {
  let html = ''
  let lastIndex = 0
  EMBEDDED_CHAT_IMAGE_PATTERN.lastIndex = 0

  for (const match of input.matchAll(EMBEDDED_CHAT_IMAGE_PATTERN)) {
    const start = match.index ?? 0
    const textSegment = input.slice(lastIndex, start)
    if (textSegment) {
      html += `<span class="rich-content-fragment">${renderInlineText(textSegment)}</span>`
    }

    const rawSrc = match[1] ?? match[2] ?? match[4] ?? ''
    const alt = match[3] ?? 'chat image'
    html += renderEmbeddedChatImage(rawSrc, alt, options)
    lastIndex = start + match[0].length
  }

  const tailSegment = input.slice(lastIndex)
  if (tailSegment) {
    html += `<span class="rich-content-fragment">${renderInlineText(tailSegment)}</span>`
  }

  return html
}

function renderRichTextBlock(content: string, className: string, extraClass: string, options: BuildDebugPreviewHtmlOptions) {
  return `<div class="${className} rich-content-block ${extraClass}">${renderTextWithEmbeddedImages(content, options)}</div>`
}

function translateHeading(text: string) {
  const normalized = text.trim()
  const mapping: Record<string, string> = {
    'Request': '请求',
    'Response': '响应',
    'Metadata': '元数据',
    'Request Messages': '请求消息',
    'Response Messages': '响应消息',
    'Tool Calls': '工具调用',
    'Tool Results': '工具结果',
    'Response JSON': '响应 JSON',
    'Response Text': '响应文本',
    'Response Reasoning': '响应推理',
    'Headers': '请求头',
    'Messages': '消息内容',
    'System': '系统提示',
    'User': '用户输入',
    'Assistant': 'AI回答',
    'Tool': '工具消息',
  }
  return mapping[normalized] || normalized
}

function roleClassFromHeading(text: string) {
  const normalized = text.trim()
  if (normalized === '用户输入') return 'role-user'
  if (normalized === 'AI回答') return 'role-assistant'
  if (normalized === '工具消息') return 'role-tool'
  if (normalized === '系统提示') return 'role-system'
  return 'role-neutral'
}

function slugifyHeading(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section'
}

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let paragraphLines: string[] = []

  const flushParagraph = () => {
    if (!paragraphLines.length) return
    blocks.push({
      type: 'paragraph',
      text: paragraphLines.join('\n'),
    })
    paragraphLines = []
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]

    if (!line.trim()) {
      flushParagraph()
      continue
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/)
    if (headingMatch) {
      flushParagraph()
      blocks.push({
        type: `h${headingMatch[1].length}` as HeadingBlock['type'],
        text: headingMatch[2].trim(),
      })
      continue
    }

    if (line === '<pre><code>') {
      flushParagraph()
      const buffer: string[] = []
      while (++index < lines.length && lines[index] !== '</code></pre>') {
        buffer.push(lines[index])
      }
      blocks.push({ type: 'metadata', content: buffer.join('\n') })
      continue
    }

    const fenceMatch = line.match(/^((`{3,}|~{3,}))([a-zA-Z0-9_-]+)?$/)
    if (fenceMatch) {
      flushParagraph()
      const fence = fenceMatch[1]
      const language = fenceMatch[3] || 'text'
      const buffer: string[] = []
      while (++index < lines.length && lines[index] !== fence) {
        buffer.push(lines[index])
      }
      blocks.push({ type: 'fence', language, content: buffer.join('\n') })
      continue
    }

    const listMatch = line.match(/^(\s*)- \[(.+?)\]\((#.+?)\)$/)
    if (listMatch) {
      flushParagraph()
      const items: ListItem[] = []
      let cursor = index
      while (cursor < lines.length) {
        const currentMatch = lines[cursor].match(/^(\s*)- \[(.+?)\]\((#.+?)\)$/)
        if (!currentMatch) break
        items.push({
          level: Math.floor(currentMatch[1].length / 2) + 1,
          label: currentMatch[2],
          href: currentMatch[3],
        })
        cursor += 1
      }
      blocks.push({ type: 'list', items })
      index = cursor - 1
      continue
    }

    paragraphLines.push(line)
  }

  flushParagraph()
  return blocks
}

function assignHeadingIds(blocks: MarkdownBlock[]) {
  const counters = new Map<string, number>()
  for (const block of blocks) {
    if (block.type !== 'h1' && block.type !== 'h2' && block.type !== 'h3') continue
    const base = slugifyHeading(block.text)
    const count = (counters.get(base) || 0) + 1
    counters.set(base, count)
    block.id = count === 1 ? base : `${base}-${count}`
  }
}

function resolveListAnchors(blocks: MarkdownBlock[]) {
  const queues = new Map<string, string[]>()
  for (const block of blocks) {
    if (block.type !== 'h1' && block.type !== 'h2' && block.type !== 'h3') continue
    const base = slugifyHeading(block.text)
    const queue = queues.get(base) || []
    queue.push(block.id || base)
    queues.set(base, queue)
  }

  for (const block of blocks) {
    if (block.type !== 'list') continue
    for (const item of block.items) {
      const base = item.href.replace(/^#/, '')
      const queue = queues.get(base)
      item.resolvedHref = queue?.shift() || base
    }
  }
}

function renderListBlock(block: ListBlock) {
  let html = '<nav class="outline" aria-label="页面导航"><div class="outline-list">'
  for (const item of block.items) {
    html += `<div class="outline-item"><a class="outline-link" style="--outline-level:${item.level}" href="#${item.resolvedHref || item.href.replace(/^#/, '')}">${escapeHtml(translateHeading(item.label))}</a></div>`
  }
  return `${html}</div></nav>`
}

function highlightJson(jsonText: string) {
  const tokenPattern = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?=\s*:))|("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?|[{}\[\],:]/g
  let result = ''
  let lastIndex = 0

  for (const match of jsonText.matchAll(tokenPattern)) {
    const token = match[0]
    const start = match.index ?? 0
    result += escapeHtml(jsonText.slice(lastIndex, start))

    let className = 'json-number'
    if (match[1]) className = 'json-key'
    else if (match[2]) className = 'json-string'
    else if (token === 'true' || token === 'false') className = 'json-boolean'
    else if (token === 'null') className = 'json-null'
    else if (/^[{}\[\],:]$/.test(token)) className = 'json-punctuation'

    result += `<span class="${className}">${escapeHtml(token)}</span>`
    lastIndex = start + token.length
  }

  result += escapeHtml(jsonText.slice(lastIndex))
  return result
}

function highlightXml(xmlText: string) {
  const tokenPattern = /(<\/?)([A-Za-z_][A-Za-z0-9:_-]*)([^>]*?)(\/?>)/g
  let result = ''
  let lastIndex = 0

  for (const match of xmlText.matchAll(tokenPattern)) {
    const start = match.index ?? 0
    const [full, open, tagName, rawAttrs, close] = match
    result += escapeHtml(xmlText.slice(lastIndex, start))

    const attrs = rawAttrs.replace(/([A-Za-z_:][A-Za-z0-9:._-]*)(\s*=\s*)("[^"]*"|'[^']*')/g, (_full, attrName, equals, attrValue) => {
      return `<span class="xml-attr-name">${escapeHtml(attrName)}</span>${escapeHtml(equals)}<span class="xml-attr-value">${escapeHtml(attrValue)}</span>`
    })

    result += [
      `<span class="xml-angle">${escapeHtml(open.slice(0, 1))}</span>`,
      open.length > 1 ? `<span class="xml-slash">${escapeHtml(open.slice(1))}</span>` : '',
      `<span class="xml-tag-token">${escapeHtml(tagName)}</span>`,
      attrs,
      `<span class="xml-angle">${escapeHtml(close)}</span>`,
    ].join('')

    lastIndex = start + full.length
  }

  result += escapeHtml(xmlText.slice(lastIndex))
  return result
}

function renderCodeBlock(content: string, language: string, extraClass = '', options: BuildDebugPreviewHtmlOptions = {}) {
  if (language === 'json') {
    return `<pre class="json-block ${extraClass}"><code>${highlightJson(content)}</code></pre>`
  }
  if (language === 'xml') {
    return `<pre class="xml-block ${extraClass}"><code>${highlightXml(content)}</code></pre>`
  }
  if (options.embedChatImages && hasEmbeddedChatImages(content)) {
    return renderRichTextBlock(content, 'role-block', extraClass, options)
  }
  return `<pre class="role-block ${extraClass}"><code>${escapeHtml(content)}</code></pre>`
}

function getBlockPreviewText(block: MarkdownBlock) {
  if (block.type === 'paragraph') return block.text
  if (block.type === 'fence' || block.type === 'metadata') return block.content
  return ''
}

function buildSystemPromptPreview(blocks: MarkdownBlock[]) {
  const content = blocks.map(getBlockPreviewText).find((value) => value.trim()) || ''
  const previewLines = content.split('\n').slice(0, 3)
  return previewLines.join('\n').trim() || 'System Prompt'
}

function renderParagraphBlock(block: ParagraphBlock, options: BuildDebugPreviewHtmlOptions) {
  if (options.embedChatImages && hasEmbeddedChatImages(block.text)) {
    return `<div class="text-block rich-inline-block">${renderTextWithEmbeddedImages(block.text, options)}</div>`
  }
  const lines = block.text.split('\n').map((line) => renderInlineText(line))
  return `<p class="text-block">${lines.join('<br />')}</p>`
}

function renderMetadataPanel(content: string, options: BuildDebugPreviewHtmlOptions) {
  const lines = content.split('\n')
  const fieldLines: string[] = []
  let detailsHtml = ''

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim() !== '<details>') {
      if (line.trim()) fieldLines.push(line)
      continue
    }

    const detailLines: string[] = []
    while (++index < lines.length && lines[index].trim() !== '</details>') {
      detailLines.push(lines[index])
    }

    const summaryLine = detailLines[0] || ''
    const summaryMatch = summaryLine.match(/^<summary>([\s\S]*?)<\/summary>([\s\S]*)$/)
    const summary = summaryMatch?.[1] || 'JSON'
    const fenceHead = summaryMatch?.[2] || detailLines[1] || ''
    const fenceMatch = fenceHead.match(/^```([a-zA-Z0-9_-]+)?$/)
    const language = fenceMatch?.[1] || 'json'
    const jsonStartIndex = summaryMatch?.[2] ? 1 : 2
    const jsonLines = detailLines.slice(jsonStartIndex).filter((detailLine) => detailLine !== '```')
    const openAttr = options.collapseJsonByDefault === false ? ' open' : ''
    detailsHtml += [
      `<details class="json-details" data-collapse-json-default="${options.collapseJsonByDefault === false ? 'false' : 'true'}"${openAttr}>`,
      `<summary>${escapeHtml(summary)}</summary>`,
      '<div class="json-details-body">',
      renderCodeBlock(jsonLines.join('\n'), language, '', options),
      '</div>',
      '</details>',
    ].join('')
  }

  const fieldHtml = fieldLines.map((line) => {
    const match = line.match(/^(.+?)\s*:\s*(.*)$/)
    const tag = escapeHtml((match?.[1] || line).trim())
    const value = renderInlineText((match?.[2] || '').trim())
    return `<div class="xml-field"><span class="xml-tag">&lt;${tag}&gt;</span><span class="xml-value">${value || 'undefined'}</span><span class="xml-tag">&lt;/${tag}&gt;</span></div>`
  }).join('')

  return [
    '<div class="metadata-panel">',
    '<div class="xml-body">',
    fieldHtml,
    detailsHtml,
    '</div>',
    '</div>',
  ].join('')
}

function unwrapInnerXmlFence(content: string) {
  const trimmed = content.trim()
  const match = trimmed.match(/^```xml\n([\s\S]*?)\n```$/)
  return match?.[1]
}

function isSpecialSystemXml(content: string) {
  const trimmed = content.trimStart()
  return trimmed.startsWith('<trigger_tool>') || trimmed.startsWith('<available_skills>')
}

function renderContextualBlock(
  block: MarkdownBlock,
  options: BuildDebugPreviewHtmlOptions,
  context: { headingLabel?: string, roleClass?: string, fenceIndex?: number } = {},
): string {
  if (block.type === 'fence') {
    if (block.language === 'json') {
      return renderCodeBlock(block.content, 'json', '', options)
    }

    const innerXml = unwrapInnerXmlFence(block.content)
    if (context.roleClass === 'role-system' && (context.fenceIndex ?? 0) === 0 && block.language === 'md' && isSpecialSystemXml(block.content)) {
      return renderCodeBlock(block.content, 'xml', 'xml-block', options)
    }

    if ((context.roleClass === 'role-assistant' || context.headingLabel === '响应文本') && (context.fenceIndex ?? 0) === 0 && block.language === 'md' && innerXml) {
      return renderCodeBlock(innerXml, 'xml', 'xml-block', options)
    }

    if (context.roleClass === 'role-tool' && block.language === 'md') {
      const extraClass = (context.fenceIndex ?? 0) === 0 ? 'tool-meta-block' : 'tool-result-block'
      return renderCodeBlock(block.content, 'md', extraClass, options)
    }

    return renderCodeBlock(block.content, block.language, '', options)
  }

  return renderStandaloneBlock(block, options)
}

function renderSystemPromptSection(
  block: HeadingBlock,
  headingLabel: string,
  contentBlocks: MarkdownBlock[],
  options: BuildDebugPreviewHtmlOptions,
) {
  const preview = buildSystemPromptPreview(contentBlocks)
  const openAttr = options.collapseSystemPromptByDefault ? '' : ' open'
  let bodyHtml = ''
  let fenceIndex = 0
  for (const contentBlock of contentBlocks) {
    bodyHtml += renderContextualBlock(contentBlock, options, {
      headingLabel,
      roleClass: 'role-system',
      fenceIndex: contentBlock.type === 'fence' ? fenceIndex++ : fenceIndex,
    })
  }

  return [
    `<section class="message-card role-system" id="${block.id}">`,
    `<details class="system-prompt-details" data-collapse-system-prompt-default="${options.collapseSystemPromptByDefault ? 'true' : 'false'}"${openAttr}>`,
    '<summary class="system-prompt-summary">',
    '<div class="system-prompt-summary-head">',
    '<span class="system-prompt-summary-arrow" aria-hidden="true">▶</span>',
    `<div class="system-prompt-summary-title">${escapeHtml(headingLabel)}</div>`,
    '</div>',
    `<pre class="system-prompt-preview"><code>${escapeHtml(preview)}</code></pre>`,
    '<div class="system-prompt-hidden-note">...已隐藏</div>',
    '</summary>',
    '<div class="system-prompt-body">',
    bodyHtml,
    '</div>',
    '</details>',
    '</section>',
  ].join('')
}

function renderStandaloneBlock(block: MarkdownBlock, options: BuildDebugPreviewHtmlOptions): string {
  if (block.type === 'list') return renderListBlock(block)
  if (block.type === 'paragraph') return renderParagraphBlock(block, options)
  if (block.type === 'fence') return renderCodeBlock(block.content, block.language, '', options)
  if (block.type === 'metadata') return renderMetadataPanel(block.content, options)
  if (block.type === 'h1') return `<h1 id="${block.id}">${escapeHtml(block.text)}</h1>`
  if (block.type === 'h2') return `<h2 id="${block.id}">${escapeHtml(translateHeading(block.text))}</h2>`
  if (block.type === 'h3') return `<h3 class="subsection-title ${roleClassFromHeading(translateHeading(block.text))}" id="${block.id}">${escapeHtml(translateHeading(block.text))}</h3>`
  return ''
}

function renderBlocks(blocks: MarkdownBlock[], options: BuildDebugPreviewHtmlOptions) {
  let html = ''
  let index = 0
  let sectionOpen = false

  while (index < blocks.length) {
    const block = blocks[index]

    if (block.type === 'h2') {
      if (sectionOpen) html += '</section>'
      html += `<section class="section-block section-${block.id}">`
      html += renderStandaloneBlock(block, options)
      sectionOpen = true
      index += 1
      continue
    }

    if (block.type === 'h3') {
      const headingLabel = translateHeading(block.text)
      const roleClass = roleClassFromHeading(headingLabel)
      let nextIndex = index + 1
      const contentBlocks: MarkdownBlock[] = []
      while (nextIndex < blocks.length && blocks[nextIndex].type !== 'h1' && blocks[nextIndex].type !== 'h2' && blocks[nextIndex].type !== 'h3') {
        contentBlocks.push(blocks[nextIndex])
        nextIndex += 1
      }

      if (roleClass !== 'role-neutral' && contentBlocks.length) {
        if (roleClass === 'role-system') {
          html += renderSystemPromptSection(block, headingLabel, contentBlocks, options)
          index = nextIndex
          continue
        }

        html += `<section class="message-card ${roleClass}" id="${block.id}"><h3 class="${roleClass}">${escapeHtml(headingLabel)}</h3>`
        let fenceIndex = 0
        for (const contentBlock of contentBlocks) {
          html += renderContextualBlock(contentBlock, options, {
            headingLabel,
            roleClass,
            fenceIndex: contentBlock.type === 'fence' ? fenceIndex++ : fenceIndex,
          })
        }
        html += '</section>'
        index = nextIndex
        continue
      }

      if (contentBlocks.length) {
        html += `<section class="subsection-block" id="${block.id}">`
        html += `<h3 class="subsection-title ${roleClass}">${escapeHtml(headingLabel)}</h3>`
        let fenceIndex = 0
        for (const contentBlock of contentBlocks) {
          html += renderContextualBlock(contentBlock, options, {
            headingLabel,
            roleClass,
            fenceIndex: contentBlock.type === 'fence' ? fenceIndex++ : fenceIndex,
          })
        }
        html += '</section>'
        index = nextIndex
        continue
      }
    }

    html += renderStandaloneBlock(block, options)
    index += 1
  }

  if (sectionOpen) html += '</section>'
  return html
}

export function buildDebugPreviewHtml(markdown: string, options: BuildDebugPreviewHtmlOptions = {}) {
  const blocks = parseMarkdownBlocks(markdown)
  assignHeadingIds(blocks)
  resolveListAnchors(blocks)
  const htmlBody = renderBlocks(blocks, options)
  const titleSuffix = options.titleSuffix || '请求 / 响应'
  const metaLabel = options.metaLabel || '结构化调试预览'
  const displaySourcePath = toDisplaySourcePath(options.sourcePath)
  const sourceLabel = displaySourcePath ? `${escapeHtml(metaLabel)}<br />${escapeHtml(displaySourcePath)}` : escapeHtml(metaLabel)

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ChatLuna Debug HTML Preview</title>
    <style>${debugPreviewStyles}</style>
  </head>
  <body>
    <div id="debug-preview-root">
      <div class="header">
        <div>
          <div class="eyebrow">ChatLuna Debug Preview</div>
          <div class="title">调试快照<span class="title-sub">(${escapeHtml(titleSuffix)})</span></div>
        </div>
        <div class="meta">${sourceLabel}</div>
      </div>
      <div class="content">${htmlBody}</div>
    </div>
  </body>
</html>`
}
