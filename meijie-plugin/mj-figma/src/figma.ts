/**
 * Minimal Figma REST API v1 client for the mj-figma plugin.
 *
 * Only the surfaces needed to READ design content are implemented:
 *
 * - `getFile` — the whole file document (`GET /v1/files/:key`).
 * - `getNode` — one node subtree (`GET /v1/files/:key/nodes?ids=`).
 * - `render` — render a node to an image URL (`GET /v1/images/:key`).
 * - `download` — fetch a signed image URL returned by `render`.
 *
 * The transport is injectable (`fetchImpl`) so tests stub the API without
 * network access. Every method returns the raw JSON (`unknown`); callers that
 * interpret it guard the wire boundary (see {@link projectTree}).
 *
 * @module mj-figma-figma
 */

/** Root of the Figma REST API v1. */
const FIGMA_API_BASE = 'https://api.figma.com'

/** One readable node of a projected Figma document tree. */
export interface FigmaNodeView {
  id: string
  name: string
  type: string
  /** TEXT nodes carry their rendered characters. */
  characters?: string
  children?: FigmaNodeView[]
}

/** The condensed document projection {@link projectTree} produces. */
export interface ProjectedTree {
  root: FigmaNodeView
  /** How many nodes were visited before the cap cut the walk short. */
  nodeCount: number
  /** Whether the cap stopped the walk before the whole tree was visited. */
  truncated: boolean
}

/** Options for {@link createFigmaClient}. */
export interface FigmaClientOptions {
  /** Personal access token (or OAuth access token) for api.figma.com. */
  token: string
  /** HTTP transport; defaults to the global `fetch`. Tests inject a stub. */
  fetchImpl?: typeof fetch
}

/** Thrown for non-2xx Figma API responses, with a human-readable status line. */
export class FigmaApiError extends Error {
  constructor(status: number, body: string) {
    super(`figma API ${status}: ${body.slice(0, 500)}`)
    this.name = 'FigmaApiError'
  }
}

/** The REST surface the plugin tools use. */
export interface FigmaClient {
  get(path: string): Promise<unknown>
  getFile(fileKey: string): Promise<unknown>
  getNode(fileKey: string, nodeId: string): Promise<unknown>
  getComments(fileKey: string): Promise<unknown>
  listProjects(teamId: string): Promise<unknown>
  getFileComponents(fileKey: string): Promise<unknown>
  getFileComponentSets(fileKey: string): Promise<unknown>
  getFileStyles(fileKey: string): Promise<unknown>
  getVariables(fileKey: string, kind: 'local' | 'published'): Promise<unknown>
  render(fileKey: string, nodeId: string, format: string, scale?: number): Promise<unknown>
  download(url: string): Promise<Uint8Array>
}

/**
 * Normalize a user-supplied node id to Figma's canonical form. Figma ids use
 * a colon separator (`306:2929`); text copied from chat or prose often turns
 * it into a hyphen (`306-2929`), which the API rejects with 404. Only the
 * unambiguous `<digits>-<digits>` shape is rewritten — instance ids
 * (`I306:8951;15:2756`) never contain a lone dash between digits.
 * @param nodeId - the id as supplied.
 * @returns the id in API-ready form.
 */
export function normalizeNodeId(nodeId: string): string {
  return /^\d+-\d+$/.test(nodeId) ? nodeId.replace('-', ':') : nodeId
}

/**
 * Build a Figma REST client over one transport.
 * @param options - token and optional transport.
 * @returns the client; every call resolves lazily, so a rotated token takes
 * effect on the next tool invocation that builds a fresh client.
 */
export function createFigmaClient(options: FigmaClientOptions): FigmaClient {
  const fetchImpl = options.fetchImpl ?? fetch
  // Personal access tokens (figd_...) authenticate via the X-Figma-Token
  // header; OAuth tokens use the Authorization Bearer header.
  const authHeaders: Record<string, string> = options.token.startsWith('figd_')
    ? { 'X-Figma-Token': options.token }
    : { Authorization: `Bearer ${options.token}` }
  const request = async (path: string): Promise<unknown> => {
    const response = await fetchImpl(`${FIGMA_API_BASE}${path}`, {
      headers: authHeaders,
      redirect: 'error',
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new FigmaApiError(response.status, body)
    }
    return response.json()
  }
  return {
    get: path => request(path),
    getFile: fileKey => request(`/v1/files/${encodeURIComponent(fileKey)}`),
    getNode: (fileKey, nodeId) => request(`/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(normalizeNodeId(nodeId))}`),
    getComments: fileKey => request(`/v1/files/${encodeURIComponent(fileKey)}/comments`),
    listProjects: teamId => request(`/v1/teams/${encodeURIComponent(teamId)}/projects`),
    getFileComponents: fileKey => request(`/v1/files/${encodeURIComponent(fileKey)}/components`),
    getFileComponentSets: fileKey => request(`/v1/files/${encodeURIComponent(fileKey)}/component_sets`),
    getFileStyles: fileKey => request(`/v1/files/${encodeURIComponent(fileKey)}/styles`),
    getVariables: (fileKey, kind) => request(`/v1/files/${encodeURIComponent(fileKey)}/variables/${kind}`),
    render: (fileKey, nodeId, format, scale) => request(
      `/v1/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(normalizeNodeId(nodeId))}&format=${encodeURIComponent(format)}`
      + (scale !== undefined ? `&scale=${scale}` : ''),
    ),
    async download(url) {
      const response = await fetchImpl(url)
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new FigmaApiError(response.status, body)
      }
      return new Uint8Array(await response.arrayBuffer())
    },
  }
}

