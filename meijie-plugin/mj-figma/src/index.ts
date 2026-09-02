/**
 * mj-figma — a Harness plugin that reads Figma design files through the
 * Figma REST API and exercises its own configuration.
 *
 * - `figma_api_get` exposes the GET operations in the reviewed Figma OpenAPI
 *   specification through a path and query allowlist.
 * - `figma_list_projects`, `figma_get_components`, and `figma_get_variables`
 *   provide focused project, library asset, and variable reads.
 * - `figma_get_node` reads a Figma design file through the REST API and
 *   returns a condensed, model-readable node tree (identity, type, TEXT
 *   characters).
 * - `figma_get_comments` reads the file's comments: commenter, timestamp,
 *   message, reply/resolved flags, and the anchored node id (image
 *   attachments are not exposed by the Figma API).
 * - `figma_render` renders a Figma node to an image, returning the signed URL
 *   and a local copy that the harness `read_image` tool can view.
 *
 * `verbose` gates per-call stdout logging so a quiet deployment can turn the
 * chatter off. The Figma token resolves per call from the `credentials`
 * service (`FIGMA_TOKEN`) when mounted, then the `FIGMA_TOKEN` environment
 * variable, then the `figmaToken` config field — never cached.
 *
 * The plugin is loaded as a raw Cordis plugin row (a `.ts` file referenced by
 * absolute path from a profile patch, e.g. `meijie-plugin/mj-figma/cordis.yml`);
 * under the harness `dsh` source launch (tsx + the root tsconfig `paths`
 * facade) its `@deepseek-ai/*` imports resolve to the workspace sources.
 *
 * @module mj-figma
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { createFigmaClient, normalizeNodeId, projectComments, projectTree, type FigmaClient } from './figma.ts'
import { authorizeFigmaGet, type FigmaQueryValue } from './openapi-get.ts'

export const name = 'mj-figma'

export const inject = ['tools']

export interface Config {
  /** Log every tool invocation to stdout. */
  verbose?: boolean
  /** Figma token fallback; the `FIGMA_TOKEN` credential or environment variable wins. */
  figmaToken?: string
  /** Default Figma file key when a Figma tool call omits `fileKey`. */
  figmaFileKey?: string
  /** Directory `figma_render` downloads images into (default: os.tmpdir()/mj-figma). */
  figmaOutputDir?: string
  /** Node-visit cap for `figma_get_node` document projection. */
  figmaMaxNodes?: number
}

export const Config: Schema<Config> = Schema.object({
  verbose: Schema.boolean().default(false),
  figmaToken: Schema.string(),
  figmaFileKey: Schema.string(),
  figmaOutputDir: Schema.string(),
  figmaMaxNodes: Schema.number().default(2000),
})

