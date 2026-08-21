/**
 * The db_* tool family: connection introspection, schema discovery, and
 * guarded read-only queries. The definitions are dialect-agnostic — every
 * operation delegates to the SqlDialect serving the connection's kind, so the
 * same five tools work for MySQL today and for any future relational engine
 * without changes.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ResolvedSqlConnection } from '../types.js'
import type { SqlDialect } from './dialect.js'

/** Everything the db_* tools need to find connections and their dialect. */
export interface SqlToolkit {
  connections: ReadonlyMap<string, ResolvedSqlConnection>
  dialects: ReadonlyMap<string, SqlDialect>
}

/** Register the five db_* tools, all served by the dialects in the toolkit. */
export function registerSqlTools(ctx: Context, toolkit: SqlToolkit): void {
  const requireConnection = (name: string): ResolvedSqlConnection => {
    const connection = toolkit.connections.get(name)
    if (connection === undefined) {
      const known = [...toolkit.connections.keys()].join(', ') || '(none configured)'
      throw new Error(`unknown connection "${name}"; configured connections: ${known}`)
    }
    return connection
  }

  const requireDialect = (connection: ResolvedSqlConnection): SqlDialect => {
    const dialect = toolkit.dialects.get(connection.kind)
    if (dialect === undefined) {
      throw new Error(`no driver for connection kind "${connection.kind}" (connection "${connection.name}")`)
    }
    return dialect
  }

  ctx.tools.register(defineTool({
    name: 'db_connections',
    description:
      'List configured SQL connections: kind, name, database (or "all databases"), host, user. Use a returned '
      + 'name as the `connection` argument of the other db_* tools.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      if (toolkit.connections.size === 0) return 'No connections configured. Add `connections` to the plugin config.'
      return [...toolkit.connections.values()]
        .map((c) => `${c.name}: ${c.kind} ${c.database ?? '(all databases)'} @ ${c.host}:${c.port} (user ${c.user})`)
        .join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'db_list_databases',
    description:
      'List the databases the connection\'s user can access (system schemas are omitted). Use a returned name '
      + 'as the `database` argument of db_list_tables / db_table_schema, or qualify tables as `database.table` '
      + 'in db_query.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection name from db_connections.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const conn = requireConnection(args.connection)
      return requireDialect(conn).listDatabases(ctx, conn)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'db_list_tables',
    description:
      'List the tables of a database. Use `filter` to find tables by name substring; omit `database` to use the '
      + 'connection\'s default database. Returns table name, type, and an approximate row count.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection name from db_connections.' },
      database: { type: 'string', description: 'Optional database name; defaults to the connection\'s database.' },
      filter: { type: 'string', description: 'Optional substring to match against table names.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const conn = requireConnection(args.connection)
      const schema = args.database ?? conn.database
      if (schema === undefined) {
        throw new Error(`connection "${conn.name}" has no default database — pass the \`database\` argument`)
      }
      return requireDialect(conn).listTables(ctx, conn, schema, args.filter)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'db_table_schema',
    description:
      'Describe one table: columns (name, type, nullability, default, key, comment), indexes, and a few sample rows. '
      + 'Omit `database` to use the connection\'s default database. Use this before writing SQL so the query matches '
      + 'the real schema.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection name from db_connections.' },
      database: { type: 'string', description: 'Optional database name; defaults to the connection\'s database.' },
      table: { type: 'string', required: true, description: 'Table name.' },
      sampleRows: { type: 'number', description: 'How many sample rows to include (default 3, capped by maxRows).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const conn = requireConnection(args.connection)
      const schema = args.database ?? conn.database
      if (schema === undefined) {
        throw new Error(`connection "${conn.name}" has no default database — pass the \`database\` argument`)
      }
      const sample = Math.min(Math.max(args.sampleRows ?? 3, 0), conn.maxRows)
      return requireDialect(conn).tableSchema(ctx, conn, schema, args.table, sample)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'db_query',
    description:
      'Execute a read-only SQL statement (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH) against a configured SQL '
      + 'connection and return the result as a text table. Writes, locks, file dumps, and multi-statements are refused. '
      + 'Unbounded SELECTs are automatically capped at maxRows. Qualify tables as `database.table` when the connection '
      + 'has no default database.',
    parameters: {
      connection: { type: 'string', required: true, description: 'Connection name from db_connections.' },
      sql: { type: 'string', required: true, description: 'The read-only SQL statement.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const conn = requireConnection(args.connection)
      return requireDialect(conn).runQuery(ctx, conn, args.sql)
    },
  }))
}
