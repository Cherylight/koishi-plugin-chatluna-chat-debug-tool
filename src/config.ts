import { Schema } from 'koishi'
import type { DebugCaptureConfig } from './types'

const CaptureFilters = Schema.array(Schema.string())
  .default([
    '/chat/completions',
    '/responses',
    'messages',
    'tools',
  ])
  .description('请求过滤关键字，只记录与聊天调试相关的请求')

export const Config: Schema<DebugCaptureConfig> = Schema.object({
  enabled: Schema.boolean()
    .default(false)
    .description('是否启用 ChatLuna 聊天调试'),
  captureEnabled: Schema.boolean()
    .default(false)
    .description('是否捕获请求与响应'),
  capturePendingRequests: Schema.boolean()
    .default(false)
    .description('是否在匹配请求开始后先写入仅包含请求的临时调试日志；完整响应成功后会替换为请求与响应日志，失败时保留请求日志并尽量记录错误'),
  captureNonChatRequests: Schema.boolean()
    .default(false)
    .description('是否允许捕获非聊天请求（包括 /mcp 与 JSON-RPC）；关闭时默认跳过这类流量，开启后仍需命中过滤关键字'),
  excludeEmbeddingRequests: Schema.boolean()
    .default(false)
    .description('是否排除 Embedding 请求日志；默认不排除，开启后跳过 /embeddings 端点或 embedding 模型请求'),
  writeMarkdown: Schema.boolean()
    .default(true)
    .description('是否将日志写入 Markdown 文件'),
  sendMode: Schema.union([
    Schema.const('text').description('文本预览'),
    Schema.const('image').description('图片'),
    Schema.const('html').description('HTML 文件'),
  ] as const)
    .default('image')
    .description('命令发送方式'),
  collapseJsonOnRender: Schema.boolean()
    .default(true)
    .description('渲染图片时是否折叠 JSON 详情'),
  collapseSystemPromptOnRender: Schema.boolean()
    .default(false)
    .description('渲染时是否折叠 System Prompt（保留三行预览）'),
  embedChatImagesOnRender: Schema.boolean()
    .default(false)
    .description('渲染图片时是否在网页中嵌入聊天图片（否则为URL）'),
  storageDir: Schema.string()
    .default('chat-debug')
    .description('日志保存目录（相对于 data 目录）'),
  maxPreviewChars: Schema.number().min(200).max(10000).step(100)
    .default(2000)
    .description('Markdown 预览最大字符数'),
  redactHeaders: Schema.array(Schema.string())
    .default(['authorization', 'cookie', 'x-api-key'])
    .description('需要脱敏的请求头'),
  captureFilters: CaptureFilters,
  mergeForwardBatchSize: Schema.number().min(1).max(20).step(1)
    .default(5)
    .description('图片模式下合并转发每批条数'),
  renderTimeoutMs: Schema.number().min(1000).max(120000).step(1000)
    .default(15000)
    .description('Markdown 渲染超时时间（毫秒）'),
  imageMaxBytes: Schema.number().min(1024).max(20 * 1024 * 1024).step(1024)
    .default(5 * 1024 * 1024)
    .description('单张图片最大字节数'),
  managerPageSize: Schema.number().min(5).max(100).step(1)
    .default(20)
    .description('管理器每页显示条数'),
}).description('ChatLuna 聊天调试配置')
