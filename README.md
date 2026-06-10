# koishi-plugin-chatluna-chat-debug-tool

捕获 ChatLuna 请求与响应，导出结构化 Markdown/JSON 调试日志，并支持命令式预览与发送。

## 功能

- 透明捕获 ChatLuna 聊天请求与响应
- 输出 Markdown 调试日志，并为管理器保留结构化 JSON
- 提供 `chat-debug` 命令用于列表、预览、发送和清理日志
- 支持文本预览、Puppeteer 图片预览，以及将 HTML 报告作为群聊文件发送

## 安装

```sh
npm install koishi-plugin-chatluna-chat-debug-tool
```

## 本地构建

```sh
corepack yarn build
```

## 本地生成 HTML 预览

`debug:html` 用于将某一份调试 Markdown 直接渲染为本地 HTML，便于在浏览器中检查样式、折叠状态和图片嵌入效果。

在首次使用或修改模板后，先执行一次构建：

```sh
corepack yarn build
```

然后执行：

```sh
corepack yarn debug:html <markdown-file-path>
```

示例：

```sh
corepack yarn debug:html d:\code_base\koishi-app\data\chat-debug\2026-05-18\md\chat-debug-example.md
```

脚本支持相对路径或绝对路径输入，生成的 HTML 会写入工作区的 `data/chat-debug-html` 目录。

## 配置默认值

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 是否启用插件 |
| `captureEnabled` | `false` | 是否开始捕获请求与响应 |
| `writeMarkdown` | `true` | 是否写出 Markdown 调试日志 |
| `sendMode` | `image` | 命令发送方式，可选 `text` / `image` / `html` |
| `collapseJsonOnRender` | `true` | HTML/图片预览时默认折叠 JSON |
| `collapseSystemPromptOnRender` | `false` | HTML/图片预览时默认展开系统提示词 |
| `embedChatImagesOnRender` | `false` | HTML/图片预览时是否把聊天图片替换为真实图片控件 |
| `storageDir` | `chat-debug` | 调试日志根目录，位于 `data/<storageDir>` |
| `maxPreviewChars` | `2000` | 文本预览的最大字符数 |
| `redactHeaders` | `['authorization', 'cookie', 'x-api-key']` | 发送前做脱敏的请求头 |
| `captureFilters` | `['/chat/completions', '/responses', 'messages', 'tools']` | 命中过滤词后才记录请求 |
| `mergeForwardBatchSize` | `5` | 图片模式下单批合并条数 |
| `renderTimeoutMs` | `15000` | Puppeteer 渲染超时，单位毫秒 |
| `imageMaxBytes` | `5242880` (`5 MiB`) | 单张预览图的最大字节数 |
| `managerPageSize` | `20` | `chat-debug.list` 默认分页大小 |

## 运行依赖

- Koishi `^4.18.0`
- `koishi-plugin-chatluna`
- 可选：`puppeteer` 服务，用于图片渲染

## 发布

仓库包含 GitHub Actions 的 npm 发布工作流：

- 推送 `main` 分支且 `package.json` 版本变化时自动检查并发布
