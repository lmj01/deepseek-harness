/** Figma OpenAPI version used to derive the read-only endpoint allowlist. */
export const FIGMA_OPENAPI_VERSION = '0.42.0'

/** Reviewed Figma OpenAPI commit used to derive the read-only endpoint allowlist. */
export const FIGMA_OPENAPI_COMMIT = '04fbbc719706e986fc79f3050d3e068e118275d9'

/** Query values accepted by the generic Figma GET tool. */
export type FigmaQueryValue = string | number | boolean

interface GetOperation {
  template: string
  query?: ReadonlySet<string>
}

const operation = (template: string, query: readonly string[] = []): GetOperation => ({
  template,
  query: new Set(query),
})

/** GET operations from Figma OpenAPI 0.42.0. */
const GET_OPERATIONS: readonly GetOperation[] = [
  operation('/v1/files/{file_key}', ['version', 'ids', 'depth', 'geometry', 'plugin_data', 'branch_data']),
  operation('/v1/files/{file_key}/nodes', ['ids', 'version', 'depth', 'geometry', 'plugin_data']),
  operation('/v1/images/{file_key}', ['ids', 'scale', 'format', 'svg_include_id', 'svg_simplify_stroke', 'use_absolute_bounds', 'version']),
  operation('/v1/files/{file_key}/images'),
  operation('/v1/files/{file_key}/meta'),
  operation('/v1/teams/{team_id}/projects'),
  operation('/v1/projects/{project_id}/meta'),
  operation('/v1/projects/{project_id}/files', ['branch_data']),
  operation('/v2/teams/{team_id}/folders'),
  operation('/v2/folders/{folder_id}/folders'),
  operation('/v2/folders/{folder_id}/files', ['continuation_token', 'page_size']),
  operation('/v2/folders/{folder_id}/meta'),
  operation('/v1/files/{file_key}/versions', ['page_size', 'before', 'after']),
  operation('/v1/files/{file_key}/comments', ['as_md']),
  operation('/v1/files/{file_key}/comments/{comment_id}/reactions', ['cursor']),
  operation('/v1/me'),
  operation('/v1/teams/{team_id}/components', ['page_size', 'after', 'before']),
  operation('/v1/files/{file_key}/components'),
  operation('/v1/components/{key}'),
  operation('/v1/teams/{team_id}/component_sets', ['page_size', 'after', 'before']),
  operation('/v1/files/{file_key}/component_sets'),
  operation('/v1/component_sets/{key}'),
  operation('/v1/teams/{team_id}/styles', ['page_size', 'after', 'before']),
  operation('/v1/files/{file_key}/styles'),
  operation('/v1/styles/{key}'),
  operation('/v2/webhooks', ['team_id', 'app_id', 'plan_api_id']),
  operation('/v2/webhooks/{webhook_id}'),
  operation('/v2/teams/{team_id}/webhooks'),
  operation('/v2/webhooks/{webhook_id}/requests', ['start_time', 'end_time', 'limit', 'cursor']),
  operation('/v1/activity_logs', ['start_time', 'end_time', 'events', 'limit']),
  operation('/v1/ai_usage/daily', ['start_date', 'end_date', 'group_by', 'next_page']),
  operation('/v1/payments', ['start_date', 'end_date', 'status', 'cursor']),
  operation('/v1/files/{file_key}/variables/local'),
  operation('/v1/files/{file_key}/variables/published'),
  operation('/v1/files/{file_key}/dev_resources', ['node_ids']),
  operation('/v1/analytics/libraries/{file_key}/component/actions', ['group_by', 'start_date', 'end_date', 'cursor']),
  operation('/v1/analytics/libraries/{file_key}/component/usages', ['group_by', 'start_date', 'end_date', 'cursor']),
  operation('/v1/analytics/libraries/{file_key}/style/actions', ['group_by', 'start_date', 'end_date', 'cursor']),
  operation('/v1/analytics/libraries/{file_key}/style/usages', ['group_by', 'start_date', 'end_date', 'cursor']),
  operation('/v1/analytics/libraries/{file_key}/variable/actions', ['group_by', 'start_date', 'end_date', 'cursor']),
  operation('/v1/analytics/libraries/{file_key}/variable/usages', ['group_by', 'start_date', 'end_date', 'cursor']),
  operation('/v1/oembed', ['url']),
]

const decodeSegment = (segment: string): string => {
  if (/%2f|%5c|%25/i.test(segment)) throw new Error('figma: encoded separators and double encoding are not allowed')
  let decoded: string
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    throw new Error('figma: path contains malformed percent encoding')
  }
  if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
    throw new Error('figma: path traversal is not allowed')
  }
  return decoded
}

/**
 * Authorizes one substituted Figma path against the reviewed OpenAPI GET list.
 *
 * @param path Substituted API path without an origin or query string.
 * @param query Separate query parameters.
 * @returns A canonical relative path with encoded query parameters.
 */
export function authorizeFigmaGet(path: string, query: Record<string, FigmaQueryValue> = {}): string {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\?#\u0000-\u001f\u007f]/.test(path)) {
    throw new Error('figma: path must be an absolute API path without origin, query, fragment, or backslash')
  }
  const rawSegments = path.slice(1).split('/')
  if (rawSegments.length === 0 || rawSegments.some(segment => segment === '' || /[{}]/.test(segment))) {
    throw new Error('figma: path contains an empty or template segment')
  }
  const segments = rawSegments.map(decodeSegment)
  const matches = GET_OPERATIONS.filter(candidate => {
    const templateSegments = candidate.template.slice(1).split('/')
    return templateSegments.length === segments.length && templateSegments.every((segment, index) => (
      /^\{[^}]+\}$/.test(segment) || segment === segments[index]
    ))
  })
  if (matches.length !== 1) throw new Error(`figma: path is not an allowed OpenAPI GET operation: ${path}`)
  const allowedQuery = matches[0]!.query ?? new Set<string>()
  for (const key of Object.keys(query)) {
    if (!allowedQuery.has(key)) throw new Error(`figma: query parameter ${key} is not allowed for ${matches[0]!.template}`)
  }
  const canonicalPath = `/${segments.map(encodeURIComponent).join('/')}`
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) search.set(key, String(value))
  return search.size === 0 ? canonicalPath : `${canonicalPath}?${search}`
}
