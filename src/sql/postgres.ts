/**
 * PostgreSQL dialect for the shared db_* tools: read-only statement guard,
 * LIMIT enforcement, double-quote identifier quoting, and the data-dictionary
 * queries, each over a fresh per-query connection.
 *
 * Semantic notes: PostgreSQL has no MySQL-style "databases" inside a
 * connection — the listing unit for the table tools is the schema (namespace).
 * `db_list_databases` therefore lists the connected database's non-system
 * schemas, and the `database` argument of `db_list_tables` / `db_table_schema`
 * carries a schema name (falling back to the connection's configured `schema`,
 * default `public`).
 */

import { Client, type QueryResultRow } from 'pg'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedSqlConnection } from '../types.js'
import { formatRows, resolvePassword } from '../util.js'
import type { SqlDialect } from './dialect.js'

// Statement guard: only read-only statements reach the server. The regexes are
// defense in depth, not the primary boundary — the primary boundary is the
// database account itself (give the agent a read-only user).
const READ_RE = /^\s*(select|show|explain|with)\b/i
const LOCK_RE = /\bfor\s+(update|share)\b/i
// PostgreSQL's SELECT ... INTO creates a new table — a write, unlike MySQL.
const INTO_RE = /^\s*select[\s\S]*\binto\b/i

function assertReadOnly(sql: string): void {
  const trimmed = sql.trim()
  if (!READ_RE.test(trimmed)) {
    throw new Error('refused: only read-only statements (SELECT / SHOW / EXPLAIN / WITH) are allowed')
  }
  if (LOCK_RE.test(trimmed) || INTO_RE.test(trimmed)) {
    throw new Error('refused: locking reads and table-creating SELECT INTO are not allowed')
  }
  const single = trimmed.replace(/;\s*$/, '')
  if (single.includes(';')) {
    throw new Error('refused: multiple statements in one call are not allowed')
  }
}

/** Append a LIMIT to unbounded SELECT/WITH queries so one call cannot flood the model. */
function enforceLimit(sql: string, maxRows: number): string {
  const trimmed = sql.trim().replace(/;\s*$/, '')
  if (/\blimit\s+(\d+|all)\b/i.test(trimmed)) return trimmed
  if (!/^\s*(select|with)\b/i.test(trimmed)) return trimmed
  return `${trimmed} LIMIT ${maxRows}`
}

/** Validate and quote a schema/table identifier for inline SQL (PostgreSQL double-quote rules). */
function escapeIdentifier(name: string): string {
  if (name.length === 0 || name.includes('\0') || name.includes('"')) {
    throw new Error(`invalid identifier "${name}": empty, or contains NUL or a double quote`)
  }
  return `"${name}"`
}

