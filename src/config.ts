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
  writeMarkdown: Schema.boolean()
    .default(true)
    .description('是否将日志写入 Markdown 文件'),
  renderImageOnCommand: Schema.boolean()
    .default(true)
    .description('是否在命令执行时将 Markdown 渲染为图片发送'),
  storageDir: Schema.string()
    .default('chat-debug')
    .description('日志保存目录（相对 data 目录）'),
  maxBodyBytes: Schema.number().min(1024).max(10 * 1024 * 1024).step(1024)
    .default(512 * 1024)
    .description('请求/响应体最大记录字节数'),
  maxPreviewChars: Schema.number().min(200).max(20000).step(100)
    .default(6000)
    .description('Markdown 预览最大字符数'),
  redactHeaders: Schema.array(Schema.string())
    .default(['authorization', 'cookie', 'x-api-key'])
    .description('需要脱敏的请求头'),
  captureFilters: CaptureFilters,
  sendMode: Schema.union([
    Schema.const('image').description('image'),
    Schema.const('text').description('text'),
    Schema.const('figure').description('figure'),
  ] as const)
    .default('figure')
    .description('命令发送方式'),
  mergeForwardBatchSize: Schema.number().min(1).max(20).step(1)
    .default(5)
    .description('合并转发每批条数'),
  renderTimeoutMs: Schema.number().min(1000).max(120000).step(1000)
    .default(15000)
    .description('Markdown 渲染超时时间（毫秒）'),
  imageMaxBytes: Schema.number().min(1024).max(20 * 1024 * 1024).step(1024)
    .default(5 * 1024 * 1024)
    .description('单张图片最大字节数'),
  fallbackToFile: Schema.boolean()
    .default(true)
    .description('图片过大或超时后是否回退为文件路径/文本预览'),
  managerPageSize: Schema.number().min(5).max(100).step(1)
    .default(20)
    .description('管理器每页显示条数'),
}).description('ChatLuna 聊天调试配置')
