/**
 * MySQL dialect for the shared db_* tools: read-only statement guard, LIMIT
 * enforcement, backtick identifier quoting, and the information_schema
 * queries, each over a fresh per-query connection.
 */

import type { Context } from '@deepseek-ai/cordis'
import mysql from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2'
import type { ResolvedSqlConnection } from '../types.js'
import { formatRows, resolvePassword } from '../util.js'
import type { SqlDialect } from './dialect.js'

// Statement guard: only read-only statements reach the server. The regexes are
// defense in depth, not the primary boundary — the primary boundary is the
// database account itself (give the agent a read-only user).
const READ_RE = /^\s*(select|show|describe|desc|explain|with)\b/i
const LOCK_RE = /\bfor\s+(update|share)\b/i
const DUMP_RE = /\binto\s+(outfile|dumpfile)\b/i

function assertReadOnly(sql: string): void {
  const trimmed = sql.trim()
  if (!READ_RE.test(trimmed)) {
    throw new Error('refused: only read-only statements (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH) are allowed')
  }
  if (LOCK_RE.test(trimmed) || DUMP_RE.test(trimmed)) {
    throw new Error('refused: locking reads and file writes (FOR UPDATE / FOR SHARE / INTO OUTFILE) are not allowed')
  }
  const single = trimmed.replace(/;\s*$/, '')
  if (single.includes(';')) {
    throw new Error('refused: multiple statements in one call are not allowed')
  }
}

/** Append a LIMIT to unbounded SELECT/WITH queries so one call cannot flood the model. */
function enforceLimit(sql: string, maxRows: number): string {
  const trimmed = sql.trim().replace(/;\s*$/, '')
  if (/\blimit\s+\d+/i.test(trimmed)) return trimmed
  if (!/^\s*(select|with)\b/i.test(trimmed)) return trimmed
  return `${trimmed} LIMIT ${maxRows}`
}

/** Validate and quote a table/schema identifier for inline SQL (MySQL backtick rules). */
function escapeIdentifier(name: string): string {
  if (name.length === 0 || name.includes('\0') || name.includes('`')) {
    throw new Error(`invalid identifier "${name}": empty, or contains NUL or a backtick`)
  }
  return `\`${name}\``
}

/** Run one callback over a fresh per-query connection, then always close it. */
async function withConnection(
  ctx: Context,
  conn: ResolvedSqlConnection,
  fn: (connection: mysql.Connection) => Promise<string>,
): Promise<string> {
  const password = await resolvePassword(ctx, conn)
  const connection = await mysql.createConnection({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    ...(conn.database === undefined ? {} : { database: conn.database }),
    password,
    charset: conn.charset,
    connectTimeout: conn.timeoutMs,
  })
  try {
    try {
      // MySQL 5.7.8+ / 8.0 only; MariaDB and older MySQL ignore this gracefully.
      await connection.query('SET SESSION MAX_EXECUTION_TIME = ?', [conn.timeoutMs])
    } catch {
      // Timeout is best-effort; the row cap and read-only account still apply.
    }
    return await fn(connection)
  } finally {
    await connection.end().catch(() => undefined)
  }
}

export const mysqlDialect: SqlDialect = {
  kind: 'mysql',
  assertReadOnly,
  enforceLimit,
  escapeIdentifier,

  async listDatabases(ctx, conn) {
    return withConnection(ctx, conn, async (connection) => {
      const [rows] = await connection.query<RowDataPacket[]>(
        'SELECT schema_name FROM information_schema.schemata '
        + "WHERE schema_name NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys') "
        + 'ORDER BY schema_name',
      )
      return formatRows(['schema_name'], rows)
    })
  },

  async listTables(ctx, conn, schema, filter) {
    return withConnection(ctx, conn, async (connection) => {
      const cols = ['table_name', 'table_type', 'table_rows']
      const [rows] = filter === undefined
        ? await connection.query<RowDataPacket[]>(
            'SELECT table_name, table_type, table_rows FROM information_schema.tables '
            + 'WHERE table_schema = ? ORDER BY table_name LIMIT ?',
            [schema, conn.maxRows],
          )
        : await connection.query<RowDataPacket[]>(
            'SELECT table_name, table_type, table_rows FROM information_schema.tables '
            + 'WHERE table_schema = ? AND table_name LIKE ? ORDER BY table_name LIMIT ?',
            [schema, `%${filter}%`, conn.maxRows],
          )
      return formatRows(cols, rows)
    })
  },

  async tableSchema(ctx, conn, schema, table, sample) {
    const qualified = `${escapeIdentifier(schema)}.${escapeIdentifier(table)}`
    return withConnection(ctx, conn, async (connection) => {
      const parts: string[] = []

      const [colRows] = await connection.query<RowDataPacket[]>(
        'SELECT column_name, column_type, is_nullable, column_default, column_key, column_comment, extra '
        + 'FROM information_schema.columns '
        + 'WHERE table_schema = ? AND table_name = ? '
        + 'ORDER BY ordinal_position',
        [schema, table],
      )
      parts.push(`columns (${colRows.length}):`)
      for (const row of colRows) {
        parts.push(
          `  ${String(row.column_name)}  ${String(row.column_type)}  nullable=${row.is_nullable}  `
          + `default=${row.column_default ?? 'NULL'}  key=${row.column_key ?? ''}  comment=${row.column_comment ?? ''}`
          + (row.extra ? `  extra=${row.extra}` : ''),
        )
      }

      const [idxRows] = await connection.query<RowDataPacket[]>(
        'SELECT index_name, non_unique, GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR \', \') AS columns '
        + 'FROM information_schema.statistics '
        + 'WHERE table_schema = ? AND table_name = ? '
        + 'GROUP BY index_name, non_unique ORDER BY index_name',
        [schema, table],
      )
      parts.push(`indexes (${idxRows.length}):`)
      for (const row of idxRows) {
        parts.push(`  ${String(row.index_name)}  unique=${row.non_unique === 0}  (${String(row.columns)})`)
      }

      if (sample > 0) {
        const [sampleRows, fields] = await connection.query<RowDataPacket[]>(`SELECT * FROM ${qualified} LIMIT ${sample}`)
        const cols = fields.map((f) => f.name)
        parts.push(`sample rows (${sampleRows.length} of up to ${sample}):`)
        parts.push(formatRows(cols, sampleRows))
      }

      return parts.join('\n')
    })
  },

  async runQuery(ctx, conn, sql) {
    assertReadOnly(sql)
    const bounded = enforceLimit(sql, conn.maxRows)
    return withConnection(ctx, conn, async (connection) => {
      const started = Date.now()
      const [rows, fields] = await connection.query<RowDataPacket[]>(bounded)
      const durationMs = Date.now() - started
      const cols = fields.map((f) => f.name)
      const capped = !/\blimit\s+\d+/i.test(sql)
      const note = capped && rows.length >= conn.maxRows
        ? ` (possibly truncated at ${conn.maxRows} rows — add an explicit LIMIT for more)`
        : ''
      return `${formatRows(cols, rows)}\n${rows.length} row(s) in ${durationMs} ms${note}`
    })
  },
}