/** Node types that may carry children in a Figma document. */
const CONTAINER_TYPES = new Set([
  'DOCUMENT', 'CANVAS', 'FRAME', 'GROUP', 'SECTION', 'COMPONENT', 'COMPONENT_SET',
  'INSTANCE', 'BOOLEAN_OPERATION', 'STICKY', 'SHAPE_WITH_TEXT',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Condense one raw Figma node into a model-readable view, keeping only
 * identity, name, type, TEXT characters, and the child tree. Geometry,
 * fills, and effect payloads are dropped: they are huge and `figma_render`
 * is the path to visual detail. The walk stops at `maxNodes` so a large
 * document cannot flood the model context; the caller reports `truncated`.
 * @param raw - one Figma document node (the wire boundary; malformed nodes
 * are skipped rather than thrown).
 * @param maxNodes - visit cap; once reached the walk returns `truncated`.
 * @returns the projected root and visit statistics.
 */
export function projectTree(raw: unknown, maxNodes = 2000): ProjectedTree {
  let nodeCount = 0
  let truncated = false
  const walk = (value: unknown): FigmaNodeView | undefined => {
    if (nodeCount >= maxNodes) {
      truncated = true
      return undefined
    }
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.type !== 'string') {
      return undefined
    }
    nodeCount += 1
    const view: FigmaNodeView = { id: value.id, name: String(value.name ?? ''), type: value.type }
    if (value.type === 'TEXT' && typeof value.characters === 'string') {
      view.characters = value.characters
    }
    if (CONTAINER_TYPES.has(value.type) && Array.isArray(value.children)) {
      const children = value.children.map(walk).filter((child): child is FigmaNodeView => child !== undefined)
      if (children.length > 0) view.children = children
    }
    return view
  }
  const root = walk(raw)
  if (root === undefined) {
    throw new Error('figma: response did not contain a readable node (expected { id, name, type })')
  }
  return { root, nodeCount, truncated }
}

/** One projected comment of a design file. */
export interface FigmaCommentView {
  id: string
  /** The commenter's display handle. */
  user: string
  createdAt: string
  message: string
  /** Set when the comment is a reply to another comment. */
  parentId?: string
  /** Set when the comment has been resolved. */
  resolvedAt?: string
  /** The design node the comment anchors to (`client_meta.node_id`), when any. */
  nodeId?: string
}

/**
 * Condense the raw `/files/:key/comments` payload into model-readable rows:
 * identity, commenter, timestamp, message, reply/resolved flags, and the
 * anchored node id. Comment image attachments are not exposed by the Figma
 * REST API, so none are projected.
 * @param raw - the comments response (the wire boundary; malformed entries
 * are skipped rather than thrown).
 * @returns the projected comments.
 */
export function projectComments(raw: unknown): FigmaCommentView[] {
  const list = Array.isArray(raw) ? raw
    : isRecord(raw) && Array.isArray(raw.comments) ? raw.comments
    : []
  return list.flatMap((entry): FigmaCommentView[] => {
    if (!isRecord(entry) || typeof entry.id !== 'string') return []
    const user = isRecord(entry.user) && typeof entry.user.handle === 'string' ? entry.user.handle : ''
    const clientMeta = isRecord(entry.client_meta) ? entry.client_meta : {}
    return [{
      id: entry.id,
      user,
      createdAt: typeof entry.created_at === 'string' ? entry.created_at : '',
      message: typeof entry.message === 'string' ? entry.message : '',
      ...(typeof entry.parent_id === 'string' && entry.parent_id !== '' ? { parentId: entry.parent_id } : {}),
      ...(typeof entry.resolved_at === 'string' ? { resolvedAt: entry.resolved_at } : {}),
      ...(typeof clientMeta.node_id === 'string' ? { nodeId: clientMeta.node_id } : {}),
    }]
  })
}
