# koishi-plugin-chatluna-chat-debug-tool

捕获 ChatLuna 请求与响应，导出结构化 Markdown/JSON 调试日志，并支持命令式预览与发送。

## 功能

- 透明捕获 ChatLuna 聊天请求与响应
- 输出 Markdown 调试日志，并为管理器保留结构化 JSON
- 提供 `chat-debug` 命令用于列表、预览、发送和清理日志
- 支持 Puppeteer 渲染图片预览，长内容可分页拆分

## 当前状态

该插件目前处于首个独立仓库版本准备阶段，计划先以私有仓库形式上传 GitHub，再接入 npm 发布流程。

## 本地构建

```sh
corepack yarn build
```

## 运行依赖

- Koishi `^4.18.0`
- `koishi-plugin-chatluna`
- 可选：`puppeteer` 服务，用于图片渲染

