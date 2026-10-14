/**
 * dsh-data-tools — read-only data-source tooling for the DeepSeek Harness.
 *
 * V1 scope: relational connection introspection, table listing, schema
 * discovery, and guarded SELECT queries against MySQL and PostgreSQL, plus
 * read-only tool families for Redis (key discovery and bounded value reads)
 * and Elasticsearch (index discovery, mappings, bounded searches). Write
 * statements and commands are refused at the tool boundary; pair this with
 * read-only accounts / roles for defense in depth.
 *
 * Layout: this file is the composition root — config schema plus wiring.
 * Shared types live in types.ts, backend-agnostic rendering and credential
 * helpers in util.ts. Each backend family is its own module: the shared db_*
 * tools live in sql/tools.ts and are driven by a SqlDialect (sql/mysql.ts,
 * sql/postgres.ts — add another engine the same way); key/value and document
 * stores get their own tool families under redis/ and elasticsearch/.
 *
 * Configuration: the three fields the browser page edits are declared
 * `.volatile()` on the Config schema, so the Loader hands `apply` one stable
 * reference per field (`config.connections.get()`). A save from the plugin's own
 * page persists into the active profile's Cordis patch and is committed into
 * those references in place — the plugin is not restarted — so every tool call
 * re-reads the references and a committed edit applies from the next call on.
 * Components that need no live edits (the tools' connection lookups) run the
 * same re-read behind `refresh()`.
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
// Type-only: pulls in the `settings` service augmentation on Context.
import type {} from '@deepseek-ai/dsh-settings'
import type {
  Config as PluginConfig, FlatConnection, ResolvedElasticsearchConnection, ResolvedRedisConnection, ResolvedSqlConnection,
} from './types.js'
export type { BaseConnection, ConnectionKind, FlatConnection } from './types.js'
import { registerSqlTools } from './sql/tools.js'
import { mysqlDialect } from './sql/mysql.js'
import { postgresDialect } from './sql/postgres.js'
import type { SqlDialect } from './sql/dialect.js'
import { registerRedisTools } from './redis/tools.js'
import { registerElasticsearchTools } from './elasticsearch/tools.js'

export const name = 'data-tools'
export const inject = ['tools', 'credentials']

/** Backend dialects available in this build; extend when a new engine lands. */
const DIALECTS: SqlDialect[] = [mysqlDialect, postgresDialect]

/** Every connection kind the Config schema accepts (sql dialects + key/value & document stores). */
const SUPPORTED_KINDS: readonly string[] = [
  ...DIALECTS.map((dialect) => dialect.kind),
  'redis',
  'elasticsearch',
]

/**
 * Profile entry id carrying this plugin's config. It is BOTH the Loader entry
 * that `cordis.patch.yml` inserts and the namespace the browser half addresses:
 * in the current harness, configuration forms are keyed by the entry id, so the
 * two must stay spelled the same.
 */
export const DATA_TOOLS_ENTRY_ID = 'data-tools'

/**
 * Connection object schema: ONE flat object for every kind (not a
 * discriminated union) because the settings host's secret redaction walks only
 * object/dict/array containers — a `role('secret')` field inside a union branch
 * is served back verbatim, leaking the secret to the configuration page.
 * Per-kind validation and defaults live in resolveConnections.
 */
const connectionSchema = Schema.object({
  name: Schema.string().required()
    .description('Unique name referenced by the `connection` argument of every db_* / redis_* / es_* tool.'),
  kind: Schema.union([
    Schema.const('mysql'), Schema.const('postgres'), Schema.const('redis'), Schema.const('elasticsearch'),
  ]).default('mysql')
    .description('Backend discriminator; unknown kinds are rejected at validation.'),
  host: Schema.string().required()
    .description('Database server host.'),
  port: Schema.number()
    .description('Server port; per-kind default when omitted (3306 mysql, 5432 postgres, 6379 redis, 9200 elasticsearch).'),
  database: Schema.union([Schema.string(), Schema.number()])
    .description('mysql/postgres: database name (string). redis: logical database index (number).'),
  user: Schema.string()
    .description('Account name: required for mysql/postgres, optional for redis (ACL) / elasticsearch (basic-auth).'),
  passwordRef: Schema.string()
    .description('Credential reference (env var name) resolved per operation through the dsh credentials seam; preferred over `password`.'),
  password: Schema.string().role('secret')
    .description('Plaintext password fallback for throwaway local setups; prefer `passwordRef`.'),
  charset: Schema.string()
    .description('Connection charset (mysql only; other kinds ignore it).'),
  ssl: Schema.boolean()
    .description('TLS for the connection (postgres / redis / elasticsearch; accepts self-signed certificates).'),
  schema: Schema.string()
    .description('Default schema (namespace) for the table tools (postgres; defaults to `public`).'),
  maxRows: Schema.number()
    .description('Per-connection result cap; falls back to `defaultMaxRows`.'),
  timeoutMs: Schema.number()
    .description('Per-connection statement/command/request timeout in ms; falls back to `defaultTimeoutMs`.'),
})

