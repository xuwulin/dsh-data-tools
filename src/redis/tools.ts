/**
 * The redis_* tool family: connection listing, bounded key discovery, bounded
 * value reads dispatched by key type, and a compact server-info summary.
 * Read-only by construction — the tools issue only read commands (SCAN, GET,
 * LRANGE, HSCAN, SSCAN, ZSCAN, TYPE, INFO, DBSIZE); there is no generic
 * command tool, so no write path exists. Pair with a Redis 6+ ACL read-only
 * user for defense in depth.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createClient, type RedisClientType } from 'redis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ResolvedRedisConnection } from '../types.js'
import { formatRows, resolvePassword } from '../util.js'

/** Everything the redis_* tools need to find connections. */
export interface RedisToolkit {
  connections: ReadonlyMap<string, ResolvedRedisConnection>
}

/** Cap one scan/read call; the tool argument is clamped to the connection cap. */
function boundLimit(requested: number | undefined, conn: ResolvedRedisConnection): number {
  return Math.min(Math.max(requested ?? conn.maxRows, 1), conn.maxRows)
}

/** Truncate a long scalar value for display, noting the real length. */
function displayText(value: string, maxLen = 1000): string {
  if (value.length <= maxLen) return value
  return `${value.slice(0, maxLen)}\n… (${value.length} chars total)`
}

/** Run one callback over a fresh per-query connection, then always close it. */
async function withRedis(
  ctx: Context,
  conn: ResolvedRedisConnection,
  // The client is pinned to RESP2 (see the createClient options below), so the
  // callback receives the RESP2-typed client — not the default RESP3 shape.
  fn: (client: RedisClientType<{}, {}, {}, 2>) => Promise<string>,
): Promise<string> {
  const password = await resolvePassword(ctx, conn)
  const client = createClient({
    // RESP3 (the default) opens with a HELLO handshake that Redis < 6.0 does
    // not understand, refusing the connection. RESP2 works with every Redis
    // version and every command this family issues, so pin it for
    // compatibility with older servers.
    RESP: 2,
    socket: {
      host: conn.host,
      port: conn.port,
      // Connection and command-level timeouts: node-redis rejects/aborts on
      // both, so a hung server cannot stall a tool call forever.
      connectTimeout: conn.timeoutMs,
      socketTimeout: conn.timeoutMs,
      // Accept self-signed certificates; the read-only command set remains
      // the boundary. Encryption is the point of `ssl`.
      ...(conn.ssl ? { tls: true, rejectUnauthorized: false } : {}),
    },
    database: conn.database,
    ...(conn.user === undefined ? {} : { username: conn.user }),
    ...(password === undefined ? {} : { password }),
  })
  try {
    await client.connect()
    return await fn(client)
  } finally {
    await client.quit().catch(() => undefined)
  }
}

