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

/** One named MySQL connection as configured by the user. */
export interface MysqlConnection extends BaseConnection {
  /** Backend discriminator; defaults to 'mysql'. Unknown kinds are rejected at config validation. */
  kind?: 'mysql'
  host: string
  port: number
  /** Optional default database. Omit it to let the agent see every database the account can access. */
  database?: string
  user: string
  /** Credential reference (env var name) resolved per operation through ctx.credentials. Preferred over `password`. */
  passwordRef?: string
  /** Plaintext password fallback for throwaway local setups. Use `passwordRef` for anything shared. */
  password?: string
  charset?: string
}

/**
 * Every connection kind the plugin can open. Extend this union and the Config
 * schema in index.ts when a new backend lands.
 */
export type ConnectionConfig = MysqlConnection

export interface Config {
  connections: ConnectionConfig[]
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
  maxRows: number
  timeoutMs: number
}
