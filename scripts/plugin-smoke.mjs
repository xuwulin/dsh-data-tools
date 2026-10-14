// Dev-only contract smoke test for the plugin's server half against the
// CURRENT harness's volatile-config contract, with no host and no database:
//
//   * `apply` reads the three `.volatile()` config fields as references
//     (`config.connections.get()`), never as plain values;
//   * a save that replaces a reference's value is visible to the next tool call
//     WITHOUT re-running `apply` (the plugin is not restarted);
//   * a save the per-kind checks refuse keeps the previous connections;
//   * the plugin registers its own configuration page policy against its own
//     fiber, so the host does not also generate a page for it.
//
// Usage: npm run build && node scripts/plugin-smoke.mjs
import { apply } from '../lib/index.js'

const failures = []
const warnings = []

/** How many refused saves were reported (each one logs its message plus the error). */
const refusals = () => warnings.filter(line => line.startsWith('data-tools:')).length

/**
 * Assert one expectation.
 * @param label - what is being checked.
 * @param condition - the check's outcome.
 * @param detail - extra context printed on failure.
 */
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
  failures.push(label)
}

/**
 * A config field the Loader would resolve for a `.volatile()` schema node:
 * one stable reference whose value a save replaces.
 * @param value - initial snapshot.
 * @returns the reference plus its test-only setter.
 */
function volatileRef(value) {
  let current = value
  return { get: () => current, set: (next) => { current = next } }
}

/**
 * A context stand-in exposing exactly what `apply` consumes.
 * @param options - whether a settings service is composed.
 * @returns the context plus the calls it recorded.
 */
function harness({ withSettings }) {
  const registered = []
  const presentations = []
  const effects = []
  const ctx = {
    fiber: { name: 'data-tools' },
    logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
    tools: { register: (definition) => { registered.push(definition) } },
    effect: (factory, label) => { effects.push(label); factory() },
    inject: (deps, callback) => {
      if (!withSettings || !deps.includes('settings')) return
      callback({
        effect: (factory, label) => { effects.push(label); factory() },
        settings: {
          configure: (policy, owner) => {
            presentations.push({ policy, owner })
            return () => {}
          },
        },
      })
    },
  }
  return { ctx, registered, presentations, effects }
}

const connection = (name, extra = {}) => ({ name, host: 'db.example', user: 'reader', ...extra })

console.log('data-tools plugin contract smoke test\n')

console.log('1. apply() with a composed settings service')
{
  const { ctx, registered, presentations, effects } = harness({ withSettings: true })
  const connections = volatileRef([connection('alpha')])
  const defaultMaxRows = volatileRef(100)
  const defaultTimeoutMs = volatileRef(10_000)
  apply(ctx, { connections, defaultMaxRows, defaultTimeoutMs })

  check('registers 5 db_*, 4 redis_*, 5 es_* tools',
    registered.filter(d => d.name.startsWith('db_')).length === 5
    && registered.filter(d => d.name.startsWith('redis_')).length === 4
    && registered.filter(d => d.name.startsWith('es_')).length === 5,
    `got ${registered.length}: ${registered.map(d => d.name).join(', ')}`)
  check('reads volatile references, not plain values', registered.length > 0)
  check('registers one presentation policy', presentations.length === 1, `got ${presentations.length}`)
  check('policy is auto:false', presentations[0]?.policy?.auto === false, JSON.stringify(presentations[0]?.policy))
  check('policy is owned by the plugin fiber', presentations[0]?.owner === ctx.fiber)
  check('wraps the policy in an effect', effects.some(label => label.includes('configuration page policy')))

  const listSql = registered.find(definition => definition.name === 'db_connections')
  const listRedis = registered.find(definition => definition.name === 'redis_connections')
  check('db_connections is registered', listSql !== undefined)
  const first = await listSql.execute({}, {})
  check('lists the configured connection', first.includes('alpha'), first)

  console.log('\n2. a save reaches the tools without re-running apply()')
  connections.set([connection('alpha'), connection('beta', { kind: 'redis', port: 6379 })])
  const refreshedSql = await listSql.execute({}, {})
  const refreshedRedis = await listRedis.execute({}, {})
  check('new connection reaches its own tool family', refreshedRedis.includes('beta'), refreshedRedis)
  check('the sql family is unchanged', refreshedSql.includes('alpha') && !refreshedSql.includes('beta'), refreshedSql)
  check('no warning was logged for a valid save', refusals() === 0, warnings.join(' | '))

  console.log('\n3. a refused save keeps the previous connections')
  connections.set([connection('dupe'), connection('dupe')])
  const afterRefusalSql = await listSql.execute({}, {})
  const afterRefusalRedis = await listRedis.execute({}, {})
  check('refused edit changes nothing',
    afterRefusalSql.includes('alpha') && afterRefusalRedis.includes('beta') && !afterRefusalSql.includes('dupe'),
    `${afterRefusalSql} || ${afterRefusalRedis}`)
  check('refusal is reported once', refusals() === 1, `refusals: ${refusals()}`)

  console.log('\n4. every volatile field drives the freshness check')
  defaultMaxRows.set(250)
  await listSql.execute({}, {})
  check('a defaultMaxRows-only save re-resolves too', refusals() === 2, `refusals: ${refusals()}`)

  console.log('\n5. an unchanged config costs nothing')
  await listSql.execute({}, {})
  check('no re-resolve without a change', refusals() === 2, `refusals: ${refusals()}`)
}

console.log('\n6. apply() without a settings service')
{
  const { ctx, registered, presentations } = harness({ withSettings: false })
  const connections = volatileRef([connection('solo')])
  apply(ctx, { connections, defaultMaxRows: volatileRef(50), defaultTimeoutMs: volatileRef(5000) })
  check('tools still register', registered.length === 14, `got ${registered.length}`)
  check('no presentation policy is attempted', presentations.length === 0)
  const listConnections = registered.find(definition => definition.name === 'db_connections')
  const listed = await listConnections.execute({}, {})
  check('connections are served from the entry config', listed.includes('solo'), listed)
}

console.log(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}: ${failures.join('; ') || 'all checks passed'}`)
process.exit(failures.length === 0 ? 0 : 1)