/**
 * Config schema. Every field the plugin's own page edits is `.volatile()`: the
 * Loader then resolves it to a stable reference (`config.connections.get()`)
 * instead of a plain value, and commits a saved edit into that reference in
 * place without restarting the plugin. `resolveConnections` is the only consumer
 * and reads the plain snapshots `readConfig` materializes.
 */
export const Config = Schema.object({
  connections: Schema.array(connectionSchema).required().volatile()
    .description('Named data-source connections the db_* / redis_* / es_* tools operate on (MySQL / PostgreSQL / Redis / Elasticsearch).'),
  defaultMaxRows: Schema.number().default(100).volatile()
    .description('Result cap applied when a connection sets none (rows for SQL, keys/items for Redis, hits/fields for Elasticsearch).'),
  defaultTimeoutMs: Schema.number().default(10_000).volatile()
    .description('Statement/command/request timeout in ms applied when a connection sets none.'),
})

/** The config the Loader hands to `apply`: `.volatile()` fields arrive as references. */
export type DataToolsConfig = ReturnType<typeof Config>

/**
 * Read the volatile references into the plain config `resolveConnections` takes.
 * The snapshots are frozen values with a stable identity until the next save, so
 * two reads of an unchanged config compare equal by reference.
 * @param config - loader-facing config of this plugin.
 * @returns one plain config snapshot.
 */
function readConfig(config: DataToolsConfig): PluginConfig {
  return {
    // The schema guarantees these three are `volatile()` fields, so the Loader
    // always resolves them to references; the schema's inferred type already
    // says so and these reads stay type-checked.
    connections: config.connections.get(),
    defaultMaxRows: config.defaultMaxRows.get(),
    defaultTimeoutMs: config.defaultTimeoutMs.get(),
  }
}

/** One resolved pass over the config: sql connections plus key/value & document stores. */
interface ResolvedConnectionSets {
  sql: Map<string, ResolvedSqlConnection>
  redis: Map<string, ResolvedRedisConnection>
  elasticsearch: Map<string, ResolvedElasticsearchConnection>
}

/**
 * Resolve every connection of one authoritative config into fresh maps,
 * validating names, kinds, and per-kind fields before anything is committed.
 * SQL kinds land in `sql` (served by the db_* tools through a SqlDialect);
 * redis and elasticsearch land in their own maps (served by the redis_* /
 * es_* tools). The Config schema is a flat superset, so per-kind defaults and
 * required fields are enforced here.
 */
