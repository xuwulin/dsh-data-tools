# dsh-data-tools

English | [中文](README.zh.md) | [Development](DEVELOP.md)

Read-only data-source tooling (MySQL / PostgreSQL / Redis / Elasticsearch) for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): let the agent **see the database before it writes code** — list connections, discover table schemas, and run guarded SELECT queries.

## Background

AI coding assistants cannot query your database by default: no table structures, no sample data, no way to verify SQL. This plugin gives the agent a safe, read-only window into MySQL, PostgreSQL, Redis, and Elasticsearch so it can write schema-accurate queries and code.

## Tools

| Tool | Purpose |
|---|---|
| `db_connections` | List configured SQL connections (name, database or "all databases", host, user — never passwords). |
| `db_list_databases` | List databases the connection's user can access (system schemas omitted). |
| `db_list_tables` | List tables of a database (optional `database`, defaults to the connection's), with optional name filter. |
| `db_table_schema` | Columns, indexes, and sample rows for one table (optional `database`). |
| `db_query` | Execute a read-only statement (dialect-specific guard: SELECT / SHOW / DESCRIBE / EXPLAIN / WITH for MySQL; SELECT / SHOW / EXPLAIN / WITH for PostgreSQL); qualify `database.table` when no default database is set. |
| `redis_connections` | List configured Redis connections (name, database index, host, port, user — never passwords). |
| `redis_keys` | List keys via SCAN (never the blocking KEYS), with optional glob pattern, bounded by `limit`. |
| `redis_read` | Read one key, dispatched by type: string / list / hash / set / zset, bounded per collection. |
| `redis_info` | Compact server info: version, clients, memory, command stats, per-db key counts. |
| `es_connections` | List configured Elasticsearch connections (name, base URL, user — never passwords). |
| `es_indices` | List indices (name, health, doc count, store size), with optional pattern filter, bounded by `limit`. |
| `es_mapping` | Describe one index's mapping: every field path with its type, bounded by `limit`. |
| `es_search` | Search one index with a JSON query body; bounded hits; omitting the query returns sample documents. |
| `es_info` | Compact cluster info: name, version, tagline. |

## Install

```sh
dsh plugin --profile web add @xwl12/dsh-data-tools@latest
```

> Building the plugin from source or installing a local checkout? See [DEVELOP.md](DEVELOP.md).

## Configuration

Configuration lives in the `data-tools` settings namespace, edited live from the web GUI: **Settings → Data sources**. The page's **Connections (JSON)** field holds the `connections` array — one JSON object per database connection:

```json
[
  {
    "name": "dev",
    "host": "10.0.0.10",
    "port": 3306,
    "database": "your_db",
    "user": "readonly_user",
    "passwordRef": "DEV_DB_PASSWORD"
  }
]
```

**Top-level options**

| Option | Type | Default | Description |
|---|---|---|---|
| `connections` | array of connection objects | — (required) | Named data-source connections the `db_*` / `redis_*` / `es_*` tools operate on. |
| `defaultMaxRows` | number | `100` | Result cap applied when a connection sets none (rows for SQL, keys/items for Redis, hits/fields for Elasticsearch). |
| `defaultTimeoutMs` | number | `10000` | Statement/command/request timeout in ms applied when a connection sets none. |

**Per-connection options** (each element of `connections`; fields marked “mysql” / “postgres” / “redis” / “elasticsearch” apply to that kind only)

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | — (required) | Unique connection name; referenced by the `connection` argument of every `db_*` / `redis_*` / `es_*` tool. |
| `kind` | `'mysql' \| 'postgres' \| 'redis' \| 'elasticsearch'` | `'mysql'` | Backend discriminator. Unknown kinds are rejected at config validation. |
| `host` | string | — (required) | Database server host. |
| `port` | number | `3306` (mysql) / `5432` (postgres) / `6379` (redis) / `9200` (elasticsearch) | Server port. |
| `database` | string (mysql/postgres) or number (redis) | (none) / `0` | mysql: optional default database (omit it to let the agent see every database the account can access). postgres: the database to connect to (omitted means the server default). redis: the logical database **index** (default 0). |
| `user` | string | — (required for mysql/postgres) | Database account name — use a read-only user. Redis: optional ACL username (Redis 6+). Elasticsearch: optional basic-auth username. |
| `passwordRef` | string | (none) | Credential reference: an environment variable name resolved per operation through the dsh credentials seam (env or the dsh `.env` file). Preferred over `password` — the secret never sits in config or session logs. |
| `password` | string | (none) | Plaintext password fallback for throwaway local setups. Marked `role('secret')`: redacted on the wire and never returned to configuration surfaces (write-only in the settings UI). |
| `charset` | string | `'utf8mb4'` | Connection charset (mysql only; other kinds ignore it). |
| `ssl` | boolean | `false` | TLS for the connection, accepting self-signed certificates (postgres / redis / elasticsearch). |
| `schema` | string | `'public'` | Default schema (namespace) for the table tools when no `database` argument is passed (postgres only). |
| `maxRows` | number | falls back to `defaultMaxRows` | Per-connection result cap. |
| `timeoutMs` | number | falls back to `defaultTimeoutMs` | Per-connection statement/command/request timeout in ms. |

> **PostgreSQL semantics**: a connection addresses one database, and the listing unit for `db_list_tables` / `db_table_schema` is a **schema** inside it. `db_list_databases` returns the connected database's non-system schemas, and the `database` argument of the table tools carries a schema name (falling back to the connection's `schema`, default `public`).

