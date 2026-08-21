# dsh-data-tools

English | [中文](README.zh.md) | [Development](DEVELOP.md)

Read-only MySQL tooling for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): let the agent **see the database before it writes code** — list connections, discover table schemas, and run guarded SELECT queries.

## Background

AI coding assistants cannot query your database by default: no table structures, no sample data, no way to verify SQL. This plugin gives the agent a safe, read-only window into MySQL so it can write schema-accurate queries and code.

## Tools

| Tool | Purpose |
|---|---|
| `db_connections` | List configured connections (name, database or "all databases", host, user — never passwords). |
| `db_list_databases` | List databases the connection's user can access (system schemas omitted). |
| `db_list_tables` | List tables of a database (optional `database`, defaults to the connection's), with optional name filter. |
| `db_table_schema` | Columns, indexes, and sample rows for one table (optional `database`). |
| `db_query` | Execute a read-only statement (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH); qualify `database.table` when no default database is set. |

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
| `connections` | array of connection objects | — (required) | Named MySQL connections the `db_*` tools operate on. |
| `defaultMaxRows` | number | `100` | Result row cap applied when a connection sets none. |
| `defaultTimeoutMs` | number | `10000` | Statement timeout in ms applied when a connection sets none. |

**Per-connection options** (each element of `connections`)

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | — (required) | Unique connection name; referenced by the `connection` argument of every `db_*` tool. |
| `kind` | `'mysql'` | `'mysql'` | Backend discriminator. Only `mysql` is implemented today; unknown kinds are rejected at config validation. |
| `host` | string | — (required) | MySQL server host. |
| `port` | number | `3306` | MySQL server port. |
| `database` | string | (none) | Optional default database. Omit it (or leave `null`/empty) to let the agent see every database the account can access via `db_list_databases`; the table tools then need a `database` argument, or qualify `database.table` in `db_query`. |
| `user` | string | — (required) | MySQL account name — use a read-only user. |
| `passwordRef` | string | (none) | Credential reference: an environment variable name resolved per operation through the dsh credentials seam (env or the dsh `.env` file). Preferred over `password` — the secret never sits in config or session logs. |
| `password` | string | (none) | Plaintext password fallback for throwaway local setups. Marked `role('secret')`: redacted on the wire and never returned to configuration surfaces (write-only in the settings UI). |
| `charset` | string | `'utf8mb4'` | Connection charset. |
| `maxRows` | number | falls back to `defaultMaxRows` | Per-connection result row cap. |
| `timeoutMs` | number | falls back to `defaultTimeoutMs` | Per-connection statement timeout in ms. |

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
  }
]
```

**Where configuration can live** — three layers, later ones win:

1. **Bundle default** — the package's own `cordis.patch.yml` (applied automatically on install; the composition base). The file itself is a developer concern — see [DEVELOP.md](DEVELOP.md).
2. **Patch overlays** — the profile's `cordis.patch.yml` or `--patch` files: id-targeted overrides of the `data-tools` row (never `insert` a second row with the same id).
3. **Settings document** — `settings.yaml` under `$DSH_HOME`, edited via the **Data sources** settings page (or the settings file directly). Applies live — no restart needed.

## Safety contract

> ⚠️ **The plugin is read-only — the agent is not.** The `db_*` tools above refuse `INSERT/UPDATE/DELETE` and everything else that mutates data. But the AI agent you are talking to can also run arbitrary scripts: given the connection details configured in this section (`host`/`port`/`user`/password), it can connect to the same MySQL server directly (e.g. with a `mysql2` script or the `mysql` CLI) and perform writes, bypassing the plugin entirely. The plugin neither can nor will prevent that.
>
> **The only real write barrier is the database account**: give the agent a MySQL user with `SELECT`-only privileges. With such an account, neither the plugin nor any script can write.

Read-only by design, with defense in depth:

1. **Primary boundary — the database account**: give the agent a MySQL user with read-only privileges (`SELECT` only). Nothing in the plugin bypasses the account.
2. **Statement guard**: only `SELECT / SHOW / DESCRIBE / EXPLAIN / WITH` pass; `INSERT/UPDATE/DELETE/DROP/ALTER/...`, `FOR UPDATE / FOR SHARE`, `INTO OUTFILE/DUMPFILE`, and multi-statement strings are refused.
3. **Bounded results**: unbounded SELECTs get an automatic `LIMIT maxRows`; cell values are truncated at 60 chars; a truncation note is appended.
4. **Statement timeout**: `SET SESSION MAX_EXECUTION_TIME` (MySQL 5.7.8+ / 8.0) plus a connection timeout.
5. **Secrets**: passwords come from the credentials seam, never from config dumps or model-visible output.
6. **Privilege-bounded discovery**: `db_list_databases` shows only the databases the read-only account can access — "all databases" is bounded by the account's grants.

Known limits: the statement guard is keyword-based, not a parser — treat it as defense in depth, not a sandbox. MariaDB lacks `MAX_EXECUTION_TIME` (timeout degrades gracefully). V1 is MySQL-only.