function resolveConnections(source: PluginConfig, supportedKinds: readonly string[]): ResolvedConnectionSets {
  const sql = new Map<string, ResolvedSqlConnection>()
  const redis = new Map<string, ResolvedRedisConnection>()
  const elasticsearch = new Map<string, ResolvedElasticsearchConnection>()
  for (const connection of source.connections) {
    const kind = connection.kind ?? 'mysql'
    if (!supportedKinds.includes(kind)) {
      throw new Error(`unsupported connection kind "${kind}" for connection "${connection.name}" — supported kinds: ${supportedKinds.join(', ')}`)
    }
    if (kind === 'redis') {
      if (redis.has(connection.name)) {
        throw new Error(`duplicate connection name "${connection.name}"`)
      }
      if (connection.database != null && typeof connection.database !== 'number') {
        throw new Error(`connection "${connection.name}": redis \`database\` must be a number (the logical database index), got ${JSON.stringify(connection.database)}`)
      }
      redis.set(connection.name, {
        kind: 'redis',
        name: connection.name,
        host: connection.host,
        port: connection.port ?? 6379,
        database: connection.database ?? 0,
        user: connection.user,
        passwordRef: connection.passwordRef,
        password: connection.password,
        ssl: connection.ssl ?? false,
        maxRows: connection.maxRows ?? source.defaultMaxRows,
        timeoutMs: connection.timeoutMs ?? source.defaultTimeoutMs,
      })
      continue
    }
    if (kind === 'elasticsearch') {
      if (elasticsearch.has(connection.name)) {
        throw new Error(`duplicate connection name "${connection.name}"`)
      }
      elasticsearch.set(connection.name, {
        kind: 'elasticsearch',
        name: connection.name,
        host: connection.host,
        port: connection.port ?? 9200,
        user: connection.user,
        passwordRef: connection.passwordRef,
        password: connection.password,
        ssl: connection.ssl ?? false,
        maxRows: connection.maxRows ?? source.defaultMaxRows,
        timeoutMs: connection.timeoutMs ?? source.defaultTimeoutMs,
      })
      continue
    }
    if (sql.has(connection.name)) {
      throw new Error(`duplicate connection name "${connection.name}"`)
    }
    if (connection.user === undefined || connection.user.trim() === '') {
      throw new Error(`connection "${connection.name}": ${kind} requires a \`user\` (read-only account name)`)
    }
    if (connection.database != null && typeof connection.database !== 'string') {
      throw new Error(`connection "${connection.name}": ${kind} \`database\` must be a string (database name), got ${JSON.stringify(connection.database)}`)
    }
    // YAML `database:` left blank parses as null/'' — treat all empty forms as "no default database".
    const database = (connection.database as string | undefined)?.trim() || undefined
    const isPostgres = kind === 'postgres'
    sql.set(connection.name, {
      kind,
      name: connection.name,
      host: connection.host,
      port: connection.port ?? (isPostgres ? 5432 : 3306),
      database,
      user: connection.user,
      passwordRef: connection.passwordRef,
      password: connection.password,
      // MySQL keeps its charset; PostgreSQL reports UTF8 and ignores the field.
      charset: isPostgres ? 'UTF8' : (connection.charset ?? 'utf8mb4'),
      // Postgres-only fields; the MySQL dialect never reads them.
      ...(isPostgres && connection.ssl !== undefined ? { ssl: connection.ssl } : {}),
      ...(isPostgres ? { schema: connection.schema?.trim() || 'public' } : {}),
      maxRows: connection.maxRows ?? source.defaultMaxRows,
      timeoutMs: connection.timeoutMs ?? source.defaultTimeoutMs,
    })
  }
  return { sql, redis, elasticsearch }
}

export function apply(ctx: Context, config: DataToolsConfig) {
  const sqlConnections = new Map<string, ResolvedSqlConnection>()
  const redisConnections = new Map<string, ResolvedRedisConnection>()
  const esConnections = new Map<string, ResolvedElasticsearchConnection>()
  const dialects = new Map(DIALECTS.map((dialect) => [dialect.kind, dialect]))

  /**
   * The config the maps were last resolved from. A volatile reference keeps its
   * identity until a save replaces its value, so comparing the three references
   * is what makes `refresh` cheap enough to run before every tool call.
   */
  let resolvedFrom: PluginConfig | undefined

  /**
   * Re-resolve the connections when a save changed the config, swapping the
   * shared maps in place. Tools close over the map objects, so this one swap
   * makes a committed edit visible to every later execution.
   *
   * The Host already refused every edit the Config schema rejects; the checks
   * left here are ours alone (unsupported kind, duplicate name, a kind that
   * requires `user`). An edit that fails them keeps the previous connections —
   * one bad field must not take every tool down — and says so in the log.
   */
  const refresh = (): void => {
    const source = readConfig(config)
    if (resolvedFrom !== undefined
      && resolvedFrom.connections === source.connections
      && resolvedFrom.defaultMaxRows === source.defaultMaxRows
      && resolvedFrom.defaultTimeoutMs === source.defaultTimeoutMs) return
    // Record the source before resolving: a refused edit is retried on the next
    // save, not on every tool call.
    resolvedFrom = source
    let next: ResolvedConnectionSets
    try {
      next = resolveConnections(source, SUPPORTED_KINDS)
    } catch (error) {
      ctx.logger.warn('data-tools: the saved configuration failed the per-kind checks below; keeping the previous connections')
      ctx.logger.warn(error)
      return
    }
    sqlConnections.clear()
    for (const [name, connection] of next.sql) sqlConnections.set(name, connection)
    redisConnections.clear()
    for (const [name, connection] of next.redis) redisConnections.set(name, connection)
    esConnections.clear()
    for (const [name, connection] of next.elasticsearch) esConnections.set(name, connection)
  }

  refresh()
  registerSqlTools(ctx, { connections: sqlConnections, dialects, refresh })
  registerRedisTools(ctx, { connections: redisConnections, refresh })
  registerElasticsearchTools(ctx, { connections: esConnections, refresh })

  // The browser half ships this plugin's own configuration page, so a composed
  // settings service must not also generate one from the schema. The policy is
  // registered against THIS plugin's fiber — the identity `describe()`
  // attributes it by — and disposal releases it again. The child inject stays
  // optional: a host without dsh-settings simply never runs the callback, and
  // the tools keep reading the patch layer's values.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
      'data-tools: own configuration page policy',
    )
  })
}
