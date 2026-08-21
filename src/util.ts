/**
 * Backend-agnostic helpers shared by every tool family: text-table rendering,
 * cell serialization, and credential resolution. Nothing here knows a specific
 * engine; dialect modules compose these with their own queries.
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ResolvedSqlConnection } from './types.js'

/** Serialize one cell value for the text table. */
export function textOf(value: unknown): string {
  if (value === null) return 'NULL'
  if (value === undefined) return ''
  if (Buffer.isBuffer(value)) return `<blob ${value.length} bytes>`
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** Render rows as an aligned text table; cell values are truncated to keep the model context bounded. */
export function formatRows(cols: string[], rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return `0 rows. Columns: ${cols.join(', ')}`
  const cap = 60
  const widths = cols.map((col) => {
    let width = col.length
    for (const row of rows) {
      const len = textOf(row[col]).length
      if (len > width) width = len
    }
    return Math.min(width, cap)
  })
  const render = (row: Record<string, unknown>) =>
    cols.map((col, i) => `${textOf(row[col]).slice(0, cap)}${' '.repeat(Math.max(0, widths[i]! - Math.min(textOf(row[col]).length, cap)))}`)
      .join(' | ')
  const header = cols.map((col, i) => `${col}${' '.repeat(Math.max(0, widths[i]! - col.length))}`).join(' | ')
  const sep = widths.map((w) => '-'.repeat(w)).join('-+-')
  return [header, sep, ...rows.map(render)].join('\n')
}

/** Resolve the effective password for one operation: credential ref wins, then plaintext. */
export async function resolvePassword(ctx: Context, conn: ResolvedSqlConnection): Promise<string | undefined> {
  if (conn.passwordRef !== undefined) {
    const resolved = await ctx.credentials.resolve(credentialRef(conn.passwordRef))
    if (resolved === undefined) {
      throw new Error(`credential "${conn.passwordRef}" is not configured — set it in env or the dsh .env file`)
    }
    return resolved.value
  }
  return conn.password
}
