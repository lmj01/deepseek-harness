# mj-cdp

DeepSeek Harness（dsh）插件库 `meijie-plugin/mj-cdp`：通过 **Chrome DevTools Protocol（CDP）** 连接当前浏览器，让 agent **分析前端的数据和效果**——读取页面 JS 状态 / DOM / 控制台日志，并截取页面视觉输出。

## 目录结构

```
meijie-plugin/mj-cdp/
├── cordis.yml              # 本插件的加载补丁（loader patch overlay），启动时注入插件行
├── src/
│   ├── index.ts            # 插件入口：4 个工具 + 控制台会话管理
│   └── cdp.ts              # CDP 客户端（HTTP 目标发现 + WebSocket 会话，传输可注入）
├── scripts/
│   └── verify-boot.ts      # 端到端验证（内置真实 WebSocket mock CDP 服务）
└── README.md
```

## 工具（模型可见）

| 工具 | 行为 |
| --- | --- |
| `cdp_targets` | 列出浏览器所有标签页（id / 标题 / URL / 类型），用于选目标 |
| `cdp_evaluate` | 在页面里执行 JavaScript 并取回返回值（页面状态、DOM 查询、前端持有的数据）；表达式抛错会作为工具错误返回 |
| `cdp_screenshot` | 截取页面视觉输出（png / jpeg），保存到本地，配合 harness 的 `read_image` 让模型直接"看到"页面效果 |
| `cdp_console` | 附加到页面，返回自首次调用以来缓冲的控制台日志与页面异常（上限 `maxConsoleEntries`） |

全部通过 CDP 的 `Runtime.evaluate` / `Page.captureScreenshot` / `Runtime.enable` 实现，Node 22 内置 WebSocket，**无新增依赖**。

## 前置条件

**方式 A（推荐）：让插件自己启动 Chrome（chrome-launcher）**

只需在配置里指定 `chromePath`（Chrome/Edge 可执行文件路径），插件会在首次调用时通过 `chrome-launcher` 自动启动浏览器（默认 headless）并开好调试端口，卸载/退出时自动杀掉。**不需要手动加 `--remote-debugging-port`**。

```yaml
chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'   # macOS
# chromePath: '/usr/bin/google-chrome'                                       # Linux
# chromePath: '/c/Program Files/Google/Chrome/Application/chrome.exe'        # Windows
# headless: false     # 默认 true；false 会打开可见窗口
# chromePort: 0       # 调试端口，0 = 随机（默认）
```

依赖 `chrome-launcher`（已声明在 `meijie-plugin/package.json`，`npm install` 一次即可）。

**方式 B：连接已在运行的浏览器（原方式）**

浏览器以远程调试模式启动后，配置 `cdpEndpoint` 连接：

```sh
# macOS Chrome（先关浏览器再执行）
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
curl http://127.0.0.1:9222/json/list   # 验证
```

```yaml
cdpEndpoint: 'http://127.0.0.1:9222'
```

两种方式可混用：显式传 `endpoint` 参数优先，其次已启动的 Chrome，然后 `chromePath` 启动，最后 `cdpEndpoint`。

## 配置（cordis.yml）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `chromePath` | — | Chrome/Edge 可执行文件路径；设置后插件用 chrome-launcher **自己启动**浏览器（开调试端口，退出时自动关闭） |
| `userDataDir` | — | 启动 Chrome 时使用的 profile 目录（chrome-launcher `userDataDir`），便携版 Chrome 需要 |
| `chromePort` | `0`（随机） | 启动 Chrome 的调试端口 |
| `headless` | `true` | 启动 Chrome 时是否 headless（`false` 显示可见窗口） |
| `launchOnLoad` | `false` | `true` 时插件加载（GUI 启动）就立即拉起 Chrome，而不是等第一次调工具 |
| `cdpEndpoint` | `http://127.0.0.1:9222` | `chromePath` 未设时，连接已运行浏览器的调试端点 |
| `cdpOutputDir` | `os.tmpdir()/mj-cdp` | `cdp_screenshot` 保存目录 |
| `maxConsoleEntries` | `200` | `cdp_console` 每页缓冲上限 |
| `verbose` | `false` | 打印每次工具调用 |

