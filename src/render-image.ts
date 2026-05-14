import type { Context } from 'koishi'
import type { DebugCaptureConfig, DebugEntry } from './types'
import { renderDebugMarkdown } from './markdown'
import { logger } from './logger'

export interface RenderResult {
  markdown: string
  buffer?: Buffer
  buffers?: Buffer[]
  mimeType?: string
  tooLarge?: boolean
}

interface RenderOptions {
  renderTimeoutMs: number
  imageMaxBytes: number
  chunkHeight: number
}

const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  renderTimeoutMs: 15000,
  imageMaxBytes: 5 * 1024 * 1024,
  chunkHeight: 1800,
}

function normalizeRenderOptions(config?: Partial<DebugCaptureConfig>): RenderOptions {
  return {
    renderTimeoutMs: config?.renderTimeoutMs ?? DEFAULT_RENDER_OPTIONS.renderTimeoutMs,
    imageMaxBytes: config?.imageMaxBytes ?? DEFAULT_RENDER_OPTIONS.imageMaxBytes,
    chunkHeight: DEFAULT_RENDER_OPTIONS.chunkHeight,
  }
}

function escapeHtml(input: string) {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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

function markdownToHtml(markdown: string) {
  const escaped = escapeHtml(markdown)
  return escaped
    .replace(/^# (.+)$/gm, (_, title) => `<h1>${translateHeading(title)}</h1>`)
    .replace(/^## (.+)$/gm, (_, title) => `<h2>${translateHeading(title)}</h2>`)
    .replace(/^### (.+)$/gm, (_, title) => {
      const heading = translateHeading(title)
      return `<h3 class="${roleClassFromHeading(heading)}">${heading}</h3>`
    })
    .replace(/~~~md\n([\s\S]*?)\n~~~/g, '<pre class="role-block"><code>$1</code></pre>')
    .replace(/```json\n([\s\S]*?)\n```/g, '<pre class="role-block role-json"><code>$1</code></pre>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>')
}

function decorateRoleBlocks(html: string) {
  return html
    .replace(/<h3 class="([^"]+)">([\s\S]*?)<\/h3>\s*<pre class="role-block/g, '<section class="message-card $1"><h3 class="$1">$2</h3><pre class="role-block')
    .replace(/<\/pre>(\s*<\/section>)?/g, (matched, _sectionClose, offset, input) => {
      const previous = input.slice(Math.max(0, offset - 80), offset)
      if (previous.includes('<section class="message-card')) {
        return '</pre></section>'
      }
      return matched
    })
}

