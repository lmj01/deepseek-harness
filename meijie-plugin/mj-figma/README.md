# mj-figma

DeepSeek Harness（dsh）插件库 `meijie-plugin/mj-figma`：通过 Cordis 插件机制注册模型可见的工具，并演示插件的配置（`cordis.yml`）如何驱动行为。除演示工具外，还集成了 **Figma REST API**，让 agent 能直接读取 Figma 设计稿内容。

## 目录结构

```
meijie-plugin/mj-figma/
├── cordis.yml              # 本插件的加载补丁（loader patch overlay），启动时注入插件行
├── src/
│   ├── index.ts            # 插件入口（Cordis 原始插件：导出 name / Config / apply）
│   └── figma.ts            # Figma REST API v1 客户端 + 节点树投影（可注入 fetch 便于测试）
├── scripts/
│   └── verify-boot.ts      # 端到端启动验证脚本（含 Figma 桩传输测试）
└── README.md
```

## 插件做什么

加载后注册七个只读工具：

| 工具 | 行为 |
| --- | --- |
| `figma_api_get` | 调用官方 OpenAPI `0.42.0` 中列出的 GET 操作；固定 Figma 官方域名并拒绝未知路径、绝对 URL、重定向、路径穿越、写请求和未声明的查询参数 |
| `figma_list_projects` | 按 team id 列出项目；底层 `/v1/teams/:team_id/projects` 已被 Figma 标记为 deprecated，新应用可通过 `figma_api_get` 使用 v2 folders API |
| `figma_get_components` | 并行读取主文件发布的 components、component sets 和 styles |
| `figma_get_variables` | 读取文件的 local 或 published variables；需要 Enterprise full member 和 `file_variables:read` |
| `figma_get_node` | 通过 Figma REST API 读取设计稿（整个文件或单个节点），返回压缩后的模型可读节点树：id / name / type / TEXT 文本 |
| `figma_get_comments` | 读取设计稿评论：评论人 / 时间 / 文本 / 回复与已解决标记 / 评论锚定的节点 id（Figma API 不暴露评论里的图片，想看对应视觉用 `figma_render` 渲染锚定节点） |
| `figma_render` | 把 Figma 节点渲染成图片（png / jpg / svg），返回签名 URL 并下载到本地，配合 harness 的 `read_image` 工具即可让模型真正“看到”设计稿 |

配置字段：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `verbose` | `false` | 为 `true` 时每次工具调用打印一行日志 |
| `figmaToken` | — | Figma 令牌备用字段；优先级：`FIGMA_TOKEN` 凭据 > 环境变量 > 此字段 |
| `figmaFileKey` | — | 默认 Figma 文件 key，工具调用可省略 `fileKey` 参数 |
| `figmaOutputDir` | `os.tmpdir()/mj-figma` | `figma_render` 图片下载目录 |
| `figmaMaxNodes` | `2000` | `figma_get_node` 遍历节点数上限（超出置 `truncated`） |

## Figma 接入

### 前置条件

1. Figma 账号 → Settings → Security → **Personal access tokens**，生成一个令牌（`figd_...`）
2. 目标设计稿的 **file key**：文件 URL 中 `/file/<key>/...` 段
3. 令牌账号对该文件有查看权限

### 配置令牌（三种方式，按优先级）

1. **凭据服务（推荐）**：在 `~/.dsh/.credentials.yaml` 写入 `FIGMA_TOKEN: figd_xxx`，或在环境变量里设 `FIGMA_TOKEN`——插件每次调用都从 `credentials` 服务重新解析，改凭据无需重启
2. `cordis.yml` 的 `config.figmaToken`
3. 默认文件 key：`config.figmaFileKey`

### 用法示例（在 Web GUI 里对 agent 说）

- “用 figma_get_node 读文件 `<fileKey>`，列出所有页面和文本”
- “读取 team `<teamId>` 的项目列表”
- “读取文件 `<fileKey>` 发布的组件、组件集和样式”
- “读取文件 `<fileKey>` 的本地 Variables”
- “用 figma_api_get 调用 `/v1/me`”
- “把 `<fileKey>` 的节点 `1:2` 渲染成 png，然后用 read_image 看一下”

## 如何启动

