/**
 * The SqlDialect seam: one implementation per relational engine, driving the
 * shared db_* tools in tools.ts. A new database (PostgreSQL, SQL Server, …) is
 * a new implementation plus a Config schema member and a registration in
 * index.ts — the tool definitions themselves never change.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedSqlConnection } from '../types.js'

/**
 * One relational SQL backend family (MySQL, PostgreSQL, …), selected by a
 * connection's `kind`. Every method returns the already-rendered text the db_*
 * tools show the model; rendering helpers live in util.ts.
 */
export interface SqlDialect {
  /** Connection `kind` values this dialect serves. */
  readonly kind: string
  /** Reject statements that are not safe read-only queries for this engine. */
  assertReadOnly(sql: string): void
  /** Append a row cap to unbounded SELECT/WITH queries so one call cannot flood the model. */
  enforceLimit(sql: string, maxRows: number): string
  /** Validate and quote a schema/table identifier for inline SQL. */
  escapeIdentifier(name: string): string
  /** List the databases the connection's user can access, system schemas omitted. */
  listDatabases(ctx: Context, conn: ResolvedSqlConnection): Promise<string>
  /** List the tables of one database, optionally filtered by name substring. */
  listTables(ctx: Context, conn: ResolvedSqlConnection, schema: string, filter: string | undefined): Promise<string>
  /** Describe one table: columns, indexes, and a few sample rows. */
  tableSchema(ctx: Context, conn: ResolvedSqlConnection, schema: string, table: string, sample: number): Promise<string>
  /** Execute one guarded read-only statement and render the result as a text table. */
  runQuery(ctx: Context, conn: ResolvedSqlConnection, sql: string): Promise<string>
}