export function apply(ctx: Context, config: Config): void {
  const log = (message: string): void => {
    if (config.verbose) console.log(`[mj-figma] ${message}`)
  }

  console.log(`[mj-figma] plugin loaded (verbose=${config.verbose})`)

  // Explicit resolve step: the deployment's render output directory, defaulted
  // once at load (a hidden `?? default` inside a tool run would hide it).
  const figmaOutputDir = config.figmaOutputDir ?? join(tmpdir(), 'mj-figma')

  /**
   * Resolve the Figma token for one call: the `credentials` service when
   * mounted (per-operation resolve, never cached), then the environment, then
   * the config fallback. The service is optional — a profile without
   * `credentials` still loads the plugin.
   * @returns the token, or `undefined` when nothing is configured.
   */
  const resolveFigmaToken = async (): Promise<string | undefined> => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const resolved = await credentials.resolve(credentialRef('FIGMA_TOKEN'))
      if (resolved !== undefined) return resolved.value
    }
    return process.env.FIGMA_TOKEN ?? config.figmaToken
  }

  /**
   * Build a client for one tool call, failing loud when no token is configured.
   * @returns a client bound to the resolved token.
   */
  const makeFigmaClient = async (): Promise<FigmaClient> => {
    const token = await resolveFigmaToken()
    if (token === undefined) {
      throw new Error('figma: no token configured — set the FIGMA_TOKEN credential (e.g. ~/.dsh/.credentials.yaml), the FIGMA_TOKEN environment variable, or config figmaToken')
    }
    return createFigmaClient({ token })
  }

  /**
   * Resolve the file key for one tool call: the call's parameter, then the
   * configured default. Fails loud when neither exists.
   * @param fileKey - the call's `fileKey` parameter, if given.
   * @returns the resolved file key.
   */
  const resolveFileKey = (fileKey: string | undefined): string => {
    const key = fileKey ?? config.figmaFileKey
    if (key === undefined) {
      throw new Error('figma: no file key — pass fileKey or set config figmaFileKey')
    }
    return key
  }

  /**
   * Download one rendered image into the plugin's output directory.
   * @param client - the Figma client whose transport downloads the URL.
   * @param fileKey - source file key, used in the file name.
   * @param nodeId - rendered node id, used in the file name.
   * @param format - image extension.
   * @returns the absolute local path.
   */
  const saveRenderedImage = async (
    client: FigmaClient, fileKey: string, nodeId: string, format: string, url: string,
  ): Promise<string> => {
    const bytes = await client.download(url)
    await mkdir(figmaOutputDir, { recursive: true })
    const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_')
    const localPath = join(figmaOutputDir, `${safe(fileKey)}-${safe(nodeId)}.${format}`)
    await writeFile(localPath, bytes)
    return localPath
  }

  ctx.tools.register(defineTool({
    name: 'figma_api_get',
    description: 'Call one read-only Figma REST endpoint allowed by the pinned official OpenAPI GET list. Pass a substituted path such as /v1/me and query parameters separately. Absolute URLs, unknown paths, write methods, traversal, redirects, custom headers, and request bodies are rejected.',
    parameters: {
      path: { type: 'string', required: true, description: 'Substituted Figma API path beginning with /v1 or /v2; no origin, query string, fragment, or template braces.' },
      query: {
        type: 'object',
        additionalProperties: true,
        description: 'Query parameters allowed by the matched OpenAPI GET operation. Values must be strings, numbers, or booleans.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      if (typeof args.path !== 'string') throw new Error('figma: path must be a string')
      const rawQuery = args.query ?? {}
      if (typeof rawQuery !== 'object' || rawQuery === null || Array.isArray(rawQuery)) {
        throw new Error('figma: query must be an object')
      }
      const query: Record<string, FigmaQueryValue> = {}
      for (const [key, value] of Object.entries(rawQuery)) {
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
          throw new Error(`figma: query parameter ${key} must be a string, number, or boolean`)
        }
        query[key] = value
      }
      const path = authorizeFigmaGet(args.path, query)
      const client = await makeFigmaClient()
      log(`figma_api_get(path=${path})`)
      const value = await client.get(path)
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`figma: expected an object response for ${path}`)
      }
      return value as Record<string, JsonValue>
    },
  }))

  ctx.tools.register(defineTool({
    name: 'figma_list_projects',
    description: 'List projects visible to the authenticated user in one Figma team. This wraps the deprecated GET /v1/teams/:team_id/projects endpoint; newer deployments should prefer the /v2 folders endpoints through figma_api_get.',
    parameters: {
      teamId: { type: 'string', required: true, description: 'Figma team id from the team URL.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const client = await makeFigmaClient()
      log(`figma_list_projects(teamId=${args.teamId})`)
      return await client.listProjects(args.teamId) as Record<string, JsonValue>
    },
  }))

  ctx.tools.register(defineTool({
    name: 'figma_get_components',
    description: 'Read the published components, component sets, and styles from one main Figma file.',
    parameters: {
      fileKey: { type: 'string', description: 'Main Figma file key; defaults to the configured figmaFileKey.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const fileKey = resolveFileKey(args.fileKey)
      const client = await makeFigmaClient()
      log(`figma_get_components(fileKey=${fileKey})`)
      const [components, componentSets, styles] = await Promise.all([
        client.getFileComponents(fileKey),
        client.getFileComponentSets(fileKey),
        client.getFileStyles(fileKey),
      ])
      return { fileKey, components, componentSets, styles } as Record<string, JsonValue>
    },
  }))

  ctx.tools.register(defineTool({
    name: 'figma_get_variables',
    description: 'Read local or published variables from a Figma file. Figma restricts this API to Enterprise full members and requires file_variables:read.',
    parameters: {
      fileKey: { type: 'string', description: 'Figma file key; defaults to the configured figmaFileKey.' },
      kind: { type: 'string', enum: ['local', 'published'] as const, description: 'Variable collection to read; defaults to local.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const fileKey = resolveFileKey(args.fileKey)
      const kind = args.kind ?? 'local'
      const client = await makeFigmaClient()
      log(`figma_get_variables(fileKey=${fileKey}, kind=${kind})`)
      return await client.getVariables(fileKey, kind) as Record<string, JsonValue>
    },
  }))

  ctx.tools.register(defineTool({
    name: 'figma_get_node',
    description: 'Read a Figma design file through the REST API. Fetches the whole file document (or one node subtree) and returns a condensed, model-readable tree: node id, name, type, and TEXT characters. Use the returned ids to render nodes with figma_render.',
    parameters: {
      fileKey: {
        type: 'string',
        description: 'Figma file key (the .../file/<key>/... segment of the file URL); defaults to the configured figmaFileKey.',
      },
      nodeId: {
        type: 'string',
        description: 'Optional node id like "1:2". Omit to read the whole file document.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fileKey: { type: 'string', required: true },
          name: { type: 'string' },
          lastModified: { type: 'string' },
          nodeId: { type: 'string' },
          nodeCount: { type: 'number', required: true },
          truncated: { type: 'boolean', required: true },
          document: { type: 'object', additionalProperties: true, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const fileKey = resolveFileKey(args.fileKey)
      // Normalize once so the request id, the response lookup, and the returned
      // id all agree (the client also normalizes, defensively).
      const nodeId = args.nodeId !== undefined ? normalizeNodeId(args.nodeId) : undefined
      const client = await makeFigmaClient()
      log(`figma_get_node(fileKey=${fileKey}, nodeId=${nodeId ?? 'all'})`)
      let raw: unknown
      let name: string | undefined
      let lastModified: string | undefined
      if (nodeId !== undefined) {
        const response = await client.getNode(fileKey, nodeId)
        const nodes: Record<string, unknown> = typeof response === 'object' && response !== null && typeof (response as Record<string, unknown>).nodes === 'object'
          ? (response as Record<string, unknown>).nodes as Record<string, unknown>
          : {}
        const entry = typeof nodes[nodeId] === 'object' && nodes[nodeId] !== null
          ? nodes[nodeId] as Record<string, unknown>
          : undefined
        if (entry === undefined) {
          throw new Error(`figma: node ${nodeId} not found in file ${fileKey}`)
        }
        raw = entry.document
      } else {
        const response = await client.getFile(fileKey)
        if (typeof response !== 'object' || response === null) {
          throw new Error(`figma: unexpected file response for ${fileKey}`)
        }
        const record = response as Record<string, unknown>
        if (typeof record.name === 'string') name = record.name
        if (typeof record.lastModified === 'string') lastModified = record.lastModified
        raw = record.document
      }
      const projected = projectTree(raw, config.figmaMaxNodes)
      return {
        fileKey,
        ...(name !== undefined ? { name } : {}),
        ...(lastModified !== undefined ? { lastModified } : {}),
        ...(nodeId !== undefined ? { nodeId } : {}),
        nodeCount: projected.nodeCount,
        truncated: projected.truncated,
        // The registry projects the open `document` schema as Record<string, JsonValue>.
        document: projected.root as unknown as Record<string, JsonValue>,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'figma_get_comments',
    description: 'Read the comments of a Figma design file through the REST API: commenter, timestamp, message, reply/resolved flags, and the design node each comment anchors to. Comment image attachments are not exposed by the Figma API; use figma_render on the anchored nodeId to view the relevant design context.',
    parameters: {
      fileKey: {
        type: 'string',
        description: 'Figma file key; defaults to the configured figmaFileKey.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fileKey: { type: 'string', required: true },
          comments: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                user: { type: 'string', required: true },
                createdAt: { type: 'string', required: true },
                message: { type: 'string', required: true },
                parentId: { type: 'string' },
                resolvedAt: { type: 'string' },
                nodeId: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.comments.map(comment => {
          const flags = [
            comment.parentId !== undefined ? `reply-to ${comment.parentId}` : '',
            comment.resolvedAt !== undefined ? 'resolved' : 'open',
            comment.nodeId !== undefined ? `node ${comment.nodeId}` : '',
          ].filter(Boolean).join(', ')
          return `${comment.id} [${comment.user}, ${comment.createdAt}] (${flags}) ${comment.message}`
        }).join('\n'),
      }],
    },
    async execute(args) {
      const fileKey = resolveFileKey(args.fileKey)
      const client = await makeFigmaClient()
      log(`figma_get_comments(fileKey=${fileKey})`)
      const raw = await client.getComments(fileKey)
      const comments = projectComments(raw)
      return { fileKey, comments }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'figma_render',
    description: `Render a Figma node to an image through the REST API (format ${JSON.stringify(['png', 'jpg', 'svg'])}). Returns the signed image URL and downloads a local copy into the configured figmaOutputDir (default: os.tmpdir()/mj-figma); combine with the harness read_image tool to view it. SVG works only for vector nodes.`,
    parameters: {
      fileKey: {
        type: 'string',
        description: 'Figma file key; defaults to the configured figmaFileKey.',
      },
      nodeId: { type: 'string', required: true, description: 'Node id to render, e.g. "1:2".' },
      format: { type: 'string', enum: ['png', 'jpg', 'svg'], description: 'Image format (default png).' },
      scale: { type: 'number', description: 'Raster scale multiplier 1-4 (default 1); ignored for svg.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          localPath: { type: 'string', required: true },
          format: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Rendered ${value.format} image:\n${value.localPath}\n${value.url}` }],
    },
    async execute(args) {
      const fileKey = resolveFileKey(args.fileKey)
      const format = args.format ?? 'png'
      const nodeId = normalizeNodeId(args.nodeId)
      const client = await makeFigmaClient()
      log(`figma_render(fileKey=${fileKey}, nodeId=${nodeId}, format=${format})`)
      const response = await client.render(fileKey, nodeId, format, args.scale)
      const images: Record<string, unknown> = typeof response === 'object' && response !== null && typeof (response as Record<string, unknown>).images === 'object'
        ? (response as Record<string, unknown>).images as Record<string, unknown>
        : {}
      const candidate = images[nodeId]
      const url = typeof candidate === 'string' ? candidate : undefined
      if (url === undefined) {
        throw new Error(`figma: no image returned for node ${nodeId} in file ${fileKey} (svg requires a vector node)`)
      }
      const localPath = await saveRenderedImage(client, fileKey, nodeId, format, url)
      return { url, localPath, format }
    },
  }))
}
