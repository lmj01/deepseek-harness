# meijie-plugin —— DeepSeek Harness 插件库

`meijie-plugin` 是挂在 deepseek-harness 仓库下的一个插件库目录，每个子目录是一个独立插件（`mj-*`）。所有插件共用根目录的 `tsconfig.json` 做类型检查，各自的 `cordis.yml` 负责加载。

## 目录结构

```
meijie-plugin/
├── tsconfig.json          # 库级类型检查配置（include mj-*/src、mj-*/scripts，新插件无需改）
├── README.md              # 本文件：插件库总览
└── mj-figma/              # 第一个插件：Figma REST API 读取 + 演示工具
    ├── cordis.yml         # mj-figma 的加载补丁（--patch 指向它）
    ├── src/               # 插件源码（index.ts 入口 + figma.ts REST 客户端）
    ├── scripts/           # verify-boot.ts 端到端验证
    └── README.md          # mj-figma 使用说明
```

## 插件列表

| 插件 | 目录 | 工具 | 说明 |
| --- | --- | --- | --- |
| mj-figma | `mj-figma/` | `greet` / `flaky_echo` / `figma_get_node` / `figma_render` | 演示配置驱动工具 + 通过 Figma REST API 读取设计稿内容 |

## 如何启动某个插件

前提：deepseek-harness 仓库已 `pnpm install`；启动走 tsx 源码解析，运行时不需要额外构建（只有 `tsc` 类型检查需要 `pnpm run build:lib` 产出的 `lib/types`）。

以 mj-figma 为例，从仓库根目录把它作为 `--patch` overlay 注入 web profile：

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