/** Run one callback over a fresh per-query connection, then always close it. */
async function withConnection(
  ctx: Context,
  conn: ResolvedSqlConnection,
  fn: (client: Client) => Promise<string>,
): Promise<string> {
  const password = await resolvePassword(ctx, conn)
  const client = new Client({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    ...(conn.database === undefined ? {} : { database: conn.database }),
    password,
    connectionTimeoutMillis: conn.timeoutMs,
    // Accept self-signed certificates; the account and statement guard remain
    // the read-only boundary. Encryption is the point of `ssl`.
    ...(conn.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  })
  await client.connect()
  try {
    try {
      // Per-session statement timeout, the PostgreSQL counterpart of MySQL's
      // MAX_EXECUTION_TIME; canceled statements surface as query errors.
      await client.query('SET statement_timeout = $1', [Math.floor(conn.timeoutMs)])
    } catch {
      // Timeout is best-effort; the row cap and read-only account still apply.
    }
    return await fn(client)
  } finally {
    await client.end().catch(() => undefined)
  }
}

export const postgresDialect: SqlDialect = {
  kind: 'postgres',
  assertReadOnly,
  enforceLimit,
  escapeIdentifier,

  async listDatabases(ctx, conn) {
    return withConnection(ctx, conn, async (client) => {
      const result = await client.query<QueryResultRow>(
        "SELECT nspname AS schema_name FROM pg_namespace "
        + "WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' "
        + 'ORDER BY nspname',
      )
      return formatRows(['schema_name'], result.rows)
    })
  },

  async listTables(ctx, conn, schema, filter) {
    const base = 'SELECT t.table_name, t.table_type, '
      + 'GREATEST(COALESCE(c.reltuples, 0)::bigint, 0) AS table_rows '
      + 'FROM information_schema.tables t '
      + 'LEFT JOIN pg_class c ON c.relname = t.table_name '
      + 'LEFT JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema '
      + 'WHERE t.table_schema = $1'
    const cols = ['table_name', 'table_type', 'table_rows']
    return withConnection(ctx, conn, async (client) => {
      const result = filter === undefined
        ? await client.query<QueryResultRow>(`${base} ORDER BY t.table_name LIMIT $2`, [schema, conn.maxRows])
        : await client.query<QueryResultRow>(
            `${base} AND t.table_name LIKE $2 ORDER BY t.table_name LIMIT $3`,
            [schema, `%${filter}%`, conn.maxRows],
          )
      return formatRows(cols, result.rows)
    })
  },

  async tableSchema(ctx, conn, schema, table, sample) {
    const qualified = `${escapeIdentifier(schema)}.${escapeIdentifier(table)}`
    const rel = '(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace '
      + 'WHERE n.nspname = $1 AND c.relname = $2)'
    return withConnection(ctx, conn, async (client) => {
      const parts: string[] = []

      const columns = await client.query<QueryResultRow>(
        'SELECT a.attname AS column_name, '
        + 'pg_catalog.format_type(a.atttypid, a.atttypmod) AS column_type, '
        + 'NOT a.attnotnull AS is_nullable, '
        + 'pg_get_expr(d.adbin, d.adrelid) AS column_default, '
        + 'col_description(a.attrelid, a.attnum) AS column_comment, '
        + 'EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND a.attnum = ANY(i.indkey) AND i.indisprimary) AS is_primary, '
        + 'EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND a.attnum = ANY(i.indkey) AND i.indisunique AND NOT i.indisprimary) AS is_unique '
        + 'FROM pg_attribute a '
        + 'JOIN pg_class c ON c.oid = a.attrelid '
        + 'JOIN pg_namespace n ON n.oid = c.relnamespace '
        + `WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [schema, table],
      )
      parts.push(`columns (${columns.rows.length}):`)
      for (const row of columns.rows) {
        parts.push(
          `  ${String(row.column_name)}  ${String(row.column_type)}  nullable=${row.is_nullable ? 'YES' : 'NO'}  `
          + `default=${row.column_default ?? 'NULL'}  key=${row.is_primary ? 'PRI' : row.is_unique ? 'UNI' : ''}  `
          + `comment=${row.column_comment ?? ''}`,
        )
      }

      const indexes = await client.query<QueryResultRow>(
        'SELECT ci.relname AS index_name, ix.indisunique AS is_unique, '
        + '(SELECT string_agg(a.attname, \', \' ORDER BY k.ord) '
        + 'FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) '
        + 'JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum '
        + 'WHERE k.attnum > 0) AS columns '
        + 'FROM pg_index ix '
        + 'JOIN pg_class ci ON ci.oid = ix.indexrelid '
        + `WHERE ix.indrelid = ${rel} ORDER BY ci.relname`,
        [schema, table],
      )
      parts.push(`indexes (${indexes.rows.length}):`)
      for (const row of indexes.rows) {
        parts.push(`  ${String(row.index_name)}  unique=${row.is_unique === true}  (${String(row.columns ?? '')})`)
      }

      if (sample > 0) {
        const sampled = await client.query<QueryResultRow>(`SELECT * FROM ${qualified} LIMIT ${sample}`)
        const cols = sampled.fields.map((f) => f.name)
        parts.push(`sample rows (${sampled.rows.length} of up to ${sample}):`)
        parts.push(formatRows(cols, sampled.rows))
      }

      return parts.join('\n')
    })
  },

  async runQuery(ctx, conn, sql) {
    assertReadOnly(sql)
    const bounded = enforceLimit(sql, conn.maxRows)
    return withConnection(ctx, conn, async (client) => {
      const started = Date.now()
      const result = await client.query<QueryResultRow>(bounded)
      const durationMs = Date.now() - started
      const cols = result.fields.map((f) => f.name)
      const capped = !/\blimit\s+(\d+|all)\b/i.test(sql)
      const note = capped && result.rows.length >= conn.maxRows
        ? ` (possibly truncated at ${conn.maxRows} rows — add an explicit LIMIT for more)`
        : ''
      return `${formatRows(cols, result.rows)}\n${result.rows.length} row(s) in ${durationMs} ms${note}`
    })
  },
}