**Full example** (every field, settings-page JSON form):

```json
[
  {
    "name": "dev",
    "kind": "mysql",
    "host": "10.0.0.10",
    "port": 3306,
    "database": "your_db",
    "user": "readonly_user",
    "passwordRef": "DEV_DB_PASSWORD",
    "charset": "utf8mb4",
    "maxRows": 50,
    "timeoutMs": 5000
  },
  {
    "name": "analytics",
    "host": "10.0.0.11",
    "port": 3306,
    "user": "analytics_ro",
    "passwordRef": "ANALYTICS_DB_PASSWORD"
  },
  {
    "name": "warehouse",
    "kind": "postgres",
    "host": "10.0.0.20",
    "port": 5432,
    "database": "analytics",
    "schema": "public",
    "user": "warehouse_ro",
    "passwordRef": "WAREHOUSE_DB_PASSWORD",
    "ssl": true,
    "maxRows": 50,
    "timeoutMs": 5000
  },
  {
    "name": "cache",
    "kind": "redis",
    "host": "10.0.0.30",
    "port": 6379,
    "database": 0,
    "user": "ro",
    "passwordRef": "CACHE_DB_PASSWORD",
    "ssl": true,
    "maxRows": 200,
    "timeoutMs": 3000
  },
  {
    "name": "logs",
    "kind": "elasticsearch",
    "host": "10.0.0.40",
    "port": 9200,
    "user": "readonly",
    "passwordRef": "ES_DB_PASSWORD",
    "ssl": true,
    "maxRows": 50,
    "timeoutMs": 5000
  }
]
```

> **Redis semantics**: `database` is the logical database **index** (default 0); `redis_keys` uses SCAN (never the blocking KEYS); every collection read (`redis_read`) is bounded by `limit` / the connection cap; `dbSize` is reported from `DBSIZE`.
>
> **Elasticsearch semantics**: the base URL is `http(s)://host:port` (https when `ssl` is true); `es_mapping`/`es_search` take a single index or pattern; `es_search` accepts the full search body as JSON and always overrides its `size` with the capped value.

**Where configuration can live** — three layers, later ones win:

1. **Bundle default** — the package's own `cordis.patch.yml` (applied automatically on install; the composition base). The file itself is a developer concern — see [DEVELOP.md](DEVELOP.md).
2. **Patch overlays** — the profile's `cordis.patch.yml` or `--patch` files: id-targeted overrides of the `data-tools` row (never `insert` a second row with the same id).
3. **Settings document** — `settings.yaml` under `$DSH_HOME`, edited via the **Data sources** settings page (or the settings file directly). Applies live — no restart needed.

## Safety contract

> ⚠️ **The plugin is read-only — the agent is not.** The `db_*` / `redis_*` / `es_*` tools above refuse writes. But the AI agent you are talking to can also run arbitrary scripts: given the connection details configured in this section (`host`/`port`/`user`/password), it can connect to the same servers directly (e.g. with a `mysql2`/`pg`/`redis`/`@elastic/elasticsearch` script or the `mysql`/`psql`/`redis-cli`/`curl` CLI) and perform writes, bypassing the plugin entirely. The plugin neither can nor will prevent that.
>
> **The only real write barrier is the account**: give the agent a `SELECT`-only SQL user, a Redis 6+ ACL user restricted to read commands (`~* +@read`), and an Elasticsearch role with read privileges only (`read`/`view_index_metadata`). With such accounts, neither the plugin nor any script can write.

Read-only by design, with defense in depth:

1. **Primary boundary — the account**: give the agent read-only SQL users (`SELECT` only), a Redis ACL read-only user (Redis 6+; older Redis relies on the tool set alone), and an Elasticsearch read-only role. Nothing in the plugin bypasses the account.
2. **Statement/command guard**: SQL — only read statements pass (`SELECT / SHOW / DESCRIBE / EXPLAIN / WITH` for MySQL; `SELECT / SHOW / EXPLAIN / WITH` for PostgreSQL, which also refuses table-creating `SELECT ... INTO`); writes, locks, and multi-statement strings are refused. Redis — there is no generic command tool: the `redis_*` tools issue only read commands (SCAN, GET, LRANGE, HSCAN, SSCAN, ZSCAN, TYPE, INFO, DBSIZE). Elasticsearch — no generic API tool: the `es_*` tools call only `_cat`, `_mapping`, `_search`, and `info`.
3. **Bounded results**: unbounded SELECTs get an automatic `LIMIT maxRows`; Redis scans and collection reads and Elasticsearch hits/mapping fields are capped by `limit` / the connection cap; cell values are truncated at 60 chars; a truncation note is appended.
4. **Timeout**: `SET SESSION MAX_EXECUTION_TIME` (MySQL 5.7.8+ / 8.0), `SET statement_timeout` (PostgreSQL), node-redis `connectTimeout` / `socketTimeout` (Redis), or the Elasticsearch client `requestTimeout`, plus a connection timeout.
5. **Secrets**: passwords come from the credentials seam, never from config dumps or model-visible output.
6. **Privilege-bounded discovery**: `db_list_databases` / `redis_keys` / `es_indices` show only what the read-only account can access — "see everything" is bounded by the account's grants.

Known limits: the SQL statement guard is keyword-based, not a parser — treat it as defense in depth, not a sandbox. MariaDB lacks `MAX_EXECUTION_TIME` (timeout degrades gracefully). V1 covers MySQL, PostgreSQL, Redis, and Elasticsearch.
