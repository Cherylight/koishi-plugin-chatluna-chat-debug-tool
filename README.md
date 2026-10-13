# koishi-plugin-chatluna-chat-debug-tool

捕获 ChatLuna 请求与响应，导出结构化 Markdown/JSON 调试日志，并支持命令式预览与发送。

## 功能

- 透明捕获 ChatLuna 聊天请求与响应
- 支持 Chat Completions 和 Responses 的流式、非流式正文、推理摘要与工具调用
- 调试日志及旧日志预览自动排除加密推理字段；响应字节数按实际接收的 UTF-8 内容统计
- 输出 Markdown 调试日志，并为管理器保留结构化 JSON
- 提供 `chat-debug` 命令用于列表、预览、发送和清理日志
- 支持文本预览、Puppeteer 图片预览，以及将 HTML 报告作为群聊文件发送
- 同一 Character 回答的工具续轮和重试生成一份合并报告，保留每次 HTTP 的原始日志链接
- 区分 HTTP 状态与 Responses 的完成、失败、中断、取消及日志截断状态

## 同一回答的合并日志

默认在 `data/<storageDir>/<UTC 日期>/turns/turn-<首次请求 ID>.md` 和 `.json` 保存合并报告。单次请求仍写入原来的 `md`、`json` 目录。

Character 的 `before-chat` / `after-chat` 事件提供会话隔离的 trace；LangChain 模型调用在异步上下文中传播它。其他请求仅在完整输入前缀、endpoint/model/tools 与前次输出的 `call_id` 共同匹配时合并工具续轮；失败后的完全相同请求只在唯一候选时归为重试。并发歧义保持独立，报告注明关联依据。

报告只展示一次公共上下文和工具定义，各步展示新增消息、工具调用/结果、参数及角色状态变化。`character_reply.messages`、工具参数 `think` 与服务返回的 reasoning 分开展示；生成的回复不代表已经发送成功。每次 HTTP 的 usage 只累计一次，cached 是 input 的子集；缺失 usage 保持 unknown，并另列已知小计。异常控制符以可见转义和计数展示，完整内容保留在经过脱敏的单次 JSON。

`chat-debug.turn <单次日志 ID 或 turn-ID>` 可预览该轮报告。文本模式按 `maxPreviewChars` 截断，其余模式生成 HTML 文件。删除一个成员日志会删除整份衍生合并报告；清理仅在全部成员都被保留时保留报告，避免已删除内容通过合并文件留存。

响应观察随客户端消费同一条流，传输字节保持不变；没有独立的响应 clone 读者。客户端取消向原始 reader 传递，日志解析和落盘不阻塞读取。`captureMaxBytes` 仅限制诊断副本，超过限制不会截断模型回答。无终止事件的 EOF 会标为 incomplete；服务错误仍单独记录，即使 HTTP 为 200。

## 安装

```sh
npm install koishi-plugin-chatluna-chat-debug-tool
```

## 本地构建

```sh
corepack yarn build
```

运行捕获、字段过滤和落盘测试：

```sh
corepack yarn test
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
| `captureMaxBytes` | `8388608` (`8 MiB`) | 单次响应诊断副本上限；不限制客户端流 |
| `mergeTurns` | `true` | 保存同一回答的合并报告 |
| `turnIdleTimeoutMs` | `30000` | 已完成调用的空闲归档间隔；活跃 Character trace 保活，pending 请求另有 30 分钟 TTL |
| `sendMode` | `image` | 命令发送方式，可选 `text` / `image` / `html` |
| `collapseJsonOnRender` | `true` | HTML/图片预览时默认折叠 JSON |
| `collapseSystemPromptOnRender` | `false` | HTML/图片预览时默认展开系统提示词 |
| `embedChatImagesOnRender` | `false` | HTML/图片预览时是否把聊天图片替换为真实图片控件 |
| `storageDir` | `chat-debug` | 调试日志根目录，位于 `data/<storageDir>` |
| `maxPreviewChars` | `2000` | 文本预览的最大字符数 |
| `redactHeaders` | `['authorization', 'cookie', 'x-api-key']` | 发送前做脱敏的请求头 |
| `excludeJsonFields` | `['encrypted_content']` | 递归排除日志与预览中的 JSON 字段；encrypted_content 始终排除，实际 API 请求和会话历史不受影响 |
| `captureFilters` | `['/chat/completions', '/responses', 'messages', 'tools']` | 命中过滤词后才记录请求 |
| `excludeRequestBodyKeywords` | `[]` | 请求体包含任一关键字时跳过日志落盘；按区分大小写的完整片段匹配 |
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