/** Register the four redis_* tools. */
export function registerRedisTools(ctx: Context, toolkit: RedisToolkit): void {
  const requireConnection = (name: string): ResolvedRedisConnection => {
    const connection = toolkit.connections.get(name)
    if (connection === undefined) {
      const known = [...toolkit.connections.keys()].join(', ') || '(none configured)'
      throw new Error(`unknown connection "${name}"; configured connections: ${known}`)
    }
    return connection
  }

  ctx.tools.register(defineTool({
    name: 'redis_connections',
    description:
      'List configured Redis connections: name, database index, host, port, user. Use a returned '
      + 'name as the `connection` argument of the other redis_* tools.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      if (toolkit.connections.size === 0) {
        return 'No Redis connections configured. Add a `kind: "redis"` connection to the plugin config.'
      }
      return [...toolkit.connections.values()]
        .map((c) => `${c.name}: redis db${c.database} @ ${c.host}:${c.port}${c.user ? ` (user ${c.user})` : ''}`)
        .join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redis_keys',
    description:
      'List keys in a Redis connection with an optional glob `pattern` (e.g. "user:*"), bounded by `limit` '
      + '(defaults to the connection cap). Uses SCAN, never the blocking KEYS.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection name from redis_connections.' },
      pattern: { type: 'string', description: 'Optional glob pattern to filter keys (e.g. "user:*").' },
      limit: { type: 'number', description: 'Maximum keys to return (capped by the connection cap).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const conn = requireConnection(args.connection)
      const limit = boundLimit(args.limit, conn)
      return withRedis(ctx, conn, async (client) => {
        const keys: string[] = []
        const options = args.pattern === undefined ? { COUNT: 200 } : { MATCH: args.pattern, COUNT: 200 }
        // node-redis v6 yields SCAN results in batches per cursor step.
        outer: for await (const batch of client.scanIterator(options)) {
          for (const key of batch) {
            keys.push(key)
            if (keys.length >= limit) break outer
          }
        }
        const dbSize = await client.dbSize().catch(() => 0)
        const note = keys.length >= limit ? ` (first ${limit} shown — use a narrower pattern)` : ''
        return `db${conn.database} holds ~${dbSize} keys; ${keys.length} shown${note}:\n`
          + (keys.length > 0 ? keys.join('\n') : '(none)')
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redis_read',
    description:
      'Read one key from a Redis connection: dispatches by the key type (string/list/hash/set/zset) and '
      + 'returns a bounded view. Strings are truncated for display; collections are capped by `limit`.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection name from redis_connections.' },
      key: { type: 'string', required: true, description: 'The key to read.' },
      limit: { type: 'number', description: 'Maximum items to return for collections (capped by the connection cap).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const conn = requireConnection(args.connection)
      const limit = boundLimit(args.limit, conn)
      return withRedis(ctx, conn, async (client) => {
        const type = await client.type(args.key)
        if (type === 'none') return `key "${args.key}" does not exist in db${conn.database}`

        switch (type) {
          case 'string': {
            const value = await client.get(args.key)
            return `type: string\nvalue: ${displayText(value ?? '')}`
          }
          case 'list': {
            const items = await client.lRange(args.key, 0, limit - 1)
            return `type: list (${items.length} of up to ${limit} items)\n`
              + formatRows(['item'], items.map((item) => ({ item })))
          }
          case 'hash': {
            const fields: Array<{ field: string; value: string }> = []
            outer: for await (const batch of client.hScanIterator(args.key, { COUNT: 200 })) {
              for (const { field, value } of batch) {
                fields.push({ field, value })
                if (fields.length >= limit) break outer
              }
            }
            return `type: hash (${fields.length} of up to ${limit} fields)\n`
              + formatRows(['field', 'value'], fields)
          }
          case 'set': {
            const members: Array<{ member: string }> = []
            outer: for await (const batch of client.sScanIterator(args.key, { COUNT: 200 })) {
              for (const member of batch) {
                members.push({ member })
                if (members.length >= limit) break outer
              }
            }
            return `type: set (${members.length} of up to ${limit} members)\n`
              + formatRows(['member'], members)
          }
          case 'zset': {
            const members: Array<{ member: string; score: string }> = []
            outer: for await (const batch of client.zScanIterator(args.key, { COUNT: 200 })) {
              for (const { value, score } of batch) {
                members.push({ member: value, score: String(score) })
                if (members.length >= limit) break outer
              }
            }
            return `type: zset (${members.length} of up to ${limit} members)\n`
              + formatRows(['member', 'score'], members)
          }
          default:
            return `type: ${type} — this key type is not supported by redis_read yet`
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'redis_info',
    description:
      'Compact server info for a Redis connection: version, mode, clients, memory, command stats, and the '
      + 'key count per database the account can see.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection name from redis_connections.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const conn = requireConnection(args.connection)
      return withRedis(ctx, conn, async (client) => {
        const info = await client.info()
        const wanted = new Set([
          'redis_version', 'redis_mode', 'connected_clients', 'used_memory_human',
          'total_commands_processed', 'keyspace_hits', 'keyspace_misses', 'uptime_in_seconds',
        ])
        const lines: string[] = []
        for (const line of info.split('\n')) {
          const colon = line.indexOf(':')
          if (colon <= 0) continue
          const key = line.slice(0, colon)
          if (wanted.has(key) || /^db\d+$/.test(key)) lines.push(line)
        }
        const dbSize = await client.dbSize().catch(() => 0)
        return `db${conn.database} size: ${dbSize} keys\n` + lines.join('\n')
      })
    },
  }))
}
