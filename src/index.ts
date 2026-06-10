import type { Context } from 'koishi'
import './types'
import { Config } from './config'
import type { DebugCaptureConfig } from './types'
import { logger } from './logger'
import { DEBUG_LOG_TABLE } from './storage'
import { installChatlunaDebugHook } from './chatluna-hook'
import { registerCommands } from './commands'
import zhCN from './locales/zh-CN'

export { Config } from './config'
export { buildDebugPreviewHtml } from './render-preview-template'
export const name = 'chatluna-chat-debug-tool'
export const inject = {
  optional: ['chatluna', 'database', 'puppeteer', 'assets'],
}

export const usage = `
## ChatLuna 聊天调试工具

记录 ChatLuna 聊天调试日志，导出 Markdown，并支持命令式预览与发送。
`

export function apply(ctx: Context, config: DebugCaptureConfig) {
  ctx.i18n.define('zh-CN', zhCN)

  ;(ctx.model as any).extend(DEBUG_LOG_TABLE, {
    id: 'string',
    createdAt: 'unsigned',
    endAt: 'unsigned',
    durationMs: 'unsigned',
    source: 'string',
    requestType: 'string',
    model: 'string',
    resolvedModel: 'string',
    method: 'string',
    url: 'text',
    status: 'unsigned',
    requestId: 'string',
    serverRequestId: 'string',
    responseId: 'string',
    truncated: 'boolean',
    requestBytes: 'unsigned',
    responseBytes: 'unsigned',
    maxTokens: 'unsigned',
    maxOutputTokens: 'unsigned',
    reasoning: 'text',
    otherOptions: 'text',
    usage: 'text',
    error: 'text',
    filePath: 'text',
    jsonPath: 'text',
    htmlPath: 'text',
    summary: 'text',
  }, {
    primary: 'id',
  })

  let uninstall: (() => void) | undefined
  let installed = false

  const ensureHookUninstalled = (reason: string) => {
    if (!installed) {
      return
    }

    uninstall?.()
    uninstall = undefined
    installed = false
    logger.info(`ChatLuna 调试 hook 已停用: reason=${reason}`)
  }

  const ensureHookInstalled = (target: Context, reason: string) => {
    if (!config.enabled || !config.captureEnabled) {
      logger.info(`跳过 ChatLuna 调试 hook 安装: reason=${reason}, enabled=${config.enabled}, captureEnabled=${config.captureEnabled}`)
      return false
    }

    if (installed) {
      return true
    }

    const hasChatluna = Boolean((target as any).chatluna)
    logger.info(`尝试安装 ChatLuna 调试 hook: reason=${reason}, hasChatluna=${hasChatluna}`)
    if (!hasChatluna) {
      return false
    }

    const result = installChatlunaDebugHook(target, config)
    if (!result.installed) {
      logger.warn(`ChatLuna 调试 hook 安装未生效: reason=${reason}`)
      return false
    }

    uninstall = result.uninstall
    installed = true
    return true
  }

  ensureHookInstalled(ctx, 'apply')

  ctx.inject(['chatluna'], (injectedCtx) => {
    ensureHookInstalled(injectedCtx, 'inject')
  })

  ctx.on('ready', () => {
    const readyInstalled = ensureHookInstalled(ctx, 'ready')
    if (config.enabled && config.captureEnabled && !readyInstalled) {
      logger.warn('ChatLuna 调试 hook 未安装：ready 阶段仍无法访问 chatluna 服务')
    }
  })

  ctx.on('dispose', () => {
    ensureHookUninstalled('dispose')
  })

  registerCommands(ctx, config, {
    isHookInstalled: () => installed,
    ensureHookInstalled: (reason) => ensureHookInstalled(ctx, reason),
    ensureHookUninstalled,
  })
  logger.info('chatluna-chat-debug-tool 已加载')
}

