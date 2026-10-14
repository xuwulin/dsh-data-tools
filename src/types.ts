/**
 * Shared type surface for dsh-data-tools.
 *
 * A configured connection is a discriminated union on `kind`: relational
 * engines (mysql, postgres, …) are served by the shared db_* tools through a
 * SqlDialect; key/value and document stores (redis, elasticsearch) get their
 * own tool families. Only `mysql` is implemented today.
 */

/** Fields shared by every configured data-source connection. */
export interface BaseConnection {
  /** Unique name referenced by the `connection` argument of every tool. */
  name: string
  /** Per-connection result row cap; falls back to `defaultMaxRows`. */
  maxRows?: number
  /** Per-connection statement timeout in ms; falls back to `defaultTimeoutMs`. */
  timeoutMs?: number
}

/** Every backend kind the plugin can open. Extend this union and the Config schema when a new backend lands. */
export type ConnectionKind = 'mysql' | 'postgres' | 'redis' | 'elasticsearch'

/**
 * One connection as configured by the user: a flat superset of every kind's
 * fields. The Config schema stays ONE flat object (not a discriminated union
 * per kind) because the settings host's secret redaction walks only
 * object/dict/array containers — a `role('secret')` field buried in a union
 * branch is served back verbatim, leaking the secret to the configuration page.
 * Per-kind validation and defaults (ports,
 * charset, ssl, schema) therefore live in `resolveConnections`, not the schema.
 */
export interface FlatConnection extends BaseConnection {
  /** Backend discriminator; defaults to 'mysql' at validation, always present in resolved configs. */
  kind?: ConnectionKind
  host: string
  /** Server port; per-kind default when omitted (3306 mysql, 5432 postgres, 6379 redis, 9200 elasticsearch). */
  port?: number
  /** mysql/postgres: database name (string). redis: logical database index (number). */
  database?: string | number
  /** Account name: required for mysql/postgres, optional for redis (ACL) / elasticsearch (basic-auth). */
  user?: string
  /** Credential reference (env var name) resolved per operation through ctx.credentials. Preferred over `password`. */
  passwordRef?: string
  /** Plaintext password fallback for throwaway local setups. Use `passwordRef` for anything shared. */
  password?: string
  /** Connection charset (mysql only; other kinds ignore it). */
  charset?: string
  /** TLS for the connection (postgres / redis / elasticsearch; accepts self-signed certificates). */
  ssl?: boolean
  /** Default schema (namespace) for the table tools (postgres; defaults to `public`). */
  schema?: string
}

/**
 * The plugin config as plain data — the shape the patch layer writes and the
 * shape `resolveConnections` reads.
 *
 * It is NOT the shape `apply` receives: every field the configuration page edits is
 * declared `.volatile()`, so the Loader hands `apply` a stable reference per
 * field and a saved edit replaces the value inside that reference. See
 * `DataToolsConfig` in `index.ts` for the loader-facing type.
 */
export interface Config {
  connections: readonly FlatConnection[]
  defaultMaxRows: number
  defaultTimeoutMs: number
}

/**
 * A relational connection with every tunable resolved to its effective value,
 * ready to be handed to a SqlDialect. New relational engines extend this with
 * their own fields (e.g. ssl) when they need them.
 */
export interface ResolvedSqlConnection {
  /** Backend discriminator; selects the SqlDialect that serves this connection. */
  kind: string
  name: string
  host: string
  port: number
  database?: string
  user: string
  passwordRef?: string
  password?: string
  charset: string
  /** TLS for the connection (postgres). */
  ssl?: boolean
  /** Default schema for table tools (postgres; resolved to 'public' when unset). */
  schema?: string
  maxRows: number
  timeoutMs: number
}

/**
 * A Redis connection with every tunable resolved to its effective value,
 * handed to the redis_* tools.
 */
export interface ResolvedRedisConnection {
  /** Backend discriminator. */
  kind: 'redis'
  name: string
  host: string
  port: number
  /** Redis logical database index (default 0). */
  database: number
  /** Optional ACL username (Redis 6+). */
  user?: string
  passwordRef?: string
  password?: string
  ssl: boolean
  /** Result cap: keys/items per call; falls back to `defaultMaxRows`. */
  maxRows: number
  timeoutMs: number
}

/**
 * An Elasticsearch connection with every tunable resolved to its effective
 * value, handed to the es_* tools.
 */
export interface ResolvedElasticsearchConnection {
  /** Backend discriminator. */
  kind: 'elasticsearch'
  name: string
  host: string
  port: number
  /** Optional basic-auth username. */
  user?: string
  passwordRef?: string
  password?: string
  ssl: boolean
  /** Result cap: hits/fields per call; falls back to `defaultMaxRows`. */
  maxRows: number
  timeoutMs: number
}