前提：`deepseek-harness` 仓库已 `pnpm install`（运行时走 tsx 源码解析，不需要额外构建；只有运行 `tsc` 类型检查时才需要仓库的 `lib/types` 产物，即已执行过 `pnpm run build:lib`）。

### 方式一：Web GUI（推荐开发期使用）

从仓库根目录启动 web profile，并把本插件作为 `--patch` overlay 注入：

```sh
cd /home/meiji/agents/deepseek-harness
pnpm dsh web --patch ./meijie-plugin/mj-figma/cordis.yml
```

浏览器打开 http://127.0.0.1:3080 ，在对话里让 agent 调用 `figma_get_node` / `figma_render` 即可看到效果。

启动日志（web 进程的 stdout）里会出现：

```
[mj-figma] plugin loaded (verbose=false)
```

### 方式二：持久化到 profile 的补丁层

把 `cordis.yml` 里的整段内容（`- insert:` 块）复制到 `$DSH_HOME/profiles/web/cordis.patch.yml`（本机即 `~/.dsh/profiles/web/cordis.patch.yml`），然后正常启动：

```sh
pnpm dsh web
```

profile 补丁层是热加载的：只改 `config` 里的值不用重启，改插件源码仍需重启。

### 方式三：其他 profile / headless

任意 profile 都可以带同一份 patch：

```sh
pnpm dsh --profile headless --patch ./meijie-plugin/mj-figma/cordis.yml "list the files in figma file <fileKey>"
```

### 验证是否已注入

不启动服务，直接打印组合后的配置树（会看到 `mj-figma` 行）：

```sh
pnpm dsh web --dump-config --patch ./meijie-plugin/mj-figma/cordis.yml
```

端到端验证（临时启动一棵最小 Cordis 树，装载真实 patch 文件并断言全部工具行为；Figma 部分用桩传输，不需要真实令牌）：

```sh
node --import tsx/esm meijie-plugin/mj-figma/scripts/verify-boot.ts
# 期望输出: verify-boot PASSED: mj-figma activated, OpenAPI GET safety and all seven Figma tools behave as configured
```

## 工作原理（为什么这样能跑起来）

- `dsh` 源码启动走 `node --import tsx/esm apps/cli/src/bin.ts`。tsx 会读取仓库根 `tsconfig.json`（extends `tsconfig.base.json`），其中的 `paths` 把 `@deepseek-ai/*` 映射到各包源码，所以插件文件里的 `import ... from '@deepseek-ai/dsh-tools'` 等无需安装即可解析到仓库源码。
- `cordis.yml` 是 loader patch 格式（顶层数组，每项是 `{ insert: [...] }` 之类的 patch entry），由 `dsh ... --patch <file>` 作为 overlay 应用到 profile 的组合树。
- 插件行 `name` 必须写**绝对路径**：相对路径会以 profile 目录（如 `~/.dsh/profiles/web/`）为基准解析，而不是 patch 文件所在目录。
- 修改插件源码后需要**重启** dsh 进程（web bundle 关闭了模块热重载）；只改 `cordis.yml` 的配置值时可热加载。

## 常见问题

- **`Cannot find package '@deepseek-ai/...'`**：不要用 `node script.ts` 直接跑，必须从仓库根目录经 `pnpm dsh ...` 或 `node --import tsx/esm ...` 启动，让 tsx 的 paths 解析生效。
- **`--patch` 文件不存在或格式不对**：启动会 fail loud，报 `failed to read overlay` / `failed to parse overlay`，检查路径与 YAML 缩进（`insert:` 下的子项要缩进两级）。
- **Figma 工具在 GUI 里看不到**：确认启动命令带了 `--patch ./meijie-plugin/mj-figma/cordis.yml`，并用 `--dump-config` 确认组合树里有 `mj-figma` 行。
- **Figma 工具报 `no token configured`**：在 `~/.dsh/.credentials.yaml` 加 `FIGMA_TOKEN: figd_xxx`（或设环境变量），改完**无需重启**（每次调用重新解析）。
- **`figma_render` 下载的图片 `read_image` 读不到**：`read_image` 受 profile 文件沙箱策略约束，默认输出目录在系统临时目录；把 `figmaOutputDir` 配到工作区内的路径（或提高权限模式）即可。
