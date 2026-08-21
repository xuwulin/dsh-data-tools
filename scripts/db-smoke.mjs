// Dev-only connectivity smoke test: reads dev.patch.yml, connects to MySQL,
// and lists the databases the account can access — the same query the plugin's
// db_list_databases tool runs. Never prints the password.
// Usage: node scripts/db-smoke.mjs
import fs from 'node:fs'
import mysql from 'mysql2/promise'

const yaml = fs.readFileSync(new URL('../dev.patch.yml', import.meta.url), 'utf8')

const field = (name) => {
  const m = yaml.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm'))
  if (!m) throw new Error(`dev.patch.yml: missing ${name}`)
  return m[1].trim()
}

const password = (yaml.match(/^\s*password:\s*(.+)$/m)?.[1]?.trim())
  ?? process.env[yaml.match(/^\s*passwordRef:\s*(.+)$/m)?.[1]?.trim() ?? '']

const connection = await mysql.createConnection({
  host: field('host'),
  port: Number(field('port')),
  user: field('user'),
  password,
  connectTimeout: 10_000,
})
try {
  const [rows] = await connection.query(
    "SELECT schema_name FROM information_schema.schemata "
    + "WHERE schema_name NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys') "
    + "ORDER BY schema_name",
  )
  console.log(`connected OK (${field('host')}:${field('port')}, user ${field('user')})`)
  const names = rows.map((r) => r.schema_name)
  console.log(`databases (${names.length}): ${names.join(', ') || '(none visible)'}`)
} finally {
  await connection.end()
}
