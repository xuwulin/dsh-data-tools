// Dev-only connectivity smoke test for every configured connection in
// ~/.dsh/settings.yaml (the same config the Data sources settings page serves).
// Uses the same drivers the plugin uses (mysql2 / pg / redis /
// @elastic/elasticsearch) with per-kind probes matching the plugin's own
// discovery queries. Never prints passwords.
//
// The settings.yaml connections block is parsed with a small purpose-built
// parser (no yaml dependency): the file's data-tools section is a list of
// `- name: ...` blocks with plain scalar fields, which this handles exactly.
//
// Usage: node scripts/conn-smoke.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import mysql from 'mysql2/promise'
import pg from 'pg'
import { createClient } from 'redis'
import { Client as EsClient } from '@elastic/elasticsearch'

const TIMEOUT = 10_000

/**
 * Extract the `data-tools` connections array from the settings.yaml text.
 * The file is split into top-level sections by column-0 keys; the block under
 * `data-tools:` is then parsed into `- name:` entries with scalar fields.
 * @param text - raw settings.yaml.
 * @returns one plain object per `- name:` block under `data-tools:`.
 */
function parseConnections(text) {
  const lines = text.split(/\r?\n/)
  const topKeys = []
  lines.forEach((line, index) => {
    if (/^[A-Za-z0-9_-]+:/.test(line)) topKeys.push(index)
  })
  const start = topKeys.findIndex(index => lines[index].startsWith('data-tools:'))
  if (start === -1) return []
  const end = start + 1 < topKeys.length ? topKeys[start + 1] : lines.length
  const body = lines.slice(start, end).join('\n')

  const blocks = [...body.matchAll(/^\s*-\s*name:\s*(.+)$/gm)]
  const connections = []
  for (let i = 0; i < blocks.length; i += 1) {
    const blockStart = blocks[i].index
    const blockEnd = i + 1 < blocks.length ? blocks[i + 1].index : body.length
    const block = body.slice(blockStart, blockEnd)
    const entry = { name: blocks[i][1].trim() }
    for (const match of block.matchAll(/^\s*(\w[\w-]*):\s*(.*?)\s*$/gm)) {
      const key = match[1]
      let value = match[2]
      if (key === 'name') continue
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      } else if (value === 'true') value = true
      else if (value === 'false') value = false
      else if (/^-?\d+$/.test(value)) value = Number(value)
      else if (value === '' || value === 'null' || value === '~') value = undefined
      entry[key] = value
    }
    connections.push(entry)
  }
  return connections
}

const settingsPath = path.join(os.homedir(), '.dsh', 'settings.yaml')
if (!fs.existsSync(settingsPath)) {
  console.log(`no settings.yaml at ${settingsPath}`)
  process.exit(1)
}
const connections = parseConnections(fs.readFileSync(settingsPath, 'utf8'))
if (connections.length === 0) {
  console.log('no data-tools connections parsed from settings.yaml')
  process.exit(1)
}

const passwordOf = (c) => {
  if (c.passwordRef !== undefined) {
    const fromEnv = process.env[c.passwordRef]
    if (fromEnv === undefined) throw new Error(`passwordRef ${c.passwordRef} not in env`)
    return fromEnv
  }
  return c.password
}

async function probeMysql(c) {
  const connection = await mysql.createConnection({
    host: c.host, port: c.port, user: c.user,
    ...(c.database ? { database: c.database } : {}),
    password: passwordOf(c), connectTimeout: TIMEOUT,
    supportBigNumbers: true, bigNumberStrings: true,
  })
  try {
    const [rows] = await connection.query(
      "SELECT schema_name FROM information_schema.schemata "
      + "WHERE schema_name NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys') "
      + 'ORDER BY schema_name LIMIT 10',
    )
    const names = rows.map((r) => r.schema_name)
    console.log(`  OK  databases visible (${names.length} shown): ${names.join(', ') || '(none)'}`)
  } finally {
    await connection.end()
  }
}

async function probePostgres(c) {
  const client = new pg.Client({
    host: c.host, port: c.port, user: c.user,
    ...(c.database ? { database: c.database } : {}),
    password: passwordOf(c), connectionTimeoutMillis: TIMEOUT,
  })
  await client.connect()
  try {
    const result = await client.query(
      "SELECT nspname AS schema_name FROM pg_namespace "
      + "WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 1 LIMIT 10",
    )
    const names = result.rows.map((r) => r.schema_name)
    console.log(`  OK  schemas visible (${names.length} shown): ${names.join(', ') || '(none)'}`)
  } finally {
    await client.end()
  }
}

async function probeRedis(c) {
  const client = createClient({
    // RESP3 (default) sends a HELLO handshake that Redis < 6.0 rejects; RESP2
    // works with every version.
    RESP: 2,
    socket: {
      host: c.host, port: c.port, connectTimeout: TIMEOUT,
      // Fail fast on the first connection error instead of retrying forever —
      // the default strategy keeps connect() pending and the probe never settles.
      reconnectStrategy: false,
      ...(c.ssl ? { tls: true, rejectUnauthorized: false } : {}),
    },
    ...(c.database !== undefined ? { database: Number(c.database) } : {}),
    ...(c.user ? { username: c.user } : {}),
    ...(c.password ? { password: c.password } : {}),
  })
  // node-redis rejects connect() with the generic "The client is closed" when
  // the socket dies; the real cause arrives on the 'error' event first.
  let socketError
  client.on('error', (error) => { socketError = error })
  try {
    await client.connect()
    const pong = await client.ping()
    const size = await client.dbSize()
    console.log(`  OK  PING=${pong}  db${c.database ?? 0} keys=${size}`)
  } catch (error) {
    const reason = socketError ?? error
    console.log(`  FAIL ${reason instanceof Error ? reason.message : String(reason)}`)
  } finally {
    await client.quit().catch(() => undefined)
  }
}

async function probeEs(c) {
  const scheme = c.ssl ? 'https' : 'http'
  const node = String(c.host).includes('://') ? c.host : `${scheme}://${c.host}:${c.port}`
  const client = new EsClient({
    node,
    requestTimeout: TIMEOUT,
    ...(c.user ? { auth: { username: c.user, password: c.password ?? '' } } : {}),
    ...(c.ssl ? { tls: { rejectUnauthorized: false } } : {}),
  })
  try {
    const info = await client.info()
    const indices = await client.cat.indices({ format: 'json', h: ['index'], size: 10 }).catch(() => null)
    const count = indices === null ? '?' : indices.length
    console.log(`  OK  cluster=${info.cluster_name} version=${info.version?.number ?? '?'} indices(first ${count})`)
  } finally {
    await client.close()
  }
}

const probes = { mysql: probeMysql, postgres: probePostgres, redis: probeRedis, elasticsearch: probeEs }
let failed = 0
for (const c of connections) {
  const label = `${c.name} [${c.kind}] ${c.host}:${c.port}`
  const probe = probes[c.kind]
  if (probe === undefined) {
    console.log(`FAIL ${label} — no probe for kind ${String(c.kind)}`)
    failed += 1
    continue
  }
  process.stdout.write(`${label}: `)
  try {
    await probe(c)
  } catch (error) {
    console.log(`  FAIL ${String(error instanceof Error ? error.message : error).slice(0, 200)}`)
    failed += 1
  }
}
process.exit(failed === 0 ? 0 : 1)
