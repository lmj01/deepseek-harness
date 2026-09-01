import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mj-db'

/** Services required by the embedded DSH MCP bridge. */
export const inject = ['tools']

const pluginDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultCommand = resolve(pluginDirectory, '../node_modules/.bin/dbx-mcp-server')
const defaultWorkingDirectory = resolve(pluginDirectory, '..')

/** Configuration for the DBX database-analysis plugin. */
export interface Config {
  /** Stable namespace used in model-facing tool names. */
  serverName?: string
  /** Installed DBX MCP launcher or native binary. */
  command?: string
  /** Working directory of the DBX MCP process. */
  cwd?: string
  /** Optional DBX data directory containing `dbx.db`. */
  dataDirectory?: string
  /** Restrict access to one stable DBX connection ID. */
  connectionId?: string
  /** Restrict access to multiple stable DBX connection IDs. */
  connectionIds?: string
  /** Restrict access to one DBX connection name. */
  connectionName?: string
  /** Restrict access to one database. */
  database?: string
  /** Timeout for each DBX MCP tool call. */
  toolCallTimeoutMs?: number
  /** Reject plugin activation if DBX MCP cannot start. */
  failOnStartupError?: boolean
}

/** Runtime validation and defaults for {@link Config}. */
export const Config: Schema<Config> = Schema.object({
  serverName: Schema.string().default('dbx'),
  command: Schema.string().default(defaultCommand),
  cwd: Schema.string().default(defaultWorkingDirectory),
  dataDirectory: Schema.string(),
  connectionId: Schema.string(),
  connectionIds: Schema.string(),
  connectionName: Schema.string(),
  database: Schema.string(),
  toolCallTimeoutMs: Schema.number().default(60_000),
  failOnStartupError: Schema.boolean().default(true),
})

/**
 * Starts DBX MCP as an effect-scoped child plugin and exposes its discovered
 * tools through the Harness tool registry.
 *
 * @param ctx Cordis context carrying the tool registry.
 * @param config Resolved DBX process and access-scope configuration.
 * @returns Startup readiness after DBX MCP tool discovery completes.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (process.platform !== 'linux') return

  const env: Record<string, string> = {
    // This only preserves read-only behavior before a central DBX MCP policy is
    // saved. The DBX policy and database credentials remain authoritative.
    DBX_MCP_ALLOW_WRITES: '0',
  }
  if (config.dataDirectory !== undefined) env.DBX_DATA_DIR = config.dataDirectory
  if (config.connectionId !== undefined) env.DBX_MCP_SCOPE_CONNECTION_ID = config.connectionId
  if (config.connectionIds !== undefined) env.DBX_MCP_SCOPE_CONNECTION_IDS = config.connectionIds
  if (config.connectionName !== undefined) env.DBX_MCP_SCOPE_CONNECTION_NAME = config.connectionName
  if (config.database !== undefined) env.DBX_MCP_SCOPE_DATABASE = config.database

  await ctx.plugin(McpClient, {
    serverName: config.serverName ?? 'dbx',
    transport: 'stdio',
    command: config.command ?? defaultCommand,
    args: [],
    env,
    cwd: config.cwd ?? defaultWorkingDirectory,
    toolCallTimeoutMs: config.toolCallTimeoutMs ?? 60_000,
    failOnStartupError: config.failOnStartupError ?? true,
    reconnect: {
      enabled: true,
      initialDelayMs: 500,
      maxDelayMs: 30_000,
      maxAttempts: 10,
    },
  })
}
