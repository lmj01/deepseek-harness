# meijie-plugin —— DeepSeek Harness 插件库

`meijie-plugin` 是挂在 deepseek-harness 仓库下的一个插件库目录，每个子目录是一个独立插件（`mj-*`）。所有插件共用根目录的 `tsconfig.json` 做类型检查，各自的 `cordis.yml` 负责加载。

## 目录结构

```
meijie-plugin/
├── tsconfig.json          # 库级类型检查配置（include mj-*/src、mj-*/scripts，新插件无需改）
├── README.md              # 本文件：插件库总览
├── mj-figma/              # Figma REST API 读取 + 演示工具
│   ├── cordis.yml         # mj-figma 的加载补丁（--patch 指向它）
│   ├── src/               # 插件源码（index.ts 入口 + figma.ts REST 客户端）
│   ├── scripts/           # verify-boot.ts 端到端验证
│   └── README.md          # mj-figma 使用说明
├── mj-cdp/                # CDP 连接当前浏览器：分析前端数据与效果
│   ├── cordis.yml         # mj-cdp 的加载补丁
│   ├── src/               # index.ts 入口 + cdp.ts CDP 客户端（HTTP+WebSocket）
│   ├── scripts/           # verify-boot.ts 端到端验证（内置 WebSocket mock CDP）
│   └── README.md          # mj-cdp 使用说明
└── mj-db/                 # DBX 数据库结构与只读查询分析
    ├── cordis.yml         # mj-db 的加载补丁
    ├── src/               # Cordis 插件入口，管理 DBX MCP 子插件
    ├── scripts/           # 插件导出、依赖、overlay 和原生平台验证
    └── README.md          # DBX 配置、安全策略与使用说明
```

## 插件列表

| 插件 | 目录 | 工具 | 说明 |
| --- | --- | --- | --- |
| mj-figma | `mj-figma/` | `figma_get_node` / `figma_get_comments` / `figma_render` | 通过 Figma REST API 读取设计稿内容与评论 |
| mj-cdp | `mj-cdp/` | `cdp_targets` / `cdp_evaluate` / `cdp_screenshot` / `cdp_console` | 通过 CDP 分析前端数据与效果；支持 chrome-launcher 指定 `chromePath` 自动启动浏览器，或连接已运行浏览器的调试端口 |
| mj-db | `mj-db/` | `mcp__dbx__dbx_list_tables` / `mcp__dbx__dbx_describe_table` / `mcp__dbx__dbx_get_schema_context` / `mcp__dbx__dbx_execute_query` 等 | 通过 `@dbx-app/mcp-server` 读取 DBX 已保存连接，分析数据库结构并执行受 DBX 策略约束的查询 |

## 如何启动某个插件

前提：deepseek-harness 仓库已 `pnpm install`；启动走 tsx 源码解析，运行时不需要额外构建（只有 `tsc` 类型检查需要 `pnpm run build:lib` 产出的 `lib/types`）。插件库自身的依赖（mj-cdp 使用的 `chrome-launcher`、mj-db 使用的 `@dbx-app/mcp-server`）在 `meijie-plugin/package.json` 声明，首次使用前执行一次 `cd meijie-plugin && npm install`。

统一加载当前所有插件时，使用插件库根目录的 `cordis.yml`：

```sh
cd /home/meiji/agents/deepseek-harness
pnpm dsh web --patch ./meijie-plugin/cordis.yml
```

统一配置默认启用 mj-figma 和 mj-db；mj-cdp 保持 `disabled: true`，避免启动时自动连接或拉起 Chrome。需要时可在根 `cordis.yml` 中启用。

只加载单个插件时，以 mj-figma 为例，从仓库根目录把它作为 `--patch` overlay 注入 web profile：

```sh
cd /home/meiji/agents/deepseek-harness
pnpm dsh web --patch ./meijie-plugin/mj-figma/cordis.yml
```

浏览器打开 http://127.0.0.1:3080 ，在对话里让 agent 调用该插件的工具即可。也可以注入多个插件（`--patch` 可重复）：

```sh
pnpm dsh web --patch ./meijie-plugin/mj-figma/cordis.yml --patch ./meijie-plugin/mj-xxx/cordis.yml
```

其他 profile / 一次性任务同理：

```sh
pnpm dsh --profile headless --patch ./meijie-plugin/mj-figma/cordis.yml "用 figma_get_node 读文件 <fileKey> 的节点树"
```

想持久化：把某个 `cordis.yml` 里的 `- insert:` 段复制进 `$DSH_HOME/profiles/web/cordis.patch.yml`（改配置值可热加载，改源码仍需重启）。

## 验证

```sh
# 库级类型检查（需仓库 lib/types 已构建）
./node_modules/.bin/tsc --noEmit -p meijie-plugin/tsconfig.json

# 单个插件的端到端验证（无需令牌，Figma 部分用桩传输）
node --import tsx/esm meijie-plugin/mj-figma/scripts/verify-boot.ts

# mj-db 的 overlay、依赖版本和原生平台验证
node --import tsx/esm meijie-plugin/mj-db/scripts/verify-config.mjs
```

## 新增一个插件

1. 新建 `mj-<name>/`，参考 `mj-figma/` 的结构：
   - `src/index.ts` —— 导出 `name` / `Config` / `apply` 的 Cordis 插件
   - `cordis.yml` —— 加载补丁，`name` 写该插件入口的**绝对路径**（相对路径会以 profile 目录为基准解析）
   - `scripts/verify-boot.ts` —— 端到端验证（可复制 mj-figma 的模板改插件 id）
   - `README.md` —— 使用说明
2. 类型检查无需改动：根 `tsconfig.json` 的 `include` 已覆盖 `mj-*/src`、`mj-*/scripts`。
3. 在本文档的插件列表加一行。

## 工作原理

- `dsh` 源码启动走 `node --import tsx/esm apps/cli/src/bin.ts`。tsx 读取仓库根 `tsconfig.json`（extends `tsconfig.base.json`）的 `paths`，把 `@deepseek-ai/*` 映射到各包源码，所以插件里直接 `import ... from '@deepseek-ai/dsh-tools'` 无需安装即可解析。
- `cordis.yml` 是 loader patch 格式（顶层数组，每项是 `{ insert: [...] }` 之类的 patch entry），由 `dsh ... --patch <file>` 作为 overlay 应用到 profile 的组合树。
- 修改插件源码后需要**重启** dsh 进程（web bundle 关闭了模块热重载）；只改 `cordis.yml` 配置值时可热加载。
