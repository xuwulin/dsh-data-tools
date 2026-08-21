/**
 * dsh-data-tools — read-only data-source tooling for the DeepSeek Harness.
 *
 * V1 scope: relational connection introspection, table listing, schema
 * discovery, and guarded SELECT queries against MySQL. Write statements are
 * refused at the tool boundary; pair this with a read-only database account
 * for defense in depth.
 *
 * Layout: this file is the composition root — config schema plus wiring.
 * Shared types live in types.ts, backend-agnostic rendering and credential
 * helpers in util.ts. Each backend family is its own module: the shared db_*
 * tools live in sql/tools.ts and are driven by a SqlDialect (sql/mysql.ts
 * today; add sql/postgres.ts the same way); key/value and document stores get
 * their own tool families under redis/ and elasticsearch/.
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
import type { Config as PluginConfig, ResolvedSqlConnection } from './types.js'
export type { ConnectionConfig, BaseConnection, MysqlConnection } from './types.js'
import { registerSqlTools } from './sql/tools.js'
import { mysqlDialect } from './sql/mysql.js'
import type { SqlDialect } from './sql/dialect.js'

export const name = 'data-tools'
export const inject = ['tools', 'credentials']

/** Backend dialects available in this build; extend when a new engine lands. */
const DIALECTS: SqlDialect[] = [mysqlDialect]

/** Settings namespace carrying this plugin's user-editable section. */
export const DATA_TOOLS_SETTINGS_NAMESPACE = settingsNamespace('data-tools')

export const Config: Schema<PluginConfig> = Schema.object({
  connections: Schema.array(Schema.object({
    name: Schema.string().required()
      .description('Unique name referenced by the `connection` argument of every db_* tool.'),
    // Discriminator for the ConnectionConfig union; Schema.const rejects unknown kinds at validation.
    kind: Schema.const('mysql').default('mysql'),
    host: Schema.string().required()
      .description('MySQL server host.'),
    port: Schema.number().default(3306)
      .description('MySQL server port.'),
    database: Schema.string()
      .description('Optional default database; omit it to let the agent see every database the account can access.'),
    user: Schema.string().required()
      .description('Read-only MySQL account name.'),
    passwordRef: Schema.string()
      .description('Credential reference (env var name) resolved per operation through the dsh credentials seam; preferred over `password`.'),
    password: Schema.string().role('secret')
      .description('Plaintext password fallback for throwaway local setups; prefer `passwordRef`.'),
    charset: Schema.string().default('utf8mb4')
      .description('Connection charset.'),
    maxRows: Schema.number()
      .description('Per-connection result row cap; falls back to `defaultMaxRows`.'),
    timeoutMs: Schema.number()
      .description('Per-connection statement timeout in ms; falls back to `defaultTimeoutMs`.'),
  })).required()
    .description('Named MySQL connections the db_* tools operate on.'),
  defaultMaxRows: Schema.number().default(100)
    .description('Result row cap applied when a connection sets none.'),
  defaultTimeoutMs: Schema.number().default(10_000)
    .description('Statement timeout in ms applied when a connection sets none.'),
})

/**
 * Resolve every connection of one authoritative config into a fresh map,
 * validating names and kinds before anything is committed.
 */
function resolveConnections(source: PluginConfig, supportedKinds: readonly string[]): Map<string, ResolvedSqlConnection> {
  const next = new Map<string, ResolvedSqlConnection>()
  for (const connection of source.connections) {
    if (next.has(connection.name)) {
      throw new Error(`duplicate connection name "${connection.name}"`)
    }
    const kind: string = connection.kind ?? 'mysql'
    if (!supportedKinds.includes(kind)) {
      throw new Error(`unsupported connection kind "${kind}" for connection "${connection.name}" — supported kinds: ${supportedKinds.join(', ')}`)
    }
    // YAML `database:` left blank parses as null/'' — treat all empty forms as "no default database".
    const database = connection.database?.trim() || undefined
    next.set(connection.name, {
      kind,
      name: connection.name,
      host: connection.host,
      port: connection.port,
      database,
      user: connection.user,
      passwordRef: connection.passwordRef,
      password: connection.password,
      charset: connection.charset ?? 'utf8mb4',
      maxRows: connection.maxRows ?? source.defaultMaxRows,
      timeoutMs: connection.timeoutMs ?? source.defaultTimeoutMs,
    })
  }
  return next
}

export function apply(ctx: Context, config: PluginConfig) {
  const connections = new Map<string, ResolvedSqlConnection>()
  const dialects = new Map(DIALECTS.map((dialect) => [dialect.kind, dialect]))

  /**
   * Swap the shared connection map to `next` once it fully validated. Tools
   * close over the map object, so this one in-place swap makes a committed
   * settings change visible to every subsequent tool execution.
   */
  const rebuild = (source: PluginConfig): void => {
    const next = resolveConnections(source, DIALECTS.map((d) => d.kind))
    connections.clear()
    for (const [name, connection] of next) connections.set(name, connection)
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
  registerSqlTools(ctx, { connections, dialects })
}