function buildPreviewHtml(markdown: string) {
  const htmlBody = decorateRoleBlocks(markdownToHtml(markdown))
  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: light;
        --bg: #eef4fb;
        --panel: #ffffff;
        --ink: #0f172a;
        --muted: #475569;
        --line: #dbeafe;
        --accent: #1d4ed8;
        --user: #93c5fd;
        --assistant: #86efac;
        --tool: #cbd5e1;
        --system: #fcd34d;
        --neutral: #dbeafe;
      }

      body {
        margin: 0;
        padding: 24px;
        background: radial-gradient(circle at 10% -20%, #ecfeff 0%, #eff6ff 42%, #f8fafc 100%);
        font-family: "Noto Sans SC", "Microsoft YaHei", "Segoe UI", sans-serif;
        color: var(--ink);
      }

      #debug-preview-root {
        width: 980px;
        margin: 0 auto;
        background: #ffffff;
        border: 1px solid #dbeafe;
        border-radius: 16px;
        box-shadow: 0 16px 36px rgba(15, 23, 42, 0.08);
        overflow: hidden;
      }

      .header {
        padding: 18px 22px;
        background: #dbeafe;
        color: #1e3a5f;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }

      .eyebrow {
        font-size: 12px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #1d4ed8;
        margin-bottom: 6px;
        font-weight: 700;
      }

      .title {
        font-size: 40px;
        font-weight: 700;
        line-height: 1.1;
      }

      .title-sub {
        font-size: 20px;
        font-weight: 600;
        opacity: 0.9;
        margin-left: 4px;
      }

      .meta {
        font-size: 13px;
        opacity: 0.95;
        text-align: right;
        line-height: 1.5;
      }

      .content {
        padding: 0;
      }

      h1, h2, h3 {
        margin: 0;
        line-height: 1.25;
      }

      h1 {
        font-size: 28px;
        padding: 18px 22px 6px;
      }

      h2 {
        font-size: 14px;
        font-weight: 700;
        color: #1d4ed8;
        padding: 18px 22px 10px;
        border-top: 1px solid #e2e8f0;
      }

      h3 {
        font-size: 14px;
        font-weight: 700;
        margin-bottom: 10px;
      }

      p, li {
        font-size: 13px;
        line-height: 1.65;
        color: #1e293b;
        word-break: break-word;
      }

      ul {
        margin: 0 22px 18px 40px;
        padding: 0;
      }

      .message-card {
        margin: 0 22px 18px;
      }

      .role-user {
        color: #1d4ed8;
      }

      .role-assistant {
        color: #15803d;
      }

      .role-tool {
        color: #475569;
      }

      .role-system {
        color: #b45309;
      }

      pre {
        margin: 0 22px 18px;
        padding: 12px;
        background: #f8fafc;
        border: 1px dashed #cbd5e1;
        border-radius: 12px;
        white-space: pre-wrap;
        word-break: break-word;
        overflow-wrap: anywhere;
      }

      .message-card pre {
        margin: 0;
      }

      .message-card.role-user pre,
      .role-user + pre {
        border-color: var(--user);
        background: #f6fbff;
      }

      .message-card.role-assistant pre,
      .role-assistant + pre {
        border-color: var(--assistant);
        background: #f3fff6;
      }

      .message-card.role-tool pre,
      .role-tool + pre {
        border-color: var(--tool);
        background: #f8fafc;
      }

      .message-card.role-system pre,
      .role-system + pre {
        border-color: var(--system);
        background: #fffdf3;
      }

      .role-json {
        border-color: var(--neutral);
        background: #f8fbff;
      }

      code {
        font-family: "Cascadia Code", "JetBrains Mono", "Consolas", "SFMono-Regular", monospace;
        font-size: 12px;
        line-height: 1.7;
        color: #1e293b;
      }

      .content > p {
        margin: 0 22px 14px;
      }
    </style>
  </head>
  <body>
    <div id="debug-preview-root">
      <div class="header">
        <div>
          <div class="eyebrow">ChatLuna Debug Preview</div>
          <div class="title">调试快照<span class="title-sub">(请求 / 响应)</span></div>
        </div>
        <div class="meta">结构化调试预览<br/>渲染输出</div>
      </div>
      <div class="content"><p>${htmlBody}</p></div>
    </div>
  </body>
</html>`
}

async function screenshotWithTimeout(page: any, clip: { x: number, y: number, width: number, height: number }, renderTimeoutMs: number) {
  const task = page.screenshot({
    type: 'png',
    clip,
    captureBeyondViewport: true,
  }) as Promise<Buffer>

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('render timeout')), renderTimeoutMs)
  })

  return Promise.race([task, timeoutPromise]) as Promise<Buffer>
}

async function screenshotPaginated(page: any, rootSelector: string, options: RenderOptions) {
  const root = await page.$(rootSelector)
  if (!root) {
    throw new Error('render root not found')
  }

  const box = await root.boundingBox()
  if (!box) {
    throw new Error('render root has no bounding box')
  }

  const scrollHeight = await page.$eval(rootSelector, (element: any) => {
    return Math.ceil(element.scrollHeight || element.getBoundingClientRect().height || 0)
  })

  const totalHeight = Math.max(Math.ceil(box.height), scrollHeight)
  const totalPages = Math.max(1, Math.ceil(totalHeight / options.chunkHeight))
  const buffers: Buffer[] = []

  for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
    const offsetY = pageIndex * options.chunkHeight
    const clipHeight = Math.min(options.chunkHeight, totalHeight - offsetY)
    const imageBuffer = await screenshotWithTimeout(
      page,
      {
        x: Math.max(0, Math.floor(box.x)),
        y: Math.max(0, Math.floor(box.y + offsetY)),
        width: Math.max(1, Math.ceil(box.width)),
        height: Math.max(1, Math.ceil(clipHeight)),
      },
      options.renderTimeoutMs,
    )
    buffers.push(imageBuffer)
  }

  return buffers
}

export async function renderDebugPreview(ctx: Context, entry: DebugEntry, config?: Partial<DebugCaptureConfig>): Promise<RenderResult> {
  const markdown = renderDebugMarkdown(entry)
  const markdownBuffer = Buffer.from(markdown, 'utf8')
  if (markdownBuffer.length > 5 * 1024 * 1024) {
    return { markdown, tooLarge: true }
  }

  const options = normalizeRenderOptions(config)
  const puppeteerService = (ctx as any).puppeteer
  if (!puppeteerService?.page) {
    logger.debug(`Puppeteer 服务不可用，回退到 Markdown 文本预览，bytes=${markdownBuffer.length}`)
    return { markdown }
  }

  let page: any
  try {
    page = await puppeteerService.page()
    await page.setViewport({ width: 1360, height: 2200, deviceScaleFactor: 1.5 })
    await page.setContent(buildPreviewHtml(markdown), { waitUntil: 'load' })

    const buffers = await screenshotPaginated(page, '#debug-preview-root', options)
    if (buffers.some((image) => image.length > options.imageMaxBytes)) {
      logger.warn(`预览截图超过大小限制，回退到 Markdown 文本预览，images=${buffers.length}`)
      return { markdown, tooLarge: true }
    }

    return {
      markdown,
      buffer: buffers[0],
      buffers,
      mimeType: 'image/png',
    }
  } catch (error) {
    logger.warn('预览截图失败，回退到 Markdown 文本预览:', error)
    return { markdown }
  } finally {
    try {
      await page?.close()
    } catch (error) {
      logger.debug('关闭 Puppeteer 页面失败:', error)
    }
  }
}
