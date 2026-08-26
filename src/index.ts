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
 * Configuration: the patch-layer entry config is the composition `base` of a
 * settings namespace (dsh-settings). User overrides land in the settings
 * document (settings.yaml) and apply live — the resolved-connection map is
 * rebuilt on every committed change, so the tools always see the authoritative
 * section. Without a settings service the entry config stays authoritative.
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
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

/** Settings namespace carrying this plugin's user-editable section. */
export const DATA_TOOLS_SETTINGS_NAMESPACE = settingsNamespace('data-tools')

/** Connection object schema for one backend kind (discriminated on `kind`). */
/**
 * Connection object schema: ONE flat object for every kind (not a
 * discriminated union) because the settings host's secret redaction walks
 * only object/dict/array containers — a `role('secret')` field inside a union
 * branch is served back verbatim, breaking save verification and leaking the
 * secret to the settings page. Per-kind validation and defaults live in
 * resolveConnections.
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

export const Config: Schema<PluginConfig> = Schema.object({
  connections: Schema.array(connectionSchema).required()
    .description('Named data-source connections the db_* / redis_* / es_* tools operate on (MySQL / PostgreSQL / Redis / Elasticsearch).'),
  defaultMaxRows: Schema.number().default(100)
    .description('Result cap applied when a connection sets none (rows for SQL, keys/items for Redis, hits/fields for Elasticsearch).'),
  defaultTimeoutMs: Schema.number().default(10_000)
    .description('Statement/command/request timeout in ms applied when a connection sets none.'),
})

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

export function apply(ctx: Context, config: PluginConfig) {
  const sqlConnections = new Map<string, ResolvedSqlConnection>()
  const redisConnections = new Map<string, ResolvedRedisConnection>()
  const esConnections = new Map<string, ResolvedElasticsearchConnection>()
  const dialects = new Map(DIALECTS.map((dialect) => [dialect.kind, dialect]))

  /**
   * Swap the shared connection maps to `next` once they fully validated. Tools
   * close over the map objects, so this one in-place swap makes a committed
   * settings change visible to every subsequent tool execution.
   */
  const rebuild = (source: PluginConfig): void => {
    const next = resolveConnections(source, SUPPORTED_KINDS)
    sqlConnections.clear()
    for (const [name, connection] of next.sql) sqlConnections.set(name, connection)
    redisConnections.clear()
    for (const [name, connection] of next.redis) redisConnections.set(name, connection)
    esConnections.clear()
    for (const [name, connection] of next.elasticsearch) esConnections.set(name, connection)
  }

  // The patch-layer entry config is the composition `base`; user overrides
  // land in the settings document and apply live. Without a settings service
  // the entry config stays authoritative (current stays the entry thunk).
  let current: () => PluginConfig = () => config
  installSettingsSection(ctx, DATA_TOOLS_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      rebuild(current())
    },
  })

  rebuild(config)
  registerSqlTools(ctx, { connections: sqlConnections, dialects })
  registerRedisTools(ctx, { connections: redisConnections })
  registerElasticsearchTools(ctx, { connections: esConnections })
}
