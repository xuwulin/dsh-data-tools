// Dev-only connectivity smoke test for the connections this deployment
// actually resolves. In the current harness the plugin's configuration page
// saves into the ACTIVE PROFILE's Cordis patch (not `$DSH_HOME/settings.yaml`,
// which earlier releases used), so the layers below are composed the way the
// loader composes them, lowest first:
//
//   1. this repo's cordis.patch.yml  (the bundle's composition base)
//   2. the active profile's cordis.patch.yml  (where a Configure-page save lands)
//   3. this repo's dev.patch.yml  (the CLI --patch overlay used in development)
//   4. any extra `--patch <file>` given on the command line
//
// Uses the same drivers the plugin uses (mysql2 / pg / redis /
// @elastic/elasticsearch) with per-kind probes matching the plugin's own
// discovery queries. Never prints passwords.
//
// Usage: node scripts/conn-smoke.mjs [--profile <name>] [--patch <file> ...]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import pg from 'pg'
import { createClient } from 'redis'
import { Client as EsClient } from '@elastic/elasticsearch'

const TIMEOUT = 10_000

/**
 * Coerce one plain YAML scalar the patch files use.
 * @param raw - scalar text after the colon.
 * @returns the coerced value; undefined for the empty/null spellings.
 */
function scalar(raw) {
  let value = raw.trim()
  if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1)
  } else if (value === 'true') return true
  else if (value === 'false') return false
  else if (/^-?\d+$/.test(value)) return Number(value)
  else if (value === '' || value === 'null' || value === '~') return undefined
  return value
}

/** Column index of the first non-space character. */
const indentOf = (line) => line.length - line.trimStart().length

/**
 * Split a block into its `- item` groups, keeping each item's own lines.
 * @param lines - block lines, already dedented to the block's own base.
 * @returns one array of lines per list item.
 */
function splitItems(lines) {
  const items = []
  for (const line of lines) {
    if (/^\s*-\s/.test(line) || items.length === 0) items.push([line])
    else items[items.length - 1].push(line)
  }
  return items
}

/** Read `key: value` scalars out of one item's lines. */
function itemFields(lines) {
  const fields = {}
  for (const line of lines) {
    const match = /^\s*(-\s*)?([\w-]+):\s*(.*)$/.exec(line)
    if (match) fields[match[2]] = scalar(match[3])
  }
  return fields
}

/**
 * Read the `data-tools` entry's `config` block out of one patch file.
 * Both spellings the loader accepts are handled: a bundle patch's nested
 * `- insert: / - id: data-tools`, and a profile patch's id-targeted
 * `- id: data-tools`.
 * @param text - raw patch file.
 * @returns the entry's config keys, or an empty object when the file has none.
 */
function configOf(text) {
  const lines = text.split(/\r?\n/)
  const idIndex = lines.findIndex(line => /^\s*(-\s*)?id:\s*['"]?data-tools['"]?\s*$/.test(line))
  if (idIndex === -1) return {}
  const idIndent = indentOf(lines[idIndex]) + (/^\s*-\s/.test(lines[idIndex]) ? 2 : 0)
  const configIndex = lines.findIndex((line, index) => index > idIndex
    && line.trim() === 'config:'
    && indentOf(line) >= idIndent)
  if (configIndex === -1) return {}
  const configIndent = indentOf(lines[configIndex])

  // Everything deeper than `config:` belongs to the entry, up to the next line
  // at or above that level.
  const body = []
  for (let index = configIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (indentOf(line) <= configIndent) break
    body.push(line)
  }

  const config = {}
  const connectionsAt = body.findIndex(line => line.trim() === 'connections:')
  if (connectionsAt !== -1) {
    const connectionsIndent = indentOf(body[connectionsAt])
    const section = body.slice(connectionsAt + 1).filter(line => indentOf(line) > connectionsIndent)
    config.connections = splitItems(section).map(itemFields)
  }
  for (const line of body) {
    const match = /^([\w-]+):\s*(.*)$/.exec(line.trim())
    if (match && match[1] !== 'connections') config[match[1]] = scalar(match[2])
  }
  return config
}

/** Compose the layers' `data-tools` configs, later layers overriding earlier ones field by field. */
function resolveConfig(layerPaths) {
  let resolved = {}
  for (const layerPath of layerPaths) {
    if (!fs.existsSync(layerPath)) continue
    resolved = { ...resolved, ...configOf(fs.readFileSync(layerPath, 'utf8')) }
  }
  return resolved
}

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : argv[at + 1]
}
const extraPatches = argv.flatMap((value, index) => (value === '--patch' && argv[index + 1] !== undefined ? [argv[index + 1]] : []))
const profile = flag('--profile', process.env.DSH_PROFILE ?? 'web')
const profileDir = process.env.DSH_PROFILE_DIR ?? path.join(os.homedir(), '.dsh', 'profiles', profile)
const layers = [
  fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)),
  path.join(profileDir, 'cordis.patch.yml'),
  fileURLToPath(new URL('../dev.patch.yml', import.meta.url)),
  ...extraPatches,
]
const config = resolveConfig(layers)
const connections = Array.isArray(config.connections) ? config.connections : []
if (connections.length === 0) {
  console.log(`no data-tools connections found in: ${layers.join(', ')}`)
  process.exit(1)
}
console.log(`connections from ${layers.filter(layer => fs.existsSync(layer)).join(' -> ')}`)

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
  // The plugin's Config schema defaults the discriminator, and so does this script.
  c.kind ??= 'mysql'
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
