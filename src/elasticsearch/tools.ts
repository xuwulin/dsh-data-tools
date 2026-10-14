/**
 * The es_* tool family: connection listing, index discovery, mapping
 * (schema) inspection, bounded searches, and a compact cluster-info summary.
 * Read-only by construction — the tools call only the _cat, _mapping, _search,
 * _count and info APIs; there is no generic "run any request" tool, so no
 * write path exists. Pair with a read-only Elasticsearch role for defense in
 * depth.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Client } from '@elastic/elasticsearch'
import type { estypes } from '@elastic/elasticsearch'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ResolvedElasticsearchConnection } from '../types.js'
import { formatRows, resolvePassword } from '../util.js'

/** Everything the es_* tools need to find connections. */
export interface ElasticsearchToolkit {
  connections: ReadonlyMap<string, ResolvedElasticsearchConnection>
  /**
   * Re-read the plugin's volatile config and re-resolve the connections when a
   * save changed it. Cheap when nothing changed (reference comparison), so every
   * tool entry point calls it before reading `connections`.
   */
  refresh: () => void
}

/** Cap one search/mapping call; the tool argument is clamped to the connection cap. */
function boundLimit(requested: number | undefined, conn: ResolvedElasticsearchConnection): number {
  return Math.min(Math.max(requested ?? conn.maxRows, 1), conn.maxRows)
}

/** Truncate a long JSON document for display, noting the real length. */
function truncateJson(value: unknown, maxLen = 800): string {
  const text = JSON.stringify(value ?? null)
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}… (${text.length} chars)`
}

/** Flatten a mapping `properties` tree into `path -> type` rows, bounded by `cap`. */
function flattenProperties(
  properties: Record<string, unknown>,
  prefix: string,
  out: Array<{ field: string; type: string }>,
  cap: number,
): void {
  for (const [name, prop] of Object.entries(properties)) {
    if (out.length >= cap) return
    const path = prefix.length === 0 ? name : `${prefix}.${name}`
    const value = prop as { type?: unknown; properties?: unknown }
    const type = typeof value.type === 'string'
      ? value.type
      : (value.properties !== undefined && typeof value.properties === 'object' ? 'object' : '?')
    out.push({ field: path, type })
    if (value.properties !== undefined && typeof value.properties === 'object') {
      flattenProperties(value.properties as Record<string, unknown>, path, out, cap)
    }
  }
}

/** Run one callback over a fresh client, then always close it. */
async function withEs(
  ctx: Context,
  conn: ResolvedElasticsearchConnection,
  fn: (client: Client) => Promise<string>,
): Promise<string> {
  const password = await resolvePassword(ctx, conn)
  // Accept a full URL in `host` (scheme included); otherwise build one from
  // host/port/ssl. A scheme in `host` is what the configuration page naturally
  // produces, so both forms must work.
  const scheme = conn.ssl ? 'https' : 'http'
  const node = conn.host.includes('://') ? conn.host : `${scheme}://${conn.host}:${conn.port}`
  const client = new Client({
    node,
    requestTimeout: conn.timeoutMs,
    // Basic auth only when both parts are known; no user means no auth header.
    ...(conn.user !== undefined && password !== undefined
      ? { auth: { username: conn.user, password } }
      : {}),
    // Accept self-signed certificates; the read-only API set remains the
    // boundary. Encryption is the point of `ssl`.
    ...(conn.ssl ? { tls: { rejectUnauthorized: false } } : {}),
  })
  try {
    return await fn(client)
  } finally {
    await client.close()
  }
}

