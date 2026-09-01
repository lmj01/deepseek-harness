/**
 * End-to-end boot check for the mj-figma plugin.
 *
 * Boots a throwaway Cordis tree that mounts the real `mj-figma/cordis.yml`
 * patch (so the file format is exercised) plus a `tools` provider, then asserts
 * the plugin activates and its tools behave as configured:
 *
 * - `figma_get_node` / `figma_render` read and render a Figma file through a
 *   STUBBED transport (`globalThis.fetch`): the REST client and tools are
 *   exercised end to end without network or a real token.
 *
 * Run from the harness repo root (needs the tsx source-launch resolution):
 *
 *   node --import tsx/esm meijie-plugin/mj-figma/scripts/verify-boot.ts
 *
 * @module verify-boot
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
// Loads the `tools` service declaration onto `ctx` (see dsh-tools' Context merge).
import type {} from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const patchPath = join(pluginDir, 'cordis.yml')

const fail = (message: string): never => {
  console.error(`verify-boot FAILED: ${message}`)
  process.exit(1)
}

const tempDir = await mkdtemp(join(tmpdir(), 'mj-figma-verify-'))
let ctx: Awaited<ReturnType<typeof boot>> | undefined
try {
  // Parse the real patch file (validates the `- insert:` overlay format), then
  // normalize the row's absolute path so the script works from any checkout.
  const patches = loadOverlayPatches('dsh-verify', patchPath)
  for (const patch of patches) {
    const row = patch.insert?.[0]
    if (row !== undefined && typeof row.name === 'string' && row.name.endsWith('index.ts')) {
      row.name = join(pluginDir, 'src/index.ts')
    }
  }
  const rowId = patches.find(patch => patch.insert?.[0]?.id === 'mj-figma')
  if (rowId === undefined) fail('cordis.yml does not insert the mj-figma row')

  const rootConfig = join(tempDir, 'cordis.yml')
  await writeFile(rootConfig, '[]\n', 'utf8')

  const toolsPatch: PatchOptions = {
    insert: [
      { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt', config: { persona: '' } },
      { id: 'tools', name: '@deepseek-ai/dsh-tools' },
    ],
  }
  ctx = await boot('dsh-verify', rootConfig, [toolsPatch, ...patches])

  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'mj-figma')
  if (entry === undefined || entry.fiber === undefined) {
    fail('mj-figma entry did not activate')
  }

  const tools = ctx.tools
  const schemas = tools.schemas()
  for (const expected of ['figma_get_node', 'figma_get_comments', 'figma_render']) {
    if (!schemas.some(schema => schema.name === expected)) fail(`${expected} tool not registered`)
  }

  const signal = new AbortController().signal
  let callId = 0
  const run = (name: string, args: unknown) => tools.execute({
    callId: ToolCallId(`verify:${++callId}`),
    name,
    arguments: args,
    signal,
  })

  // ── Figma tools against a stubbed transport ────────────────────────────────
  const previousFetch = globalThis.fetch
  const previousToken = process.env.FIGMA_TOKEN
  process.env.FIGMA_TOKEN = 'figd_test-token'
  const renderedPath: string[] = []
  try {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.startsWith('https://api.figma.com/')) {
        // Real Figma PATs authenticate via X-Figma-Token, not Authorization.
        const headers = init?.headers as Record<string, string> | undefined
        if (headers?.['X-Figma-Token'] !== 'figd_test-token') {
          fail(`figma API call missing X-Figma-Token header: ${url}`)
        }
      }
      if (url.includes('/nodes?ids=')) {
        // The dash→colon id normalization must reach the wire as 2%3A2.
        if (!url.includes('ids=2%3A2')) fail(`node id not normalized on the wire: ${url}`)
        return new Response(JSON.stringify({
          nodes: { '2:2': { document: {
            id: '2:2', name: 'Button', type: 'FRAME',
            children: [{ id: '3:3', name: 'Label', type: 'TEXT', characters: 'Click me' }],
          } } },
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/images/')) {
        return new Response(JSON.stringify({ images: { '2:2': 'https://img.example/render.png' } }),
          { headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/files/abc/comments')) {
        return new Response(JSON.stringify({
          comments: [
            {
              id: '101', user: { handle: 'Alice' }, created_at: '2026-01-02T03:04:05.000Z',
              resolved_at: null, message: 'check this button', parent_id: '', order_id: '1',
              client_meta: { node_id: '2:2' }, reactions: [],
            },
            {
              id: '102', user: { handle: 'Bob' }, created_at: '2026-01-03T00:00:00.000Z',
              resolved_at: '2026-01-04T00:00:00.000Z', message: 'fixed', parent_id: '101', order_id: '2',
              client_meta: {}, reactions: [],
            },
          ],
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url === 'https://api.figma.com/v1/files/abc') {
        return new Response(JSON.stringify({
          name: 'Demo design',
          lastModified: '2026-01-01T00:00:00.000Z',
          document: {
            id: '0:0', name: 'Document', type: 'DOCUMENT',
            children: [{
              id: '1:1', name: 'Page 1', type: 'CANVAS',
              children: [{
                id: '2:2', name: 'Button', type: 'FRAME',
                children: [{ id: '3:3', name: 'Label', type: 'TEXT', characters: 'Click me' }],
              }],
            }],
          },
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url === 'https://img.example/render.png') {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          { headers: { 'content-type': 'image/png' } })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    const file = await run('figma_get_node', { fileKey: 'abc' })
    if (file.isError) fail(`figma_get_node whole-file failed: ${JSON.stringify(file.content)}`)
    // The canonical value is registry JSON; narrow it for the assertions below.
    const fileValue = file.value as { nodeCount: number; truncated: boolean; name?: string; document: unknown }
    if (fileValue.nodeCount !== 4 || fileValue.truncated !== false || fileValue.name !== 'Demo design') {
      fail(`figma_get_node whole-file projection wrong: ${JSON.stringify(fileValue)}`)
    }
    if (!JSON.stringify(fileValue.document).includes('Click me')) {
      fail('figma_get_node projection lost TEXT characters')
    }

    // Pass the id with a hyphen ("2-2") to exercise dash→colon normalization.
    const node = await run('figma_get_node', { fileKey: 'abc', nodeId: '2-2' })
    const nodeValue = node.value as { nodeId?: string; document?: { name?: string } }
    if (node.isError || nodeValue.nodeId !== '2:2' || nodeValue.document?.name !== 'Button') {
      fail(`figma_get_node node subtree wrong: ${JSON.stringify(node)}`)
    }

    const comments = await run('figma_get_comments', { fileKey: 'abc' })
    const commentsValue = comments.value as {
      fileKey: string
      comments: Array<{
        id: string; user: string; message: string
        parentId?: string; resolvedAt?: string; nodeId?: string
      }>
    }
    if (comments.isError || commentsValue.fileKey !== 'abc' || commentsValue.comments.length !== 2) {
      fail(`figma_get_comments wrong: ${JSON.stringify(comments)}`)
    }
    const first = commentsValue.comments[0]
    const second = commentsValue.comments[1]
    if (first?.user !== 'Alice' || first?.message !== 'check this button' || first?.nodeId !== '2:2' || first?.parentId !== undefined) {
      fail(`figma_get_comments first entry wrong: ${JSON.stringify(first)}`)
    }
    if (second?.parentId !== '101' || second?.resolvedAt !== '2026-01-04T00:00:00.000Z' || second?.nodeId !== undefined) {
      fail(`figma_get_comments second entry wrong: ${JSON.stringify(second)}`)
    }

    const render = await run('figma_render', { fileKey: 'abc', nodeId: '2-2' })
    const renderValue = render.value as { url: string; localPath: string; format: string }
    if (render.isError) fail(`figma_render failed: ${JSON.stringify(render.content)}`)
    if (renderValue.url !== 'https://img.example/render.png' || renderValue.format !== 'png') {
      fail(`figma_render result wrong: ${JSON.stringify(renderValue)}`)
    }
    const bytes = await readFile(renderValue.localPath)
    if (bytes.length !== 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
      fail(`figma_render local copy is not the stubbed PNG: ${bytes.length} bytes`)
    }
    renderedPath.push(renderValue.localPath)
  } finally {
    globalThis.fetch = previousFetch
    if (previousToken === undefined) delete process.env.FIGMA_TOKEN
    else process.env.FIGMA_TOKEN = previousToken
    for (const path of renderedPath) await rm(path, { force: true })
  }

  console.log('verify-boot PASSED: mj-figma activated, tools figma_get_node/figma_get_comments/figma_render behave as configured')
} finally {
  await ctx?.fiber.dispose()
  await rm(tempDir, { recursive: true, force: true })
}
