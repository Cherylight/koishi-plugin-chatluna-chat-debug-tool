import type { Context } from 'koishi'
import type { DebugCaptureConfig, DebugEntry } from './types'
import { renderDebugMarkdown } from './markdown'
import { logger } from './logger'
import { buildDebugPreviewHtml } from './render-preview-template'

export interface RenderResult {
  markdown: string
  buffer?: Buffer
  buffers?: Buffer[]
  mimeType?: string
  tooLarge?: boolean
}

export interface RenderPreviewOptions {
  sourcePath?: string
  stripCollapsedSystemPrompt?: boolean
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

export function renderDebugPreviewHtml(
  entry: DebugEntry,
  config?: Partial<DebugCaptureConfig>,
  previewOptions: RenderPreviewOptions = {},
) {
  const markdown = renderDebugMarkdown(entry)
  const html = buildDebugPreviewHtml(markdown, {
    sourcePath: previewOptions.sourcePath,
    titleSuffix: '请求 / 响应',
    metaLabel: '结构化调试预览',
    collapseJsonByDefault: config?.collapseJsonOnRender ?? true,
    collapseSystemPromptByDefault: config?.collapseSystemPromptOnRender ?? false,
    stripCollapsedSystemPrompt: previewOptions.stripCollapsedSystemPrompt ?? false,
    embedChatImages: config?.embedChatImagesOnRender ?? false,
  })

  return { markdown, html }
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

export async function renderDebugPreview(
  ctx: Context,
  entry: DebugEntry,
  config?: Partial<DebugCaptureConfig>,
  previewOptions: RenderPreviewOptions = {},
): Promise<RenderResult> {
  const { markdown, html } = renderDebugPreviewHtml(entry, config, previewOptions)
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
    await page.setContent(html, { waitUntil: 'load' })

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