/** Register the five es_* tools. */
export function registerElasticsearchTools(ctx: Context, toolkit: ElasticsearchToolkit): void {
  const requireConnection = (name: string): ResolvedElasticsearchConnection => {
    toolkit.refresh()
    const connection = toolkit.connections.get(name)
    if (connection === undefined) {
      const known = [...toolkit.connections.keys()].join(', ') || '(none configured)'
      throw new Error(`unknown connection "${name}"; configured connections: ${known}`)
    }
    return connection
  }

  ctx.tools.register(defineTool({
    name: 'es_connections',
    description:
      'List configured Elasticsearch connections: name, base URL, user. Use a returned '
      + 'name as the `connection` argument of the other es_* tools.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      toolkit.refresh()
      if (toolkit.connections.size === 0) {
        return 'No Elasticsearch connections configured. Add a `kind: "elasticsearch"` connection to the plugin config.'
      }
      return [...toolkit.connections.values()]
        .map((c) => {
          const node = c.host.includes('://') ? c.host : `${c.ssl ? 'https' : 'http'}://${c.host}:${c.port}`
          return `${c.name}: elasticsearch ${node}${c.user ? ` (user ${c.user})` : ''}`
        })
        .join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'es_indices',
    description:
      'List indices on an Elasticsearch connection (name, health, document count, store size), bounded by `limit`. '
      + 'System indices (dot-prefixed) are omitted unless `pattern` matches them.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection name from es_connections.' },
      pattern: { type: 'string', description: 'Optional substring to filter index names (e.g. "logs").' },
      limit: { type: 'number', description: 'Maximum indices to return (capped by the connection cap).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const conn = requireConnection(args.connection)
      const limit = boundLimit(args.limit, conn)
      return withEs(ctx, conn, async (client) => {
        const res = await client.cat.indices({ format: 'json', h: ['index', 'health', 'docs.count', 'store.size'] })
        const rows = res
          .filter((row) => {
            const name = row.index ?? ''
            if (args.pattern !== undefined) return name.includes(args.pattern)
            return !name.startsWith('.')
          })
          .slice(0, limit)
          .map((row) => ({
            index: row.index ?? '',
            health: row.health ?? '',
            'docs.count': row['docs.count'] ?? '',
            'store.size': row['store.size'] ?? '',
          }))
        const cols = ['index', 'health', 'docs.count', 'store.size']
        return `indices (${rows.length} of up to ${limit}):\n` + formatRows(cols, rows)
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'es_mapping',
    description:
      'Describe the mapping (schema) of one Elasticsearch index: every field path with its type, bounded by `limit`. '
      + 'Use this before writing queries so they match the real field names and types.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection name from es_connections.' },
      index: { type: 'string', required: true, description: 'Index name (or pattern).' },
      limit: { type: 'number', description: 'Maximum fields to return (capped by the connection cap).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const conn = requireConnection(args.connection)
      const limit = boundLimit(args.limit, conn)
      return withEs(ctx, conn, async (client) => {
        const res = await client.indices.getMapping({ index: args.index })
        const lines: string[] = []
        for (const [indexName, record] of Object.entries(res)) {
          const properties = (record.mappings as { properties?: Record<string, unknown> } | undefined)?.properties
          const fields: Array<{ field: string; type: string }> = []
          if (properties !== undefined) flattenProperties(properties, '', fields, limit)
          lines.push(`index: ${indexName} — mapping fields (${fields.length} of up to ${limit}):`)
          if (fields.length > 0) lines.push(formatRows(['field', 'type'], fields))
        }
        return lines.join('\n')
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'es_search',
    description:
      'Search one Elasticsearch index with a JSON query body (the search API body: query/sort/_source/aggs, ...). '
      + 'Bounded by `size`. Omitting `query` returns `{"query":{"match_all":{}}}` (sample documents).',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection name from es_connections.' },
      index: { type: 'string', required: true, description: 'Index name (or pattern) to search.' },
      query: { type: 'string', description: 'The search body as JSON, e.g. {"query":{"match":{"title":"x"}}}. Omit for sample documents.' },
      size: { type: 'number', description: 'Maximum hits to return (capped by the connection cap).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const conn = requireConnection(args.connection)
      const size = boundLimit(args.size, conn)
      let body: Record<string, unknown>
      if (args.query === undefined || args.query.trim() === '') {
        body = { query: { match_all: {} } }
      } else {
        try {
          const parsed: unknown = JSON.parse(args.query)
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
          body = parsed as Record<string, unknown>
        } catch {
          throw new Error('query must be a valid JSON object — the Elasticsearch search body, e.g. {"query":{"match":{"title":"x"}}}')
        }
      }
      return withEs(ctx, conn, async (client) => {
        const res = await client.search({ ...body, index: args.index, size } as estypes.SearchRequest)
        const took = typeof res.took === 'number' ? res.took : Number(res.took ?? 0)
        const hits = res.hits?.hits ?? []
        const total = typeof res.hits?.total === 'object' && res.hits.total !== null
          ? res.hits.total.value
          : hits.length
        const blocks = hits.map((hit, i) => {
          const score = hit._score === null || hit._score === undefined ? '' : ` score=${hit._score}`
          return `#${i + 1} _id=${String(hit._id ?? '')}${score}\n  ${truncateJson(hit._source)}`
        })
        return `took ${took} ms; total hits ${total} (showing ${hits.length} of up to ${size}):\n`
          + (blocks.length > 0 ? blocks.join('\n') : '(no hits)')
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'es_info',
    description:
      'Compact cluster info for an Elasticsearch connection: cluster name, version, and tagline.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection name from es_connections.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const conn = requireConnection(args.connection)
      return withEs(ctx, conn, async (client) => {
        const info = await client.info()
        return `cluster: ${info.cluster_name}\n`
          + `version: ${info.version?.number ?? 'unknown'}\n`
          + `tagline: ${info.tagline ?? ''}`
      })
    },
  }))
}
