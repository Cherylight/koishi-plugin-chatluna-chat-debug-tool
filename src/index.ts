import { Context } from 'koishi'
import './types'
import { Config } from './config'
import type { DebugCaptureConfig } from './types'
import { logger } from './logger'
import { DEBUG_LOG_TABLE } from './storage'
import { installChatlunaDebugHook } from './chatluna-hook'
import { registerCommands } from './commands'

export { Config } from './config'
export const name = 'chatluna-chat-debug-tool'
export const inject = {
  optional: ['chatluna', 'database', 'puppeteer'],
}

export const usage = `
## ChatLuna 聊天调试工具

记录 ChatLuna 聊天调试日志，导出 Markdown，并支持命令式预览与发送。
`

export function apply(ctx: Context, config: DebugCaptureConfig) {
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
    summary: 'text',
  }, {
    primary: 'id',
  })

  if (config.enabled) {
    let uninstall: (() => void) | undefined
    let installed = false

    const tryInstallHook = (target: Context, reason: string) => {
      if (installed) {
        return
      }

      const hasChatluna = Boolean((target as any).chatluna)
      logger.info(`尝试安装 ChatLuna 调试 hook: reason=${reason}, hasChatluna=${hasChatluna}`)
      if (!hasChatluna) {
        return
      }

      const result = installChatlunaDebugHook(target, config)
      if (!result.installed) {
        logger.warn(`ChatLuna 调试 hook 安装未生效: reason=${reason}`)
        return
      }

      uninstall = result.uninstall
      installed = true
    }

    tryInstallHook(ctx, 'apply')

    ctx.inject(['chatluna'], (injectedCtx) => {
      tryInstallHook(injectedCtx, 'inject')
    })

    ctx.on('ready', () => {
      tryInstallHook(ctx, 'ready')
      if (!installed) {
        logger.warn('ChatLuna 调试 hook 未安装：ready 阶段仍无法访问 chatluna 服务')
      }
    })

    ctx.on('dispose', () => {
      uninstall?.()
      uninstall = undefined
      installed = false
    })
  }

  registerCommands(ctx, config)
  logger.info('chatluna-chat-debug-tool 已加载')
}