也可以在 `src/index.ts` 的 `apply` 里按环境覆盖（例如按 `platform()`/`hostname()`/`release()` 匹配 WSL2 或 Windows 时指定便携版 Chrome 的 `userDataDir`/`chromePath`，并同时打开 `launchOnLoad`），该赋值会在加载时生效。

## 如何启动

> **默认不启用**：`cordis.yml` 里该行带 `disabled: true`（插件随 patch 插入但不激活，也就不会拉起 Chrome）。启用方式二选一：
> 1. 把 `mj-cdp/cordis.yml` 里改成 `disabled: false`；
> 2. 或另加一个 enable overlay：`- id: mj-cdp` + `  disabled: false`（id 定点覆盖，不用改原文件），例如
>    `pnpm dsh web --patch ./meijie-plugin/mj-cdp/cordis.yml --patch ./meijie-plugin/mj-cdp/enable.yml`（enable.yml 内容为上面两行）。

前提：deepseek-harness 仓库已 `pnpm install`；插件库依赖已装（`cd meijie-plugin && npm install`，会装 chrome-launcher）。

```sh
cd /home/meiji/agents/deepseek-harness
pnpm dsh web --patch ./meijie-plugin/mj-cdp/cordis.yml
```

浏览器打开 http://127.0.0.1:3080 ，在对话里对 agent 说（假设配置了 `chromePath`，插件会自己拉起浏览器）：

> 用 `cdp_targets` 列出所有标签页，然后对第一个页面 `cdp_evaluate` 执行 `document.title`，再 `cdp_screenshot` 截个图用 `read_image` 看一下；`cdp_console` 看看控制台有没有报错

和 mj-figma 一起注入：`pnpm dsh web --patch ./meijie-plugin/mj-figma/cordis.yml --patch ./meijie-plugin/mj-cdp/cordis.yml`。

想持久化：把 `cordis.yml` 里的 `- insert:` 段复制进 `$DSH_HOME/profiles/web/cordis.patch.yml`。

## 验证

```sh
node --import tsx/esm meijie-plugin/mj-cdp/scripts/verify-boot.ts
# 期望输出: verify-boot PASSED: mj-cdp activated, cdp_targets/cdp_evaluate/cdp_screenshot/cdp_console work against the real WebSocket transport, and the chromePath launch path fails loud on a bad binary
```

验证脚本内置一个**真实的 CDP mock**：HTTP `/json/list` + 手写 RFC6455 WebSocket 服务（握手 + 帧编解码），插件通过**真实 WebSocket 传输**跑通 4 个工具——目标列表、求值结果与异常、截图落盘（校验 PNG 字节）、控制台与异常事件缓冲；并验证 `chromePath` 启动路径（指向不存在的二进制时错误清晰、chrome-launcher 可解析）。真实 Chrome 启动请在你的环境里用方式 A 配置 `chromePath` 验证。

## 说明

- **只读分析**：插件本身不改页面；`cdp_evaluate` 执行的是 agent 提供的表达式（可以读页面状态，写操作由表达式自己决定）。
- **启动的 Chrome 生命周期**：`chromePath` 模式在首次工具调用时启动（缓存实例），插件卸载时自动 `kill()`；`headless: false` 可看到窗口。
- `cdp_console` 的会话会持续挂在页面上缓冲日志（上限内滚动丢弃），插件卸载时自动关闭。
- 排查：`failed to launch Chrome at <path>` → chromePath 不对或 chrome-launcher 未安装；`cdp: <endpoint>/json/list returned 404/ECONNREFUSED` → 连接模式的浏览器没开 `--remote-debugging-port`；`cdp: target not found` → targetId 过期，重新 `cdp_targets`。
