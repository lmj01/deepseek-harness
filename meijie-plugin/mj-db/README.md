# mj-db

`mj-db` 是一个仅在 Linux 上启用的 DeepSeek Harness/Cordis 插件，入口为 `src/index.ts`，导出 `name`、`inject`、`Config` 和 `apply`。插件在非 Linux 平台会正常加载但不执行任何逻辑，也不会注册 DBX 工具。它在 Linux 上使用 `@dbx-app/mcp-server` 启动本地 MCP stdio 服务，并复用 DSH 自带的 `@deepseek-ai/dsh-mcp-client` 将 DBX 工具注册给模型。

## 能力

DBX MCP 会根据当前模式与连接作用域动态公布工具。主要分析工具包括：

| 工具 | 用途 |
| --- | --- |
| `mcp__dbx__dbx_list_connections` | 列出当前 MCP 策略允许访问的 DBX 连接 |
| `mcp__dbx__dbx_list_tables` | 列出表、视图或集合 |
| `mcp__dbx__dbx_describe_table` | 读取字段及表结构 |
| `mcp__dbx__dbx_get_schema_context` | 生成适合模型理解的紧凑数据库结构上下文 |
| `mcp__dbx__dbx_execute_query` | 执行 SQL 或受支持的 MongoDB 命令，最多返回 100 行 |
| `mcp__dbx__dbx_execute_redis_command` | 执行 Redis 命令 |

DBX MCP 还可能公布连接增删和桌面 UI 工具。启用连接作用域后，这些工具会被隐藏。`mj-db` 不自行解析数据库凭据，也不绕过 DBX 的访问策略。

## 安装

依赖在插件库根目录声明并锁定：

```sh
cd /home/meiji/agents/deepseek-harness/meijie-plugin
npm install
./node_modules/.bin/dbx-mcp-server --verify-platform
```

`@dbx-app/mcp-server` 通过 optional dependency 安装当前平台的原生 Rust 程序，因此不要使用 `--no-optional`。当前版本只支持 glibc Linux，不支持 Alpine/musl。

## DBX 准备

1. 在 DBX 中添加数据库连接。
2. 打开 **设置 → MCP**。
3. 将权限模式设为 **只读**。
4. 在允许连接列表中仅选择 agent 确实需要分析的连接。
5. 数据库账号自身也使用只读账号；生产数据优先使用只读副本或脱敏库。

默认 DBX 数据文件位置：

- Linux：`~/.local/share/com.dbx.app/dbx.db`

虽然 WSL 的 `process.platform` 是 `linux`，但不要直接把 DBX 数据目录指向 `/mnt/c`、`/mnt/d`、`/mnt/e` 等 Windows DrvFS/9P 挂载。SQLite 的 WAL 和文件锁可能在跨系统挂载上返回 `disk I/O error`；应将 DBX 数据复制到 WSL 的 Linux 文件系统。

如需覆盖，在 `cordis.yml` 的插件配置中设置 `dataDirectory`，值必须是包含 `dbx.db` 的目录。插件会将它转换为 DBX MCP 子进程的 `DBX_DATA_DIR`。

## 启动

DBX MCP 需要读取用户目录中的 DBX 数据文件。若 DSH 使用默认的 `workspace-write` 沙箱，`~/.local/share/com.dbx.app/dbx.db` 位于工作区之外，子进程会因只读文件系统而关闭。请选择一种方式：

1. 推荐：把 DBX 数据目录放到当前工作区可访问的位置，并在插件配置中设置 `dataDirectory`。
2. 或在明确接受主机访问范围后，用 `DSH_PERMISSION_MODE=danger-full-access` 启动。

从 DeepSeek Harness 仓库根目录运行：

```sh
cd /home/meiji/agents/deepseek-harness
DSH_PERMISSION_MODE=danger-full-access pnpm dsh web --patch ./meijie-plugin/mj-db/cordis.yml
```

如使用工作区内的数据目录，则可以保留 `workspace-write`：

```yaml
config:
  serverName: dbx
  dataDirectory: '/home/meiji/agents/deepseek-harness/meijie-plugin/.dbx-data'
```

浏览器打开 http://127.0.0.1:3080 。首次连接成功后，工具以 `mcp__dbx__...` 名称出现。

可以这样请求模型：

- “列出 DBX 中可访问的数据库连接。”
- “读取订单库的 schema，说明主要表及关联关系。”
- “统计最近七天每天的订单量，只执行只读查询，并说明 SQL 与结论。”
- “检查订单金额是否存在明显异常值，先读取表结构，再执行有限结果集的查询。”

## 配置

插件会根据 `src/index.ts` 的位置自动解析插件库根目录中的 DBX MCP 启动程序。可配置字段：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `serverName` | `dbx` | 模型工具名前缀中的 MCP 服务名 |
| `command` | 自动解析 | DBX MCP 启动程序或原生程序路径 |
| `cwd` | 插件库根目录 | DBX MCP 子进程工作目录 |
| `dataDirectory` | DBX 默认目录 | 包含 `dbx.db` 的本地 DBX 数据目录 |
| `connectionId` | — | 将访问范围进一步限制到一个稳定连接 ID |
| `connectionIds` | — | 将访问范围限制到多个连接 ID，以逗号分隔 |
| `connectionName` | — | 按连接名称缩小范围；ID scope 优先 |
| `database` | — | 进一步限制数据库 |
| `toolCallTimeoutMs` | `60000` | 单次 DBX 工具调用超时 |
| `failOnStartupError` | `true` | DBX MCP 启动或工具发现失败时阻止插件激活 |

这些字段由 `mj-db` 转换为 DSH MCP 客户端配置和 DBX 子进程环境。Web 模式认证暂未作为插件配置暴露，避免把密码或自定义认证头写入仓库。

## 安全限制

- `DBX_MCP_ALLOW_WRITES: '0'` 只为尚未保存中央策略的旧配置提供只读兼容；保存中央策略后，权限完全由 DBX 的 **设置 → MCP** 控制。
- 只读模式仍可能读取敏感数据、暴露 schema 或运行昂贵查询；数据库账号权限、连接 allowlist 和数据库资源限制才是最终边界。
- 不要为无人值守 agent 使用“完全访问”。
- 不要常态启用 `DBX_MCP_DEBUG_SQL`，它可能在诊断输出中暴露 SQL 和敏感字面量。
- 修改操作是否可用取决于 DBX 动态公布的工具及当前安全策略；不要假设工具名称固定存在。

## 验证

验证依赖与当前平台的原生程序：

```sh
cd /home/meiji/agents/deepseek-harness/meijie-plugin
npm ls @dbx-app/mcp-server
./node_modules/.bin/dbx-mcp-server --verify-platform
```

验证 overlay 能被 DSH 解析：

```sh
cd /home/meiji/agents/deepseek-harness
pnpm dsh web --dump-config --patch ./meijie-plugin/mj-db/cordis.yml
```

实际数据库验证需要本机已有 DBX 连接，并应先确认 DBX MCP 策略为只读。
